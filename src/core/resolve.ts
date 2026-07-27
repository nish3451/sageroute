/**
 * Config validation and inbound alias resolution.
 *
 * Kept separate from `types.ts` so the config loader and the management API share one
 * rule set, and so the hot-path request check stays a cheap string compare.
 *
 * The core deliberately knows nothing about how a provider is configured -- only that
 * some set of provider names exists. That keeps the decision engine free of any
 * transport or server imports.
 */

import { SAGEROUTE_DEFAULT_ALIAS, type SageRouteConfig, type SageRouteTier } from "./types";

/** The only thing tier validation needs to know about providers: which names exist. */
export type ProviderNameMap = Record<string, unknown>;

export interface SageRouteValidationIssue {
  path: Array<string | number>;
  message: string;
}

/**
 * Bare aliases in the OpenAI native family are rejected because the proxy also serves
 * real upstream model ids under those names. An alias that shadows a real catalog row
 * makes it impossible for a caller to ask for the underlying model on purpose.
 */
const NATIVE_OPENAI_FAMILY_PATTERN = /^(?:gpt-|o1-|o3-|o4-|codex-|claude-)/;
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;

function tierIssues(
  label: "cheap" | "strong",
  raw: unknown,
  providers: ProviderNameMap,
  issues: SageRouteValidationIssue[],
): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    issues.push({ path: [label], message: `${label} must be an object with provider and model` });
    return;
  }
  const tier = raw as Record<string, unknown>;
  const provider = typeof tier.provider === "string" ? tier.provider.trim() : "";
  const model = typeof tier.model === "string" ? tier.model.trim() : "";
  if (!provider) {
    issues.push({ path: [label, "provider"], message: `${label}.provider is required` });
  } else if (!Object.hasOwn(providers, provider)) {
    issues.push({
      path: [label, "provider"],
      message: `${label}.provider "${provider}" is not configured`,
    });
  }
  if (!model) {
    issues.push({ path: [label, "model"], message: `${label}.model is required` });
  }
  for (const key of ["inputPerMTok", "outputPerMTok"] as const) {
    const value = tier[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      issues.push({ path: [label, key], message: `${label}.${key} must be a non-negative number` });
    }
  }
}

export function sageRouteConfigIssues(
  raw: unknown,
  providers: ProviderNameMap,
): SageRouteValidationIssue[] {
  const issues: SageRouteValidationIssue[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    issues.push({ path: [], message: "sageRoute must be an object" });
    return issues;
  }
  const body = raw as Record<string, unknown>;

  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    issues.push({ path: ["enabled"], message: "enabled must be a boolean" });
  }

  const alias = typeof body.alias === "string" ? body.alias.trim() : "";
  if (body.alias !== undefined && typeof body.alias !== "string") {
    issues.push({ path: ["alias"], message: "alias must be a string" });
  } else if (alias) {
    if (!ALIAS_PATTERN.test(alias)) {
      issues.push({
        path: ["alias"],
        message: "alias must use letters, numbers, dot, underscore, or hyphen, with at most one \"/\" segment",
      });
    } else if (!alias.includes("/") && NATIVE_OPENAI_FAMILY_PATTERN.test(alias)) {
      issues.push({
        path: ["alias"],
        message: "bare aliases in the OpenAI native family (gpt-*, o1-*, o3-*, o4-*, codex-*) are not allowed",
      });
    }
    if (Object.hasOwn(providers, alias)) {
      issues.push({ path: ["alias"], message: `alias "${alias}" collides with configured provider name "${alias}"` });
    }
  }

  tierIssues("cheap", body.cheap, providers, issues);
  tierIssues("strong", body.strong, providers, issues);

  const cheap = body.cheap as SageRouteTier | undefined;
  const strong = body.strong as SageRouteTier | undefined;
  if (cheap?.provider && strong?.provider
    && cheap.provider === strong.provider
    && cheap.model === strong.model) {
    issues.push({
      path: ["strong"],
      message: "strong must differ from cheap; a ladder with one rung cannot escalate",
    });
  }

  const intRanges: Array<[keyof SageRouteConfig, number, number]> = [
    ["checkpointEvery", 1, 100],
    ["firstCheckpointAt", 1, 100],
    ["consecutiveBadRequired", 1, 10],
    ["maxSwitches", 0, 10],
    ["maxRestarts", 0, 10],
    ["timeoutMs", 250, 120_000],
  ];
  for (const [key, low, high] of intRanges) {
    const value = body[key as string];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < low || value > high) {
      issues.push({ path: [key as string], message: `${String(key)} must be an integer from ${low} to ${high}` });
    }
  }

  for (const key of ["interventionThreshold", "budgetEscalateFraction"] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      issues.push({ path: [key], message: `${key} must be a number from 0 to 1` });
    }
  }

  if (body.budgetUsd !== undefined
    && (typeof body.budgetUsd !== "number" || !Number.isFinite(body.budgetUsd) || body.budgetUsd < 0)) {
    issues.push({ path: ["budgetUsd"], message: "budgetUsd must be a non-negative number" });
  }
  if (body.offline !== undefined && typeof body.offline !== "boolean") {
    issues.push({ path: ["offline"], message: "offline must be a boolean" });
  }
  if (body.endpoint !== undefined && (typeof body.endpoint !== "string" || !body.endpoint.trim())) {
    issues.push({ path: ["endpoint"], message: "endpoint must be a nonblank string" });
  }
  if (body.apiKey !== undefined && typeof body.apiKey !== "string") {
    issues.push({ path: ["apiKey"], message: "apiKey must be a string" });
  }
  if (body.escalateHumanMode !== undefined
    && body.escalateHumanMode !== "notice"
    && body.escalateHumanMode !== "continue") {
    issues.push({ path: ["escalateHumanMode"], message: 'escalateHumanMode must be "notice" or "continue"' });
  }

  return issues;
}

export function sageRouteEnabled(config: { sageRoute?: SageRouteConfig }): boolean {
  const sageRoute = config.sageRoute;
  return Boolean(sageRoute && sageRoute.enabled !== false && sageRoute.cheap && sageRoute.strong);
}

/** Hot path: does this request address the SageRoute alias? */
export function sageRouteIdFromRawBody(
  body: unknown,
  config: { sageRoute?: SageRouteConfig },
): boolean {
  if (!sageRouteEnabled(config)) return false;
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const model = (body as { model?: unknown }).model;
  if (typeof model !== "string") return false;
  const alias = (typeof config.sageRoute?.alias === "string" && config.sageRoute.alias.trim())
    || SAGEROUTE_DEFAULT_ALIAS;
  return model === alias;
}
