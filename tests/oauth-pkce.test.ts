import { describe, expect, test } from "bun:test";
import { challengeForVerifier, generatePKCE } from "../src/oauth/pkce";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe("OAuth PKCE", () => {
  test("generates a 96-byte base64url verifier and S256 challenge", async () => {
    const pkce = await generatePKCE();

    expect(pkce.verifier).toHaveLength(128);
    expect(pkce.challenge).toHaveLength(43);
    expect(pkce.verifier).toMatch(BASE64URL);
    expect(pkce.challenge).toMatch(BASE64URL);
  });

  test("computes S256 challenge using the RFC 7636 test vector", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

    await expect(challengeForVerifier(verifier)).resolves.toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  test("generates unique verifiers across calls", async () => {
    const first = await generatePKCE();
    const second = await generatePKCE();

    expect(first.verifier).not.toBe(second.verifier);
    expect(first.challenge).not.toBe(second.challenge);
  });
});
