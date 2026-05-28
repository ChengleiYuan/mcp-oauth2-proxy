import type { Grant, OAuthHttpClient, TokenResponse } from './types.js';
import { applyClientAuth, parseTokenResponse } from '../http.js';
import { RefreshTokenGrant } from './refreshToken.js';

export interface AuthorizationCodeOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  authStyle: 'header' | 'body';
  authorizationCode?: string;
  redirectUri?: string;
  codeVerifier?: string;
  scope?: string;
  initialRefreshToken?: string;
  extraParams?: Record<string, string>;
}

/**
 * v1 implementation: operator pre-supplies either an authorization_code (one-shot
 * exchange) or a refresh_token. On first call, if a refresh token is configured
 * we delegate to RefreshTokenGrant; otherwise we exchange the code once and then
 * use the returned refresh_token for subsequent renewals.
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
      this.delegate = new RefreshTokenGrant(
        {
          tokenUrl: opts.tokenUrl,
          clientId: opts.clientId,
          clientSecret: opts.clientSecret,
          authStyle: opts.authStyle,
          scope: opts.scope,
          initialRefreshToken: opts.initialRefreshToken,
          extraParams: opts.extraParams,
        },
        http,
      );
    } else if (!opts.authorizationCode) {
      throw new Error(
        'authorization_code grant requires either "authorizationCode" or a pre-existing "refreshToken"',
      );
    }
  }

  supportsRenewal(): boolean {
    return true;
  }

  async fetchToken(): Promise<TokenResponse> {
    if (this.delegate) return this.delegate.fetchToken();

    if (this.codeUsed) {
      throw new Error(
        'authorization_code already consumed and no refresh_token was returned; reconfigure with a new code or a refresh token',
      );
    }

    const body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('code', this.opts.authorizationCode!);
    if (this.opts.redirectUri) body.set('redirect_uri', this.opts.redirectUri);
    if (this.opts.codeVerifier) body.set('code_verifier', this.opts.codeVerifier);
    if (this.opts.extraParams) {
      for (const [k, v] of Object.entries(this.opts.extraParams)) body.set(k, v);
    }
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
      this.delegate = new RefreshTokenGrant(
        {
          tokenUrl: this.opts.tokenUrl,
          clientId: this.opts.clientId,
          clientSecret: this.opts.clientSecret,
          authStyle: this.opts.authStyle,
          scope: this.opts.scope,
          initialRefreshToken: tok.refreshToken,
          extraParams: this.opts.extraParams,
        },
        this.http,
      );
    }
    return tok;
  }
}
