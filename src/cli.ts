#!/usr/bin/env bun
/**
 * `sageroute` command line entry point.
 *
 * `serve` boots the proxy; `check` validates a config and exits, so a deployment can
 * fail in CI rather than at 3am on a live agent run.
 */

import {
  authFilePath,
  deleteCredentials,
  listCredentials,
  loginAnthropic,
  loginOpenAI,
  saveCredentials,
  OAuthError,
  type OAuthCredentialSummary,
  type OAuthCredentials,
  type OAuthFlowController,
  type OAuthProviderId,
} from "./oauth";
import { ConfigError, loadConfigFile } from "./proxy/config";
import { SageRouteProxy } from "./proxy/server";

const PROVIDERS: readonly OAuthProviderId[] = ["openai", "anthropic"];

const USAGE = [
  "sageroute -- trajectory-aware model router",
  "",
  "Usage:",
  "  sageroute serve [--config <path>] [--port <n>] [--host <addr>]",
  "  sageroute check [--config <path>]",
  "  sageroute auth login <provider>",
  "  sageroute auth logout <provider>",
  "  sageroute auth status",
  "",
  "Auth providers:",
  "  openai, anthropic",
  "",
  "Options:",
  "  --config <path>   Config file. Default: ./sageroute.config.json (or $SAGEROUTE_CONFIG)",
  "  --port <n>        Override the configured listen port",
  "  --host <addr>     Override the configured bind address",
  "  -h, --help        Show this message",
  "",
].join("\n");

interface ParsedArgs {
  command: string;
  flags: Map<string, string>;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
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
  return { command: positional[0] ?? "serve", flags, positional };
}

function supportedProviders(): string {
  return PROVIDERS.join(", ");
}

function isProvider(value: string | undefined): value is OAuthProviderId {
  return value === "openai" || value === "anthropic";
}

function requireProvider(value: string | undefined): OAuthProviderId {
  if (isProvider(value)) return value;
  const reason = value ? `unsupported auth provider "${value}"` : "missing auth provider";
  process.stderr.write(`${reason}\nSupported providers: ${supportedProviders()}\n`);
  process.exit(1);
}

function formatLocalTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString();
}

function expiryStatus(summary: OAuthCredentialSummary, now: number = Date.now()): string {
  const localTime = formatLocalTime(summary.expires);
  if (summary.expires <= now) return `expired at ${localTime}`;
  return `expires at ${localTime}`;
}

function openBrowser(url: string): void {
  let command: string[] | null = null;
  switch (process.platform) {
    case "darwin":
      command = ["open", url];
      break;
    case "linux":
      command = ["xdg-open", url];
      break;
    case "win32":
      command = ["cmd", "/c", "start", "", url];
      break;
  }

  if (!command) return;
  try {
    Bun.spawn(command, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // The printed URL is the reliable fallback across headless and locked-down shells.
  }
}

function loginForProvider(
  provider: OAuthProviderId,
  controller: OAuthFlowController,
): Promise<OAuthCredentials> {
  switch (provider) {
    case "openai":
      return loginOpenAI(controller);
    case "anthropic":
      return loginAnthropic(controller);
  }
}

async function authLogin(provider: OAuthProviderId): Promise<void> {
  const controller: OAuthFlowController = {
    onAuthUrl: url => {
      process.stdout.write(`Open this URL in your browser to continue ${provider} OAuth login:\n${url}\n`);
      openBrowser(url);
    },
    onProgress: message => {
      process.stdout.write(`${message}\n`);
    },
  };

  const credentials = await loginForProvider(provider, controller);
  await saveCredentials(provider, credentials);

  const account = credentials.email ? ` as ${credentials.email}` : "";
  process.stdout.write(
    `Logged in to ${provider}${account}.\n`
    + `Credentials expire at ${formatLocalTime(credentials.expires)}.\n`,
  );
}

async function authLogout(provider: OAuthProviderId): Promise<void> {
  const stored = await listCredentials();
  const hadCredentials = Boolean(stored[provider]);
  await deleteCredentials(provider);
  if (hadCredentials) {
    process.stdout.write(`Removed stored ${provider} OAuth credentials.\n`);
  } else {
    process.stdout.write(`No stored ${provider} OAuth credentials found.\n`);
  }
}

async function authStatus(): Promise<void> {
  const stored = await listCredentials();
  const present = PROVIDERS.filter(provider => stored[provider]);
  process.stdout.write(`Auth file: ${authFilePath()}\n`);

  if (present.length === 0) {
    process.stdout.write("No stored OAuth credentials. Run: sageroute auth login <provider>\n");
    return;
  }

  for (const provider of present) {
    const summary = stored[provider]!;
    process.stdout.write(`${provider}\n`);
    if (summary.email) process.stdout.write(`  email      ${summary.email}\n`);
    if (summary.accountId) process.stdout.write(`  account id ${summary.accountId}\n`);
    process.stdout.write(`  status     ${expiryStatus(summary)}\n`);
  }
}

async function runAuthCommand(positional: string[]): Promise<void> {
  const subcommand = positional[1];
  if (subcommand === "login") {
    await authLogin(requireProvider(positional[2]));
    return;
  }
  if (subcommand === "logout") {
    await authLogout(requireProvider(positional[2]));
    return;
  }
  if (subcommand === "status") {
    await authStatus();
    return;
  }

  const label = subcommand ? `unknown auth command "${subcommand}"` : "missing auth command";
  process.stderr.write(`${label}\n\n${USAGE}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { command, flags, positional } = parseArgs(process.argv.slice(2));
  if (flags.has("help")) {
    process.stdout.write(USAGE);
    return;
  }

  if (command === "auth") {
    await runAuthCommand(positional);
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

main().catch(err => {
  if (err instanceof OAuthError) {
    process.stderr.write(`${err.message}\n`);
  } else if (err instanceof Error) {
    process.stderr.write(`${err.stack ?? err.message}\n`);
  } else {
    process.stderr.write(`${String(err)}\n`);
  }
  process.exit(1);
});
