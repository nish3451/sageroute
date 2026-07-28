#!/usr/bin/env bun
/**
 * Live proof against a REAL vendor, using a real subscription login.
 *
 * Every other example in this repo points the ladder at a stub upstream, which proves
 * routing changes which model receives a request but never proves the request is one a
 * vendor will actually accept. This one has no stub: the proxy boots over a real socket
 * and forwards to https://chatgpt.com/backend-api/codex with the stored ChatGPT
 * credential, so the reply is genuine model output.
 *
 *   sageroute auth import openai
 *   bun run examples/live-subscription.ts
 *
 * This spends real subscription quota. It sends two short turns.
 */

import { loadConfigFile } from "../src/proxy/config";
import { SageRouteProxy } from "../src/proxy/server";

const loaded = loadConfigFile("./sageroute.config.json");
const proxy = new SageRouteProxy({ config: loaded });
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (req: Request) => proxy.handle(req),
});
const base = `http://127.0.0.1:${server.port}`;

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(10)} ${value}`);
}

/** Pull the assistant's text out of a Responses payload, whatever shape it arrives in. */
function outputText(body: Record<string, unknown>): string {
  const output = body.output;
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output) {
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const chunk of content) {
      const text = (chunk as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join(" ").trim();
}

async function turn(label: string, prompt: string): Promise<void> {
  console.log(`\n--- ${label} ---`);
  const response = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "sageroute",
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    line("status", `HTTP ${response.status}`);
    // Vendor errors can echo request context, so print a bounded slice only.
    console.log(`  body       ${text.slice(0, 400)}`);
    throw new Error(`upstream rejected the request: HTTP ${response.status}`);
  }

  const body = JSON.parse(text) as Record<string, unknown>;
  line("status", `HTTP ${response.status}`);
  line("model", String(body.model ?? "unknown"));
  line("tier", response.headers.get("x-sageroute-tier") ?? "-");
  line("routed", response.headers.get("x-sageroute-model") ?? "-");
  line("reply", outputText(body).slice(0, 200) || "(no text)");
}

try {
  const { router } = loaded;
  console.log("ladder");
  line("cheap", `${router.cheap.provider}/${router.cheap.model}`);
  line("strong", `${router.strong.provider}/${router.strong.model}`);
  line("upstream", loaded.raw.providers[router.cheap.provider]?.baseUrl ?? "unknown");

  await turn("turn 1: real model call", "Reply with exactly the word: pong");
  await turn("turn 2: second real call", "In one short sentence, what is a proxy server?");

  console.log("\nLIVE SUBSCRIPTION CALL SUCCEEDED");
  console.log("The replies above came from the real vendor, not a stub.");
} finally {
  server.stop(true);
}
