import { createHash, randomBytes } from "node:crypto";

export async function challengeForVerifier(verifier: string): Promise<string> {
  return createHash("sha256").update(verifier).digest("base64url");
}

export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomBytes(96).toString("base64url");
  return {
    verifier,
    challenge: await challengeForVerifier(verifier),
  };
}
