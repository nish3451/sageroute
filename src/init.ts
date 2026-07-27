/**
 * Config scaffolding for `sageroute init`.
 *
 * Getting started used to mean copying an example, hand-editing JSON, and guessing which
 * environment variables mattered. That is three chances to produce a config that fails
 * validation before the router has done anything interesting.
 *
 * `init` inspects what credentials actually exist on this machine and writes a config
 * that is valid for THAT machine. The generated file is deliberately plain JSON rather
 * than a template with placeholders, so `check` either passes or names a real problem.
 */

import { resolveSecret } from "./proxy/config";
import type { ProviderConfig, ProxyConfig } from "./proxy/config";
import { listCredentials } from "./oauth";
import type { OAuthProviderId } from "./oauth";

/** A ladder tier the generated config can be built around. */
export interface LadderPreset {
  provider: string;
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface InitPlan {
  providers: Record<string, ProviderConfig>;
  cheap: LadderPreset;
  strong: LadderPreset;
  /** Human-readable notes explaining why this shape was chosen. */
  notes: string[];
}

/** Subscription tokens are only accepted here, not on the metered API host. */
const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";

/**
 * Prices are list rates at the time of writing and drift. They exist so the budget rung
 * of the ladder has something to meter against; correct them for your own billing.
 */
const OPENAI_KEY_CHEAP: LadderPreset = {
  provider: "openai", model: "gpt-4.1-mini", inputPerMTok: 0.4, outputPerMTok: 1.6,
};
const OPENAI_KEY_STRONG: LadderPreset = {
  provider: "openai", model: "gpt-4.1", inputPerMTok: 2, outputPerMTok: 8,
};
const ANTHROPIC_KEY_CHEAP: LadderPreset = {
  provider: "anthropic", model: "claude-haiku-4-5-20251001", inputPerMTok: 1, outputPerMTok: 5,
};
const ANTHROPIC_KEY_STRONG: LadderPreset = {
  provider: "anthropic", model: "claude-sonnet-4-5-20250929", inputPerMTok: 3, outputPerMTok: 15,
};
// A subscription turn is not separately billed, so the budget rung is not meaningful.
const OPENAI_SUB_CHEAP: LadderPreset = {
  provider: "openai", model: "gpt-5.4-mini", inputPerMTok: 0, outputPerMTok: 0,
};
const ANTHROPIC_SUB_STRONG: LadderPreset = {
  provider: "anthropic", model: "claude-sonnet-4-5-20250929", inputPerMTok: 0, outputPerMTok: 0,
};

export interface InitInputs {
  /** Providers with a stored subscription login. */
  logins: readonly OAuthProviderId[];
  env: Record<string, string | undefined>;
}

function subscriptionProvider(name: OAuthProviderId): ProviderConfig {
  if (name === "openai") {
    return { adapter: "openai-responses", baseUrl: CHATGPT_BASE_URL, models: ["gpt-5.4-mini", "gpt-5.6-sol"] };
  }
  return {
    adapter: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
    models: ["claude-haiku-4-5-20251001", "claude-sonnet-4-5-20250929"],
  };
}

/**
 * Choose the best ladder the available credentials can support.
 *
 * Preference order is deliberate. A subscription is preferred because it is the cheaper
 * way to pay for a turn, and a cross-vendor ladder is preferred over a single-vendor one
 * only when that is what the credentials allow, never by inventing a provider the user
 * cannot authenticate.
 */
export function planInit(inputs: InitInputs): InitPlan {
  const hasOpenAiLogin = inputs.logins.includes("openai");
  const hasAnthropicLogin = inputs.logins.includes("anthropic");
  const openAiKey = resolveSecret("${OPENAI_API_KEY}", inputs.env) !== undefined;
  const anthropicKey = resolveSecret("${ANTHROPIC_API_KEY}", inputs.env) !== undefined;

  const providers: Record<string, ProviderConfig> = {};
  const notes: string[] = [];

  if (hasOpenAiLogin) {
    providers.openai = subscriptionProvider("openai");
    notes.push("openai uses your stored ChatGPT subscription login");
  } else if (openAiKey) {
    providers.openai = {
      adapter: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "${OPENAI_API_KEY}",
      models: [OPENAI_KEY_CHEAP.model, OPENAI_KEY_STRONG.model],
    };
    notes.push("openai uses OPENAI_API_KEY from your environment");
  }

  if (hasAnthropicLogin) {
    providers.anthropic = subscriptionProvider("anthropic");
    notes.push("anthropic uses your stored Claude subscription login");
  } else if (anthropicKey) {
    providers.anthropic = {
      adapter: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "${ANTHROPIC_API_KEY}",
      models: [ANTHROPIC_KEY_CHEAP.model, ANTHROPIC_KEY_STRONG.model],
    };
    notes.push("anthropic uses ANTHROPIC_API_KEY from your environment");
  }

  // A ladder needs two distinct rungs. Prefer a cheap tier and a strong tier that the
  // detected credentials can actually reach.
  if (hasOpenAiLogin && hasAnthropicLogin) {
    return { providers, cheap: OPENAI_SUB_CHEAP, strong: ANTHROPIC_SUB_STRONG, notes };
  }
  if (hasAnthropicLogin) {
    return {
      providers,
      cheap: { ...ANTHROPIC_KEY_CHEAP, inputPerMTok: 0, outputPerMTok: 0 },
      strong: ANTHROPIC_SUB_STRONG,
      notes,
    };
  }
  if (hasOpenAiLogin) {
    return {
      providers,
      cheap: OPENAI_SUB_CHEAP,
      strong: { provider: "openai", model: "gpt-5.6-sol", inputPerMTok: 0, outputPerMTok: 0 },
      notes,
    };
  }
  if (openAiKey) {
    return { providers, cheap: OPENAI_KEY_CHEAP, strong: OPENAI_KEY_STRONG, notes };
  }
  if (anthropicKey) {
    return { providers, cheap: ANTHROPIC_KEY_CHEAP, strong: ANTHROPIC_KEY_STRONG, notes };
  }

  // Nothing detected. Emit the OpenAI key shape so the file is still a usable starting
  // point, and let the caller tell the user exactly what is missing.
  providers.openai = {
    adapter: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "${OPENAI_API_KEY}",
    models: [OPENAI_KEY_CHEAP.model, OPENAI_KEY_STRONG.model],
  };
  notes.push("no credentials detected; wrote an OPENAI_API_KEY config as a starting point");
  return { providers, cheap: OPENAI_KEY_CHEAP, strong: OPENAI_KEY_STRONG, notes };
}

/** Render a plan as the config object that gets written to disk. */
export function configFromPlan(plan: InitPlan): ProxyConfig {
  return {
    port: 8787,
    hostname: "127.0.0.1",
    providers: plan.providers,
    sageRoute: {
      enabled: true,
      alias: "sageroute",
      cheap: plan.cheap,
      strong: plan.strong,
      apiKey: "${SAGE_API_KEY}",
      checkpointEvery: 3,
      firstCheckpointAt: 3,
      interventionThreshold: 0.6,
      consecutiveBadRequired: 2,
      maxSwitches: 1,
      maxRestarts: 1,
      escalateHumanMode: "notice",
    },
  } as ProxyConfig;
}

/** Detect which providers have a usable stored login. */
export async function detectLogins(): Promise<OAuthProviderId[]> {
  const stored = await listCredentials();
  return (Object.keys(stored) as OAuthProviderId[]).filter(p => stored[p] !== undefined);
}
