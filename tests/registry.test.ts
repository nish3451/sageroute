import { describe, expect, test } from "bun:test";
import {
  addProvider,
  getRegistryEntry,
  PROVIDER_REGISTRY,
  providerConfigFor,
  RegistryError,
  registryIds,
  removeProvider,
  setTier,
} from "../src/registry";
import { proxyConfigIssues, type ProxyConfig } from "../src/proxy/config";

/**
 * A config with one provider that is fully credentialed, so a registry edit is the only
 * thing under test. A literal apiKey is used rather than `${VAR}` indirection because the
 * fixture must not depend on which variables happen to be exported in the test shell.
 */
function baseConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    providers: {
      base: {
        baseUrl: "https://base.upstream.test/v1",
        apiKey: "base-key",
        models: ["base-cheap", "base-strong"],
      },
    },
    sageRoute: {
      alias: "sageroute",
      cheap: { provider: "base", model: "base-cheap", inputPerMTok: 0.1, outputPerMTok: 0.2 },
      strong: { provider: "base", model: "base-strong", inputPerMTok: 1, outputPerMTok: 2 },
      offline: true,
    },
    ...overrides,
  };
}

describe("provider registry table", () => {
  test("ids are unique and every entry carries what a config block needs", () => {
    expect(new Set(registryIds()).size).toBe(PROVIDER_REGISTRY.length);

    for (const entry of PROVIDER_REGISTRY) {
      expect(entry.models).toHaveLength(2);
      expect(entry.models[0]).not.toBe(entry.models[1]);
      expect(() => new URL(entry.baseUrl)).not.toThrow();
      // A key entry with no envVar would write a provider with no credential at all,
      // which validates and then fails on the first request.
      if (entry.authKind === "key") expect(entry.envVar).toBeTruthy();
    }
  });

  test("lookup is case and whitespace tolerant, and unknown ids return undefined", () => {
    expect(getRegistryEntry("  KIMI ")?.id).toBe("kimi");
    expect(getRegistryEntry("nope")).toBeUndefined();
  });

  test("the same vendor is reachable under both subscription and key entries", () => {
    // Not cosmetic: a ChatGPT subscription token is rejected by the metered host, so the
    // two entries must differ by base URL or one of them cannot work.
    const oauth = getRegistryEntry("openai")!;
    const keyed = getRegistryEntry("openai-api")!;
    expect(oauth.configName).toBe(keyed.configName);
    expect(oauth.baseUrl).not.toBe(keyed.baseUrl);
  });
});

describe("providerConfigFor", () => {
  test("keys are written as env indirection, never as literal secrets", () => {
    for (const entry of PROVIDER_REGISTRY) {
      const config = providerConfigFor(entry);
      if (entry.authKind !== "key") continue;
      // A router config gets committed, pasted into issues, and synced between machines.
      expect(config.apiKey).toBe(`\${${entry.envVar}}`);
      expect(config.apiKey).not.toContain(process.env[entry.envVar!] ?? "\u0000never");
    }
  });

  test("subscription entries pin oauth and carry no key", () => {
    for (const entry of PROVIDER_REGISTRY) {
      if (entry.authKind !== "subscription") continue;
      const config = providerConfigFor(entry);
      // Under "auto" a stray OPENAI_API_KEY would silently divert a subscription tier
      // onto metered billing, which is a bill rather than an error.
      expect(config.authMode).toBe("oauth");
      expect(config.apiKey).toBeUndefined();
    }
  });
});

describe("addProvider", () => {
  test("adds a provider without mutating the input config", () => {
    const config = baseConfig();
    const change = addProvider(config, "kimi", { env: { KIMI_API_KEY: "set" } });

    expect(Object.keys(change.config.providers)).toEqual(["base", "kimi"]);
    expect(change.config.providers.kimi!.adapter).toBe("openai-chat");
    // The caller keeps the pre-edit config as the "before" side of delta validation, so
    // an in-place mutation here would make every edit look like it changed nothing.
    expect(Object.keys(config.providers)).toEqual(["base"]);
  });

  test("reports whether the required variable is exported, without reading it", () => {
    const set = addProvider(baseConfig(), "xai", { env: { XAI_API_KEY: "secret-value" } });
    expect(set.notes.join("\n")).toContain("XAI_API_KEY is set");
    expect(set.notes.join("\n")).not.toContain("secret-value");

    const unset = addProvider(baseConfig(), "xai", { env: {} });
    expect(unset.notes.join("\n")).toContain("XAI_API_KEY is NOT set");
  });

  test("--name lets one vendor back both rungs under separate keys", () => {
    const change = addProvider(baseConfig(), "kimi", { name: "kimi-strong", env: {} });
    expect(change.config.providers["kimi-strong"]).toBeDefined();
    expect(change.config.providers.kimi).toBeUndefined();
  });

  test("unknown ids are refused with the list of known ids", () => {
    expect(() => addProvider(baseConfig(), "nope")).toThrow(RegistryError);
    expect(() => addProvider(baseConfig(), "nope")).toThrow(/known providers/i);
    expect(() => addProvider(baseConfig(), "kimi", { name: "  " })).toThrow(RegistryError);
  });
});

describe("removeProvider", () => {
  test("removes an unused provider and refuses one a tier still names", () => {
    const added = addProvider(baseConfig(), "kimi", { env: {} }).config;
    expect(Object.keys(removeProvider(added, "kimi").config.providers)).toEqual(["base"]);

    // Removing anyway yields a config that fails at the next start, which converts a
    // reversible edit into a broken router discovered at the worst moment.
    expect(() => removeProvider(added, "base")).toThrow(/still backs the cheap and strong tier/);
    expect(() => removeProvider(added, "absent")).toThrow(/not configured/);
  });
});

describe("setTier", () => {
  test("repointing a tier carries registry pricing across and frees the old provider", () => {
    const added = addProvider(baseConfig(), "kimi", { env: {} }).config;
    const change = setTier(added, "cheap", "kimi/kimi-k2.5");

    expect(change.config.sageRoute.cheap).toMatchObject({
      provider: "kimi",
      model: "kimi-k2.5",
      inputPerMTok: getRegistryEntry("kimi")!.pricing.cheap.inputPerMTok,
    });
    expect(change.config.sageRoute.strong.provider).toBe("base");
  });

  test("an unknown model is allowed but warns, because a priceless tier disables budgets", () => {
    const change = setTier(baseConfig(), "strong", "base/some-new-model");
    expect(change.config.sageRoute.strong.model).toBe("some-new-model");
    expect(change.config.sageRoute.strong.inputPerMTok).toBeUndefined();
    expect(change.notes.join("\n")).toContain("no list price known");
  });

  test("malformed refs and unconfigured providers are refused", () => {
    for (const ref of ["kimi", "/kimi-k2.5", "kimi/"]) {
      expect(() => setTier(baseConfig(), "cheap", ref)).toThrow(/expected <provider>\/<model>/);
    }
    expect(() => setTier(baseConfig(), "cheap", "kimi/kimi-k2.5")).toThrow(/add it first/i);
  });
});

describe("registry edits under config validation", () => {
  test("an added key provider is valid once its variable is exported", () => {
    const change = addProvider(baseConfig(), "kimi", { env: {} });
    const saved = process.env.KIMI_API_KEY;
    process.env.KIMI_API_KEY = "test-value";
    try {
      expect(proxyConfigIssues(change.config)).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.KIMI_API_KEY;
      else process.env.KIMI_API_KEY = saved;
    }
  });

  test("a missing variable is tagged env-not-set rather than only described in prose", () => {
    // Regression: `provider add kimi` is the command that first names KIMI_API_KEY, so a
    // CLI that treats the unset variable as a broken edit makes the documented setup flow
    // impossible. The CLI defers it by code, so the tag has to survive.
    const change = addProvider(baseConfig(), "kimi", { env: {} });
    const saved = process.env.KIMI_API_KEY;
    delete process.env.KIMI_API_KEY;
    try {
      const issues = proxyConfigIssues(change.config);
      expect(issues).toHaveLength(1);
      expect(issues[0]!.code).toBe("env-not-set");
      expect(issues[0]!.path).toEqual(["providers", "kimi", "apiKey"]);
    } finally {
      if (saved !== undefined) process.env.KIMI_API_KEY = saved;
    }
  });

  test("a subscription add stays valid with no key exported at all", () => {
    const change = addProvider(baseConfig(), "anthropic", { env: {} });
    expect(proxyConfigIssues(change.config)).toEqual([]);
  });
});
