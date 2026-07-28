/**
 * The provider registry: what SageRoute knows how to talk to, and how.
 *
 * Adding a provider used to mean hand-writing a JSON block and knowing three things the
 * docs could only tell you indirectly: which adapter a vendor's wire format needs, which
 * base URL accepts the credential you actually have, and which environment variable the
 * key should be read from. Getting any of them wrong produces a config that validates and
 * then fails at the first real request.
 *
 * Encoding that knowledge here turns provider setup into naming a vendor. The registry is
 * data, not behavior, so the same table drives `provider list`, `provider add`, and the
 * suggestions printed when a ladder tier names a provider that is not configured.
 */

import type { ProviderConfig, ProxyConfig, UpstreamAdapter } from "./proxy/config";
import { CHATGPT_SUBSCRIPTION_BASE_URL } from "./proxy/config";

/**
 * How a registry entry expects to be paid for.
 *
 * `subscription` entries are backed by a stored OAuth login and take no key at all;
 * `key` entries need an API key and have no login flow. The split matters because the
 * two are not interchangeable per vendor: a ChatGPT subscription token is rejected by
 * the metered OpenAI host, so the same vendor needs two entries with different base URLs.
 */
export type RegistryAuthKind = "subscription" | "key";

export interface ProviderRegistryEntry {
  /** Registry id, as typed on the command line. */
  id: string;
  /** Human label for listings. */
  label: string;
  /** Default key under `providers` in the config. */
  configName: string;
  adapter: UpstreamAdapter;
  baseUrl: string;
  authKind: RegistryAuthKind;
  /** Environment variable the key is read from, for `key` entries. */
  envVar?: string;
  /** Suggested cheap and strong models, in that order. */
  models: [cheap: string, strong: string];
  /** List price in USD per 1M tokens, cheap tier then strong tier. */
  pricing: {
    cheap: { inputPerMTok: number; outputPerMTok: number };
    strong: { inputPerMTok: number; outputPerMTok: number };
  };
  /** One line explaining what this entry is for. */
  note: string;
}

/**
 * A subscription turn is not separately billed, so its budget rung would meter against a
 * price that does not exist. Zero is the honest value, not a placeholder.
 */
const FREE = { inputPerMTok: 0, outputPerMTok: 0 };

export const PROVIDER_REGISTRY: readonly ProviderRegistryEntry[] = [
  {
    id: "openai",
    label: "OpenAI (ChatGPT subscription)",
    configName: "openai",
    adapter: "openai-responses",
    baseUrl: CHATGPT_SUBSCRIPTION_BASE_URL,
    authKind: "subscription",
    models: ["gpt-5.4-mini", "gpt-5.6-sol"],
    pricing: { cheap: FREE, strong: FREE },
    note: "Uses a ChatGPT Plus/Pro login. Run: sageroute auth login openai",
  },
  {
    id: "openai-api",
    label: "OpenAI (API key)",
    configName: "openai",
    adapter: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    authKind: "key",
    envVar: "OPENAI_API_KEY",
    models: ["gpt-4.1-mini", "gpt-4.1"],
    pricing: {
      cheap: { inputPerMTok: 0.4, outputPerMTok: 1.6 },
      strong: { inputPerMTok: 2, outputPerMTok: 8 },
    },
    note: "Pay-per-token on the metered API host.",
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude subscription)",
    configName: "anthropic",
    adapter: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
    authKind: "subscription",
    models: ["claude-haiku-4-5-20251001", "claude-sonnet-4-5-20250929"],
    pricing: { cheap: FREE, strong: FREE },
    note: "Uses a Claude Pro/Max login. Run: sageroute auth login anthropic",
  },
  {
    id: "anthropic-api",
    label: "Anthropic (API key)",
    configName: "anthropic",
    adapter: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
    authKind: "key",
    envVar: "ANTHROPIC_API_KEY",
    models: ["claude-haiku-4-5-20251001", "claude-sonnet-4-5-20250929"],
    pricing: {
      cheap: { inputPerMTok: 1, outputPerMTok: 5 },
      strong: { inputPerMTok: 3, outputPerMTok: 15 },
    },
    note: "Pay-per-token with an Anthropic API key.",
  },
  {
    id: "xai",
    label: "xAI Grok",
    configName: "xai",
    adapter: "openai-chat",
    baseUrl: "https://api.x.ai/v1",
    authKind: "key",
    envVar: "XAI_API_KEY",
    models: ["grok-4.3", "grok-4.5"],
    pricing: {
      cheap: { inputPerMTok: 0.2, outputPerMTok: 0.5 },
      strong: { inputPerMTok: 3, outputPerMTok: 15 },
    },
    note: "OpenAI-compatible Chat Completions.",
  },
  {
    id: "kimi",
    label: "Kimi (Moonshot)",
    configName: "kimi",
    adapter: "openai-chat",
    baseUrl: "https://api.moonshot.ai/v1",
    authKind: "key",
    envVar: "KIMI_API_KEY",
    models: ["kimi-k2.5", "kimi-k2.6"],
    pricing: {
      cheap: { inputPerMTok: 0.15, outputPerMTok: 2.5 },
      strong: { inputPerMTok: 0.6, outputPerMTok: 2.5 },
    },
    note: "OpenAI-compatible Chat Completions.",
  },
];

export function getRegistryEntry(id: string): ProviderRegistryEntry | undefined {
  const wanted = id.trim().toLowerCase();
  return PROVIDER_REGISTRY.find(entry => entry.id === wanted);
}

export function registryIds(): string[] {
  return PROVIDER_REGISTRY.map(entry => entry.id);
}

/**
 * Build the provider block for a registry entry.
 *
 * Keys are stored as `${VAR}` indirection rather than literal values. A router config is
 * the kind of file that gets committed, pasted into an issue, or synced between machines,
 * so a literal key here is a secret leak waiting for the first `git add .`.
 */
export function providerConfigFor(entry: ProviderRegistryEntry): ProviderConfig {
  const config: ProviderConfig = {
    adapter: entry.adapter,
    baseUrl: entry.baseUrl,
    models: [...entry.models],
  };
  if (entry.authKind === "key" && entry.envVar) {
    config.apiKey = `\${${entry.envVar}}`;
  } else {
    // Pin the mode rather than relying on `auto`. Under `auto` a stray OPENAI_API_KEY in
    // the environment would silently divert a subscription tier onto metered billing.
    config.authMode = "oauth";
  }
  return config;
}

export interface RegistryChange {
  config: ProxyConfig;
  notes: string[];
}

export class RegistryError extends Error {}

function clone(config: ProxyConfig): ProxyConfig {
  return structuredClone(config);
}

/**
 * Add a registry provider to a config, returning a new config.
 *
 * `name` overrides the config key so the same vendor can appear twice, which is what
 * makes a cheap-and-strong ladder on one vendor expressible without editing JSON.
 */
export function addProvider(
  config: ProxyConfig,
  id: string,
  options: { name?: string; env?: Record<string, string | undefined> } = {},
): RegistryChange {
  const entry = getRegistryEntry(id);
  if (!entry) {
    throw new RegistryError(
      `unknown provider "${id}". Known providers: ${registryIds().join(", ")}`,
    );
  }

  const name = (options.name ?? entry.configName).trim();
  if (!name) throw new RegistryError("provider name cannot be empty");

  const next = clone(config);
  next.providers = { ...next.providers, [name]: providerConfigFor(entry) };

  const notes = [`added "${name}" as ${entry.label}`];
  if (entry.authKind === "key" && entry.envVar) {
    const env = options.env ?? process.env;
    notes.push(
      env[entry.envVar]
        ? `  ${entry.envVar} is set in this environment`
        : `  ${entry.envVar} is NOT set; export it before serving`,
    );
  } else {
    notes.push(`  ${entry.note}`);
  }
  return { config: next, notes };
}

/**
 * Remove a provider, refusing when a ladder tier still points at it.
 *
 * Removing it anyway would produce a config that fails validation on the next start,
 * which turns a reversible edit into a broken router discovered at the worst moment.
 */
export function removeProvider(config: ProxyConfig, name: string): RegistryChange {
  if (!config.providers || !Object.hasOwn(config.providers, name)) {
    throw new RegistryError(`provider "${name}" is not configured`);
  }

  const usedBy: string[] = [];
  for (const tier of ["cheap", "strong"] as const) {
    if (config.sageRoute?.[tier]?.provider === name) usedBy.push(tier);
  }
  if (usedBy.length > 0) {
    throw new RegistryError(
      `provider "${name}" still backs the ${usedBy.join(" and ")} tier. `
      + `Point it elsewhere first: sageroute provider use <tier> <provider>/<model>`,
    );
  }

  const next = clone(config);
  const remaining = { ...next.providers };
  delete remaining[name];
  next.providers = remaining;
  return { config: next, notes: [`removed "${name}"`] };
}

/**
 * Point a ladder tier at `provider/model`.
 *
 * Pricing is carried over from the registry when the model is one it knows, because a
 * tier with no price silently disables the budget rung rather than failing loudly.
 */
export function setTier(
  config: ProxyConfig,
  tier: "cheap" | "strong",
  ref: string,
): RegistryChange {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    throw new RegistryError(`expected <provider>/<model>, got "${ref}"`);
  }
  const provider = ref.slice(0, slash).trim();
  const model = ref.slice(slash + 1).trim();

  if (!config.providers || !Object.hasOwn(config.providers, provider)) {
    throw new RegistryError(
      `provider "${provider}" is not configured. Add it first: sageroute provider add ${provider}`,
    );
  }
  if (!config.sageRoute) throw new RegistryError("config has no sageRoute block to update");

  const known = PROVIDER_REGISTRY.find(
    e => e.configName === provider && (e.models[0] === model || e.models[1] === model),
  );
  const pricing = known
    ? (known.models[0] === model ? known.pricing.cheap : known.pricing.strong)
    : undefined;

  const next = clone(config);
  next.sageRoute = {
    ...next.sageRoute,
    [tier]: { provider, model, ...(pricing ?? {}) },
  } as ProxyConfig["sageRoute"];

  const notes = [`${tier} tier is now ${provider}/${model}`];
  if (!pricing) {
    notes.push("  no list price known for this model; set inputPerMTok/outputPerMTok to use a budget");
  }
  return { config: next, notes };
}
