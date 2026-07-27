/**
 * Live end-to-end proof for SageRoute.
 *
 * Boots the real proxy over a real TCP socket, points both ladder tiers at a local stub
 * upstream, and drives genuine trajectories through `/v1/responses` while calling the
 * REAL Levanto Sage API for every verdict. Nothing on the decision path is mocked: the
 * alias intercept, evidence extraction, signal detection, the two-stage Sage gate, the
 * guardrails, and the tier swap all run exactly as they would in production.
 *
 * The stub upstream records which model each turn actually reached. That record IS the
 * proof -- a routing decision is only real if it changes what the upstream receives.
 *
 *   export SAGE_API_KEY=lv_...
 *   bun run examples/live-e2e.ts
 */

import { prepareConfig } from "../src/proxy/config";
import { SageRouteProxy } from "../src/proxy/server";
import { clearSageRouteSessions, listSessions } from "../src/core";

const SAGE_KEY = (process.env.SAGE_API_KEY ?? "").trim();
if (!SAGE_KEY) {
  console.error("SAGE_API_KEY is required for the live run");
  process.exit(1);
}

// ------------------------------------------------------------------ stub upstream
const upstreamModels: string[] = [];
const upstream = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const body = await req.json() as { model?: string };
    upstreamModels.push(String(body.model));
    return Response.json({
      id: `resp_${upstreamModels.length}`,
      object: "response",
      model: body.model,
      status: "completed",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `working (turn ${upstreamModels.length})` }],
      }],
      usage: { input_tokens: 1200, output_tokens: 300, total_tokens: 1500 },
    });
  },
});

// ------------------------------------------------------------------ the proxy
function boot(overrides: Record<string, unknown> = {}) {
  const loaded = prepareConfig({
    port: 0,
    hostname: "127.0.0.1",
    providers: {
      stub: {
        adapter: "openai-responses",
        baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "stub-key",
        allowPrivateNetwork: true,
        models: ["cheap-model", "strong-model"],
      },
    },
    sageRoute: {
      enabled: true,
      cheap: { provider: "stub", model: "cheap-model", inputPerMTok: 0.4, outputPerMTok: 1.6 },
      strong: { provider: "stub", model: "strong-model", inputPerMTok: 2.0, outputPerMTok: 8.0 },
      apiKey: SAGE_KEY,
      checkpointEvery: 1,
      firstCheckpointAt: 3,
      ...overrides,
    },
  });
  const router = new SageRouteProxy({ config: loaded });
  return Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: r => router.handle(r) });
}

// ------------------------------------------------------------------ trajectories
function call(id: string, tool: string, args: string) {
  return { type: "function_call", call_id: id, name: tool, arguments: args };
}
function output(id: string, text: string) {
  return { type: "function_call_output", call_id: id, output: text };
}
function user(text: string) {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

/** A genuinely failing run: writes a fix, runs the tests, fails, repeats. */
function failingInput(turn: number): unknown[] {
  const items: unknown[] = [user("Fix the failing test in src/parser.ts")];
  for (let i = 1; i <= turn + 2; i++) {
    items.push(call(`w${i}`, "apply_patch", `{"path":"src/parser.ts","attempt":${i}}`));
    items.push(output(`w${i}`, "patch applied"));
    items.push(call(`t${i}`, "shell", '{"cmd":"bun test"}'));
    items.push(output(`t${i}`, "AssertionError: expected 4 to equal 5\n1 failed. exit code 1"));
  }
  return items;
}

/** A healthy run: every command succeeds. */
function healthyInput(turn: number): unknown[] {
  const items: unknown[] = [user("Add a changelog entry for the release")];
  for (let i = 1; i <= turn + 2; i++) {
    items.push(call(`e${i}`, "shell", `{"cmd":"bun test --filter step${i}"}`));
    items.push(output(`e${i}`, `ran 12 tests, 12 passed in 0.4s`));
  }
  return items;
}

async function turn(base: string, sessionKey: string, input: unknown[]) {
  const res = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "sageroute", input, prompt_cache_key: sessionKey }),
  });
  await res.text();
  return {
    model: res.headers.get("x-sageroute-model") ?? "",
    tier: res.headers.get("x-sageroute-tier") ?? "",
    action: res.headers.get("x-sageroute-action") ?? "",
    intervention: res.headers.get("x-sageroute-intervention") ?? "-",
    source: res.headers.get("x-sageroute-source") ?? "-",
    checkpoint: res.headers.get("x-sageroute-checkpoint") === "true",
  };
}

function report(label: string, rows: Array<Record<string, unknown>>): void {
  console.log(`\n--- ${label} ---`);
  for (const [i, row] of rows.entries()) {
    console.log(
      `  turn ${i + 1}: ${String(row.tier).padEnd(6)} ${String(row.action).padEnd(14)} `
      + `P(intervene)=${row.intervention} src=${row.source} -> ${row.model}`,
    );
  }
}

async function main(): Promise<void> {
  let failures = 0;
  const expect = (label: string, ok: boolean, detail: string): void => {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` -- ${detail}`}`);
    if (!ok) failures += 1;
  };

  // ---------------------------------------------------------- 1. failing trajectory
  clearSageRouteSessions();
  upstreamModels.length = 0;
  let server = boot();
  let base = `http://127.0.0.1:${server.port}`;

  const failing = [];
  for (let t = 0; t < 5; t++) failing.push(await turn(base, "live-failing", failingInput(t)));
  report("failing trajectory (real Sage)", failing);
  console.log(`  upstream saw: ${upstreamModels.join(", ")}`);

  console.log("\n  assertions:");
  expect(
    "escalated off the cheap tier",
    failing.some(r => r.tier === "strong"),
    "never reached the strong tier",
  );
  expect(
    "the escalation reached the real upstream",
    upstreamModels.includes("strong-model"),
    `upstream only saw ${[...new Set(upstreamModels)].join(", ")}`,
  );
  expect(
    "the verdict came from the live Sage API",
    failing.some(r => r.source === "sage"),
    "no turn was decided by sage",
  );
  server.stop(true);

  // ---------------------------------------------------------- 2. healthy trajectory
  clearSageRouteSessions();
  upstreamModels.length = 0;
  server = boot();
  base = `http://127.0.0.1:${server.port}`;

  const healthy = [];
  for (let t = 0; t < 5; t++) healthy.push(await turn(base, "live-healthy", healthyInput(t)));
  report("healthy trajectory (real Sage)", healthy);
  console.log(`  upstream saw: ${upstreamModels.join(", ")}`);

  console.log("\n  assertions:");
  expect(
    "stayed on the cheap tier throughout",
    healthy.every(r => r.tier === "cheap"),
    "a healthy run was escalated",
  );
  expect(
    "never sent a healthy turn to the expensive model",
    !upstreamModels.includes("strong-model"),
    "the strong model was billed for a healthy run",
  );
  server.stop(true);

  // ---------------------------------------------------------- 3. budget guardrail
  clearSageRouteSessions();
  upstreamModels.length = 0;
  // 1200 in + 300 out at cheap pricing is ~0.00096/turn; a 0.001 cap trips on turn two.
  server = boot({ budgetUsd: 0.001, budgetEscalateFraction: 0.85 });
  base = `http://127.0.0.1:${server.port}`;

  const budget = [];
  for (let t = 0; t < 4; t++) budget.push(await turn(base, "live-budget", failingInput(t)));
  report("budget guardrail", budget);

  console.log("\n  assertions:");
  const stop = budget.find(r => r.action === "escalate_human");
  expect("budget rung fired", Boolean(stop), "no turn escalated to human review");
  expect(
    "the budget stop was decided locally, without paying Sage",
    stop?.source === "local",
    `source was "${stop?.source}" rather than "local"`,
  );

  const sessions = listSessions();
  expect(
    "the cost ledger recorded real token usage",
    sessions.some(s => s.costUsd > 0),
    "every session ledger was zero",
  );
  server.stop(true);
  upstream.stop(true);

  console.log(`\n${failures === 0 ? "ALL LIVE CHECKS PASSED" : `${failures} LIVE CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
