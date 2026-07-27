import { describe, expect, test } from "bun:test";
import {
  chatToResponses,
  dispatchUpstream,
  readUsage,
  responsesToChat,
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

function baseRequest(overrides: Partial<UpstreamRequest> = {}): UpstreamRequest {
  return {
    provider: "openai",
    config: {
      adapter: "openai-responses",
      baseUrl: "https://upstream.test/v1",
      apiKey: "configured-key",
    },
    model: "gpt-cheap",
    body: {
      model: "sageroute",
      input: "hello",
    },
    stream: false,
    ...overrides,
  };
}

describe("upstream usage parsing", () => {
  test("readUsage accepts Responses, Chat Completions, and absent usage dialects", () => {
    expect(readUsage({ usage: { input_tokens: 11, output_tokens: 7 } })).toEqual({
      inputTokens: 11,
      outputTokens: 7,
    });
    expect(readUsage({ usage: { prompt_tokens: 13, completion_tokens: 5 } })).toEqual({
      inputTokens: 13,
      outputTokens: 5,
    });
    expect(readUsage({ input_tokens: 17, output_tokens: 19 })).toEqual({
      inputTokens: 17,
      outputTokens: 19,
    });
    expect(readUsage({ usage: { total_tokens: 99 } })).toBeNull();
    expect(readUsage(null)).toBeNull();
  });
});

describe("Responses and Chat wire translation", () => {
  test("responsesToChat maps instructions, messages, tool calls, tool outputs, and tools", () => {
    const chat = responsesToChat({
      instructions: "You are terse.",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Fix it" }] },
        { type: "reasoning", encrypted_content: "vendor-private" },
        {
          type: "function_call",
          call_id: "call-1",
          name: "shell",
          arguments: "{\"cmd\":\"bun test\"}",
        },
        {
          type: "function_call_output",
          call_id: "call-1",
          output: [{ type: "output_text", text: "tests failed" }],
        },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "I will patch it." }] },
      ],
      stream: true,
      temperature: 0.2,
      top_p: 0.9,
      max_output_tokens: 512,
      tools: [{
        type: "function",
        name: "shell",
        description: "run a command",
        parameters: { type: "object", properties: { cmd: { type: "string" } } },
      }],
    }, "gpt-cheap");

    expect(chat).toMatchObject({
      model: "gpt-cheap",
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 512,
    });
    expect(chat.messages).toEqual([
      { role: "system", content: "You are terse." },
      { role: "user", content: "Fix it" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call-1",
          type: "function",
          function: { name: "shell", arguments: "{\"cmd\":\"bun test\"}" },
        }],
      },
      { role: "tool", tool_call_id: "call-1", content: "tests failed" },
      { role: "assistant", content: "I will patch it." },
    ]);
    expect(chat.tools).toEqual([{
      type: "function",
      function: {
        name: "shell",
        description: "run a command",
        parameters: { type: "object", properties: { cmd: { type: "string" } } },
      },
    }]);
  });

  test("chatToResponses maps text, tool calls, and usage back to Responses", () => {
    const response = chatToResponses({
      id: "chatcmpl_123",
      created: 1_700_000_000,
      choices: [{
        message: {
          content: "patched",
          tool_calls: [{
            id: "call-9",
            type: "function",
            function: { name: "shell", arguments: "{\"cmd\":\"bun test\"}" },
          }],
        },
      }],
      usage: { prompt_tokens: 21, completion_tokens: 8 },
    }, "gpt-strong");

    expect(response).toEqual({
      id: "chatcmpl_123",
      object: "response",
      created_at: 1_700_000_000,
      model: "gpt-strong",
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: "call-9",
          name: "shell",
          arguments: "{\"cmd\":\"bun test\"}",
        },
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "patched" }],
        },
      ],
      usage: {
        input_tokens: 21,
        output_tokens: 8,
        total_tokens: 29,
      },
    });
  });
});

describe("dispatchUpstream", () => {
  test("sends Responses requests to /responses with authorization and resolves non-streaming usage", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      seenUrl = String(url);
      seenInit = init;
      return Response.json({
        id: "resp_1",
        model: "gpt-cheap",
        usage: { input_tokens: 33, output_tokens: 12 },
      });
    }) as unknown as typeof fetch;

    const result = await dispatchUpstream(baseRequest(), "runtime-key", fetchImpl);
    const body = await result.response.json() as Record<string, unknown>;

    expect(seenUrl).toBe("https://upstream.test/v1/responses");
    expect(seenInit?.method).toBe("POST");
    expect(new Headers(seenInit?.headers).get("authorization")).toBe("Bearer runtime-key");
    expect(new Headers(seenInit?.headers).get("x-api-key")).toBe("runtime-key");
    expect(JSON.parse(String(seenInit?.body))).toMatchObject({ model: "gpt-cheap", input: "hello" });
    expect(body).toMatchObject({ id: "resp_1", model: "gpt-cheap" });
    expect(await result.usage).toEqual({ inputTokens: 33, outputTokens: 12 });
  });

  test("sends Chat adapter requests to /chat/completions and converts the response envelope", async () => {
    let seenUrl = "";
    let seenPayload: Record<string, unknown> = {};
    const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      seenUrl = String(url);
      seenPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        id: "chatcmpl_1",
        created: 1_700_000_000,
        choices: [{ message: { content: "done" } }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      });
    }) as unknown as typeof fetch;

    const result = await dispatchUpstream(baseRequest({
      config: {
        adapter: "openai-chat",
        baseUrl: "https://chat.upstream.test/v1/",
      },
      body: {
        instructions: "system note",
        input: [{ type: "message", role: "user", content: "hello" }],
      },
    }), null, fetchImpl);
    const body = await result.response.json() as Record<string, unknown>;

    expect(seenUrl).toBe("https://chat.upstream.test/v1/chat/completions");
    expect(seenPayload).toMatchObject({
      model: "gpt-cheap",
      messages: [
        { role: "system", content: "system note" },
        { role: "user", content: "hello" },
      ],
    });
    expect(body).toMatchObject({
      object: "response",
      model: "gpt-cheap",
      usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
    });
    expect(await result.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  test("passes through non-OK upstream status and body", async () => {
    const fetchImpl = (async () => new Response("upstream says no", {
      status: 429,
      headers: { "Content-Type": "text/plain" },
    })) as unknown as typeof fetch;

    const result = await dispatchUpstream(baseRequest(), "runtime-key", fetchImpl);

    expect(result.response.status).toBe(429);
    expect(result.response.headers.get("content-type")).toBe("text/plain");
    expect(await result.response.text()).toBe("upstream says no");
    expect(await result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  test("tees Responses SSE so usage resolves from the final frame while client receives the full stream", async () => {
    const sse = [
      "event: response.created",
      "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_stream\"}}",
      "",
      "event: response.output_text.delta",
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}",
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":55,\"output_tokens\":13}}}",
      "",
    ].join("\n");
    const fetchImpl = (async () => new Response(streamFrom(sse), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })) as unknown as typeof fetch;

    const result = await dispatchUpstream(baseRequest({ stream: true, body: { input: "hello", stream: true } }), null, fetchImpl);
    const clientBody = await result.response.text();

    expect(result.response.headers.get("content-type")).toContain("text/event-stream");
    expect(clientBody).toBe(sse);
    expect(await result.usage).toEqual({ inputTokens: 55, outputTokens: 13 });
  });
});
