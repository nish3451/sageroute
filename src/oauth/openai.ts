import { startOAuthCallbackServer, generateOAuthState } from "./callback";
import { generatePKCE } from "./pkce";
import {
  OAuthError,
  OAuthTokenRefreshError,
  type OAuthCredentials,
  type OAuthFlowController,
} from "./types";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  const payload = parts[1];
  if (parts.length !== 3 || !payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function extractOpenAIAccountId(idToken?: string, accessToken?: string): string | undefined {
  for (const token of [idToken, accessToken]) {
    if (!token) continue;
    const payload = decodeJwtPayload(token);
    if (!payload) continue;
    const direct = stringValue(payload.chatgpt_account_id);
    if (direct) return direct;

    const namespace = asObject(payload["https://api.openai.com/auth"]);
    const namespaced = namespace ? stringValue(namespace.chatgpt_account_id) : undefined;
    if (namespaced) return namespaced;

    const organizations = payload.organizations;
    if (Array.isArray(organizations)) {
      const first = asObject(organizations[0]);
      const organizationId = first ? stringValue(first.id) : undefined;
      if (organizationId) return organizationId;
    }
  }
  return undefined;
}

export function extractOpenAIEmail(idToken?: string, accessToken?: string): string | undefined {
  for (const token of [idToken, accessToken]) {
    if (!token) continue;
    const payload = decodeJwtPayload(token);
    const email = payload ? stringValue(payload.email) : undefined;
    if (email) return email.toLowerCase();
  }
  return undefined;
}

function parseExpires(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 3600;
}

function credentialsFromResponse(data: unknown, refreshFallback?: string): OAuthCredentials {
  const body = asObject(data);
  const access = body ? stringValue(body.access_token) : undefined;
  const refresh = body ? stringValue(body.refresh_token) ?? refreshFallback : undefined;
  if (!access || !refresh) {
    throw new OAuthError("OpenAI OAuth response did not include usable credentials", "openai");
  }

  const idToken = body ? stringValue(body.id_token) : undefined;
  return {
    access,
    refresh,
    expires: Date.now() + parseExpires(body?.expires_in) * 1000,
    email: extractOpenAIEmail(idToken, access),
    accountId: extractOpenAIAccountId(idToken, access),
  };
}

async function safeOAuthError(response: Response): Promise<{ message: string; oauthError?: string }> {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: unknown; error_description?: unknown };
    const oauthError = stringValue(parsed.error);
    const description = stringValue(parsed.error_description);
    return {
      message: [oauthError, description].filter(Boolean).join(": ") || `HTTP ${response.status}`,
      oauthError,
    };
  } catch {
    return { message: `HTTP ${response.status}` };
  }
}

export async function loginOpenAI(ctrl: OAuthFlowController): Promise<OAuthCredentials> {
  const state = generateOAuthState();
  const pkce = await generatePKCE();
  const callback = startOAuthCallbackServer({
    provider: "openai",
    port: CALLBACK_PORT,
    path: CALLBACK_PATH,
    state,
  });

  try {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: callback.redirectUri,
      scope: SCOPE,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      state,
      codex_cli_simplified_flow: "true",
      originator: "sageroute",
      id_token_add_organizations: "true",
    });

    ctrl.onAuthUrl?.(`${AUTHORIZE_URL}?${params.toString()}`);
    ctrl.onProgress?.("Waiting for OpenAI browser authorization.");
    const code = await callback.waitForCode();
    ctrl.onProgress?.("Exchanging OpenAI authorization code.");

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        redirect_uri: callback.redirectUri,
        code_verifier: pkce.verifier,
      }).toString(),
    });
    if (!response.ok) {
      const details = await safeOAuthError(response);
      throw new OAuthTokenRefreshError("openai", `OpenAI OAuth token exchange failed: ${response.status} ${details.message}`, response.status, details.oauthError);
    }
    return credentialsFromResponse(await response.json());
  } finally {
    callback.close();
  }
}

export async function refreshOpenAIToken(refreshToken: string): Promise<OAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }).toString(),
  });
  if (!response.ok) {
    const details = await safeOAuthError(response);
    throw new OAuthTokenRefreshError("openai", `OpenAI OAuth refresh failed: ${response.status} ${details.message}`, response.status, details.oauthError);
  }
  return credentialsFromResponse(await response.json(), refreshToken);
}
