/**
 * The routing ladder: how a Sage verdict becomes a stable routing action.
 *
 * Sage is consulted in two stages. Stage one is a `yesno` gate -- is this agent failing
 * badly enough to intervene at all? That binary question is the sharp signal, and most
 * checkpoints end there for the price of one cheap call. Stage two runs only when the
 * gate fires and asks which of the four actions to take.
 *
 * The split was not the original design. Asking only the four-way question under-escalated
 * badly, because `choice` probabilities are independent sigmoids that do not sum to 1, so
 * every option clustered in the same narrow band and a confidence floor on the argmax
 * rejected real signal. A binary gate separates the same trajectories cleanly.
 */

import type { SageClient, SageChoiceOption } from "./sage";
import { SageError } from "./sage";
import { renderEvidence, type SignalReport } from "./signals";
import type { ResolvedSageRouteConfig, SageRouteAction } from "./types";
import { SAGEROUTE_ACTIONS } from "./types";

export const ROUTE_OPTIONS: SageChoiceOption[] = [
  {
    option: "continue",
    description:
      "The trajectory is healthy. Errors are absent, novel, or already being resolved, "
      + "checks are passing or still pending, and there is no repetition. Keep the current "
      + "low-cost model working.",
  },
  {
    option: "switch_model",
    description:
      "The agent is genuinely struggling with the reasoning: repeated failures, failing "
      + "checks, or no progress for several steps, but the workspace state is still sound. "
      + "Hand the task to a stronger, more expensive model.",
  },
  {
    option: "restart_clean",
    description:
      "The trajectory itself is polluted: the agent is looping on the same action, or has "
      + "baked in a wrong assumption it keeps building on. Discard the context and restart "
      + "from a clean state with distilled hints.",
  },
  {
    option: "escalate_human",
    description:
      "No model should continue: the task looks impossible or underspecified, the budget is "
      + "nearly exhausted, or repeated recovery attempts have failed. Stop and ask a human.",
  },
];

export const ROUTE_INSTRUCTIONS =
  "You are governing an autonomous coding agent. You are shown only factual execution "
  + "evidence from its run so far: tool calls, error classes, loop detection, progress, and "
  + "budget. Based strictly on this evidence, choose the single best next action. Prefer "
  + "'continue' unless the evidence clearly shows the agent is struggling, stuck, or wasting "
  + "budget. Escalating too early wastes money; escalating too late wastes time and produces "
  + "failed runs.";

export const INTERVENTION_QUESTION =
  "The evidence below describes an autonomous coding agent running on a CHEAP, "
  + "low-capability model. Answer yes if this agent is failing and should be handed off to a "
  + "stronger, more expensive model. Answer no if it is on track and should keep going on the "
  + "cheap model.";

export interface Verdict {
  action: SageRouteAction;
  confidence: number;
  reason: string;
  source: "sage" | "offline" | "local";
  probabilities: Record<string, number>;
  interventionProbability: number;
  sageLatencyMs: number;
}

export interface LadderState {
  switchesUsed: number;
  restartsUsed: number;
  consecutiveBad: number;
}

function verdict(partial: Partial<Verdict> & Pick<Verdict, "action" | "reason" | "source">): Verdict {
  return {
    confidence: 0,
    probabilities: {},
    interventionProbability: 0,
    sageLatencyMs: 0,
    ...partial,
  };
}

function isAction(value: string): value is SageRouteAction {
  return (SAGEROUTE_ACTIONS as readonly string[]).includes(value);
}

/**
 * Ask Sage and wrap the answer in the guardrails a production router needs.
 * `state` is mutated to record consumed switches/restarts and hysteresis progress.
 */
export async function decide(
  client: SageClient,
  config: ResolvedSageRouteConfig,
  report: SignalReport,
  goal: string,
  state: LadderState,
): Promise<Verdict> {
  // Local hard stop first. Spend limits are policy, never delegated to the model, and
  // the check runs before any network call so an exhausted budget cannot spend more.
  if (config.budgetUsd > 0 && report.budgetBurn >= config.budgetEscalateFraction) {
    return verdict({
      action: "escalate_human",
      confidence: 1,
      reason: `budget burn ${(report.budgetBurn * 100).toFixed(0)}% >= `
        + `${(config.budgetEscalateFraction * 100).toFixed(0)}%`,
      source: "local",
    });
  }

  const onStrong = report.tier === "strong";
  const evidence = renderEvidence(report, goal);

  // Stage 1: is intervention warranted at all?
  let gate;
  try {
    gate = await client.yesno(evidence, "sageroute_needs_intervention", INTERVENTION_QUESTION);
  } catch (err) {
    // Fail open: a router outage must never take the agent down with it.
    return verdict({
      action: "continue",
      reason: `sage unavailable (${err instanceof SageError ? err.message : String(err)}); continuing`,
      source: "local",
    });
  }

  const interventionProbability = gate.probabilities.yes ?? 0;
  if (interventionProbability < config.interventionThreshold) {
    state.consecutiveBad = 0;
    return verdict({
      action: "continue",
      confidence: interventionProbability,
      reason: `trajectory healthy (P(intervene)=${interventionProbability.toFixed(2)} < `
        + `${config.interventionThreshold.toFixed(2)})`,
      source: gate.source,
      probabilities: gate.probabilities,
      interventionProbability,
      sageLatencyMs: gate.latencyMs,
    });
  }

  // Stage 2: intervention is warranted, so ask which action to take.
  let decision;
  try {
    decision = await client.choice(evidence, "sageroute_action", ROUTE_INSTRUCTIONS, ROUTE_OPTIONS);
  } catch (err) {
    return verdict({
      action: "continue",
      reason: `sage unavailable (${err instanceof SageError ? err.message : String(err)}); continuing`,
      source: "local",
      interventionProbability,
    });
  }

  let proposed: SageRouteAction = isAction(decision.answer) ? decision.answer : "continue";

  // The gate already established something is wrong. If the follow-up still says
  // `continue`, take the next-best action rather than ignoring the gate outright.
  if (proposed === "continue") {
    const ranked = Object.entries(decision.probabilities)
      .filter(([name]) => name !== "continue" && isAction(name))
      .sort((a, b) => b[1] - a[1]);
    proposed = ranked.length > 0 ? ranked[0]![0] as SageRouteAction : "switch_model";
  }

  const out = verdict({
    action: proposed,
    confidence: decision.confidence,
    reason: "sage verdict",
    source: decision.source,
    probabilities: decision.probabilities,
    interventionProbability,
    sageLatencyMs: decision.latencyMs,
  });

  // Capability before retry. A restart hands the same task back to the same weak model,
  // which helps only when the context is polluted -- never when the model simply cannot
  // do the work. While still on the cheap tier with a switch available, climb first.
  if (proposed === "restart_clean" && !onStrong && state.switchesUsed < config.maxSwitches) {
    proposed = "switch_model";
    out.action = proposed;
    out.reason = "restart requested on cheap tier; upgrading capability first";
  }

  // Asymmetric hysteresis. The first cheap-to-strong hop is the cheapest, most reversible
  // move on the ladder, so it fires on one bad checkpoint. Restarts and human escalation
  // are disruptive, so they need repeated agreement.
  let required = config.consecutiveBadRequired;
  if (proposed === "switch_model" && !onStrong && state.switchesUsed === 0) required = 1;

  state.consecutiveBad += 1;
  if (state.consecutiveBad < required) {
    return verdict({
      action: "continue",
      confidence: out.confidence,
      reason: `bad checkpoint ${state.consecutiveBad}/${required}, holding`,
      source: "local",
      probabilities: out.probabilities,
      interventionProbability,
      sageLatencyMs: out.sageLatencyMs,
    });
  }

  if (proposed === "switch_model") {
    if (onStrong) {
      // Already at the top of the ladder: the next rung is a restart, never a demotion.
      if (state.restartsUsed < config.maxRestarts) {
        out.action = "restart_clean";
        out.reason = "already on strong model; restarting clean instead";
        state.restartsUsed += 1;
      } else {
        out.action = "escalate_human";
        out.reason = "strong model still failing and restarts exhausted";
      }
      state.consecutiveBad = 0;
      return out;
    }
    if (state.switchesUsed >= config.maxSwitches) {
      out.action = "escalate_human";
      out.reason = "switch budget exhausted";
      state.consecutiveBad = 0;
      return out;
    }
    state.switchesUsed += 1;
    out.reason = "agent struggling on cheap model; escalating capability";
    state.consecutiveBad = 0;
    return out;
  }

  if (proposed === "restart_clean") {
    if (state.restartsUsed >= config.maxRestarts) {
      out.action = "escalate_human";
      out.reason = "restart budget exhausted";
    } else {
      state.restartsUsed += 1;
      out.reason = "trajectory polluted; restarting from clean context";
    }
    state.consecutiveBad = 0;
    return out;
  }

  state.consecutiveBad = 0;
  out.action = "escalate_human";
  out.reason = "sage escalated to human review";
  return out;
}
