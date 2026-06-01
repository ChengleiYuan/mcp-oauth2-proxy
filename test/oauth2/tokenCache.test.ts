import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenCache } from '../../src/oauth2/tokenCache.js';
import { createLogger } from '../../src/log.js';

const log = createLogger('fatal');

describe('TokenCache', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-oauth2-cache-'));
  });

  it('round-trips a refresh token', () => {
    const c = new TokenCache({
      clientId: 'cid',
      tokenUrl: 'https://idp.example.com/token',
      dir,
      log,
    });
    expect(c.load()).toBeUndefined();
    c.save('refresh-abc', 'cid', 'https://idp.example.com/token');
    const loaded = c.load();
    expect(loaded?.refreshToken).toBe('refresh-abc');
    expect(loaded?.clientId).toBe('cid');
    expect(loaded?.tokenUrl).toBe('https://idp.example.com/token');
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns undefined on tampered ciphertext', () => {
    const c = new TokenCache({
      clientId: 'cid',
      tokenUrl: 'https://idp.example.com/token',
      dir,
      log,
    });
    c.save('refresh-abc', 'cid', 'https://idp.example.com/token');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json.enc'));
    expect(files.length).toBe(1);
    const buf = readFileSync(join(dir, files[0]!));
    buf[buf.length - 1] = buf[buf.length - 1]! ^ 0xff;
    writeFileSync(join(dir, files[0]!), buf);
    expect(c.load()).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses different files for different clientId/tokenUrl pairs', () => {
    const a = new TokenCache({ clientId: 'a', tokenUrl: 'https://x/t', dir, log });
    const b = new TokenCache({ clientId: 'b', tokenUrl: 'https://x/t', dir, log });
    a.save('rA', 'a', 'https://x/t');
    b.save('rB', 'b', 'https://x/t');
    expect(a.load()?.refreshToken).toBe('rA');
    expect(b.load()?.refreshToken).toBe('rB');
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates key.bin on first save', () => {
    const c = new TokenCache({ clientId: 'cid', tokenUrl: 'https://x/t', dir, log });
    c.save('r', 'cid', 'https://x/t');
    expect(existsSync(join(dir, 'key.bin'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
