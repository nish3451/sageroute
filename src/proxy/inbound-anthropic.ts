/**
 * Inbound Anthropic Messages adapter.
 *
 * `anthropic.ts` translates OUTBOUND: it turns the proxy's internal Responses shape into
 * an Anthropic request so Claude can answer a turn. This module is the mirror image. It
 * lets a client that natively speaks Anthropic Messages -- Claude Code above all -- enter
 * the proxy at all, by translating its request INTO the Responses shape the router
 * reasons about, and translating the answer back on the way out.
 *
 * Without this, Claude Code cannot attach: it posts to `/v1/messages`, and every other
 * route the proxy serves speaks an OpenAI wire. The router itself is untouched, because
 * once a request is in Responses shape the trajectory extractor cannot tell which client
 * sent it.
 *
 * The same four vendor differences that shape the outbound path apply in reverse:
 * `system` is top level rather than a message, tool calls and results are content blocks
 * rather than parallel arrays, `max_tokens` is the client's field name, and streaming is
 * a typed event protocol rather than a stream of deltas.
 */

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collapse Anthropic's string-or-block-array content into plain text. */
function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    if (isObj(content) && typeof content.text === "string") return content.text;
    return "";
  }
  const parts: string[] = [];
  for (const raw of content) {
    if (typeof raw === "string") parts.push(raw);
    else if (isObj(raw) && typeof raw.text === "string") parts.push(raw.text);
  }
  return parts.join("\n");
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Remove Claude Code's `<system-reminder>` context injections from message text.
 *
 * Claude Code prepends a large reminder block to the first user message carrying
 * CLAUDE.md contents and standing instructions. Observed live: a 4817 character
 * reminder in front of a 68 character task. Merged into the message text, that
 * reminder becomes the recovered goal, which is the exact string sent to Sage as the
 * description of the task. Routing every Claude Code session on boilerplate rather
 * than on the user's actual request degrades every verdict, so it is stripped here.
 *
 * Only fully delimited spans are removed. Text the user genuinely wrote is never
 * touched, and a message that is nothing but a reminder collapses to empty and is
 * dropped by the caller.
 */
export function stripSystemReminders(text: string): string {
  if (!text.includes("<system-reminder>")) return text;
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

function messageId(): string {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Translate an Anthropic Messages request into the Responses shape.
 *
 * Tool results become their own top-level input items rather than staying nested inside
 * the user message that carried them. That flattening is what makes the trajectory
 * legible: the evidence extractor pairs `function_call` with `function_call_output` by
 * `call_id`, so a tool result buried in a user message would be invisible to the router
 * and every Claude Code turn would look like an agent that never ran anything.
 */
export function anthropicRequestToResponses(body: Record<string, unknown>): Record<string, unknown> {
  const input: Array<Record<string, unknown>> = [];

  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of messages) {
    if (!isObj(raw)) continue;
    const role = raw.role === "assistant" ? "assistant" : "user";
    const content = raw.content;

    if (typeof content === "string") {
      const cleaned = stripSystemReminders(content);
      if (cleaned) input.push(textItem(role, cleaned));
      continue;
    }
    if (!Array.isArray(content)) continue;

    // Text blocks within one message are merged so a multi-block message stays one turn
    // in the trajectory rather than inflating the assistant-turn count.
    const text: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        text.push(block);
        continue;
      }
      if (!isObj(block)) continue;
      const type = typeof block.type === "string" ? block.type : "";

      if (type === "text" && typeof block.text === "string") {
        const cleaned = stripSystemReminders(block.text);
        if (cleaned) text.push(cleaned);
        continue;
      }

      if (type === "tool_use") {
        if (text.length > 0) {
          input.push(textItem(role, text.join("\n")));
          text.length = 0;
        }
        input.push({
          type: "function_call",
          call_id: typeof block.id === "string" ? block.id : "call",
          name: typeof block.name === "string" ? block.name : "unknown",
          arguments: JSON.stringify(isObj(block.input) ? block.input : {}),
        });
        continue;
      }

      if (type === "tool_result") {
        if (text.length > 0) {
          input.push(textItem(role, text.join("\n")));
          text.length = 0;
        }
        const item: Record<string, unknown> = {
          type: "function_call_output",
          call_id: typeof block.tool_use_id === "string" ? block.tool_use_id : "call",
          output: blockText(block.content),
        };
        // Claude Code marks a failed tool call with `is_error`, which is a stronger
        // signal than sniffing the text, so it is preserved for the evidence layer.
        if (block.is_error === true) item.success = false;
        input.push(item);
        continue;
      }
    }
    if (text.length > 0) input.push(textItem(role, text.join("\n")));
  }

  const request: Record<string, unknown> = {
    model: typeof body.model === "string" ? body.model : "",
    input,
  };

  const system = blockText(body.system);
  if (system) request.instructions = system;
  if (typeof body.max_tokens === "number") request.max_output_tokens = body.max_tokens;
  if (body.stream === true) request.stream = true;
  if (typeof body.temperature === "number") request.temperature = body.temperature;
  if (typeof body.top_p === "number") request.top_p = body.top_p;
  // Claude Code sends a stable id per conversation; using it keeps one session's ladder
  // state together instead of re-deriving identity from the goal digest every turn.
  if (typeof body.metadata === "object" && body.metadata !== null) {
    const meta = body.metadata as Record<string, unknown>;
    if (typeof meta.user_id === "string" && meta.user_id.trim()) {
      request.prompt_cache_key = meta.user_id.trim();
    }
  }

  if (Array.isArray(body.tools)) {
    const tools: Array<Record<string, unknown>> = [];
    for (const tool of body.tools) {
      if (!isObj(tool)) continue;
      const name = typeof tool.name === "string" ? tool.name : "";
      if (!name) continue;
      tools.push({
        type: "function",
        name,
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: isObj(tool.input_schema) ? tool.input_schema : { type: "object", properties: {} },
      });
    }
    if (tools.length > 0) request.tools = tools;
  }

  return request;
}

function textItem(role: "user" | "assistant", text: string): Record<string, unknown> {
  return {
    type: "message",
    role,
    content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
  };
}

/** Pull the assistant text and tool calls out of a Responses `output` array. */
function readResponsesOutput(output: unknown): { text: string; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  let text = "";
  if (!Array.isArray(output)) return { text, calls };
  for (const item of output) {
    if (!isObj(item)) continue;
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      calls.push(item);
      continue;
    }
    if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (isObj(part) && typeof part.text === "string") text += part.text;
      }
    }
  }
  return { text, calls };
}

/** Build the Anthropic `content` block array for an assistant reply. */
function replyBlocks(text: string, calls: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  if (text) blocks.push({ type: "text", text });
  for (const call of calls) {
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(typeof call.arguments === "string" ? call.arguments : "{}");
    } catch {
      // A malformed argument string is the model's problem. Dropping the call would
      // leave the client waiting on a tool result that can never arrive.
      parsed = {};
    }
    blocks.push({
      type: "tool_use",
      id: typeof call.call_id === "string" ? call.call_id : "call",
      name: typeof call.name === "string" ? call.name : "unknown",
      input: isObj(parsed) ? parsed : {},
    });
  }
  // Anthropic clients expect at least one block; an empty array reads as a broken turn.
  if (blocks.length === 0) blocks.push({ type: "text", text: "" });
  return blocks;
}

/** Translate a completed Responses body back into an Anthropic Messages reply. */
export function responsesToAnthropicReply(
  raw: unknown,
  model: string,
): Record<string, unknown> {
  const body = isObj(raw) ? raw : {};
  const { text, calls } = readResponsesOutput(body.output);
  const usage = isObj(body.usage) ? body.usage : {};

  return {
    id: typeof body.id === "string" ? body.id : messageId(),
    type: "message",
    role: "assistant",
    model,
    content: replyBlocks(text, calls),
    // A turn that called tools must say so, or the client will not run them.
    stop_reason: calls.length > 0 ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: num(usage.input_tokens),
      output_tokens: num(usage.output_tokens),
    },
  };
}

/**
 * Translate the proxy's Responses SSE stream into Anthropic's typed event protocol.
 *
 * Text is forwarded delta by delta so the client renders while the model is still
 * writing. Tool calls cannot be: a `tool_use` block needs complete JSON input, and the
 * arguments only finish arriving at `response.output_item.done`. They are therefore
 * emitted as whole blocks after the text block closes.
 */
export function responsesStreamToAnthropic(
  source: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const id = messageId();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (type: string, payload: Record<string, unknown>): void => {
        controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`));
      };

      let inputTokens = 0;
      let outputTokens = 0;
      let textOpen = false;
      let sawText = false;
      const calls: Array<Record<string, unknown>> = [];

      send("message_start", {
        message: {
          id,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });

      const openText = (): void => {
        if (textOpen) return;
        send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        textOpen = true;
        sawText = true;
      };

      let buffer = "";
      try {
        // @ts-expect-error async iteration over a web stream is supported at runtime
        for await (const chunk of source) {
          buffer += decoder.decode(chunk as Uint8Array, { stream: true });
          let cut = buffer.indexOf("\n");
          while (cut !== -1) {
            const line = buffer.slice(0, cut).trim();
            buffer = buffer.slice(cut + 1);
            cut = buffer.indexOf("\n");
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const event = JSON.parse(payload) as Record<string, unknown>;
              const kind = typeof event.type === "string" ? event.type : "";

              if (kind === "response.output_text.delta" && typeof event.delta === "string") {
                if (event.delta) {
                  openText();
                  send("content_block_delta", {
                    index: 0,
                    delta: { type: "text_delta", text: event.delta },
                  });
                }
                continue;
              }

              if (kind === "response.output_item.done" && isObj(event.item)) {
                const item = event.item;
                if (item.type === "function_call" || item.type === "custom_tool_call") calls.push(item);
                continue;
              }

              if (kind === "response.completed" && isObj(event.response)) {
                const response = event.response;
                const usage = isObj(response.usage) ? response.usage : {};
                inputTokens = num(usage.input_tokens);
                outputTokens = num(usage.output_tokens);
                // Some upstreams only ever report tool calls on the terminal frame, so
                // it is read as a fallback rather than trusted as the only source.
                if (calls.length === 0) {
                  const { calls: finalCalls } = readResponsesOutput(response.output);
                  calls.push(...finalCalls);
                }
                continue;
              }
            } catch {
              // A partial or non-JSON frame is not worth failing a live turn over.
            }
          }
        }
      } catch {
        // Always close the protocol properly so the client is never left hanging.
      }

      if (textOpen) {
        send("content_block_stop", { index: 0 });
        textOpen = false;
      }

      // A reply with no text at all still needs one block for the client to accept it.
      if (!sawText && calls.length === 0) {
        send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        send("content_block_stop", { index: 0 });
      }

      let index = sawText ? 1 : 0;
      for (const call of calls) {
        let parsed: unknown = {};
        try {
          parsed = JSON.parse(typeof call.arguments === "string" ? call.arguments : "{}");
        } catch {
          parsed = {};
        }
        send("content_block_start", {
          index,
          content_block: {
            type: "tool_use",
            id: typeof call.call_id === "string" ? call.call_id : "call",
            name: typeof call.name === "string" ? call.name : "unknown",
            input: {},
          },
        });
        send("content_block_delta", {
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(isObj(parsed) ? parsed : {}) },
        });
        send("content_block_stop", { index });
        index += 1;
      }

      send("message_delta", {
        delta: { stop_reason: calls.length > 0 ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      });
      send("message_stop", {});
      controller.close();
    },
  });
}
