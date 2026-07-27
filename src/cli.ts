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
import {
  ConfigError,
  loadConfigFile,
  resolveAuthMode,
  type LoadedConfig,
} from "./proxy/config";
import { existsSync, writeFileSync } from "node:fs";
import { SageRouteProxy } from "./proxy/server";
import { configFromPlan, detectLogins, planInit } from "./init";

const PROVIDERS: readonly OAuthProviderId[] = ["openai", "anthropic"];

/**
 * Report which credential a ladder tier will actually authenticate with.
 *
 * Under the default `auto` mode this is inferred rather than declared, so surfacing it
 * in `check` is what keeps the choice from being a surprise discovered at runtime.
 */
function tierAuthSuffix(loaded: LoadedConfig, providerName: string): string {
  const provider = loaded.raw.providers[providerName];
  if (!provider) return "";
  if (resolveAuthMode(providerName, provider) === "oauth") {
    return "  [oauth subscription]";
  }
  return provider.apiKey === undefined ? "  [no credential]" : "  [api key]";
}

const USAGE = [
  "sageroute -- trajectory-aware model router",
  "",
  "Usage:",
  "  sageroute init [--config <path>] [--force]",
  "  sageroute serve [--config <path>] [--port <n>] [--host <addr>]",
  "                  generates a config on first run if none exists",
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
  "  --force           Overwrite an existing config during init",
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

/**
 * Write a config that is valid for THIS machine.
 *
 * The previous first run was copy an example, hand-edit JSON, guess at environment
 * variables. Each of those is a chance to produce a file that fails validation before
 * the router has done anything worth seeing. This inspects the credentials that
 * actually exist and generates a matching ladder.
 */
async function runInit(flags: Map<string, string>): Promise<void> {
  const path = configPath(flags);

  if (existsSync(path) && !flags.has("force")) {
    process.stderr.write(
      `refusing to overwrite existing config: ${path}\n`
      + "Pass --force to replace it, or --config <path> to write somewhere else.\n",
    );
    process.exit(1);
  }

  const loaded = await writeGeneratedConfig(path);
  if (loaded) process.stdout.write(nextSteps([]));
}

/**
 * Generate, write, and validate a config, reporting what was produced.
 *
 * Returns the loaded config, or undefined when the generated file still needs a
 * credential. Shared by `init` and by `serve`'s first-run bootstrap so both paths
 * produce byte-identical files and identical explanations.
 */
async function writeGeneratedConfig(path: string): Promise<LoadedConfig | undefined> {
  const plan = planInit({ logins: await detectLogins(), env: process.env });
  writeFileSync(path, `${JSON.stringify(configFromPlan(plan), null, 2)}\n`, "utf8");

  process.stdout.write(`wrote ${path}\n`);
  for (const note of plan.notes) process.stdout.write(`  ${note}\n`);

  // Validate immediately so a broken first run is reported here rather than at serve
  // time, and so the credential each tier resolved to is visible up front.
  let loaded: LoadedConfig;
  try {
    loaded = loadConfigFile(path);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stdout.write(`\nconfig needs attention:\n${err.message}\n`);
      process.stdout.write(nextSteps(plan.notes));
      return undefined;
    }
    throw err;
  }

  const { router } = loaded;
  process.stdout.write(
    "\nladder\n"
    + `  cheap   ${router.cheap.provider}/${router.cheap.model}${tierAuthSuffix(loaded, router.cheap.provider)}\n`
    + `  strong  ${router.strong.provider}/${router.strong.model}${tierAuthSuffix(loaded, router.strong.provider)}\n`
    + `  sage    ${router.offline || !router.apiKey ? "offline stub (set SAGE_API_KEY for live decisions)" : router.endpoint}\n`,
  );
  return loaded;
}

/** The config path this invocation should use, in precedence order. */
function configPath(flags: Map<string, string>): string {
  return flags.get("config")
    ?? process.env.SAGEROUTE_CONFIG
    ?? "./sageroute.config.json";
}

/** Tell the user the shortest path from here to a running router. */
function nextSteps(notes: readonly string[]): string {
  const lines = ["", "next"];
  if (notes.some(n => n.includes("no credentials detected"))) {
    lines.push("  1. sageroute auth login anthropic   (or export OPENAI_API_KEY)");
    lines.push("  2. sageroute init --force");
    lines.push("  3. sageroute serve");
  } else {
    lines.push("  1. export SAGE_API_KEY=lv_...   https://docs.levanto.ai/");
    lines.push("  2. sageroute serve");
  }
  lines.push("");
  return lines.join("\n");
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

  if (command === "init") {
    await runInit(flags);
    return;
  }

  const path = configPath(flags);

  // First run should not be a dead end. `serve` with no config generates one from the
  // credentials on this machine instead of failing with a bare ENOENT that the user has
  // to translate into a command themselves.
  let loaded: LoadedConfig;
  if (command === "serve" && !existsSync(path)) {
    process.stdout.write(`no config at ${path}; generating one\n`);
    const bootstrapped = await writeGeneratedConfig(path);
    if (!bootstrapped) process.exit(1);
    loaded = bootstrapped;
    process.stdout.write("\n");
  } else {
    try {
      loaded = loadConfigFile(path);
    } catch (err) {
      if (err instanceof ConfigError) {
        process.stderr.write(`${err.message}\n`);
        if (!existsSync(path)) {
          process.stderr.write("Run `sageroute init` to generate one.\n");
        }
        process.exit(1);
      }
      throw err;
    }
  }

  if (command === "check") {
    const { router } = loaded;
    process.stdout.write(
      `config ok: ${path}\n`
      + `  alias   ${router.alias}\n`
      + `  cheap   ${router.cheap.provider}/${router.cheap.model}${tierAuthSuffix(loaded, router.cheap.provider)}\n`
      + `  strong  ${router.strong.provider}/${router.strong.model}${tierAuthSuffix(loaded, router.strong.provider)}\n`
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
