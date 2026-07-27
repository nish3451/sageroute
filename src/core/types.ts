/**
 * SageRoute: a trajectory-aware model router.
 *
 * Conventional routers classify difficulty from the prompt before any work happens.
 * SageRoute starts every task on the cheap tier and re-decides each turn from what the
 * agent actually DID -- tool calls, error classes, loops, failed verifications, budget
 * burn -- consulting the Levanto Sage decision API (https://docs.levanto.ai/) for the
 * verdict.
 *
 * SageRoute ships as an OpenAI-compatible proxy because that is where the evidence is:
 * an agent harness resends its whole conversation every turn, so the proxy sees the full
 * execution history for free on a request it is already handling.
 */

export type SageRouteAction =
  | "continue"
  | "switch_model"
  | "restart_clean"
  | "escalate_human";

export const SAGEROUTE_ACTIONS: readonly SageRouteAction[] = [
  "continue",
  "switch_model",
  "restart_clean",
  "escalate_human",
];

/** One rung of the capability ladder: a concrete provider/model plus list pricing. */
export interface SageRouteTier {
  provider: string;
  model: string;
  /** USD per 1M input tokens. Used only for the cost ledger, never for the verdict. */
  inputPerMTok?: number;
  /** USD per 1M output tokens. */
  outputPerMTok?: number;
}

export interface SageRouteConfig {
  /** Master switch. When false the alias stops resolving and normal routing applies. */
  enabled?: boolean;
  /**
   * Public model id clients request. Defaults to `sageroute`. Bare aliases in the
   * OpenAI native family are rejected for the same reason combos reject them: they
   * would shadow real catalog rows.
   */
  alias?: string;
  /** Where every task starts. */
  cheap: SageRouteTier;
  /** Where a struggling task is escalated to. */
  strong: SageRouteTier;
  /** Sage decision API base. Defaults to https://sage.levanto.ai. */
  endpoint?: string;
  /** Sage API key; supports `${VAR}` / `$VAR` env indirection like every other secret here. */
  apiKey?: string;
  /** Turns between Sage consultations. Default 3. */
  checkpointEvery?: number;
  /** Never judge before this many recorded actions exist. Default 3. */
  firstCheckpointAt?: number;
  /** Stage-one gate: P(intervene) at or above this asks the four-way question. Default 0.6. */
  interventionThreshold?: number;
  /** Hysteresis for restarts and human escalation. Default 2. */
  consecutiveBadRequired?: number;
  /** Cheap -> strong hops allowed per session. Default 1. */
  maxSwitches?: number;
  /** Clean restarts allowed per session. Default 1. */
  maxRestarts?: number;
  /** Session spend cap in USD. 0 or omitted disables the budget rung. */
  budgetUsd?: number;
  /** Fraction of budget that triggers human escalation. Default 0.85. */
  budgetEscalateFraction?: number;
  /** Use the deterministic local decision stub instead of the network. Default false. */
  offline?: boolean;
  /** Sage HTTP timeout in ms. Default 8000 -- the router must not stall the turn. */
  timeoutMs?: number;
  /**
   * What `escalate_human` does on the wire. `notice` (default) answers the turn with a
   * synthesized assistant message that stops the agent and states why; `continue` keeps
   * the agent running on the strong tier and only records the verdict.
   */
  escalateHumanMode?: "notice" | "continue";
}

/** A resolved, defaulted view of the user config. */
export interface ResolvedSageRouteConfig {
  alias: string;
  cheap: Required<Pick<SageRouteTier, "provider" | "model">> & {
    inputPerMTok: number;
    outputPerMTok: number;
  };
  strong: Required<Pick<SageRouteTier, "provider" | "model">> & {
    inputPerMTok: number;
    outputPerMTok: number;
  };
  endpoint: string;
  apiKey: string | null;
  checkpointEvery: number;
  firstCheckpointAt: number;
  interventionThreshold: number;
  consecutiveBadRequired: number;
  maxSwitches: number;
  maxRestarts: number;
  budgetUsd: number;
  budgetEscalateFraction: number;
  offline: boolean;
  timeoutMs: number;
  escalateHumanMode: "notice" | "continue";
}

export const SAGEROUTE_DEFAULT_ALIAS = "sageroute";
export const SAGEROUTE_DEFAULT_ENDPOINT = "https://sage.levanto.ai";

/** Default list pricing (USD per 1M tokens) when a tier omits it. */
const DEFAULT_CHEAP_PRICING = { inputPerMTok: 0.25, outputPerMTok: 2.0 };
const DEFAULT_STRONG_PRICING = { inputPerMTok: 1.25, outputPerMTok: 10.0 };

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function positiveInt(value: unknown, fallback: number, low: number, high: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= low && value <= high
    ? value
    : fallback;
}

function fraction(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, 0, 1) : fallback;
}

function tier(
  raw: SageRouteTier,
  defaults: { inputPerMTok: number; outputPerMTok: number },
): ResolvedSageRouteConfig["cheap"] {
  return {
    provider: raw.provider.trim(),
    model: raw.model.trim(),
    inputPerMTok: typeof raw.inputPerMTok === "number" && raw.inputPerMTok >= 0
      ? raw.inputPerMTok
      : defaults.inputPerMTok,
    outputPerMTok: typeof raw.outputPerMTok === "number" && raw.outputPerMTok >= 0
      ? raw.outputPerMTok
      : defaults.outputPerMTok,
  };
}

/**
 * Apply defaults. `resolveSecret` is injected so this module stays free of config-loader
 * imports (and so tests can resolve `env:` refs without touching the process env).
 */
export function resolveSageRouteConfig(
  raw: SageRouteConfig,
  resolveSecret: (value: string | undefined) => string | undefined = value => value,
): ResolvedSageRouteConfig {
  const key = resolveSecret(raw.apiKey)?.trim();
  return {
    alias: (typeof raw.alias === "string" && raw.alias.trim()) || SAGEROUTE_DEFAULT_ALIAS,
    cheap: tier(raw.cheap, DEFAULT_CHEAP_PRICING),
    strong: tier(raw.strong, DEFAULT_STRONG_PRICING),
    endpoint: ((typeof raw.endpoint === "string" && raw.endpoint.trim())
      || SAGEROUTE_DEFAULT_ENDPOINT).replace(/\/+$/, ""),
    apiKey: key ? key : null,
    checkpointEvery: positiveInt(raw.checkpointEvery, 3, 1, 100),
    firstCheckpointAt: positiveInt(raw.firstCheckpointAt, 3, 1, 100),
    interventionThreshold: fraction(raw.interventionThreshold, 0.6),
    consecutiveBadRequired: positiveInt(raw.consecutiveBadRequired, 2, 1, 10),
    maxSwitches: positiveInt(raw.maxSwitches, 1, 0, 10),
    maxRestarts: positiveInt(raw.maxRestarts, 1, 0, 10),
    budgetUsd: typeof raw.budgetUsd === "number" && raw.budgetUsd > 0 ? raw.budgetUsd : 0,
    budgetEscalateFraction: fraction(raw.budgetEscalateFraction, 0.85),
    offline: raw.offline === true,
    timeoutMs: positiveInt(raw.timeoutMs, 8000, 250, 120_000),
    escalateHumanMode: raw.escalateHumanMode === "continue" ? "continue" : "notice",
  };
}
