/**
 * Adopt subscription logins that other CLIs already completed on this machine.
 *
 * The browser OAuth flow is the supported path, but it is also the most annoying step in
 * setup: it needs a GUI, a loopback port, and a human. If Codex or Claude Code has
 * already done that work, the resulting credential is exactly what SageRoute needs.
 * Adopting it creates no new grant, and revoking the original tool's login revokes this
 * one too.
 *
 * This only ever READS foreign files. It never writes to them, so nothing SageRoute does
 * can disturb the CLI a credential came from.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeJwtPayload, extractOpenAIAccountId, extractOpenAIEmail } from "./openai";
import type { OAuthCredentials, OAuthProviderId } from "./types";

/** A foreign credential plus where it came from, for reporting without leaking tokens. */
export interface ImportedCredential {
  provider: OAuthProviderId;
  credentials: OAuthCredentials;
  sourcePath: string;
  sourceTool: string;
}

export function codexAuthPath(home: string = homedir()): string {
  return join(home, ".codex", "auth.json");
}

export function claudeAuthPath(home: string = homedir()): string {
  return join(home, ".claude", ".credentials.json");
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Codex stores no explicit expiry, so it comes from the access token's own `exp` claim.
 *
 * A missing or unparseable claim is treated as already expired rather than assumed good.
 * That is the safe direction: it triggers the normal refresh path instead of sending a
 * dead token upstream and surfacing as an opaque 401 mid-run.
 */
export function expiryFromAccessToken(access: string): number {
  const payload = decodeJwtPayload(access);
  const exp = payload?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : 0;
}

/** Read the credential the Codex CLI stores for a ChatGPT subscription. */
export function importFromCodex(home?: string): ImportedCredential | undefined {
  const path = codexAuthPath(home);
  const raw = readJson(path) as { tokens?: Record<string, unknown> } | undefined;
  const tokens = raw?.tokens;
  if (!tokens) return undefined;

  const access = str(tokens.access_token);
  const refresh = str(tokens.refresh_token);
  if (!access || !refresh) return undefined;

  const idToken = str(tokens.id_token);
  const credentials: OAuthCredentials = {
    access,
    refresh,
    expires: expiryFromAccessToken(access),
  };
  const email = extractOpenAIEmail(idToken, access);
  if (email) credentials.email = email;
  // The stored account id is authoritative; the JWT claim is only a fallback.
  const accountId = str(tokens.account_id) ?? extractOpenAIAccountId(idToken, access);
  if (accountId) credentials.accountId = accountId;

  return { provider: "openai", credentials, sourcePath: path, sourceTool: "Codex CLI" };
}

/** Read the credential Claude Code writes for a Claude Pro/Max subscription. */
export function importFromClaude(home?: string): ImportedCredential | undefined {
  const path = claudeAuthPath(home);
  const raw = readJson(path) as { claudeAiOauth?: Record<string, unknown> } | undefined;
  const oauth = raw?.claudeAiOauth;
  if (!oauth) return undefined;

  const access = str(oauth.accessToken);
  const refresh = str(oauth.refreshToken);
  if (!access || !refresh) return undefined;

  const expiresAt = oauth.expiresAt;
  const credentials: OAuthCredentials = {
    access,
    refresh,
    expires: typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : 0,
  };
  const email = str(oauth.email);
  if (email) credentials.email = email;

  return { provider: "anthropic", credentials, sourcePath: path, sourceTool: "Claude Code" };
}

/** Every foreign credential this machine can offer, in provider order. */
export function discoverImportableCredentials(home?: string): ImportedCredential[] {
  const found: ImportedCredential[] = [];
  const codex = importFromCodex(home);
  if (codex) found.push(codex);
  const claude = importFromClaude(home);
  if (claude) found.push(claude);
  return found;
}
