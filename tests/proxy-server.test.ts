import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearSageRouteSessions,
  type SageClient,
  type SageDecision,
  type SageRouteAction,
} from "../src/core";
import { prepareConfig, type LoadedConfig, type ProxyConfig } from "../src/proxy/config";
import { SageRouteProxy } from "../src/proxy/server";

class FakeSageClient implements SageClient {
  yesnoCalls = 0;
  choiceCalls = 0;

  constructor(
    private readonly yesProbability: number,
    private readonly action: SageRouteAction,
  ) {}

  async yesno(): Promise<SageDecision> {
    this.yesnoCalls += 1;
    return {
      kind: "yesno",
      answer: this.yesProbability >= 0.5 ? "yes" : "no",
      confidence: Math.abs(this.yesProbability - 0.5) * 2,
      probabilities: { yes: this.yesProbability, no: 1 - this.yesProbability },
      latencyMs: 3,
      model: "fake-sage",
      source: "sage",
    };
  }

  async choice(): Promise<SageDecision> {
    this.choiceCalls += 1;
    return {
      kind: "choice",
      answer: this.action,
      confidence: 0.92,
      probabilities: {
        continue: this.action === "continue" ? 0.92 : 0.01,
        switch_model: this.action === "switch_model" ? 0.92 : 0.01,
        restart_clean: this.action === "restart_clean" ? 0.92 : 0.01,
        escalate_human: this.action === "escalate_human" ? 0.92 : 0.01,
      },
      latencyMs: 4,
      model: "fake-sage",
      source: "sage",
    };
  }
}

interface CapturedCall {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function rawConfig(overrides: Partial<ProxyConfig["sageRoute"]> = {}, authToken?: string): ProxyConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    ...(authToken ? { authToken } : {}),
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://upstream.test/v1",
        apiKey: "openai-key",
        models: ["cheap-model", "strong-model", "other-model"],
      },
    },
    sageRoute: {
      alias: "sageroute",
      cheap: {
        provider: "openai",
        model: "cheap-model",
        inputPerMTok: 0.5,
        outputPerMTok: 1.5,
      },
      strong: {
        provider: "openai",
        model: "strong-model",
        inputPerMTok: 2,
        outputPerMTok: 8,
      },
      checkpointEvery: 1,
      firstCheckpointAt: 3,
      interventionThreshold: 0.6,
      consecutiveBadRequired: 1,
      maxSwitches: 1,
      maxRestarts: 1,
      offline: true,
      ...overrides,
    },
  };
}

function config(overrides: Partial<ProxyConfig["sageRoute"]> = {}, authToken?: string): LoadedConfig {
  return prepareConfig(rawConfig(overrides, authToken));
}

function recorder(responseBody: Record<string, unknown> = {
  id: "resp_upstream",
  object: "response",
  model: "unused",
  output: [],
  usage: { input_tokens: 1000, output_tokens: 2000 },
}): { calls: CapturedCall[]; fetchImpl: typeof fetch } {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return Response.json(responseBody);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function request(path: string, body?: unknown, headers?: HeadersInit): Request {
  return new Request(`https://proxy.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function user(text: string): Record<string, unknown> {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

function assistant(text: string): Record<string, unknown> {
  return { type: "message", role: "assistant", content: [{ type: "output_text", text }] };
}

function call(id: string, name = "shell", args = "{}"): Record<string, unknown> {
  return { type: "function_call", call_id: id, name, arguments: args };
}

function output(id: string, text = "tests passed"): Record<string, unknown> {
  return { type: "function_call_output", call_id: id, output: text };
}

function routedBody(promptCacheKey: string, outputText = "tests passed"): Record<string, unknown> {
  return {
    model: "sageroute",
    prompt_cache_key: promptCacheKey,
    input: [
      user("fix the failing test"),
      call("call-1", "shell", "{\"cmd\":\"bun test\"}"),
      output("call-1", outputText),
      call("call-2", "shell", "{\"cmd\":\"bun test\"}"),
      output("call-2", outputText),
      call("call-3", "shell", "{\"cmd\":\"bun test\"}"),
      output("call-3", outputText),
    ],
  };
}

async function flushUsage(): Promise<void> {
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  clearSageRouteSessions();
});

describe("SageRouteProxy server endpoints", () => {
  test("/health returns ok without auth", async () => {
    const proxy = new SageRouteProxy({ config: config({}, "secret") });

    const response = await proxy.handle(request("/health"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", router: "sageroute" });
  });

  test("auth rejects missing or incorrect bearer tokens and accepts the correct token", async () => {
    const { fetchImpl } = recorder();
    const proxy = new SageRouteProxy({ config: config({}, "secret"), fetchImpl });

    expect((await proxy.handle(request("/v1/models"))).status).toBe(401);
    expect((await proxy.handle(request("/v1/models", undefined, { Authorization: "Bearer wrong" }))).status).toBe(401);

    const response = await proxy.handle(request("/v1/models", undefined, { Authorization: "Bearer secret" }));
    expect(response.status).toBe(200);
  });

  test("/v1/models lists the router alias and provider-prefixed models", async () => {
    const proxy = new SageRouteProxy({ config: config() });

    const response = await proxy.handle(request("/v1/models"));
    const body = await response.json() as { data: Array<{ id: string }> };

    expect(body.data.map(row => row.id)).toEqual([
      "sageroute",
      "openai/cheap-model",
      "openai/strong-model",
      "openai/other-model",
    ]);
  });

  test("non-alias Responses models pass through upstream without routing", async () => {
    const { calls, fetchImpl } = recorder();
    const sage = new FakeSageClient(0.99, "switch_model");
    const proxy = new SageRouteProxy({ config: config(), fetchImpl, sageClient: sage });

    const response = await proxy.handle(request("/v1/responses", {
      model: "openai/other-model",
      input: "hello",
    }));

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://upstream.test/v1/responses");
    expect(calls[0]!.body).toMatchObject({ model: "other-model", input: "hello" });
    expect(response.headers.get("x-sageroute-action")).toBeNull();
    expect(sage.yesnoCalls + sage.choiceCalls).toBe(0);
  });

  test("unknown model returns 404", async () => {
    const { calls, fetchImpl } = recorder();
    const proxy = new SageRouteProxy({ config: config(), fetchImpl });

    const response = await proxy.handle(request("/v1/responses", {
      model: "missing-provider/model",
      input: "hello",
    }));
    const body = await response.json() as { error: { type: string; message: string } };

    expect(response.status).toBe(404);
    expect(body.error.type).toBe("model_not_found");
    expect(body.error.message).toContain('unknown model "missing-provider/model"');
    expect(calls).toHaveLength(0);
  });

  test("healthy alias trajectory stays on the cheap tier", async () => {
    const { calls, fetchImpl } = recorder();
    const proxy = new SageRouteProxy({
      config: config(),
      fetchImpl,
      sageClient: new FakeSageClient(0.05, "continue"),
    });

    const response = await proxy.handle(request("/v1/responses", routedBody("healthy-proxy-test")));

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.model).toBe("cheap-model");
    expect(response.headers.get("x-sageroute-model")).toBe("openai/cheap-model");
    expect(response.headers.get("x-sageroute-tier")).toBe("cheap");
    expect(response.headers.get("x-sageroute-action")).toBe("continue");
  });

  test("failing alias trajectory escalates to the strong tier when Sage forces intervention", async () => {
    const { calls, fetchImpl } = recorder();
    const proxy = new SageRouteProxy({
      config: config(),
      fetchImpl,
      sageClient: new FakeSageClient(0.97, "switch_model"),
    });

    const response = await proxy.handle(request("/v1/responses", routedBody("failing-proxy-test", "tests failed")));

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.model).toBe("strong-model");
    expect(response.headers.get("x-sageroute-model")).toBe("openai/strong-model");
    expect(response.headers.get("x-sageroute-tier")).toBe("strong");
    expect(response.headers.get("x-sageroute-action")).toBe("switch_model");
  });

  test("escalate_human notice answers locally without calling upstream", async () => {
    const { calls, fetchImpl } = recorder();
    const proxy = new SageRouteProxy({
      config: config({ escalateHumanMode: "notice" }),
      fetchImpl,
      sageClient: new FakeSageClient(0.98, "escalate_human"),
    });

    const response = await proxy.handle(request("/v1/responses", routedBody("human-notice-test", "tests failed")));
    const body = await response.json() as { output: Array<{ content: Array<{ text: string }> }> };

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(0);
    expect(body.output[0]!.content[0]!.text).toContain("SageRoute stopped this run");
  });

  test("restart_clean trims reasoning and assistant items from forwarded input but keeps tool evidence", async () => {
    const { calls, fetchImpl } = recorder();
    const proxy = new SageRouteProxy({
      config: config({ maxSwitches: 0 }),
      fetchImpl,
      sageClient: new FakeSageClient(0.99, "restart_clean"),
    });
    const body = {
      model: "sageroute",
      prompt_cache_key: "restart-clean-test",
      input: [
        user("fix the task"),
        { type: "reasoning", encrypted_content: "drop me" },
        assistant("wrong thought"),
        call("call-1", "shell", "{\"cmd\":\"bun test\"}"),
        output("call-1", "tests failed"),
        call("call-2", "shell", "{\"cmd\":\"bun test\"}"),
        output("call-2", "tests failed"),
        call("call-3", "shell", "{\"cmd\":\"bun test\"}"),
        output("call-3", "tests failed"),
      ],
    };

    const response = await proxy.handle(request("/v1/responses", body));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-sageroute-action")).toBe("restart_clean");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.input).toEqual([
      user("fix the task"),
      call("call-1", "shell", "{\"cmd\":\"bun test\"}"),
      output("call-1", "tests failed"),
      call("call-2", "shell", "{\"cmd\":\"bun test\"}"),
      output("call-2", "tests failed"),
      call("call-3", "shell", "{\"cmd\":\"bun test\"}"),
      output("call-3", "tests failed"),
    ]);
  });

  test("/v1/sageroute/sessions reflects routing state and metered cost", async () => {
    const { fetchImpl } = recorder({
      id: "resp_cost",
      object: "response",
      model: "cheap-model",
      output: [],
      usage: { input_tokens: 1_000_000, output_tokens: 500_000 },
    });
    const proxy = new SageRouteProxy({
      config: config(),
      fetchImpl,
      sageClient: new FakeSageClient(0.05, "continue"),
    });

    const turn = await proxy.handle(request("/v1/responses", routedBody("cost-ledger-test")));
    await turn.text();
    await flushUsage();
    const sessions = await proxy.handle(request("/v1/sageroute/sessions"));
    const body = await sessions.json() as { data: Array<{ id: string; tier: string; turns: number; cost_usd: number }> };

    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: "pck:cost-ledger-test",
      tier: "cheap",
      turns: 1,
    });
    expect(body.data[0]!.cost_usd).toBeCloseTo(1.25, 6);
  });

  test("chat completions alias is rejected but non-alias chat completions pass through", async () => {
    const { calls, fetchImpl } = recorder({
      id: "chatcmpl_proxy",
      created: 1_700_000_000,
      choices: [{ message: { content: "chat ok" } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
    const proxy = new SageRouteProxy({ config: config(), fetchImpl });

    const alias = await proxy.handle(request("/v1/chat/completions", {
      model: "sageroute",
      messages: [{ role: "user", content: "hello" }],
    }));
    const aliasBody = await alias.json() as { error: { message: string } };
    expect(alias.status).toBe(400);
    expect(aliasBody.error.message).toContain("requires the /v1/responses endpoint");
    expect(calls).toHaveLength(0);

    const nonAlias = await proxy.handle(request("/v1/chat/completions", {
      model: "openai/other-model",
      messages: [{ role: "user", content: "hello" }],
    }));
    const nonAliasBody = await nonAlias.json() as Record<string, unknown>;

    expect(nonAlias.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://upstream.test/v1/chat/completions");
    expect(calls[0]!.body).toMatchObject({ model: "other-model", messages: [{ role: "user", content: "hello" }] });
    expect(nonAliasBody).toMatchObject({
      object: "response",
      model: "other-model",
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    });
  });
});
