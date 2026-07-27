import { describe, expect, test } from "bun:test";
import {
  ConfigError,
  prepareConfig,
  proxyConfigIssues,
  resolveSecret,
  type ProxyConfig,
} from "../src/proxy/config";

function validConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    providers: {
      cheap: {
        baseUrl: "https://cheap.upstream.test/v1",
        apiKey: "cheap-key",
        models: ["cheap-model"],
      },
      strong: {
        baseUrl: "https://strong.upstream.test/v1",
        apiKey: "strong-key",
        models: ["strong-model"],
      },
    },
    sageRoute: {
      alias: "sageroute",
      cheap: {
        provider: "cheap",
        model: "cheap-model",
        inputPerMTok: 0.1,
        outputPerMTok: 0.2,
      },
      strong: {
        provider: "strong",
        model: "strong-model",
        inputPerMTok: 1,
        outputPerMTok: 2,
      },
      offline: true,
    },
    ...overrides,
  };
}

function issueText(raw: unknown): string {
  return proxyConfigIssues(raw).map(issue => `${issue.path.join(".")}: ${issue.message}`).join("\n");
}

describe("proxy config secrets", () => {
  test("resolveSecret supports env indirection forms, literals, blanks, and missing variables", () => {
    const env = {
      BRACED: "braced-value",
      BARE: "bare-value",
      PREFIXED: "prefixed-value",
    };

    expect(resolveSecret("${BRACED}", env)).toBe("braced-value");
    expect(resolveSecret("$BARE", env)).toBe("bare-value");
    expect(resolveSecret("env:PREFIXED", env)).toBe("prefixed-value");
    expect(resolveSecret(" literal-token ", env)).toBe("literal-token");
    expect(resolveSecret("${MISSING}", env)).toBeUndefined();
    expect(resolveSecret("$MISSING", env)).toBeUndefined();
    expect(resolveSecret("env:MISSING", env)).toBeUndefined();
    expect(resolveSecret("", env)).toBeUndefined();
    expect(resolveSecret(undefined, env)).toBeUndefined();
  });
});

describe("proxy config validation", () => {
  test("rejects missing providers and empty provider maps", () => {
    expect(issueText({ sageRoute: validConfig().sageRoute })).toContain(
      "providers: providers must be an object of named providers",
    );
    expect(issueText(validConfig({ providers: {} }))).toContain("providers: at least one provider is required");
  });

  test("rejects malformed base URLs", () => {
    expect(issueText(validConfig({
      providers: {
        cheap: { baseUrl: "not a url" },
        strong: { baseUrl: "https://strong.upstream.test/v1" },
      },
    }))).toContain('providers.cheap.baseUrl: baseUrl "not a url" is not a valid URL');

    expect(issueText(validConfig({
      providers: {
        cheap: { baseUrl: "ftp://cheap.upstream.test/v1" },
        strong: { baseUrl: "https://strong.upstream.test/v1" },
      },
    }))).toContain("providers.cheap.baseUrl: baseUrl must be http or https");
  });

  test("rejects private-network upstreams unless explicitly allowed", () => {
    expect(issueText(validConfig({
      providers: {
        cheap: { baseUrl: "https://127.0.0.1/v1" },
        strong: { baseUrl: "https://strong.upstream.test/v1" },
      },
    }))).toContain("private address; set allowPrivateNetwork: true");

    const allowed = validConfig({
      providers: {
        cheap: { baseUrl: "http://localhost:8080/v1", allowPrivateNetwork: true },
        strong: { baseUrl: "https://strong.upstream.test/v1" },
      },
    });
    expect(proxyConfigIssues(allowed)).toEqual([]);
  });

  test("rejects unknown upstream adapters", () => {
    expect(issueText(validConfig({
      providers: {
        cheap: { baseUrl: "https://cheap.upstream.test/v1", adapter: "bad-adapter" as never },
        strong: { baseUrl: "https://strong.upstream.test/v1" },
      },
    }))).toContain(
      'providers.cheap.adapter: adapter must be one of '
      + '"openai-responses", "openai-chat", "anthropic-messages"',
    );
  });

  test("accepts every supported upstream adapter", () => {
    for (const adapter of ["openai-responses", "openai-chat", "anthropic-messages"] as const) {
      expect(proxyConfigIssues(validConfig({
        providers: {
          cheap: { baseUrl: "https://cheap.upstream.test/v1", adapter },
          strong: { baseUrl: "https://strong.upstream.test/v1" },
        },
      }))).toEqual([]);
    }
  });

  test("rejects unset apiKey environment references", () => {
    expect(issueText(validConfig({
      providers: {
        cheap: { baseUrl: "https://cheap.upstream.test/v1", apiKey: "env:SAGEROUTE_TEST_KEY_SHOULD_NOT_EXIST" },
        strong: { baseUrl: "https://strong.upstream.test/v1" },
      },
    }))).toContain(
      "providers.cheap.apiKey: apiKey references an environment variable that is not set: "
      + "env:SAGEROUTE_TEST_KEY_SHOULD_NOT_EXIST",
    );
  });

  test("rejects configs without sageRoute and ladders whose cheap and strong tiers are identical", () => {
    expect(issueText({ providers: validConfig().providers })).toContain(
      "sageRoute: sageRoute is required; this proxy exists to route",
    );

    expect(issueText(validConfig({
      sageRoute: {
        cheap: { provider: "cheap", model: "same-model" },
        strong: { provider: "cheap", model: "same-model" },
      },
    }))).toContain("sageRoute.strong: strong must differ from cheap; a ladder with one rung cannot escalate");
  });

  test("prepareConfig throws ConfigError with validation issues", () => {
    expect(() => prepareConfig({ providers: {} })).toThrow(ConfigError);
    try {
      prepareConfig({ providers: {} });
      throw new Error("prepareConfig should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).issues.length).toBeGreaterThan(0);
    }
  });

  test("prepareConfig applies proxy and router defaults", () => {
    const loaded = prepareConfig({
      providers: {
        cheap: { baseUrl: "https://cheap.upstream.test/v1" },
        strong: { baseUrl: "https://strong.upstream.test/v1" },
      },
      sageRoute: {
        cheap: { provider: "cheap", model: "cheap-model" },
        strong: { provider: "strong", model: "strong-model" },
      },
    });

    expect(loaded.raw.port).toBe(8787);
    expect(loaded.raw.hostname).toBe("127.0.0.1");
    expect(loaded.authToken).toBeNull();
    expect(loaded.router).toMatchObject({
      alias: "sageroute",
      endpoint: "https://sage.levanto.ai",
      apiKey: null,
      checkpointEvery: 3,
      firstCheckpointAt: 3,
      interventionThreshold: 0.6,
      consecutiveBadRequired: 2,
      maxSwitches: 1,
      maxRestarts: 1,
      budgetUsd: 0,
      budgetEscalateFraction: 0.85,
      offline: false,
      timeoutMs: 8000,
      escalateHumanMode: "notice",
    });
    expect(loaded.router.cheap).toEqual({
      provider: "cheap",
      model: "cheap-model",
      inputPerMTok: 0.25,
      outputPerMTok: 2,
    });
    expect(loaded.router.strong).toEqual({
      provider: "strong",
      model: "strong-model",
      inputPerMTok: 1.25,
      outputPerMTok: 10,
    });
  });
});
