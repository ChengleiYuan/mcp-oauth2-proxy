import { describe, it, expect } from 'vitest';
import { ClientCredentialsGrant } from '../../src/oauth2/grants/clientCredentials.js';
import { mockHttpClient } from '../helpers.js';

describe('ClientCredentialsGrant', () => {
  it('sends grant_type and Basic auth header by default', async () => {
    const http = mockHttpClient([
      {
        status: 200,
        body: { access_token: 'abc', expires_in: 3600, token_type: 'Bearer' },
      },
    ]);
    const grant = new ClientCredentialsGrant(
      {
        tokenUrl: 'https://idp.example.com/token',
        clientId: 'cid',
        clientSecret: 'csec',
        scope: 'mcp:read',
        resource: 'https://mcp.example.com/mcp',
        audience: 'https://mcp.example.com',
        authStyle: 'header',
        extraParams: { resource: 'https://ignored.example.com/mcp' },
      },
      http,
    );
    const tok = await grant.fetchToken();
    expect(tok.accessToken).toBe('abc');
    expect(tok.expiresInSeconds).toBe(3600);
    expect(http.calls).toHaveLength(1);
    const call = http.calls[0]!;
    expect(call.body.grant_type).toBe('client_credentials');
    expect(call.body.scope).toBe('mcp:read');
    expect(call.body.resource).toBe('https://mcp.example.com/mcp');
    expect(call.body.audience).toBe('https://mcp.example.com');
    expect(call.body.client_id).toBe('cid');
    expect(call.body.client_secret).toBeUndefined();
    expect(call.headers.authorization).toMatch(/^Basic /);
  });

  it('sends credentials in body when authStyle=body', async () => {
    const http = mockHttpClient([
      { status: 200, body: { access_token: 'abc', expires_in: 60, token_type: 'Bearer' } },
    ]);
    const grant = new ClientCredentialsGrant(
      {
        tokenUrl: 'https://idp.example.com/token',
        clientId: 'cid',
        clientSecret: 'csec',
        authStyle: 'body',
      },
      http,
    );
    await grant.fetchToken();
    const call = http.calls[0]!;
    expect(call.body.client_id).toBe('cid');
    expect(call.body.client_secret).toBe('csec');
    expect(call.headers.authorization).toBeUndefined();
  });

  it('throws on token endpoint error', async () => {
    const http = mockHttpClient([
      { status: 400, body: { error: 'invalid_client', error_description: 'bad cred' } },
    ]);
    const grant = new ClientCredentialsGrant(
      { tokenUrl: 'https://idp.example.com/token', clientId: 'cid', authStyle: 'body' },
      http,
    );
    await expect(grant.fetchToken()).rejects.toThrow(/bad cred/);
  });
});
