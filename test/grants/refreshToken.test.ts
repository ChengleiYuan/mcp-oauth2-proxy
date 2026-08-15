import { describe, it, expect } from 'vitest';
import { RefreshTokenGrant } from '../../src/oauth2/grants/refreshToken.js';
import { mockHttpClient } from '../helpers.js';

describe('RefreshTokenGrant', () => {
  it('uses initial refresh token and rotates on response', async () => {
    const http = mockHttpClient([
      {
        status: 200,
        body: { access_token: 'a1', expires_in: 60, refresh_token: 'r2', token_type: 'Bearer' },
      },
      {
        status: 200,
        body: { access_token: 'a2', expires_in: 60, refresh_token: 'r3', token_type: 'Bearer' },
      },
    ]);
    const grant = new RefreshTokenGrant(
      {
        tokenUrl: 'https://idp.example.com/token',
        clientId: 'cid',
        authStyle: 'body',
        scope: 'mcp:read',
        resource: 'https://mcp.example.com/mcp',
        initialRefreshToken: 'r1',
      },
      http,
    );
    await grant.fetchToken();
    expect(http.calls[0]!.body.refresh_token).toBe('r1');
    expect(http.calls[0]!.body.scope).toBe('mcp:read');
    expect(http.calls[0]!.body.resource).toBe('https://mcp.example.com/mcp');
    await grant.fetchToken();
    expect(http.calls[1]!.body.refresh_token).toBe('r2');
  });
});
