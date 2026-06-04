import { describe, it, expect } from 'vitest';
import { isLoopbackHost, assertSecureUrl } from '../src/security.js';

describe('isLoopbackHost', () => {
  it('recognizes loopback hosts', () => {
    for (const h of ['localhost', '127.0.0.1', '127.5.6.7', '::1', '[::1]', 'LOCALHOST']) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });

  it('rejects non-loopback hosts', () => {
    for (const h of ['example.com', '10.0.0.1', '0.0.0.0', '192.168.1.1', '8.8.8.8']) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});

describe('assertSecureUrl', () => {
  const ok = (url: string, allowInsecureHttp = false): void =>
    assertSecureUrl(url, { allowInsecureHttp, label: 'test' });

  it('allows https to any host', () => {
    expect(() => ok('https://example.com/x')).not.toThrow();
  });

  it('allows http to a loopback host', () => {
    expect(() => ok('http://127.0.0.1:8080/x')).not.toThrow();
    expect(() => ok('http://localhost/x')).not.toThrow();
  });

  it('rejects http to a non-loopback host by default', () => {
    expect(() => ok('http://example.com/x')).toThrow(/cleartext http/);
  });

  it('allows http to a non-loopback host when allowInsecureHttp is set', () => {
    expect(() => ok('http://example.com/x', true)).not.toThrow();
  });

  it('rejects non-http(s) schemes', () => {
    expect(() => ok('ftp://example.com/x')).toThrow(/http or https/);
  });

  it('rejects malformed URLs', () => {
    expect(() => ok('not a url')).toThrow(/not a valid URL/);
  });
});
