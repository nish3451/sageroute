#!/usr/bin/env bun
/**
 * `sageroute` command line entry point.
 *
 * `serve` boots the proxy; `check` validates a config and exits, so a deployment can
 * fail in CI rather than at 3am on a live agent run.
 */

import {
  authFilePath,
  claudeAuthPath,
  codexAuthPath,
  deleteCredentials,
  discoverImportableCredentials,
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
  formatIssues,
  loadConfigFile,
  proxyConfigIssues,
  resolveAuthMode,
  type LoadedConfig,
} from "./proxy/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { SageRouteProxy } from "./proxy/server";
import { configFromPlan, detectLogins, planInit } from "./init";
import {
  addProvider,
  getRegistryEntry,
  PROVIDER_REGISTRY,
  RegistryError,
  registryIds,
  removeProvider,
  setTier,
} from "./registry";

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
  "  sageroute auth import [provider]",
  "  sageroute auth status",
  "",
  "  sageroute provider list",
  "  sageroute provider add <id> [--name <key>] [--config <path>]",
  "  sageroute provider remove <name> [--config <path>]",
  "  sageroute provider use <cheap|strong> <provider>/<model> [--config <path>]",
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

/**
 * Adopt subscription logins other CLIs already completed on this machine.
 *
 * The browser flow needs a GUI, a loopback port, and a human, which is the slowest part
 * of setup and impossible in a headless session. When Codex or Claude Code has already
 * paid that cost, reusing the credential creates no new grant and skips the whole step.
 */
async function authImport(only?: OAuthProviderId): Promise<void> {
  const found = discoverImportableCredentials()
    .filter(entry => only === undefined || entry.provider === only);

  if (found.length === 0) {
    const scope = only ? `for ${only}` : "on this machine";
    process.stderr.write(
      `No importable subscription logins found ${scope}.\n`
      + `Looked in:\n  ${codexAuthPath()}\n  ${claudeAuthPath()}\n`
      + "Run `sageroute auth login <provider>` to authorize in a browser instead.\n",
    );
    process.exit(1);
  }

  for (const entry of found) {
    await saveCredentials(entry.provider, entry.credentials);
    const account = entry.credentials.email ? ` as ${entry.credentials.email}` : "";
    process.stdout.write(
      `Imported ${entry.provider}${account} from ${entry.sourceTool}\n`
      + `  source  ${entry.sourcePath}\n`
      + `  status  ${expiryStatus(entry.credentials)}\n`,
    );
  }

  process.stdout.write(
    `\nStored in ${authFilePath()}\n`
    + "The source file was not modified. Refresh happens independently from here.\n",
  );
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
  if (subcommand === "import") {
    // The provider argument is optional here: with none, import everything found.
    await authImport(positional[2] ? requireProvider(positional[2]) : undefined);
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
function readRawConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    process.stderr.write(`no config at ${path}\nRun \`sageroute init\` to generate one.\n`);
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (err) {
    process.stderr.write(`config at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

/**
 * Write a mutated config, but only after it still validates.
 *
 * A provider edit that leaves the file unroutable is worse than a rejected command: the
 * failure surfaces at the next start, far from the edit that caused it. Validating the
 * candidate before it reaches disk keeps a bad edit from ever being persisted.
 */
function writeCheckedConfig(
  path: string,
  before: unknown,
  after: unknown,
  notes: readonly string[],
): void {
  // Validation is whole-config, so a pre-existing problem elsewhere in the file would
  // block an unrelated edit. Refusing to add xAI because an OPENAI_API_KEY happens not
  // to be exported in this shell is a dead end with no obvious way out, and the shell
  // running the CLI is often not the one that will run the router anyway.
  //
  // So the gate is the DELTA: refuse only problems this edit introduced, and report
  // pre-existing ones as warnings the user can act on when convenient.
  const priorKeys = new Set(proxyConfigIssues(before).map(issue => issueKey(issue)));
  const issues = proxyConfigIssues(after);
  const introduced = issues.filter(issue => !priorKeys.has(issueKey(issue)));

  // An unexported key is the one "introduced" problem that is not a mistake. `provider
  // add kimi` is precisely the command that first names KIMI_API_KEY, so treating its
  // absence as a broken edit makes the documented flow impossible: the config must exist
  // before exporting the key is even meaningful. Defer it to a setup step instead.
  const pending = introduced.filter(issue => issue.code === "env-not-set");
  const blocking = introduced.filter(issue => issue.code !== "env-not-set");

  if (blocking.length > 0) {
    process.stderr.write(`refusing to write; this change breaks the config:\n${formatIssues(blocking)}\n`);
    process.exit(1);
  }

  writeFileSync(path, `${JSON.stringify(after, null, 2)}\n`, "utf8");
  for (const note of notes) process.stdout.write(`${note}\n`);
  process.stdout.write(`\nwrote ${path}\n`);

  if (pending.length > 0) {
    process.stdout.write(`\nbefore serving, export:\n${formatIssues(pending)}\n`);
  }

  const preExisting = issues.filter(issue => priorKeys.has(issueKey(issue)));
  if (preExisting.length > 0) {
    process.stdout.write(
      `\npre-existing issues in this config (not caused by this change):\n${formatIssues(preExisting)}\n`,
    );
  }
}

/** Identity for an issue, so the same problem before and after an edit compares equal. */
function issueKey(issue: { path: Array<string | number>; message: string }): string {
  return `${issue.path.join(".")}|${issue.message}`;
}

/** `provider list`: the registry, plus what this config already uses. */
function providerList(path: string): void {
  process.stdout.write("Available providers (sageroute provider add <id>):\n\n");
  for (const entry of PROVIDER_REGISTRY) {
    const auth = entry.authKind === "subscription"
      ? "subscription login"
      : `key from ${entry.envVar}`;
    process.stdout.write(
      `  ${entry.id.padEnd(14)} ${entry.label}\n`
      + `  ${"".padEnd(14)} ${auth}, models: ${entry.models.join(", ")}\n\n`,
    );
  }

  if (!existsSync(path)) {
    process.stdout.write(`No config at ${path} yet. Run \`sageroute init\` first.\n`);
    return;
  }
  const raw = readRawConfig(path);
  const configured = Object.entries((raw.providers ?? {}) as Record<string, { baseUrl?: string }>);
  process.stdout.write(`Configured in ${path}:\n`);
  if (configured.length === 0) {
    process.stdout.write("  (none)\n");
    return;
  }
  for (const [name, provider] of configured) {
    process.stdout.write(`  ${name.padEnd(14)} ${provider.baseUrl ?? "(no baseUrl)"}\n`);
  }
}

/**
 * `provider` subcommands. Every mutation reads, edits, validates, then writes, so a
 * rejected edit leaves the existing config untouched rather than half-applied.
 */
function runProviderCommand(positional: string[], flags: Map<string, string>): void {
  const path = configPath(flags);
  const sub = positional[1];

  try {
    if (sub === "list" || sub === undefined) {
      providerList(path);
      return;
    }

    if (sub === "add") {
      const id = positional[2];
      if (!id) {
        process.stderr.write(`missing provider id. Known: ${registryIds().join(", ")}\n`);
        process.exit(1);
      }
      const entry = getRegistryEntry(id);
      const raw = readRawConfig(path);
      const change = addProvider(raw as never, id, { name: flags.get("name") });
      writeCheckedConfig(path, raw, change.config, change.notes);
      if (entry?.authKind === "subscription") {
        process.stdout.write(`\nNext: sageroute auth login ${entry.configName}\n`);
      }
      return;
    }

    if (sub === "remove") {
      const name = positional[2];
      if (!name) {
        process.stderr.write("missing provider name\n");
        process.exit(1);
      }
      const raw = readRawConfig(path);
      const change = removeProvider(raw as never, name);
      writeCheckedConfig(path, raw, change.config, change.notes);
      return;
    }

    if (sub === "use") {
      const tier = positional[2];
      const ref = positional[3];
      if (tier !== "cheap" && tier !== "strong") {
        process.stderr.write(`expected tier "cheap" or "strong", got "${tier ?? ""}"\n`);
        process.exit(1);
      }
      if (!ref) {
        process.stderr.write("missing <provider>/<model>\n");
        process.exit(1);
      }
      const raw = readRawConfig(path);
      const change = setTier(raw as never, tier, ref);
      writeCheckedConfig(path, raw, change.config, change.notes);
      return;
    }
  } catch (err) {
    if (err instanceof RegistryError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  process.stderr.write(`unknown provider command "${sub}"\n\n${USAGE}`);
  process.exit(1);
}

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

  if (command === "provider") {
    runProviderCommand(positional, flags);
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
