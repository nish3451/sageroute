#!/usr/bin/env bun
/**
 * `sageroute` command line entry point.
 *
 * Two subcommands, both boring on purpose. `serve` boots the proxy; `check` validates a
 * config and exits, so a deployment can fail in CI rather than at 3am on a live agent
 * run.
 */

import { ConfigError, loadConfigFile } from "./proxy/config";
import { SageRouteProxy } from "./proxy/server";

const USAGE = [
  "sageroute -- trajectory-aware model router",
  "",
  "Usage:",
  "  sageroute serve [--config <path>] [--port <n>] [--host <addr>]",
  "  sageroute check [--config <path>]",
  "",
  "Options:",
  "  --config <path>   Config file. Default: ./sageroute.config.json (or $SAGEROUTE_CONFIG)",
  "  --port <n>        Override the configured listen port",
  "  --host <addr>     Override the configured bind address",
  "  -h, --help        Show this message",
  "",
].join("\n");

function parseArgs(argv: string[]): { command: string; flags: Map<string, string> } {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      flags.set("help", "true");
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        flags.set(arg.slice(2), argv[++i] ?? "");
      }
      continue;
    }
    positional.push(arg);
  }
  return { command: positional[0] ?? "serve", flags };
}

function main(): void {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (flags.has("help")) {
    process.stdout.write(USAGE);
    return;
  }

  const path = flags.get("config")
    ?? process.env.SAGEROUTE_CONFIG
    ?? "./sageroute.config.json";

  let loaded;
  try {
    loaded = loadConfigFile(path);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  if (command === "check") {
    const { router } = loaded;
    process.stdout.write(
      `config ok: ${path}\n`
      + `  alias   ${router.alias}\n`
      + `  cheap   ${router.cheap.provider}/${router.cheap.model}\n`
      + `  strong  ${router.strong.provider}/${router.strong.model}\n`
      + `  sage    ${router.offline || !router.apiKey ? "offline stub" : router.endpoint}\n`,
    );
    return;
  }

  if (command !== "serve") {
    process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
    process.exit(1);
  }

  const portFlag = flags.get("port");
  const port = portFlag ? Number(portFlag) : loaded.raw.port;
  const hostname = flags.get("host") ?? loaded.raw.hostname;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`invalid port: ${portFlag}\n`);
    process.exit(1);
  }

  const proxy = new SageRouteProxy({ config: loaded });
  const server = Bun.serve({
    port,
    hostname,
    idleTimeout: 255,
    fetch: request => proxy.handle(request),
  });

  const { router } = loaded;
  process.stdout.write(
    `sageroute listening on http://${server.hostname}:${server.port}\n`
    + `  request model "${router.alias}" to route by trajectory\n`
    + `  cheap  ${router.cheap.provider}/${router.cheap.model}\n`
    + `  strong ${router.strong.provider}/${router.strong.model}\n`
    + `  sage   ${router.offline || !router.apiKey ? "offline stub (no API key)" : router.endpoint}\n`,
  );
}

main();
