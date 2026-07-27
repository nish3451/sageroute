/**
 * The per-turn routing decision.
 *
 * This is the piece that makes SageRoute a router rather than an observer: given an
 * inbound `/v1/responses` body, it recovers the trajectory, decides which tier should
 * answer this turn, and rewrites the request body to point at that tier.
 *
 * Cadence matters. Sage is consulted every `checkpointEvery` turns, never before
 * `firstCheckpointAt` actions exist, and never at all once a session has escalated. In
 * between, the session simply stays on the tier the last checkpoint chose, so the common
 * case costs nothing.
 */

import { extractTrajectory } from "./evidence";
import { decide, type Verdict } from "./policy";
import { HttpSageClient, OfflineSageClient, type SageClient } from "./sage";
import { computeSignals, type SignalReport } from "./signals";
import {
  getSession,
  recordHistory,
  sessionIdFor,
  type SageRouteSession,
} from "./session";
import type { ResolvedSageRouteConfig, SageRouteAction } from "./types";

export interface RouteTurnResult {
  /** The concrete `provider/model` reference this turn should be sent to. */
  modelRef: string;
  tier: "cheap" | "strong";
  session: SageRouteSession;
  action: SageRouteAction;
  /** True when Sage was actually consulted this turn. */
  checkpointed: boolean;
  verdict?: Verdict;
  report?: SignalReport;
  goal: string;
  /** Set when the ladder wants the turn answered with a human-escalation notice. */
  escalateNotice?: string;
}

export function clientFor(config: ResolvedSageRouteConfig, fetchImpl?: typeof fetch): SageClient {
  if (config.offline || !config.apiKey) return new OfflineSageClient();
  return new HttpSageClient(config.apiKey, config.endpoint, config.timeoutMs, fetchImpl);
}

function tierRef(config: ResolvedSageRouteConfig, tier: "cheap" | "strong"): string {
  const target = tier === "strong" ? config.strong : config.cheap;
  return `${target.provider}/${target.model}`;
}

export function pricingFor(
  config: ResolvedSageRouteConfig,
  tier: "cheap" | "strong",
): { inputPerMTok: number; outputPerMTok: number } {
  const target = tier === "strong" ? config.strong : config.cheap;
  return { inputPerMTok: target.inputPerMTok, outputPerMTok: target.outputPerMTok };
}

function escalationNotice(session: SageRouteSession, verdict: Verdict): string {
  const spent = session.costUsd > 0 ? ` Spent so far: $${session.costUsd.toFixed(4)}.` : "";
  return `SageRoute stopped this run and is asking for human review.\n\n`
    + `Reason: ${verdict.reason}.${spent}\n\n`
    + `The task has been attempted on ${session.switchesUsed > 0 ? "both the cheap and the strong model" : "the cheap model"}`
    + `${session.restartsUsed > 0 ? ` with ${session.restartsUsed} clean restart(s)` : ""}, and the execution `
    + `evidence does not show it converging. Review the trajectory, then re-send with a narrower task, `
    + `more context, or an explicit model to continue.`;
}

/**
 * Decide which model answers this turn. Pure with respect to the request body; the
 * caller applies `modelRef` to the wire.
 */
export async function routeTurn(
  body: unknown,
  headers: Headers | undefined,
  config: ResolvedSageRouteConfig,
  client: SageClient,
  now = Date.now(),
): Promise<RouteTurnResult> {
  const trajectory = extractTrajectory((body as { input?: unknown } | undefined)?.input);
  const goal = trajectory.goal;
  const sessionId = sessionIdFor(body, headers, goal);

  // No stable identity means no session: route to the cheap tier and stay stateless
  // rather than merging unrelated conversations into one budget.
  if (!sessionId) {
    const stateless = getSession(`anon:${now}:${Math.random().toString(36).slice(2, 10)}`, now);
    return {
      modelRef: tierRef(config, "cheap"),
      tier: "cheap",
      session: stateless,
      action: "continue",
      checkpointed: false,
      goal,
    };
  }

  const session = getSession(sessionId, now);
  session.turns += 1;

  const report = computeSignals(trajectory, {
    model: tierRef(config, session.tier),
    tier: session.tier,
    costUsd: session.costUsd,
    budgetUsd: config.budgetUsd,
    switchesUsed: session.switchesUsed,
  });

  // Once a session has escalated, it stays escalated until the client starts a new one.
  // Re-asking Sage every turn would spend money to re-derive a decision already made.
  if (session.escalated) {
    return {
      modelRef: tierRef(config, session.tier),
      tier: session.tier,
      session,
      action: "escalate_human",
      checkpointed: false,
      goal,
      report,
    };
  }

  const enoughEvidence = report.toolCalls >= config.firstCheckpointAt;
  const dueForCheckpoint = session.turns - session.lastCheckpointTurn >= config.checkpointEvery;
  if (!enoughEvidence || !dueForCheckpoint) {
    return {
      modelRef: tierRef(config, session.tier),
      tier: session.tier,
      session,
      action: "continue",
      checkpointed: false,
      goal,
      report,
    };
  }

  session.lastCheckpointTurn = session.turns;
  const verdict = await decide(client, config, report, goal, session);
  if (verdict.source !== "local") session.sageCalls += 1;

  const fromModel = tierRef(config, session.tier);
  let escalateNotice: string | undefined;

  switch (verdict.action) {
    case "switch_model":
      session.tier = "strong";
      break;
    case "restart_clean":
      // The restart is applied on the wire by trimming stale context; the tier is
      // whatever the ladder already established.
      session.restartPending = true;
      break;
    case "escalate_human":
      session.escalated = true;
      if (config.escalateHumanMode === "notice") {
        escalateNotice = escalationNotice(session, verdict);
      }
      break;
    case "continue":
      break;
  }

  const toModel = tierRef(config, session.tier);
  if (verdict.action !== "continue") {
    recordHistory(session, {
      at: now,
      step: report.step,
      action: verdict.action,
      fromModel,
      toModel,
      reason: verdict.reason,
      source: verdict.source,
      confidence: verdict.confidence,
      interventionProbability: verdict.interventionProbability,
      sageLatencyMs: verdict.sageLatencyMs,
    });
    console.warn(
      `[sageroute] ${session.id}: ${verdict.action} (${fromModel} -> ${toModel}) `
      + `P(intervene)=${verdict.interventionProbability.toFixed(2)} reason="${verdict.reason}"`,
    );
  }

  return {
    modelRef: toModel,
    tier: session.tier,
    session,
    action: verdict.action,
    checkpointed: true,
    verdict,
    report,
    goal,
    ...(escalateNotice ? { escalateNotice } : {}),
  };
}

/**
 * Build the concrete request body for the chosen tier.
 *
 * A switch does not replay the weak model's confusion. When a restart is pending, the
 * assistant's own reasoning and narration are dropped while the task, the tool calls, and
 * their real outputs are kept: the stronger model inherits facts and artifacts, not the
 * dead ends that caused the escalation.
 */
export function concreteRequestBody(body: unknown, modelRef: string, restart: boolean): Record<string, unknown> {
  const clone = structuredClone(body) as Record<string, unknown>;
  clone.model = modelRef;
  if (!restart || !Array.isArray(clone.input)) return clone;

  const kept: unknown[] = [];
  for (const raw of clone.input as unknown[]) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      kept.push(raw);
      continue;
    }
    const item = raw as Record<string, unknown>;
    // Reasoning items carry provider-specific encrypted payloads that a different
    // provider cannot decrypt, and they are precisely the polluted context a restart
    // exists to discard.
    if (item.type === "reasoning") continue;
    if (item.role === "assistant") continue;
    kept.push(item);
  }
  clone.input = kept;
  return clone;
}
