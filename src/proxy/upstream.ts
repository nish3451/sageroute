/**
 * Upstream dispatch: send a routed turn to a real provider and meter what it cost.
 *
 * Two wire formats are supported. `openai-responses` is what modern agent harnesses
 * actually speak and is forwarded near-verbatim. `openai-chat` is the older Chat
 * Completions shape, still the only thing many gateways expose, so the router can put a
 * cheap tier on one vendor and a strong tier on another.
 *
 * Usage metering is the load-bearing part. The budget rung of the ladder is only honest
 * if the cost ledger reflects real token counts, and on a streaming response the token
 * counts arrive in the LAST event -- long after the client has started reading. So the
 * stream is tee'd: the client is served byte-for-byte in real time while a parallel
 * reader watches for the usage frame and settles the ledger when it lands.
 */

import type { ProviderConfig } from "./config";

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface UpstreamRequest {
  provider: string;
  config: ProviderConfig;
  /** Model id as the upstream knows it, with the provider prefix already stripped. */
  model: string;
  body: Record<string, unknown>;
  stream: boolean;
}

export interface UpstreamResult {
  response: Response;
  /** Resolves when real token counts are known, or with zeros if none were reported. */
  usage: Promise<TurnUsage>;
}

const DEFAULT_TIMEOUT_MS = 600_000;

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Pull token counts out of whichever usage dialect the upstream speaks.
 * Responses says `input_tokens`; Chat Completions says `prompt_tokens`.
 */
export function readUsage(raw: unknown): TurnUsage | null {
  if (!isObj(raw)) return null;
  const usage = isObj(raw.usage) ? raw.usage : raw;
  const input = usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens;
  if (input === undefined && output === undefined) return null;
  return { inputTokens: num(input), outputTokens: num(output) };
}

/** Flatten a Responses `input` array into Chat Completions messages. */
export function responsesToChat(body: Record<string, unknown>, model: string): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  const instructions = body.instructions;
  if (typeof instructions === "string" && instructions.trim()) {
    messages.push({ role: "system", content: instructions });
  }

  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const raw of input) {
      if (typeof raw === "string") {
        messages.push({ role: "user", content: raw });
        continue;
      }
      if (!isObj(raw)) continue;
      const type = typeof raw.type === "string" ? raw.type : "";
      const role = typeof raw.role === "string" ? raw.role : "";

      if (type === "function_call" || type === "custom_tool_call") {
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [{
            id: typeof raw.call_id === "string" ? raw.call_id : "call",
            type: "function",
            function: {
              name: typeof raw.name === "string" ? raw.name : "unknown",
              arguments: typeof raw.arguments === "string" ? raw.arguments : "{}",
            },
          }],
        });
        continue;
      }
      if (type === "function_call_output" || type === "custom_tool_call_output") {
        messages.push({
          role: "tool",
          tool_call_id: typeof raw.call_id === "string" ? raw.call_id : "call",
          content: flattenContent(raw.output),
        });
        continue;
      }
      // Reasoning items carry provider-specific encrypted payloads that a different
      // vendor cannot decrypt. Dropping them is required for cross-provider ladders.
      if (type === "reasoning") continue;
      if (role) messages.push({ role, content: flattenContent(raw.content) });
    }
  }

  const chat: Record<string, unknown> = { model, messages };
  if (body.stream === true) chat.stream = true;
  if (body.stream === true) chat.stream_options = { include_usage: true };
  if (typeof body.temperature === "number") chat.temperature = body.temperature;
  if (typeof body.top_p === "number") chat.top_p = body.top_p;
  if (typeof body.max_output_tokens === "number") chat.max_tokens = body.max_output_tokens;
  if (Array.isArray(body.tools)) chat.tools = chatTools(body.tools);
  return chat;
}

function chatTools(tools: unknown[]): unknown[] {
  return tools.map(tool => {
    if (!isObj(tool)) return tool;
    // Responses puts the schema at the top level; Chat nests it under `function`.
    if (tool.type === "function" && isObj(tool.function)) return tool;
    if (typeof tool.name === "string") {
      return {
        type: "function",
        function: {
          name: tool.name,
          description: typeof tool.description === "string" ? tool.description : undefined,
          parameters: isObj(tool.parameters) ? tool.parameters : { type: "object", properties: {} },
        },
      };
    }
    return tool;
  });
}

function flattenContent(content: unknown): string {
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
    if (inner !== undefined) return flattenContent(inner);
  }
  return "";
}

/** Wrap a Chat Completions reply in the Responses envelope the client expects back. */
export function chatToResponses(raw: unknown, model: string): Record<string, unknown> {
  const body = isObj(raw) ? raw : {};
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const first = isObj(choices[0]) ? choices[0] as Record<string, unknown> : {};
  const message = isObj(first.message) ? first.message : {};
  const text = typeof message.content === "string" ? message.content : "";

  const output: Array<Record<string, unknown>> = [];
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of toolCalls) {
    if (!isObj(call)) continue;
    const fn = isObj(call.function) ? call.function : {};
    output.push({
      type: "function_call",
      call_id: typeof call.id === "string" ? call.id : "call",
      name: typeof fn.name === "string" ? fn.name : "unknown",
      arguments: typeof fn.arguments === "string" ? fn.arguments : "{}",
    });
  }
  if (text || output.length === 0) {
    output.push({
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
    });
  }

  const usage = readUsage(body) ?? { inputTokens: 0, outputTokens: 0 };
  return {
    id: typeof body.id === "string" ? body.id : `resp_${Date.now().toString(36)}`,
    object: "response",
    created_at: num(body.created) || Math.floor(Date.now() / 1000),
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

function headersFor(provider: ProviderConfig, apiKey: string | null): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (apiKey) {
    headers.set("Authorization", `Bearer ${apiKey}`);
    // Anthropic-compatible gateways read the key from their own header.
    headers.set("x-api-key", apiKey);
  }
  for (const [key, value] of Object.entries(provider.headers ?? {})) headers.set(key, value);
  return headers;
}

/**
 * Tee an SSE body so the client streams in real time while a second reader mines the
 * events for the usage frame. Without this the budget ladder would only ever see zeros
 * on streaming turns, which is exactly when an agent burns the most money.
 */
function meterStream(
  source: ReadableStream<Uint8Array>,
  settle: (usage: TurnUsage) => void,
): ReadableStream<Uint8Array> {
  const [toClient, toMeter] = source.tee();
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    let found: TurnUsage | null = null;
    try {
      // @ts-expect-error async iteration over a web stream is supported at runtime
      for await (const chunk of toMeter) {
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
            const event = JSON.parse(payload) as unknown;
            const direct = readUsage(event);
            if (direct) found = direct;
            // Responses streaming nests the final object under `response`.
            if (isObj(event) && isObj(event.response)) {
              const nested = readUsage(event.response);
              if (nested) found = nested;
            }
          } catch {
            // A partial or non-JSON frame is not worth failing the turn over.
          }
        }
      }
    } catch {
      // Metering must never break delivery; the client stream is a separate branch.
    }
    settle(found ?? { inputTokens: 0, outputTokens: 0 });
  })();
  return toClient;
}

/**
 * Translate a stream of Chat Completions deltas into Responses SSE events, so a client
 * that only speaks Responses can stream from a Chat-only upstream.
 */
function chatStreamToResponses(
  source: ReadableStream<Uint8Array>,
  model: string,
  settle: (usage: TurnUsage) => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const id = `resp_${Date.now().toString(36)}`;
  let text = "";
  let usage: TurnUsage = { inputTokens: 0, outputTokens: 0 };

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
              const reported = readUsage(event);
              if (reported) usage = reported;
              const choices = Array.isArray(event.choices) ? event.choices : [];
              const delta = isObj(choices[0]) ? (choices[0] as Record<string, unknown>).delta : undefined;
              const piece = isObj(delta) && typeof delta.content === "string" ? delta.content : "";
              if (piece) {
                text += piece;
                send("response.output_text.delta", { delta: piece, item_id: `${id}-0`, output_index: 0 });
              }
            } catch {
              // Ignore malformed frames rather than aborting a live turn.
            }
          }
        }
      } catch {
        // Fall through to completion so the client always gets a terminal event.
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

/**
 * Send one routed turn upstream. The returned `usage` promise settles when the real
 * token counts are known, which for a stream is after the client has finished reading.
 */
export async function dispatchUpstream(
  request: UpstreamRequest,
  apiKey: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<UpstreamResult> {
  const adapter = request.config.adapter ?? "openai-responses";
  const base = request.config.baseUrl.replace(/\/+$/, "");
  const isChat = adapter === "openai-chat";
  const url = `${base}${isChat ? "/chat/completions" : "/responses"}`;
  const payload = isChat
    ? Array.isArray(request.body.messages)
      ? { ...request.body, model: request.model }
      : responsesToChat(request.body, request.model)
    : { ...request.body, model: request.model };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let settle: (usage: TurnUsage) => void = () => {};
  const usage = new Promise<TurnUsage>(resolve => { settle = resolve; });

  let upstream: Response;
  try {
    upstream = await fetchImpl(url, {
      method: "POST",
      headers: headersFor(request.config, apiKey),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    settle({ inputTokens: 0, outputTokens: 0 });
    throw new Error(`upstream "${request.provider}" unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!upstream.ok) {
    clearTimeout(timer);
    settle({ inputTokens: 0, outputTokens: 0 });
    const detail = await upstream.text().catch(() => "");
    return {
      response: new Response(detail || JSON.stringify({ error: { message: `upstream ${upstream.status}` } }), {
        status: upstream.status,
        headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
      }),
      usage,
    };
  }

  const streaming = request.stream && Boolean(upstream.body)
    && (upstream.headers.get("content-type") ?? "").includes("text/event-stream");

  if (streaming) {
    const body = isChat
      ? chatStreamToResponses(upstream.body!, request.model, u => { clearTimeout(timer); settle(u); })
      : meterStream(upstream.body!, u => { clearTimeout(timer); settle(u); });
    return {
      response: new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      }),
      usage,
    };
  }

  const decoded = await upstream.json().catch(() => ({}));
  clearTimeout(timer);
  const measured = readUsage(decoded) ?? { inputTokens: 0, outputTokens: 0 };
  settle(measured);
  const outBody = isChat ? chatToResponses(decoded, request.model) : decoded;
  return {
    response: new Response(JSON.stringify(outBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
    usage,
  };
}
