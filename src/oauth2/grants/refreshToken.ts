import type { Grant, OAuthHttpClient, TokenResponse } from './types.js';
import { applyClientAuth, parseTokenResponse } from '../http.js';

export interface RefreshTokenOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scope?: string;
  resource?: string;
  authStyle: 'header' | 'body';
  initialRefreshToken: string;
  extraParams?: Record<string, string>;
  onRefreshTokenUpdated?: (refreshToken: string) => void;
}

export class RefreshTokenGrant implements Grant {
  readonly name = 'refresh_token';
  private refreshToken: string;
  private readonly opts: RefreshTokenOptions;

  constructor(
    opts: RefreshTokenOptions,
    private readonly http: OAuthHttpClient,
  ) {
    this.opts = opts;
    this.refreshToken = opts.initialRefreshToken;
  }

  supportsRenewal(): boolean {
    return true;
  }

  async fetchToken(): Promise<TokenResponse> {
    const body = new URLSearchParams();
    body.set('grant_type', 'refresh_token');
    body.set('refresh_token', this.refreshToken);
    if (this.opts.extraParams) {
      for (const [k, v] of Object.entries(this.opts.extraParams)) body.set(k, v);
    }
    if (this.opts.scope) body.set('scope', this.opts.scope);
    if (this.opts.resource) body.set('resource', this.opts.resource);
    const headers: Record<string, string> = {};
    applyClientAuth(body, headers, {
      clientId: this.opts.clientId,
      clientSecret: this.opts.clientSecret,
      authStyle: this.opts.authStyle,
    });
    const { status, bodyText } = await this.http.postForm(this.opts.tokenUrl, body, headers);
    const tok = parseTokenResponse(status, bodyText);
    if (tok.refreshToken && tok.refreshToken !== this.refreshToken) {
      this.refreshToken = tok.refreshToken;
      this.opts.onRefreshTokenUpdated?.(tok.refreshToken);
    }
    return tok;
  }
}
