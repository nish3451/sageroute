import { describe, expect, test } from "bun:test";
import {
  CHATGPT_SUBSCRIPTION_BASE_URL,
  proxyConfigIssues,
  resolveAuthMode,
  type ProviderConfig,
} from "../src/proxy/config";

const NO_ENV: Record<string, string | undefined> = {};

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return { baseUrl: "https://api.anthropic.com/v1", ...overrides };
}

function issueText(raw: unknown): string {
  return proxyConfigIssues(raw).map(i => `${i.path.join(".")}: ${i.message}`).join("\n");
}

function configWith(providers: Record<string, ProviderConfig>): Record<string, unknown> {
  const names = Object.keys(providers);
  return {
    providers,
    sageRoute: {
      enabled: true,
      cheap: { provider: names[0], model: "cheap-model" },
      strong: { provider: names[1] ?? names[0], model: "strong-model" },
      offline: true,
    },
  };
}

describe("auto auth mode precedence", () => {
  test("defaults to OAuth when a provider has a login flow and no key", () => {
    expect(resolveAuthMode("anthropic", provider(), NO_ENV)).toBe("oauth");
    expect(resolveAuthMode(
      "openai",
      provider({ baseUrl: CHATGPT_SUBSCRIPTION_BASE_URL }),
      NO_ENV,
    )).toBe("oauth");
  });

  test("an explicitly configured key wins over a subscription", () => {
    // Someone who set a key meant to use it; quietly spending their plan instead
    // would be a surprise in the wrong direction.
    expect(resolveAuthMode("anthropic", provider({ apiKey: "sk-live" }), NO_ENV)).toBe("key");
    expect(resolveAuthMode(
      "anthropic",
      provider({ apiKey: "${ANTHROPIC_API_KEY}" }),
      { ANTHROPIC_API_KEY: "sk-from-env" },
    )).toBe("key");
  });

  test("an apiKey pointing at an unset variable falls through to OAuth", () => {
    expect(resolveAuthMode("anthropic", provider({ apiKey: "${MISSING_VAR}" }), NO_ENV)).toBe("oauth");
  });

  test("providers without a login flow stay on keys", () => {
    expect(resolveAuthMode("xai", provider({ baseUrl: "https://api.x.ai/v1" }), NO_ENV)).toBe("key");
    expect(resolveAuthMode("kimi", provider({ baseUrl: "https://api.moonshot.ai/v1" }), NO_ENV)).toBe("key");
  });

  test("a ChatGPT subscription is not attempted against the metered API host", () => {
    expect(resolveAuthMode("openai", provider({ baseUrl: "https://api.openai.com/v1" }), NO_ENV)).toBe("key");
  });

  test("an explicit mode is always honored over the automatic choice", () => {
    expect(resolveAuthMode("anthropic", provider({ authMode: "key" }), NO_ENV)).toBe("key");
    expect(resolveAuthMode(
      "anthropic",
      provider({ authMode: "oauth", apiKey: "sk-live" }),
      NO_ENV,
    )).toBe("oauth");
  });
});

describe("auto auth mode validation", () => {
  test("a keyless OAuth-capable provider validates with no config changes", () => {
    expect(proxyConfigIssues(configWith({
      anthropic: provider(),
      openai: provider({ baseUrl: CHATGPT_SUBSCRIPTION_BASE_URL }),
    }))).toEqual([]);
  });

  test("an existing keyed config still validates unchanged", () => {
    expect(proxyConfigIssues(configWith({
      anthropic: provider({ apiKey: "sk-a" }),
      xai: provider({ baseUrl: "https://api.x.ai/v1", apiKey: "sk-b" }),
    }))).toEqual([]);
  });

  test("an unset key is still fatal when no subscription can cover the tier", () => {
    expect(issueText(configWith({
      xai: provider({ baseUrl: "https://api.x.ai/v1", apiKey: "${SAGEROUTE_MISSING_KEY}" }),
      kimi: provider({ baseUrl: "https://api.moonshot.ai/v1" }),
    }))).toContain("apiKey references an environment variable that is not set");
  });

  test("an unset key is tolerated when a subscription login can cover the tier", () => {
    expect(proxyConfigIssues(configWith({
      anthropic: provider({ apiKey: "${SAGEROUTE_MISSING_KEY}" }),
      xai: provider({ baseUrl: "https://api.x.ai/v1", apiKey: "sk-b" }),
    }))).toEqual([]);
  });

  test("explicit oauth against the metered OpenAI host is rejected with the fix", () => {
    const text = issueText(configWith({
      openai: provider({ baseUrl: "https://api.openai.com/v1", authMode: "oauth" }),
      xai: provider({ baseUrl: "https://api.x.ai/v1", apiKey: "sk-b" }),
    }));
    expect(text).toContain("not accepted at api.openai.com");
    expect(text).toContain(CHATGPT_SUBSCRIPTION_BASE_URL);
  });

  test("an unknown authMode is reported with the supported set", () => {
    expect(issueText(configWith({
      anthropic: provider({ authMode: "sso" as never }),
      xai: provider({ baseUrl: "https://api.x.ai/v1", apiKey: "sk-b" }),
    }))).toContain('authMode must be one of "auto", "key", "oauth"');
  });
});
