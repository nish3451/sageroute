import { describe, expect, test } from "bun:test";
import {
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  ANTHROPIC_VERSION,
  anthropicStreamToResponses,
  anthropicToResponses,
  readAnthropicUsage,
  responsesToAnthropic,
} from "../src/proxy/anthropic";
import {
  dispatchUpstream,
  type TurnUsage,
  type UpstreamRequest,
} from "../src/proxy/upstream";

function streamFrom(text: string): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
}

function sseData(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter(line => line.startsWith("data:"))
    .map(line => JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
}

function baseRequest(overrides: Partial<UpstreamRequest> = {}): UpstreamRequest {
  return {
    provider: "anthropic",
    config: {
      adapter: "anthropic-messages",
      baseUrl: "https://anthropic.upstream.test/v1",
      apiKey: "configured-key",
    },
    model: "claude-sonnet",
    body: {
      model: "sageroute",
      input: "hello",
    },
    stream: false,
    ...overrides,
  };
}

function anthropicSse(): string {
  return [
    "event: message_start",
    "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"usage\":{\"input_tokens\":17}}}",
    "",
    "event: content_block_delta",
    "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hel\"}}",
    "",
    "event: content_block_delta",
    "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"lo\"}}",
    "",
    "event: message_delta",
    "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":5}}",
    "",
    "event: message_stop",
    "data: {\"type\":\"message_stop\"}",
    "",
  ].join("\n");
}

describe("Anthropic usage parsing", () => {
  test("readAnthropicUsage accepts present, partially absent, and missing usage", () => {
    expect(readAnthropicUsage({ usage: { input_tokens: 11, output_tokens: 7 } })).toEqual({
      inputTokens: 11,
      outputTokens: 7,
    });
    expect(readAnthropicUsage({ usage: { input_tokens: 13 } })).toEqual({
      inputTokens: 13,
      outputTokens: 0,
    });
    expect(readAnthropicUsage({ output_tokens: 5 })).toEqual({
      inputTokens: 0,
      outputTokens: 5,
    });
    expect(readAnthropicUsage({ usage: { total_tokens: 99 } })).toBeNull();
    expect(readAnthropicUsage(null)).toBeNull();
  });
});

describe("Responses and Anthropic wire translation", () => {
  test("responsesToAnthropic maps instructions, messages, tool blocks, tools, and options", () => {
    const request = responsesToAnthropic({
      instructions: "You are terse.",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Fix it" }] },
        { type: "reasoning", encrypted_content: "vendor-private" },
        {
          type: "function_call",
          call_id: "call-1",
          name: "shell",
          arguments: "{\"cmd\":\"bun test\",\"attempt\":1}",
        },
        {
          type: "function_call",
          call_id: "call-bad",
          name: "bad_args",
          arguments: "{not json",
        },
        {
          type: "function_call_output",
          call_id: "call-1",
          output: [{ type: "output_text", text: "tests failed" }],
        },
        {
          type: "function_call_output",
          call_id: "call-2",
          output: "lint failed",
        },
        { type: "message", role: "system", content: [{ type: "input_text", text: "Use CI evidence." }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "I will patch it." }] },
      ],
      stream: true,
      temperature: 0.2,
      top_p: 0.9,
      max_output_tokens: 512,
      tools: [
        {
          type: "function",
          name: "shell",
          description: "run a command",
          parameters: { type: "object", properties: { cmd: { type: "string" } } },
        },
        {
          type: "function",
          function: {
            name: "lookup",
            description: "read docs",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ],
    }, "claude-sonnet");

    expect(request).toMatchObject({
      model: "claude-sonnet",
      system: "You are terse.\n\nUse CI evidence.",
      max_tokens: 512,
      stream: true,
      temperature: 0.2,
      top_p: 0.9,
    });
    expect(request.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Fix it" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call-1", name: "shell", input: { cmd: "bun test", attempt: 1 } },
          { type: "tool_use", id: "call-bad", name: "bad_args", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call-1", content: "tests failed" },
          { type: "tool_result", tool_use_id: "call-2", content: "lint failed" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "I will patch it." }] },
    ]);
    expect(request.tools).toEqual([
      {
        name: "shell",
        description: "run a command",
        input_schema: { type: "object", properties: { cmd: { type: "string" } } },
      },
      {
        name: "lookup",
        description: "read docs",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
  });

  test("responsesToAnthropic maps string and absent input to required user messages with default max tokens", () => {
    const stringInput = responsesToAnthropic({ input: "hello" }, "claude-haiku");
    const emptyInput = responsesToAnthropic({}, "claude-haiku");

    expect(stringInput).toMatchObject({
      model: "claude-haiku",
      max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
    });
    expect(stringInput.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
    expect(emptyInput.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "" }] },
    ]);
  });

  test("anthropicToResponses maps text, tool use, usage, and empty replies", () => {
    const mixed = anthropicToResponses({
      id: "msg_123",
      content: [
        { type: "text", text: "Need " },
        { type: "tool_use", id: "toolu_1", name: "search", input: { q: "docs" } },
        { type: "text", text: "data." },
      ],
      usage: { input_tokens: 21, output_tokens: 8 },
    }, "claude-sonnet");
    const empty = anthropicToResponses({
      id: "msg_empty",
      content: [],
    }, "claude-sonnet");

    expect(mixed).toMatchObject({
      id: "msg_123",
      object: "response",
      model: "claude-sonnet",
      status: "completed",
      usage: {
        input_tokens: 21,
        output_tokens: 8,
        total_tokens: 29,
      },
    });
    expect(mixed.output).toEqual([
      {
        type: "function_call",
        call_id: "toolu_1",
        name: "search",
        arguments: "{\"q\":\"docs\"}",
      },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Need data." }],
      },
    ]);
    expect(empty.output).toEqual([
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "" }],
      },
    ]);
  });

  test("anthropicStreamToResponses translates text deltas and settles split usage", async () => {
    let settled: TurnUsage | undefined;
    const stream = anthropicStreamToResponses(streamFrom(anthropicSse()), "claude-sonnet", usage => {
      settled = usage;
    });

    const clientBody = await new Response(stream).text();
    const events = sseData(clientBody);
    const deltas = events.filter(event => event.type === "response.output_text.delta");
    const completed = events.find(event => event.type === "response.completed");
    const response = completed?.response as Record<string, unknown>;

    expect(events[0]?.type).toBe("response.created");
    expect(deltas.map(event => event.delta)).toEqual(["hel", "lo"]);
    expect(response).toMatchObject({
      object: "response",
      model: "claude-sonnet",
      status: "completed",
      usage: {
        input_tokens: 17,
        output_tokens: 5,
        total_tokens: 22,
      },
    });
    expect(response.output).toEqual([
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "hello" }],
      },
    ]);
    expect(settled).toEqual({ inputTokens: 17, outputTokens: 5 });
  });
});

describe("dispatchUpstream with Anthropic", () => {
  test("sends Anthropic requests to /messages with vendor auth headers only", async () => {
    let seenAnthropicUrl = "";
    let seenAnthropicInit: RequestInit | undefined;
    const anthropicFetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      seenAnthropicUrl = String(url);
      seenAnthropicInit = init;
      return Response.json({
        id: "msg_1",
        content: [{ type: "text", text: "done" }],
        usage: { input_tokens: 3, output_tokens: 2 },
      });
    }) as unknown as typeof fetch;

    await dispatchUpstream(baseRequest(), "runtime-key", anthropicFetch);

    const anthropicHeaders = new Headers(seenAnthropicInit?.headers);
    expect(seenAnthropicUrl).toBe("https://anthropic.upstream.test/v1/messages");
    expect(seenAnthropicInit?.method).toBe("POST");
    expect(anthropicHeaders.get("x-api-key")).toBe("runtime-key");
    expect(anthropicHeaders.get("anthropic-version")).toBe(ANTHROPIC_VERSION);
    expect(anthropicHeaders.get("authorization")).toBeNull();

    let seenOpenAiInit: RequestInit | undefined;
    const openAiFetch = (async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      seenOpenAiInit = init;
      return Response.json({
        id: "resp_1",
        model: "gpt-cheap",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as unknown as typeof fetch;

    await dispatchUpstream(baseRequest({
      provider: "openai",
      config: {
        adapter: "openai-responses",
        baseUrl: "https://openai.upstream.test/v1",
      },
      model: "gpt-cheap",
    }), "runtime-key", openAiFetch);

    const openAiHeaders = new Headers(seenOpenAiInit?.headers);
    expect(openAiHeaders.get("authorization")).toBe("Bearer runtime-key");
    expect(openAiHeaders.get("x-api-key")).toBeNull();
  });

  test("converts non-streaming Anthropic replies to Responses and resolves usage", async () => {
    let seenPayload: Record<string, unknown> = {};
    const fetchImpl = (async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      seenPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        id: "msg_2",
        content: [{ type: "text", text: "patched" }],
        usage: { input_tokens: 34, output_tokens: 13 },
      });
    }) as unknown as typeof fetch;

    const result = await dispatchUpstream(baseRequest({
      body: {
        instructions: "system note",
        input: [{ type: "message", role: "user", content: "hello" }],
      },
    }), null, fetchImpl);
    const body = await result.response.json() as Record<string, unknown>;

    expect(seenPayload).toMatchObject({
      model: "claude-sonnet",
      system: "system note",
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
      max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
    });
    expect(body).toMatchObject({
      id: "msg_2",
      object: "response",
      model: "claude-sonnet",
      status: "completed",
      usage: {
        input_tokens: 34,
        output_tokens: 13,
        total_tokens: 47,
      },
    });
    expect(body.output).toEqual([
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "patched" }],
      },
    ]);
    expect(await result.usage).toEqual({ inputTokens: 34, outputTokens: 13 });
  });

  test("converts streaming Anthropic replies to Responses SSE and resolves usage", async () => {
    const fetchImpl = (async () => new Response(streamFrom(anthropicSse()), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })) as unknown as typeof fetch;

    const result = await dispatchUpstream(baseRequest({
      stream: true,
      body: { input: "hello", stream: true },
    }), null, fetchImpl);
    const clientBody = await result.response.text();
    const events = sseData(clientBody);
    const deltas = events.filter(event => event.type === "response.output_text.delta");
    const completed = events.find(event => event.type === "response.completed");
    const response = completed?.response as Record<string, unknown>;

    expect(result.response.headers.get("content-type")).toContain("text/event-stream");
    expect(events[0]?.type).toBe("response.created");
    expect(deltas.map(event => event.delta)).toEqual(["hel", "lo"]);
    expect(response).toMatchObject({
      model: "claude-sonnet",
      usage: {
        input_tokens: 17,
        output_tokens: 5,
        total_tokens: 22,
      },
    });
    expect(await result.usage).toEqual({ inputTokens: 17, outputTokens: 5 });
  });

  test("passes through non-OK Anthropic status and body", async () => {
    const fetchImpl = (async () => new Response("anthropic says no", {
      status: 529,
      headers: { "Content-Type": "text/plain" },
    })) as unknown as typeof fetch;

    const result = await dispatchUpstream(baseRequest(), "runtime-key", fetchImpl);

    expect(result.response.status).toBe(529);
    expect(result.response.headers.get("content-type")).toBe("text/plain");
    expect(await result.response.text()).toBe("anthropic says no");
    expect(await result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});
