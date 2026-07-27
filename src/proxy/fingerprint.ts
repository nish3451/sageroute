/**
 * First-party client fingerprints for OAuth-authenticated upstreams.
 *
 * A subscription token is not a general API credential. It is issued to one specific
 * first-party client, and the vendor checks that the request looks like it came from
 * that client. A valid token sent with a bare header set is a mismatched signature and
 * gets rejected, so these headers are a functional requirement rather than cosmetics.
 *
 * Only values that are stable and safe to pin live here. Anything requiring a live
 * version manifest or a signed billing attestation is deliberately not modeled: a
 * confident wrong guess fails worse than an absent header.
 */

import { createHash } from "node:crypto";

/** Mirrors the header set the Claude Code CLI sends alongside an OAuth bearer token. */
export const CLAUDE_CODE_HEADERS: Readonly<Record<string, string>> = {
  "X-App": "cli",
  "X-Stainless-Retry-Count": "0",
  "X-Stainless-Runtime": "node",
  "X-Stainless-Lang": "js",
  "X-Stainless-Timeout": "600",
  "X-Stainless-Arch": process.arch,
  "X-Stainless-OS": process.platform,
  "X-Stainless-Package-Version": "0.74.0",
  "X-Stainless-Runtime-Version": process.version.replace(/^v/, ""),
};

/**
 * A stable per-credential session id shaped like a UUIDv4.
 *
 * Claude Code holds one session id for the life of a CLI session. Deriving it from a
 * hash of the token reproduces that stability across the turns of a conversation
 * without persisting anything, and the token itself never leaves this function.
 */
export function claudeCodeSessionId(token: string | undefined): string {
  const seed = token && token.length > 0 ? token : "sageroute-anonymous";
  const digest = createHash("sha256").update(`sageroute-claude-session:${seed}`, "utf8").digest("hex");
  const variant = ((parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

/** The base URL ChatGPT subscription tokens are accepted on. */
export const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

/** Identifies the calling client to the ChatGPT backend. */
export const SAGEROUTE_ORIGINATOR = "sageroute";
