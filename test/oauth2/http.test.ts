import { describe, it, expect } from 'vitest';
import { parseTokenResponse } from '../../src/oauth2/http.js';

describe('parseTokenResponse', () => {
  it.each(['bearer', 'BEARER', 'bEaReR'])('normalizes %s token type', (tokenType) => {
    const token = parseTokenResponse(
      200,
      JSON.stringify({ access_token: 'access', token_type: tokenType }),
    );

    expect(token.tokenType).toBe('Bearer');
  });

  it('preserves other token types', () => {
    const token = parseTokenResponse(
      200,
      JSON.stringify({ access_token: 'access', token_type: 'MAC' }),
    );

    expect(token.tokenType).toBe('MAC');
  });
});
