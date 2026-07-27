/**
 * The SageRoute proxy server.
 *
 * An OpenAI-compatible endpoint that agent harnesses can point at directly. Requests
 * addressed to the router alias are routed per turn from execution evidence; everything
 * else is passed through to the named provider untouched, so the proxy can be the only
 * endpoint a harness needs to know about.
 *
 * The order of operations in `handleResponses` is deliberate:
 *   1. Decide the tier BEFORE any upstream call, so the decision governs this turn
 *      rather than the next one.
 *   2. Answer a human-escalation verdict locally, without spending a token.
 *   3. Settle the cost ledger AFTER the turn completes, from real usage.
 */

import {
  addTurnCost,
  clientFor,
  concreteRequestBody,
  listSessions,
  pricingFor,
  routeTurn,
  sageRouteIdFromRawBody,
  type RouteTurnResult,
  type SageClient,
} from "../core";
import type { LoadedConfig, ProviderConfig } from "./config";
import { resolveSecret } from "./config";
import { dispatchUpstream, type UpstreamCredential } from "./upstream";
import { getValidAccessToken, loadCredentials, OAuthError } from "../oauth";
import type { OAuthProviderId } from "../oauth";

export interface ServerOptions {
  config: LoadedConfig;
  /** Injectable for tests and for pointing Sage at a stub. */
  fetchImpl?: typeof fetch;
  sageClient?: SageClient;
}

interface ResolvedTarget {
  provider: string;
  config: ProviderConfig;
  model: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status: number, type = "invalid_request_error"): Response {
  return json({ error: { message, type } }, status);
}

/**
 * Split a `provider/model` reference. A bare model id falls back to the single
 * configured provider when there is exactly one, because forcing a prefix on a
 * one-provider deployment is friction with no safety benefit.
 */
export function resolveTarget(ref: string, providers: Record<string, ProviderConfig>): ResolvedTarget | null {
  const slash = ref.indexOf("/");
  if (slash > 0) {
    const provider = ref.slice(0, slash);
    const model = ref.slice(slash + 1);
    const config = providers[provider];
    if (config && model) return { provider, config, model };
    return null;
  }
  const names = Object.keys(providers);
  if (names.length === 1) {
    const only = names[0]!;
    return { provider: only, config: providers[only]!, model: ref };
  }
  for (const [name, config] of Object.entries(providers)) {
    if (config.models?.includes(ref)) return { provider: name, config, model: ref };
  }
  return null;
}

/** Synthesize the assistant turn that carries a human-escalation notice. */
/**
 * Resolve the credential one provider should authenticate with.
 *
 * In `oauth` mode the stored login is the source of truth and is refreshed on demand, so
 * a long agent run does not die mid-trajectory on an expired access token. The account id
 * is read alongside it because the ChatGPT backend requires it on every call.
 */
export async function credentialFor(
  name: string,
  config: ProviderConfig,
): Promise<UpstreamCredential> {
  if ((config.authMode ?? "key") !== "oauth") {
    return { mode: "key", apiKey: resolveSecret(config.apiKey) ?? null };
  }
  const provider = (config.oauthProvider ?? name) as OAuthProviderId;
  const token = await getValidAccessToken(provider);
  const stored = await loadCredentials(provider);
  return { mode: "oauth", provider, token, accountId: stored?.accountId };
}

function escalationResponse(notice: string, model: string, stream: boolean): Response {
  const body = {
    id: `resp_${Date.now().toString(36)}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "completed",
    output: [{
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: notice }],
    }],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
  if (!stream) return json(body);

  const encoder = new TextEncoder();
  const send = (type: string, payload: Record<string, unknown>): string =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
  const sse = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(send("response.created", {
        response: { id: body.id, object: "response", model, status: "in_progress" },
      })));
      controller.enqueue(encoder.encode(send("response.output_text.delta", {
        delta: notice, item_id: `${body.id}-0`, output_index: 0,
      })));
      controller.enqueue(encoder.encode(send("response.completed", { response: body })));
      controller.close();
    },
  });
  return new Response(sse, {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

export class SageRouteProxy {
  private readonly sage: SageClient;

  constructor(private readonly options: ServerOptions) {
    this.sage = options.sageClient ?? clientFor(options.config.router, options.fetchImpl);
  }

  /** Bearer check. Absent `authToken` means the proxy trusts its network. */
  private authorized(request: Request): boolean {
    const expected = this.options.config.authToken;
    if (!expected) return true;
    const header = request.headers.get("authorization") ?? "";
    return header.startsWith("Bearer ") && header.slice(7).trim() === expected;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/health") return json({ status: "ok", router: "sageroute" });
    if (!this.authorized(request)) return errorResponse("missing or invalid bearer token", 401, "authentication_error");
    if (path === "/v1/models" || path === "/models") return this.handleModels();
    if (path === "/v1/sageroute/sessions") return this.handleSessions();
    if (path === "/v1/responses" || path === "/responses") {
      if (request.method !== "POST") return errorResponse("method not allowed", 405);
      return this.handleResponses(request);
    }
    if (path === "/v1/chat/completions" || path === "/chat/completions") {
      if (request.method !== "POST") return errorResponse("method not allowed", 405);
      return this.handleChatCompletions(request);
    }
    return errorResponse(`unknown route ${path}`, 404);
  }

  private handleModels(): Response {
    const { raw, router } = this.options.config;
    const created = Math.floor(Date.now() / 1000);
    const rows: Array<Record<string, unknown>> = [{
      id: router.alias,
      object: "model",
      created,
      owned_by: "sageroute",
      sageroute: {
        cheap: `${router.cheap.provider}/${router.cheap.model}`,
        strong: `${router.strong.provider}/${router.strong.model}`,
      },
    }];
    for (const [name, provider] of Object.entries(raw.providers)) {
      for (const model of provider.models ?? []) {
        rows.push({ id: `${name}/${model}`, object: "model", created, owned_by: name });
      }
    }
    return json({ object: "list", data: rows });
  }

  /** Observability: what the router decided, per session, and what it cost. */
  private handleSessions(): Response {
    return json({
      object: "list",
      data: listSessions().map(session => ({
        id: session.id,
        tier: session.tier,
        turns: session.turns,
        cost_usd: Number(session.costUsd.toFixed(6)),
        switches_used: session.switchesUsed,
        restarts_used: session.restartsUsed,
        sage_calls: session.sageCalls,
        escalated: session.escalated,
        created_at: session.createdAt,
        last_seen_at: session.lastSeenAt,
        history: session.history,
      })),
    });
  }

  private async handleResponses(request: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return errorResponse("request body must be valid JSON", 400);
    }

    const { raw, router } = this.options.config;
    const stream = body.stream === true;

    // Not addressed to the router: pass through untouched.
    if (!sageRouteIdFromRawBody(body, { sageRoute: raw.sageRoute })) {
      const ref = typeof body.model === "string" ? body.model : "";
      const target = resolveTarget(ref, raw.providers);
      if (!target) return errorResponse(`unknown model "${ref}"`, 404, "model_not_found");
      return this.send(target, body, stream);
    }

    // Route this turn from the trajectory the client just sent us.
    const decision = await routeTurn(body, request.headers, router, this.sage);

    // A human-escalation notice is still a routing decision, so it carries the same
    // observability headers as a forwarded turn. Answering it bare would make the one
    // turn an operator most needs to explain the least explicable on the wire.
    if (decision.escalateNotice) {
      const notice = escalationResponse(decision.escalateNotice, router.alias, stream);
      return this.withDecisionHeaders(notice, decision);
    }

    const restart = decision.session.restartPending;
    if (restart) decision.session.restartPending = false;
    const routed = concreteRequestBody(body, decision.modelRef, restart);

    const target = resolveTarget(decision.modelRef, raw.providers);
    if (!target) {
      return errorResponse(`ladder tier "${decision.modelRef}" is not a configured provider`, 500, "api_error");
    }

    const response = await this.send(target, routed, stream, usage => {
      addTurnCost(decision.session, usage, pricingFor(router, decision.tier));
    });
    return this.withDecisionHeaders(response, decision);
  }

  /** Surface the decision on the wire so operators can see routing without log access. */
  private withDecisionHeaders(response: Response, decision: RouteTurnResult): Response {
    const headers = new Headers(response.headers);
    headers.set("x-sageroute-model", decision.modelRef);
    headers.set("x-sageroute-tier", decision.tier);
    headers.set("x-sageroute-action", decision.action);
    headers.set("x-sageroute-session", decision.session.id);
    headers.set("x-sageroute-checkpoint", String(decision.checkpointed));
    if (decision.verdict) {
      headers.set("x-sageroute-intervention", decision.verdict.interventionProbability.toFixed(3));
      headers.set("x-sageroute-source", decision.verdict.source);
    }
    return new Response(response.body, { status: response.status, headers });
  }

  /**
   * Chat Completions clients get the same router by translating into the Responses
   * shape, routing, and translating the answer back.
   */
  private async handleChatCompletions(request: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return errorResponse("request body must be valid JSON", 400);
    }
    const { raw } = this.options.config;
    if (!sageRouteIdFromRawBody(body, { sageRoute: raw.sageRoute })) {
      const ref = typeof body.model === "string" ? body.model : "";
      const target = resolveTarget(ref, raw.providers);
      if (!target) return errorResponse(`unknown model "${ref}"`, 404, "model_not_found");
      return this.send({ ...target, config: { ...target.config, adapter: "openai-chat" } }, body, body.stream === true);
    }
    return errorResponse(
      "the SageRoute alias requires the /v1/responses endpoint, which carries the tool-call "
      + "history the router reasons about",
      400,
    );
  }

  private async send(
    target: ResolvedTarget,
    body: Record<string, unknown>,
    stream: boolean,
    onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void,
  ): Promise<Response> {
    let credential: UpstreamCredential;
    try {
      credential = await credentialFor(target.provider, target.config);
    } catch (err) {
      // A missing or unrefreshable login is an operator problem, not an upstream fault,
      // and the message carries the exact command that fixes it.
      if (err instanceof OAuthError) return errorResponse(err.message, 401, "authentication_error");
      throw err;
    }
    try {
      const result = await dispatchUpstream(
        { provider: target.provider, config: target.config, model: target.model, body, stream },
        credential,
        this.options.fetchImpl,
      );
      if (onUsage) void result.usage.then(onUsage);
      return result.response;
    } catch (err) {
      return errorResponse(err instanceof Error ? err.message : String(err), 502, "api_error");
    }
  }
}

export function createProxy(options: ServerOptions): SageRouteProxy {
  return new SageRouteProxy(options);
}
