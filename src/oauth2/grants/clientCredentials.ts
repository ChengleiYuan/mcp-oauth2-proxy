import type { Grant, OAuthHttpClient, TokenResponse } from './types.js';
import { applyClientAuth, parseTokenResponse } from '../http.js';

export interface ClientCredentialsOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scope?: string;
  resource?: string;
  audience?: string;
  authStyle: 'header' | 'body';
  extraParams?: Record<string, string>;
}

export class ClientCredentialsGrant implements Grant {
  readonly name = 'client_credentials';

  constructor(
    private readonly opts: ClientCredentialsOptions,
    private readonly http: OAuthHttpClient,
  ) {}

  supportsRenewal(): boolean {
    return true;
  }

  async fetchToken(): Promise<TokenResponse> {
    const body = new URLSearchParams();
    body.set('grant_type', 'client_credentials');
    if (this.opts.extraParams) {
      for (const [k, v] of Object.entries(this.opts.extraParams)) body.set(k, v);
    }
    if (this.opts.scope) body.set('scope', this.opts.scope);
    if (this.opts.resource) body.set('resource', this.opts.resource);
    if (this.opts.audience) body.set('audience', this.opts.audience);
    const headers: Record<string, string> = {};
    applyClientAuth(body, headers, {
      clientId: this.opts.clientId,
      clientSecret: this.opts.clientSecret,
      authStyle: this.opts.authStyle,
    });
    const { status, bodyText } = await this.http.postForm(this.opts.tokenUrl, body, headers);
    return parseTokenResponse(status, bodyText);
  }
}
