import { describe, expect, test } from "bun:test";
import {
  anthropicRequestToResponses,
  responsesStreamToAnthropic,
  responsesToAnthropicReply,
  stripSystemReminders,
} from "../src/proxy/inbound-anthropic";

function streamFrom(text: string): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Array<Record<string, unknown>>> {
  const text = await new Response(stream).text();
  return text
    .split("\n")
    .filter(line => line.startsWith("data:"))
    .map(line => JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
}

function sse(events: Array<Record<string, unknown>>): string {
  return events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

describe("anthropicRequestToResponses", () => {
  test("moves system to instructions and max_tokens to max_output_tokens", () => {
    const result = anthropicRequestToResponses({
      model: "sageroute",
      system: "be terse",
      max_tokens: 1024,
      messages: [{ role: "user", content: "ship it" }],
    });

    expect(result.instructions).toBe("be terse");
    expect(result.max_output_tokens).toBe(1024);
    expect(result.model).toBe("sageroute");
  });

  test("accepts a system block array, which is what Claude Code sends", () => {
    const result = anthropicRequestToResponses({
      model: "sageroute",
      system: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
      messages: [{ role: "user", content: "go" }],
    });

    expect(result.instructions).toBe("first\nsecond");
  });

  test("lifts tool_use and tool_result into top-level trajectory items", () => {
    const result = anthropicRequestToResponses({
      model: "sageroute",
      messages: [
        { role: "user", content: [{ type: "text", text: "run the tests" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "checking" },
            { type: "tool_use", id: "toolu_1", name: "bash", input: { cmd: "bun test" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "2 failed" }],
        },
      ],
    });

    const input = result.input as Array<Record<string, unknown>>;
    const call = input.find(item => item.type === "function_call");
    const output = input.find(item => item.type === "function_call_output");

    // Flattening is what makes the trajectory legible to the evidence extractor: a tool
    // result left nested inside a user message is invisible to the router.
    expect(call).toBeDefined();
    expect(call!.call_id).toBe("toolu_1");
    expect(call!.name).toBe("bash");
    expect(JSON.parse(String(call!.arguments))).toEqual({ cmd: "bun test" });
    expect(output).toBeDefined();
    expect(output!.call_id).toBe("toolu_1");
    expect(output!.output).toBe("2 failed");
  });

  test("preserves the is_error flag as an explicit failure signal", () => {
    const result = anthropicRequestToResponses({
      model: "sageroute",
      messages: [{
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }],
      }],
    });

    const output = (result.input as Array<Record<string, unknown>>)[0]!;
    expect(output.success).toBe(false);
  });

  test("keeps the first user message recoverable as the goal", () => {
    const result = anthropicRequestToResponses({
      model: "sageroute",
      messages: [{ role: "user", content: [{ type: "text", text: "refactor auth" }] }],
    });

    const first = (result.input as Array<Record<string, unknown>>)[0]!;
    expect(first.role).toBe("user");
    expect(JSON.stringify(first.content)).toContain("refactor auth");
  });

  test("strips the system-reminder block Claude Code prepends to the first message", () => {
    // Observed live: a 4817 character reminder in front of a 68 character task. Merged
    // in, that boilerplate becomes the goal string sent to Sage, so every Claude Code
    // session would be routed on CLAUDE.md contents instead of the user's request.
    const reminder = "<system-reminder>\nCodebase instructions here.\n</system-reminder>\n\n";
    const result = anthropicRequestToResponses({
      model: "sageroute",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: reminder },
          { type: "text", text: "list the txt files" },
        ],
      }],
    });

    const text = JSON.stringify(result.input);
    expect(text).toContain("list the txt files");
    expect(text).not.toContain("system-reminder");
    expect(text).not.toContain("Codebase instructions here");
  });

  test("a message that is only a reminder is dropped rather than sent as an empty turn", () => {
    const result = anthropicRequestToResponses({
      model: "sageroute",
      messages: [
        { role: "user", content: [{ type: "text", text: "<system-reminder>noise</system-reminder>" }] },
        { role: "user", content: [{ type: "text", text: "the real task" }] },
      ],
    });

    const input = result.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(1);
    expect(JSON.stringify(input[0]!.content)).toContain("the real task");
  });

  test("translates tools into the Responses function shape", () => {
    const result = anthropicRequestToResponses({
      model: "sageroute",
      messages: [{ role: "user", content: "hi" }],
      tools: [{
        name: "bash",
        description: "run a command",
        input_schema: { type: "object", properties: { cmd: { type: "string" } } },
      }],
    });

    const tools = result.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("bash");
    expect(tools[0]!.type).toBe("function");
    expect(tools[0]!.parameters).toEqual({ type: "object", properties: { cmd: { type: "string" } } });
  });
});

describe("stripSystemReminders", () => {
  test("removes a delimited reminder span", () => {
    expect(stripSystemReminders("<system-reminder>ctx</system-reminder>\n\ndo the thing"))
      .toBe("do the thing");
  });

  test("removes several spans in one message", () => {
    expect(stripSystemReminders("<system-reminder>a</system-reminder>keep<system-reminder>b</system-reminder>"))
      .toBe("keep");
  });

  test("leaves ordinary text untouched", () => {
    expect(stripSystemReminders("just a normal request")).toBe("just a normal request");
  });

  test("leaves an unterminated tag alone rather than eating the user's text", () => {
    // Truncating from a stray opener would silently discard a real request.
    const text = "why does <system-reminder> appear in my logs";
    expect(stripSystemReminders(text)).toBe(text);
  });
});

describe("responsesToAnthropicReply", () => {
  test("maps assistant text and usage back onto the Messages envelope", () => {
    const reply = responsesToAnthropicReply({
      id: "resp_1",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "done" }],
      }],
      usage: { input_tokens: 12, output_tokens: 3 },
    }, "sageroute");

    expect(reply.type).toBe("message");
    expect(reply.role).toBe("assistant");
    expect(reply.content).toEqual([{ type: "text", text: "done" }]);
    expect(reply.stop_reason).toBe("end_turn");
    expect(reply.usage).toEqual({ input_tokens: 12, output_tokens: 3 });
  });

  test("reports stop_reason tool_use so the client actually runs the tool", () => {
    const reply = responsesToAnthropicReply({
      output: [
        { type: "function_call", call_id: "c1", name: "bash", arguments: "{\"cmd\":\"ls\"}" },
      ],
    }, "sageroute");

    expect(reply.stop_reason).toBe("tool_use");
    const blocks = reply.content as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({ type: "tool_use", id: "c1", name: "bash", input: { cmd: "ls" } });
  });

  test("never returns an empty content array", () => {
    const reply = responsesToAnthropicReply({ output: [] }, "sageroute");
    expect((reply.content as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("responsesStreamToAnthropic", () => {
  test("emits the typed Anthropic event protocol in order", async () => {
    const events = await collect(responsesStreamToAnthropic(streamFrom(sse([
      { type: "response.created", response: { id: "r1" } },
      { type: "response.output_text.delta", delta: "hel" },
      { type: "response.output_text.delta", delta: "lo" },
      { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 2 } } },
    ])), "sageroute"));

    const types = events.map(event => event.type);
    expect(types[0]).toBe("message_start");
    expect(types).toContain("content_block_start");
    expect(types).toContain("content_block_delta");
    expect(types).toContain("content_block_stop");
    expect(types[types.length - 1]).toBe("message_stop");

    const text = events
      .filter(event => event.type === "content_block_delta")
      .map(event => (event.delta as Record<string, unknown>).text)
      .join("");
    expect(text).toBe("hello");

    const delta = events.find(event => event.type === "message_delta")!;
    expect(delta.usage).toEqual({ input_tokens: 5, output_tokens: 2 });
  });

  test("streams tool calls as complete blocks after the text closes", async () => {
    const events = await collect(responsesStreamToAnthropic(streamFrom(sse([
      { type: "response.output_text.delta", delta: "running" },
      {
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "c9", name: "bash", arguments: "{\"cmd\":\"ls\"}" },
      },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ])), "sageroute"));

    const start = events.find(event =>
      event.type === "content_block_start"
      && (event.content_block as Record<string, unknown>).type === "tool_use");
    expect(start).toBeDefined();
    expect((start!.content_block as Record<string, unknown>).id).toBe("c9");
    // The text block owns index 0, so the tool block must not collide with it.
    expect(start!.index).toBe(1);

    const delta = events.find(event =>
      event.type === "content_block_delta"
      && (event.delta as Record<string, unknown>).type === "input_json_delta");
    expect(JSON.parse(String((delta!.delta as Record<string, unknown>).partial_json))).toEqual({ cmd: "ls" });

    const messageDelta = events.find(event => event.type === "message_delta")!;
    expect((messageDelta.delta as Record<string, unknown>).stop_reason).toBe("tool_use");
  });

  test("recovers tool calls that only appear on the terminal frame", async () => {
    const events = await collect(responsesStreamToAnthropic(streamFrom(sse([
      {
        type: "response.completed",
        response: {
          output: [{ type: "function_call", call_id: "c2", name: "grep", arguments: "{}" }],
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    ])), "sageroute"));

    const start = events.find(event =>
      event.type === "content_block_start"
      && (event.content_block as Record<string, unknown>).type === "tool_use");
    expect(start).toBeDefined();
  });

  test("always terminates the protocol even on a malformed stream", async () => {
    const events = await collect(responsesStreamToAnthropic(streamFrom("data: {not json\n\n"), "sageroute"));
    const types = events.map(event => event.type);
    expect(types[0]).toBe("message_start");
    expect(types[types.length - 1]).toBe("message_stop");
  });
});
