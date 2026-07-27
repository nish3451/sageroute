import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  OAuthCredentialSummary,
  OAuthCredentials,
  OAuthProviderId,
} from "./types";

type AuthStore = Partial<Record<OAuthProviderId, OAuthCredentials>>;

const AUTH_FILE_NAME = "auth.json";
const PROVIDERS: readonly OAuthProviderId[] = ["openai", "anthropic"];

function defaultAuthDir(): string {
  return join(homedir(), ".sageroute");
}

function isProvider(value: string): value is OAuthProviderId {
  return (PROVIDERS as readonly string[]).includes(value);
}

function isCredential(value: unknown): value is OAuthCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<OAuthCredentials>;
  return typeof candidate.access === "string"
    && typeof candidate.refresh === "string"
    && typeof candidate.expires === "number"
    && Number.isFinite(candidate.expires)
    && (candidate.email === undefined || typeof candidate.email === "string")
    && (candidate.accountId === undefined || typeof candidate.accountId === "string");
}

function normalizeStore(value: unknown): AuthStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const store: AuthStore = {};
  for (const [provider, credential] of Object.entries(value)) {
    if (isProvider(provider) && isCredential(credential)) {
      store[provider] = credential;
    }
  }
  return store;
}

function authDir(dir?: string): string {
  return dir ?? defaultAuthDir();
}

export function authFilePath(dir?: string): string {
  return join(authDir(dir), AUTH_FILE_NAME);
}

async function ensureAuthDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function backupCorruptFile(path: string): Promise<void> {
  if (!await exists(path)) return;
  const backup = `${path}.corrupt.${Date.now().toString(36)}.${randomUUID().slice(0, 8)}`;
  try {
    await rename(path, backup);
    await chmod(backup, 0o600);
  } catch {
    // If the filesystem refuses a backup, future saves still try again before replacing.
  }
}

async function readStore(dir?: string): Promise<AuthStore> {
  const path = authFilePath(dir);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return normalizeStore(parsed);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    if (code === "ENOENT") return {};
    await backupCorruptFile(path);
    return {};
  }
}

async function writeStore(store: AuthStore, dir?: string): Promise<void> {
  const directory = authDir(dir);
  const path = authFilePath(directory);
  await ensureAuthDir(directory);

  const tempPath = join(directory, `.auth.json.${process.pid.toString()}.${randomUUID()}.tmp`);
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(store, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  await chmod(tempPath, 0o600);
  await rename(tempPath, path);
  await chmod(path, 0o600);
}

export async function loadCredentials(
  provider: OAuthProviderId,
  dir?: string,
): Promise<OAuthCredentials | null> {
  const store = await readStore(dir);
  return store[provider] ?? null;
}

export async function saveCredentials(
  provider: OAuthProviderId,
  creds: OAuthCredentials,
  dir?: string,
): Promise<void> {
  const directory = authDir(dir);
  const path = authFilePath(directory);
  await ensureAuthDir(directory);
  try {
    await stat(path);
    await readStore(directory);
  } catch {
    // readStore distinguishes missing files from corrupt/unreadable files and backs up
    // the latter before persistence can replace the target.
  }

  const store = await readStore(directory);
  store[provider] = creds;
  await writeStore(store, directory);
}

export async function deleteCredentials(provider: OAuthProviderId, dir?: string): Promise<void> {
  const store = await readStore(dir);
  if (!store[provider]) return;
  delete store[provider];
  await writeStore(store, dir);
}

export async function listCredentials(
  dir?: string,
): Promise<Partial<Record<OAuthProviderId, OAuthCredentialSummary>>> {
  const store = await readStore(dir);
  const entries = Object.entries(store).map(([provider, creds]) => {
    const summary: OAuthCredentialSummary = { expires: creds.expires };
    if (creds.email) summary.email = creds.email;
    if (creds.accountId) summary.accountId = creds.accountId;
    return [provider, summary] as const;
  });
  return Object.fromEntries(entries) as Partial<Record<OAuthProviderId, OAuthCredentialSummary>>;
}
