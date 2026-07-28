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
import {
  ANTHROPIC_VERSION,
  anthropicStreamToResponses,
  anthropicToResponses,
  applyClaudeCodeIdentity,
  readAnthropicUsage,
  responsesToAnthropic,
} from "./anthropic";
import {
  CLAUDE_CODE_HEADERS,
  claudeCodeSessionId,
  SAGEROUTE_ORIGINATOR,
} from "./fingerprint";
import { ANTHROPIC_OAUTH_BETA, type OAuthProviderId } from "../oauth";

/**
 * How one upstream call authenticates.
 *
 * These are not interchangeable secrets. A `key` is a metered API credential, while an
 * `oauth` token is a subscription credential issued to a specific first-party client,
 * which changes the headers AND the request body the vendor will accept.
 */
export type UpstreamCredential =
  | { mode: "key"; apiKey: string | null }
  | { mode: "oauth"; provider: OAuthProviderId; token: string; accountId?: string };

/** Callers that only have an API key can still pass a bare string or null. */
export type CredentialInput = string | null | UpstreamCredential;

function normalizeCredential(input: CredentialInput): UpstreamCredential {
  if (input === null || typeof input === "string") return { mode: "key", apiKey: input };
  return input;
}

/**
 * Prepare a Responses body for the ChatGPT subscription backend.
 *
 * That backend does not persist response items for a subscription caller, so `store` is
 * pinned false. Item ids in `input` then refer to stored objects that were never created
 * and the request 404s, so they are stripped. `call_id` is untouched: it is what pairs a
 * tool call to its output, and the router's evidence layer reads exactly those pairs.
 *
 * It also rejects `max_output_tokens` outright with 400 "Unsupported parameter", unlike
 * the metered API host which accepts it. Found against the live vendor while attaching
 * Claude Code, whose `max_tokens` translates into exactly that field on every request.
 * Dropping it costs nothing here: the caller's cap is advisory, and failing the whole
 * turn to honor it is a worse trade than answering without it.
 */
export function withoutStoredItemIds(body: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...body, store: false };
  delete next.max_output_tokens;
  if (!Array.isArray(next.input)) return next;
  next.input = next.input.map(item => {
    if (!isObj(item) || !("id" in item)) return item;
    const { id: _id, ...rest } = item;
    return rest;
  });
  return next;
}

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

export function headersFor(provider: ProviderConfig, credential: CredentialInput): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  const adapter = provider.adapter ?? "openai-responses";
  const isAnthropic = adapter === "anthropic-messages";
  const cred = normalizeCredential(credential);

  if (cred.mode === "oauth") {
    // A subscription token is a bearer token for every vendor, including Anthropic,
    // which otherwise authenticates on x-api-key.
    headers.set("Authorization", `Bearer ${cred.token}`);
    if (cred.provider === "anthropic") {
      headers.set("anthropic-beta", ANTHROPIC_OAUTH_BETA);
      for (const [key, value] of Object.entries(CLAUDE_CODE_HEADERS)) headers.set(key, value);
      headers.set("X-Claude-Code-Session-Id", claudeCodeSessionId(cred.token));
      headers.set("x-client-request-id", crypto.randomUUID());
    } else {
      // The ChatGPT backend scopes a token to one account and rejects the call without it.
      if (cred.accountId) headers.set("ChatGPT-Account-Id", cred.accountId);
      headers.set("originator", SAGEROUTE_ORIGINATOR);
      headers.set("session_id", crypto.randomUUID());
    }
  } else if (cred.apiKey) {
    if (isAnthropic) {
      // Anthropic authenticates on its own header and rejects a bare bearer token.
      headers.set("x-api-key", cred.apiKey);
    } else {
      headers.set("Authorization", `Bearer ${cred.apiKey}`);
    }
  }

  if (isAnthropic) headers.set("anthropic-version", ANTHROPIC_VERSION);
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
 * Collapse a Responses SSE stream back into the single JSON object it describes.
 *
 * Needed because the transport and the caller can disagree: the ChatGPT subscription
 * backend only accepts `stream: true`, but a caller that asked for a plain object still
 * expects one. Responses streaming emits the completed object nested under `response`,
 * so the last such frame is the authoritative result.
 */
async function collapseResponsesStream(
  source: ReadableStream<Uint8Array>,
): Promise<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = "";
  let latest: Record<string, unknown> = {};
  // The ChatGPT backend's terminal frame carries an EMPTY `output` array; the actual
  // message items only ever arrive on `response.output_item.done`. Collecting them here
  // is what keeps a reassembled turn from looking like a successful empty answer.
  const items: Array<Record<string, unknown>> = [];

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
        const event = JSON.parse(payload) as unknown;
        if (!isObj(event)) continue;
        if (event.type === "response.output_item.done" && isObj(event.item)) {
          items.push(event.item);
          continue;
        }
        if (isObj(event.response)) latest = event.response;
        else if (event.object === "response") latest = event;
      } catch {
        // A partial or non-JSON frame is not worth failing the turn over.
      }
    }
  }

  const existing = latest.output;
  const hasOutput = Array.isArray(existing) && existing.length > 0;
  return hasOutput || items.length === 0 ? latest : { ...latest, output: items };
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
  credential: CredentialInput,
  fetchImpl: typeof fetch = fetch,
): Promise<UpstreamResult> {
  const adapter = request.config.adapter ?? "openai-responses";
  const base = request.config.baseUrl.replace(/\/+$/, "");
  const isChat = adapter === "openai-chat";
  const isAnthropic = adapter === "anthropic-messages";
  const url = `${base}${isAnthropic ? "/messages" : isChat ? "/chat/completions" : "/responses"}`;
  const cred = normalizeCredential(credential);
  const isOAuth = cred.mode === "oauth";
  // The ChatGPT subscription backend refuses a non-streaming body with
  // 400 "Stream must be set to true". Found against the live vendor; no stub enforces
  // it. The transport is therefore forced to stream even when the caller asked for a
  // single JSON object, and the events are reassembled below.
  const forceStream = isOAuth && cred.provider === "openai" && !isAnthropic && !isChat;
  let payload: Record<string, unknown>;
  if (isAnthropic) {
    payload = responsesToAnthropic(request.body, request.model);
    // An Anthropic OAuth token is scoped to Claude Code, so the body must present as it.
    if (isOAuth) payload = applyClaudeCodeIdentity(payload);
  } else if (isChat) {
    // A caller that already sent a native Chat body is passed through untouched;
    // translating it would drop `messages` on the floor.
    payload = Array.isArray(request.body.messages)
      ? { ...request.body, model: request.model }
      : responsesToChat(request.body, request.model);
  } else {
    payload = { ...request.body, model: request.model };
    // The ChatGPT backend does not persist response items for a subscription caller, so
    // forwarded item ids would reference stored objects that do not exist and 404.
    if (isOAuth) payload = withoutStoredItemIds(payload);
    if (forceStream) payload = { ...payload, stream: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let settle: (usage: TurnUsage) => void = () => {};
  const usage = new Promise<TurnUsage>(resolve => { settle = resolve; });

  let upstream: Response;
  try {
    upstream = await fetchImpl(url, {
      method: "POST",
      headers: headersFor(request.config, cred),
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

  // The ChatGPT backend answers a streamed request with SSE frames but sends NO
  // content-type header at all, so sniffing the header alone silently misclassifies the
  // body as JSON and yields an empty object. When the transport forced streaming we
  // already know what is on the wire, so trust that over the missing header.
  const sseBody = Boolean(upstream.body)
    && (forceStream || (upstream.headers.get("content-type") ?? "").includes("text/event-stream"));
  const streaming = request.stream && sseBody;

  if (streaming) {
    const done = (u: TurnUsage): void => { clearTimeout(timer); settle(u); };
    const body = isAnthropic
      ? anthropicStreamToResponses(upstream.body!, request.model, done)
      : isChat
        ? chatStreamToResponses(upstream.body!, request.model, done)
        : meterStream(upstream.body!, done);
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

  // The transport was forced to stream for a caller that asked for a plain object, so
  // put the object back together before answering.
  if (!request.stream && sseBody) {
    const collapsed = await collapseResponsesStream(upstream.body!);
    clearTimeout(timer);
    settle(readUsage(collapsed) ?? { inputTokens: 0, outputTokens: 0 });
    return {
      response: new Response(JSON.stringify(collapsed), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      usage,
    };
  }

  const decoded = await upstream.json().catch(() => ({}));
  clearTimeout(timer);
  const measured = (isAnthropic ? readAnthropicUsage(decoded) : readUsage(decoded))
    ?? { inputTokens: 0, outputTokens: 0 };
  settle(measured);
  const outBody = isAnthropic
    ? anthropicToResponses(decoded, request.model)
    : isChat ? chatToResponses(decoded, request.model) : decoded;
  return {
    response: new Response(JSON.stringify(outBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
    usage,
  };
}
