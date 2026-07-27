/**
 * Anthropic Messages API adapter.
 *
 * Anthropic is the one supported vendor that does not speak an OpenAI-shaped wire, so
 * it gets a real adapter rather than a base-URL swap. Four differences actually matter:
 *
 *   1. `system` is a top-level field, not a message with `role: "system"`.
 *   2. `max_tokens` is REQUIRED. Omitting it is a 400, so a default is always sent.
 *   3. Tool calls and their results are content BLOCKS inside messages, not a parallel
 *      `tool_calls` array, and a tool result rides on a `user` message.
 *   4. Streaming is a typed event protocol rather than a stream of chat deltas.
 *
 * Everything here converts to and from the Responses shape the rest of the proxy uses,
 * so the router never learns that a vendor is different.
 */

import type { TurnUsage } from "./upstream";
import { CLAUDE_CODE_SYSTEM_INSTRUCTION } from "../oauth";

/** Anthropic rejects a request without this, so the adapter always sends one. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192;
export const ANTHROPIC_VERSION = "2023-06-01";

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function flatten(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const raw of content) {
      if (typeof raw === "string") parts.push(raw);
      else if (isObj(raw) && typeof raw.text === "string") parts.push(raw.text);
      else if (isObj(raw) && typeof raw.output === "string") parts.push(raw.output);
    }
    return parts.join("\n");
  }
  if (isObj(content)) {
    const inner = content.content ?? content.output ?? content.text;
    if (typeof inner === "string") return inner;
    if (inner !== undefined) return flatten(inner);
  }
  return "";
}

/** Anthropic usage omits a field entirely when it is zero, so both are read defensively. */
export function readAnthropicUsage(raw: unknown): TurnUsage | null {
  if (!isObj(raw)) return null;
  const usage = isObj(raw.usage) ? raw.usage : raw;
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  if (input === undefined && output === undefined) return null;
  return { inputTokens: num(input), outputTokens: num(output) };
}

/**
 * Translate a Responses body into an Anthropic Messages request.
 *
 * Consecutive tool results are merged into a single `user` message because Anthropic
 * requires alternating roles: sending three separate user messages in a row is a 400,
 * and an agent turn routinely answers several parallel tool calls at once.
 */
export function responsesToAnthropic(
  body: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  const systemParts: string[] = [];

  if (typeof body.instructions === "string" && body.instructions.trim()) {
    systemParts.push(body.instructions);
  }

  /** Append a block, merging into the previous message when the role matches. */
  const push = (role: "user" | "assistant", block: Record<string, unknown>): void => {
    const last = messages[messages.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) {
      (last.content as unknown[]).push(block);
      return;
    }
    messages.push({ role, content: [block] });
  };

  const input = body.input;
  if (typeof input === "string") {
    push("user", { type: "text", text: input });
  } else if (Array.isArray(input)) {
    for (const raw of input) {
      if (typeof raw === "string") {
        push("user", { type: "text", text: raw });
        continue;
      }
      if (!isObj(raw)) continue;
      const type = typeof raw.type === "string" ? raw.type : "";
      const role = typeof raw.role === "string" ? raw.role : "";

      if (type === "function_call" || type === "custom_tool_call") {
        let parsed: unknown = {};
        try {
          parsed = JSON.parse(typeof raw.arguments === "string" ? raw.arguments : "{}");
        } catch {
          // A malformed argument string is the model's problem, not a reason to drop
          // the call from the history; send an empty object and let the vendor answer.
          parsed = {};
        }
        push("assistant", {
          type: "tool_use",
          id: typeof raw.call_id === "string" ? raw.call_id : "call",
          name: typeof raw.name === "string" ? raw.name : "unknown",
          input: isObj(parsed) ? parsed : {},
        });
        continue;
      }

      if (type === "function_call_output" || type === "custom_tool_call_output") {
        // Tool results are user-turn blocks in this API, not their own role.
        push("user", {
          type: "tool_result",
          tool_use_id: typeof raw.call_id === "string" ? raw.call_id : "call",
          content: flatten(raw.output),
        });
        continue;
      }

      // Encrypted vendor-specific reasoning cannot cross a provider boundary.
      if (type === "reasoning") continue;

      const text = flatten(raw.content);
      if (role === "system") {
        if (text) systemParts.push(text);
        continue;
      }
      if (!text) continue;
      push(role === "assistant" ? "assistant" : "user", { type: "text", text });
    }
  }

  // Anthropic requires a nonempty message list.
  if (messages.length === 0) messages.push({ role: "user", content: [{ type: "text", text: "" }] });

  const request: Record<string, unknown> = {
    model,
    messages,
    max_tokens: typeof body.max_output_tokens === "number"
      ? body.max_output_tokens
      : ANTHROPIC_DEFAULT_MAX_TOKENS,
  };
  if (systemParts.length > 0) request.system = systemParts.join("\n\n");
  if (body.stream === true) request.stream = true;
  if (typeof body.temperature === "number") request.temperature = body.temperature;
  if (typeof body.top_p === "number") request.top_p = body.top_p;

  if (Array.isArray(body.tools)) {
    const tools: Array<Record<string, unknown>> = [];
    for (const tool of body.tools) {
      if (!isObj(tool)) continue;
      // Accept both the Responses flat shape and the Chat nested shape.
      const fn = isObj(tool.function) ? tool.function : tool;
      const name = typeof fn.name === "string" ? fn.name : "";
      if (!name) continue;
      tools.push({
        name,
        description: typeof fn.description === "string" ? fn.description : "",
        input_schema: isObj(fn.parameters)
          ? fn.parameters
          : { type: "object", properties: {} },
      });
    }
    if (tools.length > 0) request.tools = tools;
  }

  return request;
}

/**
 * Reshape a Messages request so it presents as Claude Code.
 *
 * An Anthropic OAuth token is scoped to Claude Code rather than to the general API, and
 * the vendor checks the request against that scope. The first system block has to be the
 * Claude Code identity string exactly; the caller's own system prompt is preserved as a
 * second block rather than replaced, so routing does not silently discard instructions.
 *
 * `system` therefore becomes a block array here even though the key-mode path sends a
 * plain string. Both shapes are valid for Anthropic.
 */
export function applyClaudeCodeIdentity(request: Record<string, unknown>): Record<string, unknown> {
  const identity = { type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION };
  const existing = request.system;

  const blocks: Array<Record<string, unknown>> = [identity];
  if (typeof existing === "string" && existing.trim()) {
    blocks.push({ type: "text", text: existing });
  } else if (Array.isArray(existing)) {
    for (const block of existing) {
      // Guard against double-prefixing if this request was already shaped.
      if (isObj(block) && block.type === "text" && block.text === CLAUDE_CODE_SYSTEM_INSTRUCTION) continue;
      blocks.push(isObj(block) ? block : { type: "text", text: flatten(block) });
    }
  }

  return { ...request, system: blocks };
}

/** Translate an Anthropic Messages reply back into the Responses envelope. */
export function anthropicToResponses(raw: unknown, model: string): Record<string, unknown> {
  const body = isObj(raw) ? raw : {};
  const blocks = Array.isArray(body.content) ? body.content : [];

  const output: Array<Record<string, unknown>> = [];
  let text = "";
  for (const block of blocks) {
    if (!isObj(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
      continue;
    }
    if (block.type === "tool_use") {
      output.push({
        type: "function_call",
        call_id: typeof block.id === "string" ? block.id : "call",
        name: typeof block.name === "string" ? block.name : "unknown",
        arguments: JSON.stringify(isObj(block.input) ? block.input : {}),
      });
    }
  }
  if (text || output.length === 0) {
    output.push({
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
    });
  }

  const usage = readAnthropicUsage(body) ?? { inputTokens: 0, outputTokens: 0 };
  return {
    id: typeof body.id === "string" ? body.id : `resp_${Date.now().toString(36)}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "completed",
    output,
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      total_tokens: usage.inputTokens + usage.outputTokens,
    },
  };
}

/**
 * Translate Anthropic's typed SSE protocol into Responses stream events.
 *
 * Token counts arrive split across two frames: `message_start` carries input tokens and
 * `message_delta` carries the final output count. Both are accumulated, otherwise the
 * budget ladder would systematically undercount every streaming Anthropic turn.
 */
export function anthropicStreamToResponses(
  source: ReadableStream<Uint8Array>,
  model: string,
  settle: (usage: TurnUsage) => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const id = `resp_${Date.now().toString(36)}`;
  let text = "";
  const usage: TurnUsage = { inputTokens: 0, outputTokens: 0 };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (type: string, payload: Record<string, unknown>): void => {
        controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`));
      };
      send("response.created", { response: { id, object: "response", model, status: "in_progress" } });

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

              if (kind === "message_start" && isObj(event.message)) {
                const started = readAnthropicUsage(event.message);
                if (started) {
                  usage.inputTokens = started.inputTokens;
                  usage.outputTokens = started.outputTokens;
                }
                continue;
              }
              if (kind === "content_block_delta" && isObj(event.delta)) {
                const piece = typeof event.delta.text === "string" ? event.delta.text : "";
                if (piece) {
                  text += piece;
                  send("response.output_text.delta", { delta: piece, item_id: `${id}-0`, output_index: 0 });
                }
                continue;
              }
              if (kind === "message_delta") {
                const final = readAnthropicUsage(event);
                if (final && final.outputTokens > 0) usage.outputTokens = final.outputTokens;
                continue;
              }
            } catch {
              // A partial or non-JSON frame is not worth failing a live turn over.
            }
          }
        }
      } catch {
        // Always emit a terminal event so the client is never left hanging.
      }

      send("response.completed", {
        response: {
          id,
          object: "response",
          model,
          status: "completed",
          output: [{
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text }],
          }],
          usage: {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            total_tokens: usage.inputTokens + usage.outputTokens,
          },
        },
      });
      controller.close();
      settle(usage);
    },
  });
}
