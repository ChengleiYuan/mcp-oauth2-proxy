import { describe, it, expect, vi } from 'vitest';
import { TokenManager } from '../src/oauth2/tokenManager.js';
import type { Grant, TokenResponse } from '../src/oauth2/grants/types.js';

function makeGrant(responses: TokenResponse[]): Grant & { calls: number } {
  let i = 0;
  const g = {
    name: 'fake',
    calls: 0,
    supportsRenewal: () => true,
    async fetchToken(): Promise<TokenResponse> {
      g.calls++;
      const idx = Math.min(i, responses.length - 1);
      i++;
      return responses[idx]!;
    },
  };
  return g;
}

describe('TokenManager', () => {
  it('caches token until skew window', async () => {
    let now = 1_000_000;
    const grant = makeGrant([
      { accessToken: 't1', tokenType: 'Bearer', expiresInSeconds: 100 },
      { accessToken: 't2', tokenType: 'Bearer', expiresInSeconds: 100 },
    ]);
    const tm = new TokenManager({ grant, refreshSkewSeconds: 10, now: () => now });

    expect((await tm.getToken()).accessToken).toBe('t1');
    expect(grant.calls).toBe(1);

    now += 50_000; // 50s elapsed, 50s remaining > 10s skew
    expect((await tm.getToken()).accessToken).toBe('t1');
    expect(grant.calls).toBe(1);

    now += 45_000; // 5s remaining < 10s skew
    expect((await tm.getToken()).accessToken).toBe('t2');
    expect(grant.calls).toBe(2);
  });

  it('deduplicates concurrent refreshes', async () => {
    const grant = makeGrant([{ accessToken: 't1', tokenType: 'Bearer', expiresInSeconds: 100 }]);
    const tm = new TokenManager({ grant, refreshSkewSeconds: 10 });
    const [a, b, c] = await Promise.all([tm.getToken(), tm.getToken(), tm.getToken()]);
    expect(a.accessToken).toBe('t1');
    expect(b.accessToken).toBe('t1');
    expect(c.accessToken).toBe('t1');
    expect(grant.calls).toBe(1);
  });

  it('invalidate() forces refresh', async () => {
    const grant = makeGrant([
      { accessToken: 't1', tokenType: 'Bearer', expiresInSeconds: 1000 },
      { accessToken: 't2', tokenType: 'Bearer', expiresInSeconds: 1000 },
    ]);
    const tm = new TokenManager({ grant, refreshSkewSeconds: 10 });
    expect((await tm.getToken()).accessToken).toBe('t1');
    tm.invalidate();
    expect((await tm.getToken()).accessToken).toBe('t2');
    expect(grant.calls).toBe(2);
  });

  it('propagates fetch errors and clears inflight', async () => {
    const failing: Grant = {
      name: 'fail',
      supportsRenewal: () => true,
      fetchToken: vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({
        accessToken: 'ok',
        tokenType: 'Bearer',
        expiresInSeconds: 100,
      }),
    };
    const tm = new TokenManager({ grant: failing, refreshSkewSeconds: 10 });
    await expect(tm.getToken()).rejects.toThrow('boom');
    expect((await tm.getToken()).accessToken).toBe('ok');
  });
});
