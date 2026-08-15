import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import type { Logger } from '../log.js';
import { isLoopbackHost } from '../security.js';

export interface InteractiveAuthOptions {
  authorizationUrl: string;
  clientId: string;
  scope?: string;
  resource?: string;
  callbackHost: string;
  callbackPort: number;
  callbackTimeoutSeconds: number;
  redirectUri?: string;
  extraParams?: Record<string, string>;
  log: Logger;
  openBrowser?: (url: string) => void;
}

export interface InteractiveAuthResult {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export async function runInteractiveAuth(
  opts: InteractiveAuthOptions,
): Promise<InteractiveAuthResult> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = computeS256Challenge(codeVerifier);
  const state = base64UrlEncode(randomBytes(32));
  const redirectUri =
    opts.redirectUri ?? `http://${opts.callbackHost}:${opts.callbackPort}/callback`;

  if (!isLoopbackHost(opts.callbackHost)) {
    opts.log.warn(
      { callbackHost: opts.callbackHost },
      'interactive auth: callbackHost is not a loopback address; the OAuth callback ' +
        'listener will be reachable from other hosts. Bind 127.0.0.1 unless you have a reason not to.',
    );
  }

  const authUrl = buildAuthorizeUrl({
    authorizationUrl: opts.authorizationUrl,
    clientId: opts.clientId,
    redirectUri,
    scope: opts.scope,
    resource: opts.resource,
    state,
    codeChallenge,
    extraParams: opts.extraParams,
  });

  const { server, codePromise } = startCallbackServer({
    host: opts.callbackHost,
    port: opts.callbackPort,
    expectedState: state,
    timeoutMs: opts.callbackTimeoutSeconds * 1000,
    log: opts.log,
  });

  try {
    await waitForListening(server);
    opts.log.info(
      { url: authUrl, redirectUri },
      'interactive auth: open the following URL in your browser to log in',
    );
    process.stderr.write(`\n[mcp-oauth2-proxy] Open this URL to log in:\n  ${authUrl}\n\n`);
    const opener = opts.openBrowser ?? openBrowser;
    try {
      opener(authUrl);
    } catch (err) {
      opts.log.warn({ err }, 'interactive auth: failed to launch browser');
    }
    const code = await codePromise;
    return { code, codeVerifier, redirectUri };
  } finally {
    server.close();
  }
}

export function generateCodeVerifier(): string {
  // 32 bytes -> 43 base64url chars, within RFC 7636 43..128 range
  return base64UrlEncode(randomBytes(32));
}

export function computeS256Challenge(verifier: string): string {
  return base64UrlEncode(createHash('sha256').update(verifier).digest());
}

export function buildAuthorizeUrl(args: {
  authorizationUrl: string;
  clientId: string;
  redirectUri: string;
  scope?: string;
  resource?: string;
  state: string;
  codeChallenge: string;
  extraParams?: Record<string, string>;
}): string {
  const u = new URL(args.authorizationUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', args.clientId);
  u.searchParams.set('redirect_uri', args.redirectUri);
  if (args.scope) u.searchParams.set('scope', args.scope);
  u.searchParams.set('state', args.state);
  u.searchParams.set('code_challenge', args.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (args.extraParams) {
    for (const [k, v] of Object.entries(args.extraParams)) u.searchParams.set(k, v);
  }
  if (args.resource) u.searchParams.set('resource', args.resource);
  return u.toString();
}

interface StartCallbackServerOptions {
  host: string;
  port: number;
  expectedState: string;
  timeoutMs: number;
  log: Logger;
}

export function startCallbackServer(opts: StartCallbackServerOptions): {
  server: Server;
  codePromise: Promise<string>;
} {
  let resolve!: (code: string) => void;
  let reject!: (err: Error) => void;
  const codePromise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const timer = setTimeout(() => {
    reject(new Error(`interactive auth timed out after ${opts.timeoutMs} ms`));
  }, opts.timeoutMs);
  timer.unref?.();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!isAllowedHost(req.headers.host, opts.port)) {
      opts.log.warn(
        { host: req.headers.host },
        'callback: rejected request with untrusted Host header',
      );
      respondHtml(res, 400, 'Authorization failed', 'Untrusted Host header.');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${opts.host}:${opts.port}`);
    if (url.pathname !== '/callback') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const error = url.searchParams.get('error');
    const errorDesc = url.searchParams.get('error_description');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (error) {
      respondHtml(
        res,
        400,
        `Authorization failed: ${escapeHtml(error)}`,
        errorDesc ? escapeHtml(errorDesc) : '',
      );
      clearTimeout(timer);
      reject(
        new Error(
          `authorization server returned error: ${error}${errorDesc ? ` - ${errorDesc}` : ''}`,
        ),
      );
      return;
    }
    if (!code || !state) {
      respondHtml(res, 400, 'Authorization failed', 'Missing code or state in callback.');
      clearTimeout(timer);
      reject(new Error('callback missing code or state'));
      return;
    }
    if (state !== opts.expectedState) {
      respondHtml(res, 400, 'Authorization failed', 'State mismatch — possible CSRF.');
      clearTimeout(timer);
      reject(new Error('callback state mismatch'));
      return;
    }
    respondHtml(
      res,
      200,
      'Login successful',
      'You can close this tab and return to your MCP client.',
    );
    clearTimeout(timer);
    resolve(code);
  });

  server.listen(opts.port, opts.host);
  return { server, codePromise };
}

function isAllowedHost(hostHeader: string | undefined, expectedPort: number): boolean {
  if (!hostHeader) return false;
  let parsed: URL;
  try {
    parsed = new URL(`http://${hostHeader}`);
  } catch {
    return false;
  }
  if (!isLoopbackHost(parsed.hostname)) return false;
  // An explicit port in the Host header must match the listener; absence is fine.
  if (parsed.port && Number(parsed.port) !== expectedPort) return false;
  return true;
}

function waitForListening(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (server.listening) {
      resolve();
      return;
    }
    const onListen = (): void => {
      server.off('error', onError);
      resolve();
    };
    const onError = (err: Error): void => {
      server.off('listening', onListen);
      reject(err);
    };
    server.once('listening', onListen);
    server.once('error', onError);
  });
}

function openBrowser(url: string): void {
  const plat = platform();
  let cmd: string;
  let args: string[];
  if (plat === 'win32') {
    // Avoid `cmd /c start` — `&` in the URL is a cmd command separator
    // even inside quotes. rundll32 hands the URL straight to the shell's
    // URL protocol handler with no further parsing.
    cmd = 'rundll32';
    args = ['url.dll,FileProtocolHandler', url];
  } else if (plat === 'darwin') {
    cmd = 'open';
    args = [url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  // If the opener binary is missing (e.g. headless Linux without xdg-utils)
  // Node emits an 'error' event that becomes an uncaught exception unless
  // we attach a handler. The user can still copy the URL printed to stderr.
  child.on('error', () => {
    /* swallowed; caller already logged the URL */
  });
  child.unref();
}

function respondHtml(res: ServerResponse, status: number, heading: string, body: string): void {
  res.statusCode = status;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(heading)}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1f2328}h1{font-size:1.25rem}</style>
</head><body><h1>${escapeHtml(heading)}</h1><p>${body}</p></body></html>`);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
