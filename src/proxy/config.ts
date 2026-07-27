/**
 * Proxy configuration: loading, secret indirection, and validation.
 *
 * A router that sits in front of paid APIs has to be strict about two things: it must
 * never start with a config that cannot route (a half-defined ladder is worse than no
 * router at all), and it must never require a secret to be written into a file that
 * gets committed. Hence eager whole-config validation and `${VAR}` indirection on every
 * credential field.
 */

import { readFileSync } from "node:fs";
import { sageRouteConfigIssues, type SageRouteValidationIssue } from "../core/resolve";
import { resolveSageRouteConfig, type ResolvedSageRouteConfig, type SageRouteConfig } from "../core/types";

/**
 * Wire formats SageRoute knows how to speak to an upstream.
 *
 * `openai-responses` is the native agent-harness format. `openai-chat` covers the large
 * set of vendors that expose an OpenAI-compatible Chat Completions endpoint (xAI, Kimi,
 * and most gateways). `anthropic-messages` is the one supported vendor whose wire format
 * genuinely differs, so it gets a real adapter rather than a base-URL swap.
 */
export type UpstreamAdapter = "openai-responses" | "openai-chat" | "anthropic-messages";

export const UPSTREAM_ADAPTERS: readonly UpstreamAdapter[] = [
  "openai-responses",
  "openai-chat",
  "anthropic-messages",
];

export interface ProviderConfig {
  /** Defaults to `openai-responses`, the format agent harnesses actually send. */
  adapter?: UpstreamAdapter;
  /** Base URL including the version segment, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  /** Supports `${VAR}`, `$VAR`, and `env:VAR` indirection. */
  apiKey?: string;
  /** Extra headers merged into every upstream request. */
  headers?: Record<string, string>;
  /** Advertised on `/v1/models`. Purely cosmetic; routing uses the ladder. */
  models?: string[];
  /**
   * Loopback and RFC1918 upstreams are refused unless this is set. A proxy that
   * forwards credentials is an SSRF primitive if it will talk to anything.
   */
  allowPrivateNetwork?: boolean;
  /** Upstream request timeout in ms. Default 600000 -- agent turns are long. */
  timeoutMs?: number;
}

export interface ProxyConfig {
  port: number;
  hostname: string;
  /** Optional bearer token clients must present. Supports env indirection. */
  authToken?: string;
  providers: Record<string, ProviderConfig>;
  sageRoute: SageRouteConfig;
}

export interface LoadedConfig {
  raw: ProxyConfig;
  router: ResolvedSageRouteConfig;
  authToken: string | null;
}

export class ConfigError extends Error {
  constructor(message: string, readonly issues: SageRouteValidationIssue[] = []) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Resolve `${VAR}`, `$VAR`, and `env:VAR` against the environment.
 *
 * A missing variable resolves to undefined rather than to the literal text, so a
 * forgotten export fails loudly at validation instead of being sent upstream as a
 * nonsense API key and coming back as an opaque 401.
 */
export function resolveSecret(
  value: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const braced = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(trimmed);
  if (braced) return env[braced[1]!];
  const bare = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
  if (bare) return env[bare[1]!];
  const prefixed = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
  if (prefixed) return env[prefixed[1]!];
  return trimmed;
}

const PRIVATE_HOST_PATTERN =
  /^(?:localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|\[?::1\]?|172\.(?:1[6-9]|2\d|3[01])\.)/i;

function providerIssues(
  name: string,
  provider: ProviderConfig | undefined,
  issues: SageRouteValidationIssue[],
): void {
  if (!provider || typeof provider !== "object") {
    issues.push({ path: ["providers", name], message: "provider must be an object" });
    return;
  }
  const base = typeof provider.baseUrl === "string" ? provider.baseUrl.trim() : "";
  if (!base) {
    issues.push({ path: ["providers", name, "baseUrl"], message: "baseUrl is required" });
    return;
  }
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    issues.push({ path: ["providers", name, "baseUrl"], message: `baseUrl "${base}" is not a valid URL` });
    return;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    issues.push({ path: ["providers", name, "baseUrl"], message: "baseUrl must be http or https" });
  }
  if (PRIVATE_HOST_PATTERN.test(url.hostname) && provider.allowPrivateNetwork !== true) {
    issues.push({
      path: ["providers", name, "baseUrl"],
      message: `baseUrl "${url.hostname}" is a private address; set allowPrivateNetwork: true to permit it`,
    });
  }
  if (provider.adapter !== undefined
    && !(UPSTREAM_ADAPTERS as readonly string[]).includes(provider.adapter)) {
    issues.push({
      path: ["providers", name, "adapter"],
      message: `adapter must be one of ${UPSTREAM_ADAPTERS.map(a => `"${a}"`).join(", ")}`,
    });
  }
  if (provider.apiKey !== undefined && resolveSecret(provider.apiKey) === undefined) {
    issues.push({
      path: ["providers", name, "apiKey"],
      message: `apiKey references an environment variable that is not set: ${provider.apiKey}`,
    });
  }
}

/** Validate the whole config. Returns every problem at once rather than the first. */
export function proxyConfigIssues(raw: unknown): SageRouteValidationIssue[] {
  const issues: SageRouteValidationIssue[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return [{ path: [], message: "config must be a JSON object" }];
  }
  const config = raw as Partial<ProxyConfig>;

  if (config.port !== undefined
    && (typeof config.port !== "number" || !Number.isInteger(config.port)
      || config.port < 0 || config.port > 65535)) {
    issues.push({ path: ["port"], message: "port must be an integer from 0 to 65535" });
  }

  const providers = config.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    issues.push({ path: ["providers"], message: "providers must be an object of named providers" });
  } else if (Object.keys(providers).length === 0) {
    issues.push({ path: ["providers"], message: "at least one provider is required" });
  } else {
    for (const [name, provider] of Object.entries(providers)) providerIssues(name, provider, issues);
  }

  if (!config.sageRoute) {
    issues.push({ path: ["sageRoute"], message: "sageRoute is required; this proxy exists to route" });
  } else {
    for (const issue of sageRouteConfigIssues(config.sageRoute, providers ?? {})) {
      issues.push({ path: ["sageRoute", ...issue.path], message: issue.message });
    }
  }

  return issues;
}

export function formatIssues(issues: SageRouteValidationIssue[]): string {
  return issues
    .map(issue => `  - ${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("\n");
}

/** Validate and apply defaults. Throws `ConfigError` listing every problem found. */
export function prepareConfig(raw: unknown): LoadedConfig {
  const issues = proxyConfigIssues(raw);
  if (issues.length > 0) {
    throw new ConfigError(`invalid SageRoute config:\n${formatIssues(issues)}`, issues);
  }
  const config = raw as ProxyConfig;
  const router = resolveSageRouteConfig(config.sageRoute, resolveSecret);
  return {
    raw: {
      ...config,
      port: typeof config.port === "number" ? config.port : 8787,
      hostname: typeof config.hostname === "string" && config.hostname.trim()
        ? config.hostname.trim()
        : "127.0.0.1",
    },
    router,
    authToken: resolveSecret(config.authToken) ?? null,
  };
}

export function loadConfigFile(path: string): LoadedConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read config at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`config at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return prepareConfig(parsed);
}
