import { describe, expect, test } from "bun:test";
import { configFromPlan, planInit } from "../src/init";
import { prepareConfig, resolveAuthMode } from "../src/proxy/config";

const NO_ENV: Record<string, string | undefined> = {};

/**
 * Validate a generated config under the same environment it was planned for.
 *
 * `planInit` takes an injected env, but config validation reads `process.env`, so a
 * generated config has to be checked against the real variables it references or the
 * assertion tests the harness rather than the product.
 */
function expectValidUnder(env: Record<string, string | undefined>, config: ReturnType<typeof configFromPlan>): void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    expect(() => prepareConfig({
      ...config,
      sageRoute: { ...config.sageRoute, apiKey: undefined, offline: true },
    })).not.toThrow();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("init planning", () => {
  test("a config generated with no credentials is still valid JSON with a real ladder", () => {
    const plan = planInit({ logins: [], env: NO_ENV });
    const config = configFromPlan(plan);

    expect(plan.notes.join(" ")).toContain("no credentials detected");
    expect(config.sageRoute.cheap.model).not.toBe(config.sageRoute.strong.model);
    expect(Object.keys(config.providers).length).toBeGreaterThan(0);
  });

  test("a detected API key produces a config that passes validation unchanged", () => {
    const env = { OPENAI_API_KEY: "sk-live" };
    const plan = planInit({ logins: [], env });

    expect(plan.notes.join(" ")).toContain("OPENAI_API_KEY");
    // prepareConfig throws on any validation issue, so this asserts a clean first run.
    expectValidUnder(env, configFromPlan(plan));
  });

  test("both subscriptions build a cross-vendor ladder that resolves to OAuth", () => {
    const plan = planInit({ logins: ["openai", "anthropic"], env: NO_ENV });
    const config = configFromPlan(plan);

    expect(plan.cheap.provider).toBe("openai");
    expect(plan.strong.provider).toBe("anthropic");
    // A subscription turn is not separately billed, so the budget rung is left inert.
    expect(plan.cheap.inputPerMTok).toBe(0);

    for (const [name, provider] of Object.entries(config.providers)) {
      expect(provider.apiKey).toBeUndefined();
      expect(resolveAuthMode(name, provider, NO_ENV)).toBe("oauth");
    }
  });

  test("an OpenAI subscription is pointed at the ChatGPT backend, never the metered host", () => {
    const config = configFromPlan(planInit({ logins: ["openai"], env: NO_ENV }));
    const openai = config.providers.openai!;

    expect(openai.baseUrl).toBe("https://chatgpt.com/backend-api/codex");
    // Aimed at api.openai.com the token would be refused, so this must resolve to OAuth.
    expect(resolveAuthMode("openai", openai, NO_ENV)).toBe("oauth");
  });

  test("a subscription is preferred over an API key for the same provider", () => {
    const plan = planInit({ logins: ["anthropic"], env: { ANTHROPIC_API_KEY: "sk-ant" } });
    expect(plan.notes.join(" ")).toContain("subscription");
    expect(plan.providers.anthropic?.apiKey).toBeUndefined();
  });

  test("every generated config passes validation for its own credential situation", () => {
    const cases: Array<{ logins: Array<"openai" | "anthropic">; env: Record<string, string | undefined> }> = [
      { logins: ["openai", "anthropic"], env: NO_ENV },
      { logins: ["anthropic"], env: NO_ENV },
      { logins: ["openai"], env: NO_ENV },
      { logins: [], env: { OPENAI_API_KEY: "sk-live" } },
      { logins: [], env: { ANTHROPIC_API_KEY: "sk-ant" } },
    ];

    for (const { logins, env } of cases) {
      expectValidUnder(env, configFromPlan(planInit({ logins, env })));
    }
  });
});
