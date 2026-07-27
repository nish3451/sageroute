export type OAuthProviderId = "openai" | "anthropic";

/**
 * Long-lived refresh tokens live on disk, so callers should only pass this shape to
 * the store and never include it in logs or human-facing errors.
 */
export interface OAuthCredentials {
  access: string;
  refresh: string;
  /** Expiration time as epoch milliseconds. Provider-specific skew is already applied. */
  expires: number;
  email?: string;
  accountId?: string;
}

export interface OAuthFlowController {
  onAuthUrl?: (url: string) => void;
  onProgress?: (message: string) => void;
}

export interface OAuthCredentialSummary {
  expires: number;
  email?: string;
  accountId?: string;
}

export class OAuthError extends Error {
  constructor(message: string, readonly provider?: OAuthProviderId) {
    super(message);
    this.name = "OAuthError";
  }
}

export class OAuthLoginRequiredError extends OAuthError {
  constructor(provider: OAuthProviderId, message?: string) {
    super(message ?? `OAuth login required for ${provider}. Run: sageroute auth login ${provider}`, provider);
    this.name = "OAuthLoginRequiredError";
  }
}

export class OAuthCallbackError extends OAuthError {
  constructor(message: string, provider?: OAuthProviderId) {
    super(message, provider);
    this.name = "OAuthCallbackError";
  }
}

export class OAuthTokenRefreshError extends OAuthError {
  constructor(
    provider: OAuthProviderId,
    message: string,
    readonly httpStatus?: number,
    readonly oauthError?: string,
  ) {
    super(message, provider);
    this.name = "OAuthTokenRefreshError";
  }

  get requiresLogin(): boolean {
    return this.oauthError === "invalid_grant" || this.httpStatus === 400 || this.httpStatus === 401;
  }
}
