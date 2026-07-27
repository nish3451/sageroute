#!/usr/bin/env bun
/**
 * Live OAuth proof over real sockets.
 *
 * The vendors are stubbed, because a real ChatGPT or Claude subscription token cannot be
 * minted in CI. What is NOT stubbed is everything this project owns: the credential
 * store on disk, the expiry and refresh logic, the proxy's credential resolution, and
 * the exact bytes that reach the upstream socket. Unit tests assert the same shaping
 * against an injected fetch; this asserts it survives a real HTTP hop.
 *
 * Run with an isolated HOME so the developer's own ~/.sageroute is never touched:
 *   HOME=$(mktemp -d) bun run examples/live-oauth.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { prepareConfig } from "../src/proxy/config";
import { SageRouteProxy } from "../src/proxy/server";

const home = homedir();
if (!home.includes("tmp") && !process.env.SAGEROUTE_ALLOW_REAL_HOME) {
  throw new Error(`refusing to run against a real HOME (${home}); set HOME to a temp dir first`);
}

interface Captured {
  headers: Headers;
  body: Record<string, unknown>;
}

const failures: string[] = [];

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures.push(label);
  console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ""}`);
}

function seedCredentials(store: Record<string, unknown>): void {
  const dir = join(home, ".sageroute");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "auth.json"), `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

/** A stub Anthropic that records exactly what arrived on the wire. */
function startVendor(captured: Captured[]): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      captured.push({ headers: new Headers(request.headers), body });
      return Response.json({
        id: "msg_live",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 11, output_tokens: 3 },
      });
    },
  });
}

/** A stub Anthropic token endpoint, to exercise refresh without a real vendor. */
function startTokenServer(hits: { count: number }): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch() {
      hits.count += 1;
      return Response.json({
        access_token: "refreshed-access-token",
        refresh_token: "refreshed-refresh-token",
        expires_in: 3600,
        account: { uuid: "acct_live", email_address: "live@example.com" },
      });
    },
  });
}

function configFor(vendorUrl: string): ReturnType<typeof prepareConfig> {
  return prepareConfig({
    port: 0,
    hostname: "127.0.0.1",
    providers: {
      anthropic: {
        adapter: "anthropic-messages",
        baseUrl: vendorUrl,
        authMode: "oauth",
        // The stub vendor is on loopback, which the SSRF guard blocks by default.
        allowPrivateNetwork: true,
        models: ["claude-haiku-4-5-20251001", "claude-sonnet-4-5-20250929"],
      },
    },
    sageRoute: {
      enabled: true,
      alias: "sageroute",
      cheap: { provider: "anthropic", model: "claude-haiku-4-5-20251001", inputPerMTok: 1, outputPerMTok: 5 },
      strong: { provider: "anthropic", model: "claude-sonnet-4-5-20250929", inputPerMTok: 3, outputPerMTok: 15 },
      offline: true,
    },
  });
}

async function main(): Promise<void> {
  const captured: Captured[] = [];
  const vendor = startVendor(captured);
  const vendorUrl = `http://127.0.0.1:${vendor.port}/v1`;

  // 1. A valid, unexpired subscription credential.
  console.log("\n[1] valid OAuth credential reaches the vendor as Claude Code");
  seedCredentials({
    anthropic: {
      access: "live-access-token",
      refresh: "live-refresh-token",
      expires: Date.now() + 60 * 60 * 1000,
      email: "live@example.com",
      accountId: "acct_live",
    },
  });

  const proxy = new SageRouteProxy({ config: configFor(vendorUrl) });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: r => proxy.handle(r) });
  const base = `http://127.0.0.1:${server.port}`;

  const response = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "sageroute",
      instructions: "Be terse.",
      input: [{ type: "message", role: "user", content: "hi" }],
    }),
  });

  check("proxy returned 200", response.status === 200, `got ${response.status}`);
  check("routing headers present", response.headers.get("x-sageroute-tier") === "cheap");

  const first = captured[0];
  check("vendor was called", first !== undefined);
  if (first) {
    check(
      "Authorization is the OAuth bearer token",
      first.headers.get("authorization") === "Bearer live-access-token",
    );
    check("x-api-key is absent", first.headers.get("x-api-key") === null);
    check(
      "anthropic-beta advertises Claude Code and OAuth",
      (first.headers.get("anthropic-beta") ?? "").includes("oauth-2025-04-20"),
    );
    check("Claude Code fingerprint sent", first.headers.get("x-app") === "cli");
    check("session id sent", Boolean(first.headers.get("x-claude-code-session-id")));

    const system = first.body.system;
    const blocks = Array.isArray(system) ? system as Array<Record<string, unknown>> : [];
    check(
      "first system block is the Claude Code identity",
      typeof blocks[0]?.text === "string"
        && (blocks[0]!.text as string).includes("Claude Agent SDK"),
      JSON.stringify(system),
    );
    check(
      "caller instructions preserved as a later block",
      blocks.some(b => b.text === "Be terse."),
      JSON.stringify(system),
    );
  }

  // 2. An expired credential must refresh before the turn, not fail it.
  console.log("\n[2] expired credential refreshes automatically");
  const hits = { count: 0 };
  const tokenServer = startTokenServer(hits);
  const originalFetch = globalThis.fetch;
  // The Anthropic token URL is a module constant, so redirect it at the network edge.
  globalThis.fetch = ((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const target = String(url) === "https://api.anthropic.com/v1/oauth/token"
      ? `http://127.0.0.1:${tokenServer.port}/token`
      : url;
    return originalFetch(target as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;

  seedCredentials({
    anthropic: {
      access: "stale-access-token",
      refresh: "live-refresh-token",
      expires: Date.now() - 1000,
      email: "live@example.com",
      accountId: "acct_live",
    },
  });

  const refreshed = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "sageroute", input: [{ type: "message", role: "user", content: "hi" }] }),
  });
  check("refreshed turn returned 200", refreshed.status === 200, `got ${refreshed.status}`);
  check("token endpoint was called exactly once", hits.count === 1, `called ${hits.count} times`);
  const second = captured[1];
  check(
    "vendor received the REFRESHED token, not the stale one",
    second?.headers.get("authorization") === "Bearer refreshed-access-token",
    second?.headers.get("authorization") ?? "none",
  );

  const persisted = await Bun.file(join(home, ".sageroute", "auth.json")).json() as Record<string, { access?: string }>;
  check("refreshed token was persisted to disk", persisted.anthropic?.access === "refreshed-access-token");

  globalThis.fetch = originalFetch;

  // 3. No credential at all is an actionable 401, not a confusing upstream error.
  console.log("\n[3] missing login is a clear, actionable failure");
  seedCredentials({});
  const unauthorized = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "sageroute", input: [{ type: "message", role: "user", content: "hi" }] }),
  });
  const errorBody = await unauthorized.json() as { error?: { message?: string } };
  check("missing credential returns 401", unauthorized.status === 401, `got ${unauthorized.status}`);
  check(
    "error names the exact fix",
    (errorBody.error?.message ?? "").includes("sageroute auth login anthropic"),
    errorBody.error?.message ?? "none",
  );
  check("no upstream call was made without a credential", captured.length === 2, `${captured.length} calls`);

  server.stop(true);
  vendor.stop(true);
  tokenServer.stop(true);

  console.log("");
  if (failures.length > 0) {
    console.log(`FAILED: ${failures.length} check(s): ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log("ALL LIVE OAUTH CHECKS PASSED");
}

await main();
