import * as oidc from 'openid-client';
import { NearpaysError } from './errors.ts';
import type { ClientKey } from './keys.ts';

/** Tokens from the token endpoint. */
export interface TokenSet {
  accessToken: string;
  expiresIn: number;
  refreshToken?: string;
  scope?: string;
  /** From the ID token, when one came back. */
  idTokenClaims?: Record<string, unknown>;
}

export interface ApiResponse {
  status: number;
  headers: Headers;
  body: unknown;
  /** The `WWW-Authenticate` error, when the API sent one. */
  challenge?: { error?: string; description?: string };
}

export interface AuthorizationChecks {
  codeVerifier: string;
  state: string;
  nonce: string;
}

/**
 * Everything the SDK needs from the OAuth protocol. The default speaks to
 * Nearpays through openid-client, a certified OpenID relying-party library:
 * pushed authorization requests, PKCE, private_key_jwt and DPoP. Tests swap
 * in a fake.
 */
export interface Transport {
  randomChecks(): Promise<AuthorizationChecks & { codeChallenge: string }>;
  pushAuthorization(params: Record<string, string>, dpop: CryptoKeyPair): Promise<URL>;
  exchangeCode(callback: URL, checks: AuthorizationChecks, dpop: CryptoKeyPair): Promise<TokenSet>;
  refresh(refreshToken: string, dpop: CryptoKeyPair): Promise<TokenSet>;
  revoke(token: string): Promise<void>;
  request(
    accessToken: string,
    dpop: CryptoKeyPair,
    method: string,
    url: URL,
    body?: string,
    headers?: Headers,
  ): Promise<ApiResponse>;
}

export class OpenIdTransport implements Transport {
  #config: Promise<oidc.Configuration> | undefined;
  readonly #issuer: URL;
  readonly #clientId: string;
  readonly #clientKey: Promise<ClientKey>;
  readonly #insecure: boolean;

  constructor(options: {
    issuer: URL;
    clientId: string;
    clientKey: Promise<ClientKey>;
    allowInsecureHttp: boolean;
  }) {
    this.#issuer = options.issuer;
    this.#clientId = options.clientId;
    this.#clientKey = options.clientKey;
    this.#insecure = options.allowInsecureHttp;
  }

  #configuration(): Promise<oidc.Configuration> {
    this.#config ??= (async () => {
      const { key, kid } = await this.#clientKey;
      return oidc.discovery(
        this.#issuer,
        this.#clientId,
        undefined,
        oidc.PrivateKeyJwt({ key, kid }),
        this.#insecure ? { execute: [oidc.allowInsecureRequests] } : undefined,
      );
    })().catch((error) => {
      this.#config = undefined; // try discovery again next time
      throw wrap(error, 'discovery_failed');
    });
    return this.#config;
  }

  async #dpop(pair: CryptoKeyPair) {
    return oidc.getDPoPHandle(await this.#configuration(), pair);
  }

  async randomChecks() {
    const codeVerifier = oidc.randomPKCECodeVerifier();
    return {
      codeVerifier,
      codeChallenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
    };
  }

  async pushAuthorization(params: Record<string, string>, dpop: CryptoKeyPair) {
    try {
      return await oidc.buildAuthorizationUrlWithPAR(await this.#configuration(), params, {
        DPoP: await this.#dpop(dpop),
      });
    } catch (error) {
      throw wrap(error, 'authorization_request_failed');
    }
  }

  async exchangeCode(callback: URL, checks: AuthorizationChecks, dpop: CryptoKeyPair) {
    try {
      const tokens = await oidc.authorizationCodeGrant(
        await this.#configuration(),
        callback,
        {
          pkceCodeVerifier: checks.codeVerifier,
          expectedState: checks.state,
          expectedNonce: checks.nonce,
          idTokenExpected: true,
        },
        undefined,
        { DPoP: await this.#dpop(dpop) },
      );
      return tokenSet(tokens);
    } catch (error) {
      throw wrap(error, 'code_exchange_failed');
    }
  }

  async refresh(refreshToken: string, dpop: CryptoKeyPair) {
    try {
      const tokens = await oidc.refreshTokenGrant(
        await this.#configuration(),
        refreshToken,
        undefined,
        { DPoP: await this.#dpop(dpop) },
      );
      return tokenSet(tokens);
    } catch (error) {
      throw wrap(error, 'refresh_failed');
    }
  }

  async revoke(token: string) {
    try {
      await oidc.tokenRevocation(await this.#configuration(), token);
    } catch (error) {
      throw wrap(error, 'revocation_failed');
    }
  }

  async request(
    accessToken: string,
    dpop: CryptoKeyPair,
    method: string,
    url: URL,
    body?: string,
    headers?: Headers,
  ): Promise<ApiResponse> {
    let response: Response;
    let challenge: ApiResponse['challenge'];
    try {
      response = await oidc.fetchProtectedResource(
        await this.#configuration(),
        accessToken,
        url,
        method,
        body,
        headers,
        { DPoP: await this.#dpop(dpop) },
      );
    } catch (error) {
      if (!(error instanceof oidc.WWWAuthenticateChallengeError)) {
        throw wrap(error, 'request_failed');
      }
      response = error.response;
      const parameters = error.cause[0]?.parameters;
      challenge = { error: parameters?.error, description: parameters?.error_description };
    }
    const text = await response.text().catch(() => '');
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: response.status, headers: response.headers, body: parsed, challenge };
  }
}

function tokenSet(tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers): TokenSet {
  return {
    accessToken: tokens.access_token,
    expiresIn: tokens.expires_in ?? 300,
    refreshToken: tokens.refresh_token,
    scope: tokens.scope,
    idTokenClaims: tokens.claims() as Record<string, unknown> | undefined,
  };
}

/** An openid-client failure as a NearpaysError, keeping the OAuth error code. */
function wrap(error: unknown, fallback: string): NearpaysError {
  if (error instanceof NearpaysError) return error;
  if (error instanceof oidc.ResponseBodyError) {
    return new NearpaysError(error.error, error.error_description ?? error.message, {
      status: error.status,
      body: error.cause,
      cause: error,
    });
  }
  if (error instanceof oidc.AuthorizationResponseError) {
    return new NearpaysError(error.error, error.error_description ?? error.message, {
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new NearpaysError(fallback, message, { cause: error });
}
