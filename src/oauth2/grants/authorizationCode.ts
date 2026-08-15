import type { Grant, OAuthHttpClient, TokenResponse } from './types.js';
import { applyClientAuth, parseTokenResponse } from '../http.js';
import { RefreshTokenGrant } from './refreshToken.js';
import { runInteractiveAuth, type InteractiveAuthResult } from '../interactive.js';
import type { Logger } from '../../log.js';

export interface AuthorizationCodeOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  authStyle: 'header' | 'body';
  authorizationCode?: string;
  redirectUri?: string;
  codeVerifier?: string;
  scope?: string;
  resource?: string;
  initialRefreshToken?: string;
  extraParams?: Record<string, string>;

  authorizationUrl?: string;
  interactive: boolean;
  callbackHost: string;
  callbackPort: number;
  callbackTimeoutSeconds: number;

  log: Logger;
  onRefreshTokenUpdated?: (refreshToken: string) => void;
  runInteractive?: typeof runInteractiveAuth;
}

/**
 * Acquires tokens via OAuth2 authorization_code with PKCE.
 *
 * Three input modes (resolved lazily on first fetchToken):
 *   1. A pre-existing refresh token (delegate immediately).
 *   2. A pre-supplied one-shot authorization_code (exchange once, then
 *      delegate to RefreshTokenGrant if the IdP returned a refresh_token).
 *   3. Interactive browser-based login: open authorizationUrl, capture the
 *      code on a local callback listener, exchange it, persist the refresh
 *      token via onRefreshTokenUpdated.
 */
export class AuthorizationCodeGrant implements Grant {
  readonly name = 'authorization_code';
  private delegate?: RefreshTokenGrant;
  private codeUsed = false;

  constructor(
    private readonly opts: AuthorizationCodeOptions,
    private readonly http: OAuthHttpClient,
  ) {
    if (opts.initialRefreshToken) {
      this.delegate = this.buildDelegate(opts.initialRefreshToken);
    }
  }

  supportsRenewal(): boolean {
    return true;
  }

  async fetchToken(): Promise<TokenResponse> {
    if (this.delegate) return this.delegate.fetchToken();

    let code = this.opts.authorizationCode;
    let codeVerifier = this.opts.codeVerifier;
    let redirectUri = this.opts.redirectUri;

    if (!code) {
      if (this.codeUsed) {
        throw new Error(
          'authorization_code already consumed and no refresh_token was returned; reconfigure with a new code or a refresh token',
        );
      }
      if (!this.opts.interactive) {
        throw new Error(
          'authorization_code grant requires "authorizationCode", a pre-existing "refreshToken", or interactive=true with an authorizationUrl',
        );
      }
      if (!this.opts.authorizationUrl) {
        throw new Error(
          'interactive authorization_code flow requires an authorizationUrl (set OAUTH2_AUTHORIZATION_URL or enable discovery)',
        );
      }
      const runner = this.opts.runInteractive ?? runInteractiveAuth;
      const result: InteractiveAuthResult = await runner({
        authorizationUrl: this.opts.authorizationUrl,
        clientId: this.opts.clientId,
        scope: this.opts.scope,
        resource: this.opts.resource,
        callbackHost: this.opts.callbackHost,
        callbackPort: this.opts.callbackPort,
        callbackTimeoutSeconds: this.opts.callbackTimeoutSeconds,
        redirectUri: this.opts.redirectUri,
        extraParams: this.opts.extraParams,
        log: this.opts.log,
      });
      code = result.code;
      codeVerifier = result.codeVerifier;
      redirectUri = result.redirectUri;
    }

    const body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('code', code);
    if (redirectUri) body.set('redirect_uri', redirectUri);
    if (codeVerifier) body.set('code_verifier', codeVerifier);
    if (this.opts.extraParams) {
      for (const [k, v] of Object.entries(this.opts.extraParams)) body.set(k, v);
    }
    if (this.opts.resource) body.set('resource', this.opts.resource);
    const headers: Record<string, string> = {};
    applyClientAuth(body, headers, {
      clientId: this.opts.clientId,
      clientSecret: this.opts.clientSecret,
      authStyle: this.opts.authStyle,
    });

    const { status, bodyText } = await this.http.postForm(this.opts.tokenUrl, body, headers);
    const tok = parseTokenResponse(status, bodyText);
    this.codeUsed = true;

    if (tok.refreshToken) {
      this.opts.onRefreshTokenUpdated?.(tok.refreshToken);
      this.delegate = this.buildDelegate(tok.refreshToken);
    }
    return tok;
  }

  private buildDelegate(refreshToken: string): RefreshTokenGrant {
    return new RefreshTokenGrant(
      {
        tokenUrl: this.opts.tokenUrl,
        clientId: this.opts.clientId,
        clientSecret: this.opts.clientSecret,
        authStyle: this.opts.authStyle,
        scope: this.opts.scope,
        resource: this.opts.resource,
        initialRefreshToken: refreshToken,
        extraParams: this.opts.extraParams,
        onRefreshTokenUpdated: this.opts.onRefreshTokenUpdated,
      },
      this.http,
    );
  }
}
