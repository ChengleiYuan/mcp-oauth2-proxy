import { describe, it, expect } from 'vitest';
import { request } from 'undici';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  buildAuthorizeUrl,
  computeS256Challenge,
  generateCodeVerifier,
  runInteractiveAuth,
  startCallbackServer,
} from '../../src/oauth2/interactive.js';
import { createLogger } from '../../src/log.js';

const log = createLogger('fatal');

describe('PKCE helpers', () => {
  it('generates a verifier in the 43..128 char base64url range', () => {
    const v = generateCodeVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('S256 challenge is deterministic and base64url', () => {
    const c1 = computeS256Challenge('verifier-xyz');
    const c2 = computeS256Challenge('verifier-xyz');
    expect(c1).toBe(c2);
    expect(c1).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('buildAuthorizeUrl includes PKCE, scope, resource, state, and extras', () => {
    const u = new URL(
      buildAuthorizeUrl({
        authorizationUrl: 'https://idp.example.com/authorize',
        clientId: 'cid',
        redirectUri: 'http://127.0.0.1:53682/callback',
        scope: 'a b',
        resource: 'https://mcp.example.com/mcp',
        state: 's-1',
        codeChallenge: 'cc-1',
        extraParams: { audience: 'api://x', resource: 'https://ignored.example.com/mcp' },
      }),
    );
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('cid');
    expect(u.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:53682/callback');
    expect(u.searchParams.get('scope')).toBe('a b');
    expect(u.searchParams.get('resource')).toBe('https://mcp.example.com/mcp');
    expect(u.searchParams.get('state')).toBe('s-1');
    expect(u.searchParams.get('code_challenge')).toBe('cc-1');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('audience')).toBe('api://x');
  });
});

describe('callback server', () => {
  it('resolves with code on matching state and returns success HTML', async () => {
    const port = await pickPort();
    const { server, codePromise } = startCallbackServer({
      host: '127.0.0.1',
      port,
      expectedState: 'st1',
      timeoutMs: 5000,
      log,
    });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    try {
      const res = await request(`http://127.0.0.1:${port}/callback?code=AC&state=st1`);
      expect(res.statusCode).toBe(200);
      const body = await res.body.text();
      expect(body).toContain('Login successful');
      const code = await codePromise;
      expect(code).toBe('AC');
    } finally {
      server.close();
    }
  });

  it('rejects on state mismatch', async () => {
    const port = await pickPort();
    const { server, codePromise } = startCallbackServer({
      host: '127.0.0.1',
      port,
      expectedState: 'st1',
      timeoutMs: 5000,
      log,
    });
    const caught = codePromise.catch((e: Error) => e);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    try {
      const res = await request(`http://127.0.0.1:${port}/callback?code=AC&state=BAD`);
      expect(res.statusCode).toBe(400);
      await res.body.text();
      expect((await caught).message).toMatch(/state mismatch/);
    } finally {
      server.close();
    }
  });

  it('rejects a request whose Host header is not loopback', async () => {
    const port = await pickPort();
    const { server, codePromise } = startCallbackServer({
      host: '127.0.0.1',
      port,
      expectedState: 'st1',
      timeoutMs: 5000,
      log,
    });
    // keep the rejection from becoming an unhandled rejection if it ever fires
    const caught = codePromise.catch((e: Error) => e);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            path: '/callback?code=AC&state=st1',
            method: 'GET',
            headers: { host: 'evil.example.com' },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(400);
    } finally {
      server.close();
    }
    void caught;
  });
});

describe('runInteractiveAuth end-to-end (simulated browser)', () => {
  it('completes when callback is hit', async () => {
    const port = await pickPort();
    const result = await runInteractiveAuth({
      authorizationUrl: 'https://idp.example.com/authorize',
      clientId: 'cid',
      callbackHost: '127.0.0.1',
      callbackPort: port,
      callbackTimeoutSeconds: 5,
      log,
      openBrowser: (url) => {
        const u = new URL(url);
        const state = u.searchParams.get('state')!;
        void request(`http://127.0.0.1:${port}/callback?code=XYZ&state=${state}`).then((r) =>
          r.body.dump(),
        );
      },
    });
    expect(result.code).toBe('XYZ');
    expect(result.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(result.redirectUri).toBe(`http://127.0.0.1:${port}/callback`);
  });
});

async function pickPort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address() as AddressInfo;
      const p = addr.port;
      s.close(() => resolve(p));
    });
  });
}
