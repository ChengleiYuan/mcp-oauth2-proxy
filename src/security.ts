/**
 * URL transport-security guards.
 *
 * OAuth2 access tokens, client secrets, and PKCE codes traverse the upstream
 * and token endpoints, so cleartext HTTP to a non-loopback host would leak
 * credentials. These helpers enforce https for remote hosts while still
 * allowing plaintext http to loopback addresses (local dev and the PKCE
 * callback redirect_uri).
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (LOOPBACK_HOSTS.has(h)) return true;
  // Entire 127.0.0.0/8 block is loopback.
  return /^127(?:\.\d{1,3}){3}$/.test(h);
}

export interface SecureUrlOptions {
  allowInsecureHttp: boolean;
  label: string;
}

/**
 * Throws if `url` uses cleartext http to a non-loopback host, unless
 * `allowInsecureHttp` is set. https and loopback-http always pass.
 */
export function assertSecureUrl(url: string, opts: SecureUrlOptions): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${opts.label} is not a valid URL: ${url}`);
  }
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol === 'http:') {
    if (isLoopbackHost(parsed.hostname) || opts.allowInsecureHttp) return;
    throw new Error(
      `${opts.label} uses cleartext http to a non-loopback host (${parsed.host}), ` +
        'which would leak OAuth2 credentials/tokens. Use https, target a loopback ' +
        'address, or set allowInsecureHttp / ALLOW_INSECURE_HTTP=true to override.',
    );
  }
  throw new Error(`${opts.label} must use http or https, got "${parsed.protocol}"`);
}
