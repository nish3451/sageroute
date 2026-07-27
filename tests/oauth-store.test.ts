import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  authFilePath,
  deleteCredentials,
  listCredentials,
  loadCredentials,
  saveCredentials,
  type OAuthCredentials,
} from "../src/oauth";

const tempDirs: string[] = [];

function tempAuthDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sageroute-auth-test-"));
  tempDirs.push(dir);
  return dir;
}

function sampleCredentials(overrides: Partial<OAuthCredentials> = {}): OAuthCredentials {
  return {
    access: "access-token",
    refresh: "refresh-token",
    expires: 1_900_000_000_000,
    email: "user@example.com",
    accountId: "acct_123",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("OAuth credential store", () => {
  test("round-trips credentials for a provider", async () => {
    const dir = tempAuthDir();
    const credentials = sampleCredentials();

    await saveCredentials("openai", credentials, dir);

    await expect(loadCredentials("openai", dir)).resolves.toEqual(credentials);
    await expect(loadCredentials("anthropic", dir)).resolves.toBeNull();
  });

  test("creates private auth directory and file permissions", async () => {
    const dir = tempAuthDir();

    await saveCredentials("anthropic", sampleCredentials(), dir);

    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(authFilePath(dir)).mode & 0o777).toBe(0o600);
  });

  test("atomically replaces existing provider credentials", async () => {
    const dir = tempAuthDir();
    await saveCredentials("openai", sampleCredentials({ access: "old-access" }), dir);

    await saveCredentials("openai", sampleCredentials({ access: "new-access" }), dir);

    await expect(loadCredentials("openai", dir)).resolves.toMatchObject({ access: "new-access" });
    expect(readdirSync(dir).filter(name => name.includes(".tmp"))).toEqual([]);
  });

  test("backs up a corrupt auth file and behaves as empty", async () => {
    const dir = tempAuthDir();
    writeFileSync(authFilePath(dir), "{not-json", { mode: 0o600 });

    await expect(loadCredentials("openai", dir)).resolves.toBeNull();

    const backups = readdirSync(dir).filter(name => name.startsWith("auth.json.corrupt."));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir, backups[0]!), "utf8")).toBe("{not-json");

    await saveCredentials("openai", sampleCredentials(), dir);
    expect(readdirSync(dir).filter(name => name.startsWith("auth.json.corrupt."))).toEqual(backups);
  });

  test("deletes one provider without touching the other", async () => {
    const dir = tempAuthDir();
    await saveCredentials("openai", sampleCredentials({ access: "openai-access" }), dir);
    await saveCredentials("anthropic", sampleCredentials({ access: "anthropic-access" }), dir);

    await deleteCredentials("openai", dir);

    await expect(loadCredentials("openai", dir)).resolves.toBeNull();
    await expect(loadCredentials("anthropic", dir)).resolves.toMatchObject({ access: "anthropic-access" });
  });

  test("lists providers with stored credentials", async () => {
    const dir = tempAuthDir();
    await saveCredentials("openai", sampleCredentials({ email: "openai@example.com" }), dir);
    await saveCredentials("anthropic", sampleCredentials({ email: "claude@example.com" }), dir);

    await expect(listCredentials(dir)).resolves.toEqual({
      openai: {
        email: "openai@example.com",
        accountId: "acct_123",
        expires: 1_900_000_000_000,
      },
      anthropic: {
        email: "claude@example.com",
        accountId: "acct_123",
        expires: 1_900_000_000_000,
      },
    });
  });
});
