import { describe, it, expect } from 'vitest';
import { AuthorizationCodeGrant } from '../../src/oauth2/grants/authorizationCode.js';
import { mockHttpClient } from '../helpers.js';
import { createLogger } from '../../src/log.js';

const log = createLogger('fatal');

const baseOpts = {
  tokenUrl: 'https://idp.example.com/token',
  clientId: 'cid',
  authStyle: 'body' as const,
  interactive: false,
  callbackHost: '127.0.0.1',
  callbackPort: 0,
  callbackTimeoutSeconds: 5,
  log,
};

describe('AuthorizationCodeGrant', () => {
  it('exchanges code once and then uses refresh_token from response', async () => {
    const http = mockHttpClient([
      {
        status: 200,
        body: {
          access_token: 'a1',
          expires_in: 60,
          refresh_token: 'r1',
          token_type: 'Bearer',
        },
      },
      {
        status: 200,
        body: { access_token: 'a2', expires_in: 60, token_type: 'Bearer' },
      },
    ]);
    const grant = new AuthorizationCodeGrant(
      {
        ...baseOpts,
        authorizationCode: 'code-123',
        redirectUri: 'https://app.example.com/cb',
        codeVerifier: 'pkce-verifier',
      },
      http,
    );

    await grant.fetchToken();
    expect(http.calls[0]!.body.grant_type).toBe('authorization_code');
    expect(http.calls[0]!.body.code).toBe('code-123');
    expect(http.calls[0]!.body.redirect_uri).toBe('https://app.example.com/cb');
    expect(http.calls[0]!.body.code_verifier).toBe('pkce-verifier');

    await grant.fetchToken();
    expect(http.calls[1]!.body.grant_type).toBe('refresh_token');
    expect(http.calls[1]!.body.refresh_token).toBe('r1');
  });

  it('uses RefreshTokenGrant immediately when initialRefreshToken provided', async () => {
    const http = mockHttpClient([
      { status: 200, body: { access_token: 'a', expires_in: 60, token_type: 'Bearer' } },
    ]);
    const grant = new AuthorizationCodeGrant(
      { ...baseOpts, initialRefreshToken: 'r0' },
      http,
    );
    await grant.fetchToken();
    expect(http.calls[0]!.body.grant_type).toBe('refresh_token');
    expect(http.calls[0]!.body.refresh_token).toBe('r0');
  });

  it('throws on fetchToken when interactive disabled and no code/refresh token', async () => {
    const http = mockHttpClient([]);
    const grant = new AuthorizationCodeGrant({ ...baseOpts }, http);
    await expect(grant.fetchToken()).rejects.toThrow(/authorizationCode/);
  });

  it('runs interactive flow when no code or refresh token and interactive=true', async () => {
    const http = mockHttpClient([
      {
        status: 200,
        body: {
          access_token: 'a1',
          expires_in: 60,
          refresh_token: 'r-interactive',
          token_type: 'Bearer',
        },
      },
    ]);
    let savedRt: string | undefined;
    const grant = new AuthorizationCodeGrant(
      {
        ...baseOpts,
        interactive: true,
        authorizationUrl: 'https://idp.example.com/authorize',
        onRefreshTokenUpdated: (rt) => {
          savedRt = rt;
        },
        runInteractive: async () => ({
          code: 'fresh-code',
          codeVerifier: 'fresh-verifier',
          redirectUri: 'http://127.0.0.1:53682/callback',
        }),
      },
      http,
    );

    const tok = await grant.fetchToken();
    expect(tok.refreshToken).toBe('r-interactive');
    expect(savedRt).toBe('r-interactive');
    expect(http.calls[0]!.body.code).toBe('fresh-code');
    expect(http.calls[0]!.body.code_verifier).toBe('fresh-verifier');
    expect(http.calls[0]!.body.redirect_uri).toBe('http://127.0.0.1:53682/callback');
  });

  it('throws when interactive=true but no authorizationUrl is set', async () => {
    const http = mockHttpClient([]);
    const grant = new AuthorizationCodeGrant({ ...baseOpts, interactive: true }, http);
    await expect(grant.fetchToken()).rejects.toThrow(/authorizationUrl/);
  });
});
