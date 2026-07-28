import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  claudeAuthPath,
  codexAuthPath,
  discoverImportableCredentials,
  expiryFromAccessToken,
  importFromClaude,
  importFromCodex,
} from "../src/oauth";

const tempDirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "sageroute-import-test-"));
  tempDirs.push(dir);
  return dir;
}

/** Build a JWT-shaped token. Only the payload is read, so the signature is filler. */
function jwt(payload: Record<string, unknown>): string {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

function writeCodexAuth(home: string, tokens: Record<string, unknown>): void {
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(codexAuthPath(home), JSON.stringify({ auth_mode: "chatgpt", tokens }), "utf8");
}

function writeClaudeAuth(home: string, oauth: Record<string, unknown>): void {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(claudeAuthPath(home), JSON.stringify({ claudeAiOauth: oauth }), "utf8");
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("credential import", () => {
  test("reads a Codex ChatGPT login, deriving expiry from the token's exp claim", () => {
    const home = tempHome();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    writeCodexAuth(home, {
      access_token: jwt({ exp }),
      refresh_token: "refresh-value",
      id_token: jwt({ email: "Person@Example.com" }),
      account_id: "acct-from-file",
    });

    const imported = importFromCodex(home);
    expect(imported?.provider).toBe("openai");
    expect(imported?.credentials.refresh).toBe("refresh-value");
    expect(imported?.credentials.expires).toBe(exp * 1000);
    expect(imported?.credentials.email).toBe("person@example.com");
    expect(imported?.credentials.accountId).toBe("acct-from-file");
  });

  test("prefers the stored account id over the JWT claim", () => {
    const home = tempHome();
    writeCodexAuth(home, {
      access_token: jwt({ exp: 1, chatgpt_account_id: "acct-from-jwt" }),
      refresh_token: "r",
      account_id: "acct-from-file",
    });
    expect(importFromCodex(home)?.credentials.accountId).toBe("acct-from-file");
  });

  test("falls back to the JWT account id when the file omits one", () => {
    const home = tempHome();
    writeCodexAuth(home, {
      access_token: jwt({ exp: 1, chatgpt_account_id: "acct-from-jwt" }),
      refresh_token: "r",
    });
    expect(importFromCodex(home)?.credentials.accountId).toBe("acct-from-jwt");
  });

  test("treats an unparseable expiry as already expired rather than assuming it is good", () => {
    // Assuming validity would send a dead token upstream and surface as an opaque 401
    // mid-run; expiring it immediately routes through the normal refresh path instead.
    expect(expiryFromAccessToken("not-a-jwt")).toBe(0);
    expect(expiryFromAccessToken(jwt({ sub: "no-exp-claim" }))).toBe(0);
  });

  test("ignores a Codex file that has no usable token pair", () => {
    const home = tempHome();
    writeCodexAuth(home, { access_token: jwt({ exp: 1 }) });
    expect(importFromCodex(home)).toBeUndefined();
  });

  test("ignores corrupt and missing credential files instead of throwing", () => {
    const home = tempHome();
    expect(importFromCodex(home)).toBeUndefined();
    expect(importFromClaude(home)).toBeUndefined();

    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(codexAuthPath(home), "{ not json", "utf8");
    expect(importFromCodex(home)).toBeUndefined();
  });

  test("reads a Claude Code login with its explicit expiry", () => {
    const home = tempHome();
    writeClaudeAuth(home, {
      accessToken: "claude-access",
      refreshToken: "claude-refresh",
      expiresAt: 1899000000000,
    });

    const imported = importFromClaude(home);
    expect(imported?.provider).toBe("anthropic");
    expect(imported?.credentials.access).toBe("claude-access");
    expect(imported?.credentials.expires).toBe(1899000000000);
  });

  test("discovers every importable login on the machine", () => {
    const home = tempHome();
    writeCodexAuth(home, { access_token: jwt({ exp: 1 }), refresh_token: "r" });
    writeClaudeAuth(home, { accessToken: "a", refreshToken: "r", expiresAt: 1 });

    expect(discoverImportableCredentials(home).map(e => e.provider)).toEqual(["openai", "anthropic"]);
  });

  test("never modifies the source file it read from", () => {
    const home = tempHome();
    writeCodexAuth(home, { access_token: jwt({ exp: 1 }), refresh_token: "r" });
    const before = readFileSync(codexAuthPath(home), "utf8");

    discoverImportableCredentials(home);

    expect(readFileSync(codexAuthPath(home), "utf8")).toBe(before);
  });
});
