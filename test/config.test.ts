import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENV_KEYS = [
  'MCP_PROXY_CONFIG',
  'UPSTREAM_URL',
  'UPSTREAM_TIMEOUT_MS',
  'UPSTREAM_PROTOCOL_VERSION',
  'UPSTREAM_OPEN_SERVER_STREAM',
  'LOG_LEVEL',
  'OAUTH2_GRANT',
  'OAUTH2_TOKEN_URL',
  'OAUTH2_CLIENT_ID',
  'OAUTH2_CLIENT_SECRET',
  'OAUTH2_REFRESH_TOKEN',
  'OAUTH2_AUTHORIZATION_CODE',
  'OAUTH2_CODE_VERIFIER',
  'OAUTH2_REDIRECT_URI',
  'OAUTH2_SCOPE',
  'OAUTH2_RESOURCE',
  'OAUTH2_AUDIENCE',
  'OAUTH2_AUTH_STYLE',
  'OAUTH2_REFRESH_SKEW_SECONDS',
  'OAUTH2_CALLBACK_PORT',
  'OAUTH2_CALLBACK_TIMEOUT_SECONDS',
  'OAUTH2_EXTRA_PARAMS',
  'DISCOVERY_ENABLED',
  'ALLOW_INSECURE_HTTP',
] as const;

describe('loadConfig', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('builds full config from env vars only (no file)', () => {
    process.env.UPSTREAM_URL = 'https://mcp.example.com/mcp';
    process.env.UPSTREAM_TIMEOUT_MS = '15000';
    process.env.UPSTREAM_OPEN_SERVER_STREAM = 'false';
    process.env.OAUTH2_GRANT = 'client_credentials';
    process.env.OAUTH2_TOKEN_URL = 'https://idp.example.com/token';
    process.env.OAUTH2_CLIENT_ID = 'cid';
    process.env.OAUTH2_CLIENT_SECRET = 'csec';
    process.env.OAUTH2_SCOPE = 'mcp:read';
    process.env.OAUTH2_RESOURCE = 'https://mcp.example.com/mcp';
    process.env.OAUTH2_AUTH_STYLE = 'body';
    process.env.OAUTH2_REFRESH_SKEW_SECONDS = '60';
    process.env.OAUTH2_EXTRA_PARAMS = '{"resource":"https://mcp.example.com"}';

    const cfg = loadConfig();
    expect(cfg.upstream.url).toBe('https://mcp.example.com/mcp');
    expect(cfg.upstream.timeoutMs).toBe(15000);
    expect(cfg.upstream.openServerStream).toBe(false);
    expect(cfg.oauth2.grant).toBe('client_credentials');
    expect(cfg.oauth2.tokenUrl).toBe('https://idp.example.com/token');
    expect(cfg.oauth2.clientId).toBe('cid');
    expect(cfg.oauth2.clientSecret).toBe('csec');
    expect(cfg.oauth2.scope).toBe('mcp:read');
    expect(cfg.oauth2.resource).toBe('https://mcp.example.com/mcp');
    expect(cfg.oauth2.authStyle).toBe('body');
    expect(cfg.oauth2.refreshSkewSeconds).toBe(60);
    expect(cfg.oauth2.extraParams).toEqual({ resource: 'https://mcp.example.com' });
  });

  it('merges file + env, with env taking precedence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-cfg-'));
    const file = join(dir, 'config.json');
    writeFileSync(
      file,
      JSON.stringify({
        upstream: { url: 'https://file.example.com/mcp' },
        oauth2: {
          grant: 'client_credentials',
          tokenUrl: 'https://idp.example.com/token',
          clientId: 'from-file',
          clientSecret: 'will-be-overridden',
          resource: 'https://file.example.com/mcp',
        },
      }),
    );
    process.env.MCP_PROXY_CONFIG = file;
    process.env.OAUTH2_CLIENT_SECRET = 'from-env';
    process.env.OAUTH2_RESOURCE = 'https://env.example.com/mcp';
    process.env.UPSTREAM_URL = 'https://env.example.com/mcp';

    try {
      const cfg = loadConfig();
      expect(cfg.upstream.url).toBe('https://env.example.com/mcp');
      expect(cfg.oauth2.clientId).toBe('from-file');
      expect(cfg.oauth2.clientSecret).toBe('from-env');
      expect(cfg.oauth2.resource).toBe('https://env.example.com/mcp');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws if OAUTH2_EXTRA_PARAMS is invalid JSON', () => {
    process.env.UPSTREAM_URL = 'https://mcp.example.com/mcp';
    process.env.OAUTH2_GRANT = 'client_credentials';
    process.env.OAUTH2_TOKEN_URL = 'https://idp.example.com/token';
    process.env.OAUTH2_CLIENT_ID = 'cid';
    process.env.OAUTH2_EXTRA_PARAMS = '{not json';
    expect(() => loadConfig()).toThrow(/OAUTH2_EXTRA_PARAMS/);
  });

  it('reports a clear zod error when required fields are missing', () => {
    expect(() => loadConfig()).toThrow();
  });

  it('throws a clear error when OAUTH2_CALLBACK_PORT is not an integer', () => {
    process.env.UPSTREAM_URL = 'https://mcp.example.com/mcp';
    process.env.OAUTH2_GRANT = 'client_credentials';
    process.env.OAUTH2_TOKEN_URL = 'https://idp.example.com/token';
    process.env.OAUTH2_CLIENT_ID = 'cid';
    process.env.OAUTH2_CALLBACK_PORT = '53683x';
    expect(() => loadConfig()).toThrow(/OAUTH2_CALLBACK_PORT must be an integer/);
  });

  it('throws a clear error when UPSTREAM_TIMEOUT_MS is empty', () => {
    process.env.UPSTREAM_URL = 'https://mcp.example.com/mcp';
    process.env.OAUTH2_GRANT = 'client_credentials';
    process.env.OAUTH2_TOKEN_URL = 'https://idp.example.com/token';
    process.env.OAUTH2_CLIENT_ID = 'cid';
    process.env.UPSTREAM_TIMEOUT_MS = '  ';
    expect(() => loadConfig()).toThrow(/UPSTREAM_TIMEOUT_MS must be an integer/);
  });

  it('rejects cleartext http upstream.url to a non-loopback host', () => {
    process.env.UPSTREAM_URL = 'http://mcp.example.com/mcp';
    process.env.OAUTH2_GRANT = 'client_credentials';
    process.env.OAUTH2_TOKEN_URL = 'https://idp.example.com/token';
    process.env.OAUTH2_CLIENT_ID = 'cid';
    expect(() => loadConfig()).toThrow(/upstream\.url uses cleartext http/);
  });

  it('rejects cleartext http oauth2.tokenUrl to a non-loopback host', () => {
    process.env.UPSTREAM_URL = 'https://mcp.example.com/mcp';
    process.env.OAUTH2_GRANT = 'client_credentials';
    process.env.OAUTH2_TOKEN_URL = 'http://idp.example.com/token';
    process.env.OAUTH2_CLIENT_ID = 'cid';
    expect(() => loadConfig()).toThrow(/oauth2\.tokenUrl uses cleartext http/);
  });

  it('allows cleartext http to a loopback host without the escape hatch', () => {
    process.env.UPSTREAM_URL = 'http://127.0.0.1:8080/mcp';
    process.env.OAUTH2_GRANT = 'client_credentials';
    process.env.OAUTH2_TOKEN_URL = 'http://localhost:9000/token';
    process.env.OAUTH2_CLIENT_ID = 'cid';
    const cfg = loadConfig();
    expect(cfg.upstream.url).toBe('http://127.0.0.1:8080/mcp');
  });

  it('allows cleartext http to a remote host when ALLOW_INSECURE_HTTP is set', () => {
    process.env.UPSTREAM_URL = 'http://mcp.example.com/mcp';
    process.env.OAUTH2_GRANT = 'client_credentials';
    process.env.OAUTH2_TOKEN_URL = 'http://idp.example.com/token';
    process.env.OAUTH2_CLIENT_ID = 'cid';
    process.env.ALLOW_INSECURE_HTTP = 'true';
    const cfg = loadConfig();
    expect(cfg.allowInsecureHttp).toBe(true);
    expect(cfg.upstream.url).toBe('http://mcp.example.com/mcp');
  });
});
