import { beforeEach, describe, expect, test } from "bun:test";
import { clearSageRouteSessions } from "../src/core";
import { prepareConfig, type LoadedConfig, type ProxyConfig } from "../src/proxy/config";
import { SageRouteProxy } from "../src/proxy/server";

interface CapturedCall {
  url: string;
  body: Record<string, unknown>;
}

function rawConfig(authToken?: string): ProxyConfig {
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
      cheap: { provider: "openai", model: "cheap-model", inputPerMTok: 0.5, outputPerMTok: 1.5 },
      strong: { provider: "openai", model: "strong-model", inputPerMTok: 2, outputPerMTok: 8 },
      checkpointEvery: 1,
      firstCheckpointAt: 3,
      interventionThreshold: 0.6,
      consecutiveBadRequired: 1,
      maxSwitches: 1,
      maxRestarts: 1,
      offline: true,
    },
  };
}

function config(authToken?: string): LoadedConfig {
  return prepareConfig(rawConfig(authToken));
}

function recorder(body: Record<string, unknown> = {
  id: "resp_upstream",
  object: "response",
  model: "unused",
  output: [{
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "upstream says hi" }],
  }],
  usage: { input_tokens: 10, output_tokens: 4 },
}): { calls: CapturedCall[]; fetchImpl: typeof fetch } {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return Response.json(body);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function messagesRequest(body: unknown, headers?: HeadersInit): Request {
  return new Request("https://proxy.test/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/**
 * A Claude Code shaped turn whose evidence shows a struggling agent: the same command
 * run three times, failing every time. Enough to reach a checkpoint and escalate.
 */
function strugglingTurn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "sageroute",
    max_tokens: 4096,
    system: [{ type: "text", text: "You are a Claude agent." }],
    messages: [
      { role: "user", content: [{ type: "text", text: "fix the failing test" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "bash", input: { cmd: "bun test" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "1 failed" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t2", name: "bash", input: { cmd: "bun test" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "1 failed" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t3", name: "bash", input: { cmd: "bun test" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t3", content: "1 failed" }] },
    ],
    ...overrides,
  };
}

/** A healthy Claude Code turn: one tool call that succeeded. */
function healthyTurn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "sageroute",
    max_tokens: 4096,
    system: [{ type: "text", text: "You are a Claude agent." }],
    messages: [
      { role: "user", content: [{ type: "text", text: "add a helper function" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "h1", name: "bash", input: { cmd: "bun test" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "h1", content: "12 pass 0 fail" }] },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  clearSageRouteSessions();
});

describe("/v1/messages inbound Anthropic route", () => {
  test("routes an Anthropic-shaped turn and answers on the Anthropic wire", async () => {
    const { calls, fetchImpl } = recorder();
    const proxy = new SageRouteProxy({ config: config(), fetchImpl });

    const response = await proxy.handle(messagesRequest(healthyTurn()));
    expect(response.status).toBe(200);

    // Upstream sees a Responses request; the client never learns a translation happened.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://upstream.test/v1/responses");
    expect(calls[0]!.body.model).toBe("cheap-model");
    expect(calls[0]!.body.instructions).toBe("You are a Claude agent.");

    const body = await response.json() as Record<string, unknown>;
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.content).toEqual([{ type: "text", text: "upstream says hi" }]);
    expect(response.headers.get("x-sageroute-tier")).toBe("cheap");
  });

  test("struggle evidence recovered from the Anthropic wire escalates the model", async () => {
    const { calls, fetchImpl } = recorder();
    const proxy = new SageRouteProxy({ config: config(), fetchImpl });

    const response = await proxy.handle(messagesRequest(strugglingTurn()));

    // The whole point of the inbound adapter: a Claude Code turn is routed on what the
    // agent DID, and three identical failing commands is enough to buy a stronger model.
    expect(calls[0]!.body.model).toBe("strong-model");
    expect(response.headers.get("x-sageroute-tier")).toBe("strong");
    expect(response.headers.get("x-sageroute-action")).toBe("switch_model");
  });

  test("every task starts on the cheap tier", async () => {
    const { calls, fetchImpl } = recorder();
    const proxy = new SageRouteProxy({ config: config(), fetchImpl });

    await proxy.handle(messagesRequest({
      model: "sageroute",
      max_tokens: 512,
      messages: [{ role: "user", content: "hello" }],
    }));

    expect(calls[0]!.body.model).toBe("cheap-model");
  });

  test("tool evidence from the Anthropic wire reaches the router", async () => {
    const { calls, fetchImpl } = recorder();
    const proxy = new SageRouteProxy({ config: config(), fetchImpl });

    await proxy.handle(messagesRequest(strugglingTurn()));

    // The router only sees actions if tool blocks were flattened into the input array.
    const input = calls[0]!.body.input as Array<Record<string, unknown>>;
    expect(input.filter(item => item.type === "function_call")).toHaveLength(3);
    expect(input.filter(item => item.type === "function_call_output")).toHaveLength(3);
  });

  test("non-alias models pass through to the named provider", async () => {
    const { calls, fetchImpl } = recorder();
    const proxy = new SageRouteProxy({ config: config(), fetchImpl });

    const response = await proxy.handle(messagesRequest({
      model: "openai/other-model",
      max_tokens: 256,
      messages: [{ role: "user", content: "hi" }],
    }));

    expect(response.status).toBe(200);
    expect(calls[0]!.body.model).toBe("other-model");
    expect(response.headers.get("x-sageroute-tier")).toBeNull();
  });

  test("an unknown model is a 404 rather than a silent fallback", async () => {
    const { fetchImpl } = recorder();
    const proxy = new SageRouteProxy({ config: config(), fetchImpl });

    const response = await proxy.handle(messagesRequest({
      model: "nope/nothing",
      messages: [{ role: "user", content: "hi" }],
    }));

    expect(response.status).toBe(404);
  });

  test("accepts x-api-key, which is how Anthropic clients authenticate", async () => {
    const { fetchImpl } = recorder();
    const proxy = new SageRouteProxy({ config: config("secret"), fetchImpl });

    const rejected = await proxy.handle(messagesRequest(healthyTurn(), { "x-api-key": "wrong" }));
    expect(rejected.status).toBe(401);

    const accepted = await proxy.handle(messagesRequest(healthyTurn(), { "x-api-key": "secret" }));
    expect(accepted.status).toBe(200);
  });

  test("a streaming request answers with the Anthropic event protocol", async () => {
    const sseBody = [
      { type: "response.output_text.delta", delta: "streamed" },
      { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 1 } } },
    ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

    const fetchImpl = (async () => new Response(sseBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })) as unknown as typeof fetch;

    const proxy = new SageRouteProxy({ config: config(), fetchImpl });
    const response = await proxy.handle(messagesRequest(healthyTurn({ stream: true })));

    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain("text_delta");
    expect(text).toContain("event: message_stop");
  });

  test("an upstream error is surfaced, not buried in a synthetic assistant turn", async () => {
    const fetchImpl = (async () => Response.json(
      { error: { message: "upstream exploded" } },
      { status: 500 },
    )) as unknown as typeof fetch;

    const proxy = new SageRouteProxy({ config: config(), fetchImpl });
    const response = await proxy.handle(messagesRequest(healthyTurn()));

    expect(response.status).toBeGreaterThanOrEqual(400);
    const body = await response.json() as Record<string, unknown>;
    expect(body.error).toBeDefined();
  });
});
