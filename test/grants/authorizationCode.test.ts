import { describe, it, expect } from 'vitest';
import { AuthorizationCodeGrant } from '../../src/oauth2/grants/authorizationCode.js';
import { mockHttpClient } from '../helpers.js';

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
        tokenUrl: 'https://idp.example.com/token',
        clientId: 'cid',
        authStyle: 'body',
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
      {
        tokenUrl: 'https://idp.example.com/token',
        clientId: 'cid',
        authStyle: 'body',
        initialRefreshToken: 'r0',
      },
      http,
    );
    await grant.fetchToken();
    expect(http.calls[0]!.body.grant_type).toBe('refresh_token');
    expect(http.calls[0]!.body.refresh_token).toBe('r0');
  });

  it('throws if neither code nor refresh token supplied', () => {
    const http = mockHttpClient([]);
    expect(
      () =>
        new AuthorizationCodeGrant(
          { tokenUrl: 'https://idp.example.com/token', clientId: 'cid', authStyle: 'body' },
          http,
        ),
    ).toThrow(/authorizationCode/);
  });
});
