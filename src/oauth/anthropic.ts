import { startOAuthCallbackServer, generateOAuthState } from "./callback";
import { generatePKCE } from "./pkce";
import {
  OAuthError,
  OAuthTokenRefreshError,
  type OAuthCredentials,
  type OAuthFlowController,
} from "./types";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const SCOPE = "org:create_api_key user:profile user:inference";
const CALLBACK_PORT = 54545;
const CALLBACK_PATH = "/callback";
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

export const ANTHROPIC_OAUTH_BETA = "claude-code-20250219,oauth-2025-04-20";
export const CLAUDE_CODE_SYSTEM_INSTRUCTION = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

/**
 * Anthropic OAuth tokens are scoped to Claude Code, not to arbitrary API clients.
 * Requests authenticated with one must present as Claude Code: bearer auth, the OAuth
 * beta header, and this exact first system block, otherwise the API rejects the call.
 */

interface AnthropicAccount {
  uuid?: unknown;
  email_address?: unknown;
}

interface AnthropicTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  account?: AnthropicAccount;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function splitCodeAndState(code: string, state: string): { code: string; state: string } {
  const hash = code.indexOf("#");
  if (hash < 0) return { code, state };
  const nextState = code.slice(hash + 1);
  return {
    code: code.slice(0, hash),
    state: nextState.length > 0 ? nextState : state,
  };
}

function credentialsFromResponse(data: AnthropicTokenResponse, refreshFallback?: string): OAuthCredentials {
  const access = stringValue(data.access_token);
  const refresh = stringValue(data.refresh_token) ?? refreshFallback;
  const expiresIn = typeof data.expires_in === "number" && Number.isFinite(data.expires_in)
    ? data.expires_in
    : 3600;
  if (!access || !refresh) {
    throw new OAuthError("Anthropic OAuth response did not include usable credentials", "anthropic");
  }

  return {
    access,
    refresh,
    expires: Date.now() + expiresIn * 1000 - EXPIRY_SKEW_MS,
    accountId: stringValue(data.account?.uuid),
    email: stringValue(data.account?.email_address),
  };
}

async function postToken(body: Record<string, string>): Promise<AnthropicTokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    let oauthError: string | undefined;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      oauthError = stringValue(parsed.error);
    } catch {
      // Provider errors are contextual enough without echoing raw response bodies.
    }
    throw new OAuthTokenRefreshError(
      "anthropic",
      `Anthropic OAuth request failed: ${response.status}${oauthError ? ` ${oauthError}` : ""}`,
      response.status,
      oauthError,
    );
  }
  try {
    return JSON.parse(text) as AnthropicTokenResponse;
  } catch {
    throw new OAuthError("Anthropic OAuth response was not valid JSON", "anthropic");
  }
}

export async function loginAnthropic(ctrl: OAuthFlowController): Promise<OAuthCredentials> {
  const state = generateOAuthState();
  const pkce = await generatePKCE();
  const callback = startOAuthCallbackServer({
    provider: "anthropic",
    port: CALLBACK_PORT,
    path: CALLBACK_PATH,
    state,
  });

  try {
    const params = new URLSearchParams({
      code: "true",
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: callback.redirectUri,
      scope: SCOPE,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      state,
    });

    ctrl.onAuthUrl?.(`${AUTHORIZE_URL}?${params.toString()}`);
    ctrl.onProgress?.("Waiting for Anthropic browser authorization.");
    const rawCode = await callback.waitForCode();
    const parsed = splitCodeAndState(rawCode, state);
    ctrl.onProgress?.("Exchanging Anthropic authorization code.");

    const response = await postToken({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: parsed.code,
      state: parsed.state,
      redirect_uri: callback.redirectUri,
      code_verifier: pkce.verifier,
    });
    return credentialsFromResponse(response);
  } finally {
    callback.close();
  }
}

export async function refreshAnthropicToken(refreshToken: string): Promise<OAuthCredentials> {
  const response = await postToken({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });
  return credentialsFromResponse(response, refreshToken);
}
