import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { discoverFromUpstream } from '../../src/oauth2/discovery.js';
import { createLogger } from '../../src/log.js';

const log = createLogger('fatal');

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

async function startMetadataServer(
  asMetadata: Record<string, unknown>,
): Promise<{ origin: string }> {
  server = createServer((req, res) => {
    const origin = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/.well-known/oauth-protected-resource') {
      res.end(JSON.stringify({ resource: origin, authorization_servers: [origin] }));
      return;
    }
    if (req.url === '/.well-known/oauth-authorization-server') {
      res.end(JSON.stringify(asMetadata));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
  const origin = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return { origin };
}

describe('discoverFromUpstream security', () => {
  it('drops an insecure (remote http) token endpoint but keeps a secure one', async () => {
    const { origin } = await startMetadataServer({
      token_endpoint: 'http://evil.example.com/token',
      authorization_endpoint: 'https://idp.example.com/authorize',
    });
    const result = await discoverFromUpstream(`${origin}/mcp`, log);
    expect(result.tokenEndpoint).toBeUndefined();
    expect(result.authorizationEndpoint).toBe('https://idp.example.com/authorize');
  });

  it('keeps an insecure endpoint when allowInsecureHttp is true', async () => {
    const { origin } = await startMetadataServer({
      token_endpoint: 'http://evil.example.com/token',
    });
    const result = await discoverFromUpstream(`${origin}/mcp`, log, true);
    expect(result.tokenEndpoint).toBe('http://evil.example.com/token');
  });
});
