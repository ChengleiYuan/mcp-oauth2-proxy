import type { Grant, TokenResponse } from './grants/types.js';
import type { Logger } from '../log.js';

interface CachedToken {
  accessToken: string;
  tokenType: string;
  expiresAt: number;
}

export interface TokenManagerOptions {
  grant: Grant;
  refreshSkewSeconds: number;
  now?: () => number;
  log?: Logger;
}

/**
 * Caches an OAuth2 access token and refreshes it on demand, with:
 *  - proactive refresh (skew window)
 *  - in-flight request deduplication
 *  - invalidate() so callers can force a refresh on 401
 */
export class TokenManager {
  private cached?: CachedToken;
  private inflight?: Promise<CachedToken>;
  private readonly now: () => number;
  private readonly log?: Logger;

  constructor(private readonly opts: TokenManagerOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  async getToken(): Promise<{ accessToken: string; tokenType: string }> {
    const skewMs = this.opts.refreshSkewSeconds * 1000;
    if (this.cached && this.cached.expiresAt - this.now() > skewMs) {
      return { accessToken: this.cached.accessToken, tokenType: this.cached.tokenType };
    }
    if (!this.inflight) {
      this.inflight = this.refresh().finally(() => {
        this.inflight = undefined;
      });
    }
    const tok = await this.inflight;
    return { accessToken: tok.accessToken, tokenType: tok.tokenType };
  }

  private async refresh(): Promise<CachedToken> {
    this.log?.debug({ grant: this.opts.grant.name }, 'refreshing oauth2 token');
    const tok: TokenResponse = await this.opts.grant.fetchToken();
    const cached: CachedToken = {
      accessToken: tok.accessToken,
      tokenType: tok.tokenType,
      expiresAt: this.now() + tok.expiresInSeconds * 1000,
    };
    this.cached = cached;
    this.log?.info(
      { grant: this.opts.grant.name, expiresInSeconds: tok.expiresInSeconds },
      'oauth2 token refreshed',
    );
    return cached;
  }
}
