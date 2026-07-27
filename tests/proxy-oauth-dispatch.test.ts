import { describe, expect, test } from "bun:test";
import { applyClaudeCodeIdentity } from "../src/proxy/anthropic";
import {
  dispatchUpstream,
  headersFor,
  withoutStoredItemIds,
  type UpstreamRequest,
} from "../src/proxy/upstream";
import { ANTHROPIC_OAUTH_BETA, CLAUDE_CODE_SYSTEM_INSTRUCTION } from "../src/oauth";
import { claudeCodeSessionId } from "../src/proxy/fingerprint";

function captureFetch(reply: () => Response): {
  fetchImpl: typeof fetch;
  seen: () => { url: string; init: RequestInit | undefined };
} {
  let url = "";
  let init: RequestInit | undefined;
  const fetchImpl = (async (target: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    url = String(target);
    init = options;
    return reply();
  }) as unknown as typeof fetch;
  return { fetchImpl, seen: () => ({ url, init }) };
}

function anthropicReply(): Response {
  return Response.json({
    id: "msg_1",
    content: [{ type: "text", text: "ok" }],
    usage: { input_tokens: 4, output_tokens: 2 },
  });
}

function anthropicRequest(overrides: Partial<UpstreamRequest> = {}): UpstreamRequest {
  return {
    provider: "anthropic",
    config: { adapter: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1" },
    model: "claude-sonnet",
    body: { instructions: "Be terse.", input: "hi" },
    stream: false,
    ...overrides,
  };
}

describe("OAuth request shaping", () => {
  test("Anthropic OAuth uses bearer auth and the Claude Code fingerprint, not x-api-key", () => {
    const headers = headersFor(
      { adapter: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1" },
      { mode: "oauth", provider: "anthropic", token: "oauth-token" },
    );

    expect(headers.get("authorization")).toBe("Bearer oauth-token");
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("anthropic-beta")).toBe(ANTHROPIC_OAUTH_BETA);
    expect(headers.get("X-App")).toBe("cli");
    expect(headers.get("X-Claude-Code-Session-Id")).toBe(claudeCodeSessionId("oauth-token"));
  });

  test("Claude Code session id is stable per token and differs across tokens", () => {
    expect(claudeCodeSessionId("token-a")).toBe(claudeCodeSessionId("token-a"));
    expect(claudeCodeSessionId("token-a")).not.toBe(claudeCodeSessionId("token-b"));
    expect(claudeCodeSessionId("token-a")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("ChatGPT OAuth sends the account id, and key mode never does", () => {
    const oauth = headersFor(
      { baseUrl: "https://chatgpt.com/backend-api/codex" },
      { mode: "oauth", provider: "openai", token: "tok", accountId: "acct_9" },
    );
    expect(oauth.get("authorization")).toBe("Bearer tok");
    expect(oauth.get("ChatGPT-Account-Id")).toBe("acct_9");
    expect(oauth.get("originator")).toBe("sageroute");

    const keyed = headersFor({ baseUrl: "https://api.openai.com/v1" }, "sk-test");
    expect(keyed.get("authorization")).toBe("Bearer sk-test");
    expect(keyed.get("ChatGPT-Account-Id")).toBeNull();
  });

  test("a bare string or null credential still behaves as key mode", () => {
    expect(headersFor({ baseUrl: "https://x.test" }, "sk-a").get("authorization")).toBe("Bearer sk-a");
    expect(headersFor({ baseUrl: "https://x.test" }, null).get("authorization")).toBeNull();
  });

  test("Claude Code identity becomes the first system block and preserves the caller prompt", () => {
    const shaped = applyClaudeCodeIdentity({ system: "Be terse." });
    expect(shaped.system).toEqual([
      { type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION },
      { type: "text", text: "Be terse." },
    ]);

    // A request with no system prompt still has to lead with the identity block.
    expect(applyClaudeCodeIdentity({}).system).toEqual([
      { type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION },
    ]);
  });

  test("applying the Claude Code identity twice does not duplicate the block", () => {
    const once = applyClaudeCodeIdentity({ system: "Be terse." });
    const twice = applyClaudeCodeIdentity(once);
    expect(twice.system).toEqual(once.system);
  });

  test("dispatch shapes the Anthropic body only in OAuth mode", async () => {
    const oauthCapture = captureFetch(anthropicReply);
    await dispatchUpstream(
      anthropicRequest(),
      { mode: "oauth", provider: "anthropic", token: "oauth-token" },
      oauthCapture.fetchImpl,
    );
    const oauthBody = JSON.parse(String(oauthCapture.seen().init?.body)) as Record<string, unknown>;
    expect(oauthBody.system).toEqual([
      { type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION },
      { type: "text", text: "Be terse." },
    ]);

    const keyCapture = captureFetch(anthropicReply);
    await dispatchUpstream(anthropicRequest(), "sk-key", keyCapture.fetchImpl);
    const keyBody = JSON.parse(String(keyCapture.seen().init?.body)) as Record<string, unknown>;
    expect(keyBody.system).toBe("Be terse.");
    expect(new Headers(keyCapture.seen().init?.headers).get("anthropic-beta")).toBeNull();
  });

  test("ChatGPT OAuth turns off storage and strips item ids while keeping call_id pairing", () => {
    const shaped = withoutStoredItemIds({
      input: [
        { id: "msg_1", type: "message", role: "user", content: "hi" },
        { id: "fc_1", type: "function_call", call_id: "call_1", name: "read", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
      ],
    });

    expect(shaped.store).toBe(false);
    const input = shaped.input as Array<Record<string, unknown>>;
    expect(input.every(item => !("id" in item))).toBe(true);
    // call_id is the evidence layer's join key and must survive.
    expect(input[1]?.call_id).toBe("call_1");
    expect(input[2]?.call_id).toBe("call_1");
  });

  test("dispatch strips item ids for a ChatGPT OAuth turn but leaves a keyed turn intact", async () => {
    const responsesRequest = (): UpstreamRequest => ({
      provider: "openai",
      config: { baseUrl: "https://chatgpt.com/backend-api/codex" },
      model: "gpt-5",
      body: { input: [{ id: "msg_1", type: "message", role: "user", content: "hi" }] },
      stream: false,
    });
    const reply = (): Response => Response.json({ id: "resp_1", output: [], usage: {} });

    const oauthCapture = captureFetch(reply);
    await dispatchUpstream(
      responsesRequest(),
      { mode: "oauth", provider: "openai", token: "tok", accountId: "acct_1" },
      oauthCapture.fetchImpl,
    );
    const oauthBody = JSON.parse(String(oauthCapture.seen().init?.body)) as Record<string, unknown>;
    expect(oauthBody.store).toBe(false);
    expect((oauthBody.input as Array<Record<string, unknown>>)[0]).not.toHaveProperty("id");

    const keyCapture = captureFetch(reply);
    await dispatchUpstream(responsesRequest(), "sk-key", keyCapture.fetchImpl);
    const keyBody = JSON.parse(String(keyCapture.seen().init?.body)) as Record<string, unknown>;
    expect(keyBody).not.toHaveProperty("store");
    expect((keyBody.input as Array<Record<string, unknown>>)[0]?.id).toBe("msg_1");
  });
});
