import { refreshAnthropicToken } from "./anthropic";
import { refreshOpenAIToken } from "./openai";
import {
  deleteCredentials,
  listCredentials,
  loadCredentials,
  saveCredentials,
  authFilePath,
} from "./store";
import {
  OAuthLoginRequiredError,
  OAuthTokenRefreshError,
  type OAuthCredentials,
  type OAuthProviderId,
} from "./types";

export {
  ANTHROPIC_OAUTH_BETA,
  CLAUDE_CODE_SYSTEM_INSTRUCTION,
  loginAnthropic,
  refreshAnthropicToken,
} from "./anthropic";
export { startOAuthCallbackServer, generateOAuthState } from "./callback";
export { loginOpenAI, refreshOpenAIToken } from "./openai";
export {
  claudeAuthPath,
  codexAuthPath,
  discoverImportableCredentials,
  expiryFromAccessToken,
  importFromClaude,
  importFromCodex,
  type ImportedCredential,
} from "./import";
export { challengeForVerifier, generatePKCE } from "./pkce";
export {
  authFilePath,
  deleteCredentials,
  listCredentials,
  loadCredentials,
  saveCredentials,
} from "./store";
export type {
  OAuthCredentialSummary,
  OAuthCredentials,
  OAuthFlowController,
  OAuthProviderId,
} from "./types";
export {
  OAuthCallbackError,
  OAuthError,
  OAuthLoginRequiredError,
  OAuthTokenRefreshError,
} from "./types";

const REFRESH_WINDOW_MS = 5 * 60 * 1000;
const inFlightRefresh = new Map<OAuthProviderId, Promise<OAuthCredentials>>();

function loginCommand(provider: OAuthProviderId): string {
  return `sageroute auth login ${provider}`;
}

function refreshForProvider(provider: OAuthProviderId, refreshToken: string): Promise<OAuthCredentials> {
  switch (provider) {
    case "openai":
      return refreshOpenAIToken(refreshToken);
    case "anthropic":
      return refreshAnthropicToken(refreshToken);
    default: {
      const exhaustive: never = provider;
      throw new OAuthLoginRequiredError(exhaustive);
    }
  }
}

function mergeRefreshedCredentials(previous: OAuthCredentials, next: OAuthCredentials): OAuthCredentials {
  return {
    access: next.access,
    refresh: next.refresh || previous.refresh,
    expires: next.expires,
    email: next.email ?? previous.email,
    accountId: next.accountId ?? previous.accountId,
  };
}

async function refreshAndPersist(provider: OAuthProviderId, previous: OAuthCredentials): Promise<OAuthCredentials> {
  try {
    const refreshed = mergeRefreshedCredentials(previous, await refreshForProvider(provider, previous.refresh));
    await saveCredentials(provider, refreshed);
    return refreshed;
  } catch (error) {
    if (error instanceof OAuthTokenRefreshError && error.requiresLogin) {
      await deleteCredentials(provider);
      throw new OAuthLoginRequiredError(
        provider,
        `OAuth refresh for ${provider} was rejected. Run: ${loginCommand(provider)}`,
      );
    }
    throw error;
  }
}

export async function getValidAccessToken(provider: OAuthProviderId, now: number = Date.now()): Promise<string> {
  const credentials = await loadCredentials(provider);
  if (!credentials) {
    throw new OAuthLoginRequiredError(
      provider,
      `No OAuth credentials are stored for ${provider}. Run: ${loginCommand(provider)}`,
    );
  }
  if (credentials.expires > now + REFRESH_WINDOW_MS) return credentials.access;

  const existing = inFlightRefresh.get(provider);
  if (existing) return (await existing).access;

  const pending = refreshAndPersist(provider, credentials);
  inFlightRefresh.set(provider, pending);
  try {
    return (await pending).access;
  } finally {
    inFlightRefresh.delete(provider);
  }
}
