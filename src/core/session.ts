/**
 * Per-session routing state.
 *
 * A trajectory-aware router has to remember what it already did: which tier the session
 * is on, how many switches it has spent, how much it has cost, and when it last paid for
 * a Sage call. HTTP is stateless, so the session identity is recovered from the request.
 *
 * Identity preference order, most to least reliable:
 *   1. `prompt_cache_key` -- Codex sends a stable per-conversation value.
 *   2. `x-codex-parent-thread-id` -- present on collaboration surfaces.
 *   3. A digest of the first user message, which is stable across turns of one task.
 *
 * Sessions expire on idle so a long-lived proxy does not accumulate state forever.
 */

import { digest } from "./evidence";
import type { LadderState } from "./policy";
import type { SageRouteAction } from "./types";

export const SESSION_IDLE_MS = 6 * 60 * 60 * 1000;
const MAX_SESSIONS = 512;
const MAX_HISTORY = 50;

export interface RouteHistoryEntry {
  at: number;
  step: number;
  action: SageRouteAction;
  fromModel: string;
  toModel: string;
  reason: string;
  source: string;
  confidence: number;
  interventionProbability: number;
  sageLatencyMs: number;
}

export interface SageRouteSession extends LadderState {
  id: string;
  tier: "cheap" | "strong";
  createdAt: number;
  lastSeenAt: number;
  /** Turns observed on this session; drives the checkpoint cadence. */
  turns: number;
  /** Turn index of the last Sage consultation. */
  lastCheckpointTurn: number;
  costUsd: number;
  /** Set once escalate_human fires, so the notice is not re-sent every turn. */
  escalated: boolean;
  /** Set by restart_clean; consumed by the next turn to trim stale context. */
  restartPending: boolean;
  history: RouteHistoryEntry[];
  /** Sage calls made for this session, for the observability surface. */
  sageCalls: number;
}

const sessions = new Map<string, SageRouteSession>();

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Derive a stable session id from the request. Returns null when nothing identifying is
 * present, which makes the caller treat the turn as unroutable rather than inventing an
 * identity that would silently merge unrelated conversations into one budget.
 */
export function sessionIdFor(body: unknown, headers?: Headers, goal?: string): string | null {
  if (isObj(body)) {
    const cacheKey = body.prompt_cache_key;
    if (typeof cacheKey === "string" && cacheKey.trim()) return `pck:${cacheKey.trim()}`;
  }
  const threadId = headers?.get("x-codex-parent-thread-id")?.trim();
  if (threadId) return `thr:${threadId}`;
  if (goal && goal.trim()) return `goal:${digest(goal.trim(), 20)}`;
  return null;
}

function evict(now: number): void {
  for (const [id, session] of sessions) {
    if (now - session.lastSeenAt > SESSION_IDLE_MS) sessions.delete(id);
  }
  if (sessions.size <= MAX_SESSIONS) return;
  // Still over the cap after expiry: drop the least recently used first.
  const ordered = [...sessions.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
  for (const [id] of ordered.slice(0, sessions.size - MAX_SESSIONS)) sessions.delete(id);
}

export function getSession(id: string, now = Date.now()): SageRouteSession {
  evict(now);
  const existing = sessions.get(id);
  if (existing) {
    existing.lastSeenAt = now;
    return existing;
  }
  const created: SageRouteSession = {
    id,
    tier: "cheap",
    createdAt: now,
    lastSeenAt: now,
    turns: 0,
    lastCheckpointTurn: 0,
    costUsd: 0,
    escalated: false,
    restartPending: false,
    history: [],
    sageCalls: 0,
    switchesUsed: 0,
    restartsUsed: 0,
    consecutiveBad: 0,
  };
  sessions.set(id, created);
  return created;
}

export function peekSession(id: string): SageRouteSession | undefined {
  return sessions.get(id);
}

export function recordHistory(session: SageRouteSession, entry: RouteHistoryEntry): void {
  session.history.push(entry);
  if (session.history.length > MAX_HISTORY) {
    session.history.splice(0, session.history.length - MAX_HISTORY);
  }
}

export function listSessions(): SageRouteSession[] {
  return [...sessions.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

export function clearSageRouteSessions(id?: string): void {
  if (id === undefined) sessions.clear();
  else sessions.delete(id);
}

/** Add the cost of one completed turn, in USD, from real token counts. */
export function addTurnCost(
  session: SageRouteSession,
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
  pricing: { inputPerMTok: number; outputPerMTok: number },
): void {
  if (!usage) return;
  const input = typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
  const output = typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
  session.costUsd += (input * pricing.inputPerMTok + output * pricing.outputPerMTok) / 1_000_000;
}
