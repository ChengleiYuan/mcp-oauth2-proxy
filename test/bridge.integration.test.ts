import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createLogger } from '../src/log.js';
import { TokenManager } from '../src/oauth2/tokenManager.js';
import { ClientCredentialsGrant } from '../src/oauth2/grants/clientCredentials.js';
import { undiciHttpClient } from '../src/oauth2/http.js';
import { StdioCodec, type JsonRpcMessage } from '../src/stdio.js';
import { Bridge } from '../src/bridge.js';

interface IdpState {
  tokenCalls: number;
  nextAccessToken: string;
}
interface UpstreamState {
  rejectFirstWithUnauthorized: boolean;
  seenAuth: string[];
  seenSessionIds: string[];
  postsToRespondWithSse: boolean;
  serverStreamRequested: boolean;
  slowMethodDelayMs: number;
  respond404ForMethod: string | null;
  getRequestCount: number;
  respond400OnGet: boolean;
}

function makeIdp(state: IdpState): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const params = new URLSearchParams(body);
      if (params.get('grant_type') !== 'client_credentials') {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'unsupported_grant' }));
        return;
      }
      state.tokenCalls++;
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          access_token: state.nextAccessToken,
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      );
    });
  });
}

function makeUpstream(state: UpstreamState): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    state.seenAuth.push(req.headers.authorization ?? '');
    const sid = req.headers['mcp-session-id'];
    if (typeof sid === 'string') state.seenSessionIds.push(sid);

    if (state.rejectFirstWithUnauthorized) {
      state.rejectFirstWithUnauthorized = false;
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    if (req.method === 'GET') {
      state.serverStreamRequested = true;
      state.getRequestCount++;
      if (state.respond400OnGet) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'bad request' }));
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache');
      res.write(
        'data: ' +
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/server_push',
            params: { hello: 'from-server-stream' },
          }) +
          '\n\n',
      );
      return;
    }

    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body) as JsonRpcMessage;
      const isInit = msg.method === 'initialize';
      res.setHeader('mcp-session-id', 'srv-session');

      if (state.respond404ForMethod && msg.method === state.respond404ForMethod) {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'session not found' }));
        return;
      }

      if (msg.id === undefined || msg.id === null) {
        res.statusCode = 202;
        res.end();
        return;
      }

      const responseMsg = {
        jsonrpc: '2.0',
        id: msg.id,
        result: { ok: true, method: msg.method, isInit },
      };

      const finish = () => {
        if (state.postsToRespondWithSse) {
          res.statusCode = 200;
          res.setHeader('content-type', 'text/event-stream');
          res.write('data: ' + JSON.stringify(responseMsg) + '\n\n');
          res.end();
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(responseMsg));
      };

      if (state.slowMethodDelayMs > 0 && msg.method === 'slow') {
        setTimeout(finish, state.slowMethodDelayMs);
        return;
      }
      finish();
    });
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (typeof addr !== 'object' || !addr) throw new Error('no address');
  return addr.port;
}

async function collectMessages(
  stream: PassThrough,
  expected: number,
  timeoutMs = 1000,
): Promise<JsonRpcMessage[]> {
  const out: JsonRpcMessage[] = [];
  const start = Date.now();
  let buffer = '';
  stream.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.length === 0) continue;
      out.push(JSON.parse(line) as JsonRpcMessage);
    }
  });
  while (out.length < expected && Date.now() - start < timeoutMs) {
    await delay(10);
  }
  return out;
}

describe('Bridge (stdio ↔ HTTP MCP)', () => {
  let idp: Server;
  let upstream: Server;
  let idpPort: number;
  let upstreamPort: number;
  const idpState: IdpState = { tokenCalls: 0, nextAccessToken: 'tok-1' };
  const upstreamState: UpstreamState = {
    rejectFirstWithUnauthorized: false,
    seenAuth: [],
    seenSessionIds: [],
    postsToRespondWithSse: false,
    serverStreamRequested: false,
    slowMethodDelayMs: 0,
    respond404ForMethod: null,
    getRequestCount: 0,
    respond400OnGet: false,
  };

  beforeAll(async () => {
    idp = makeIdp(idpState);
    upstream = makeUpstream(upstreamState);
    idpPort = await listen(idp);
    upstreamPort = await listen(upstream);
  });
  afterAll(async () => {
    await new Promise<void>((r) => idp.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  function makeBridge(opts?: { openServerStream?: boolean }): {
    bridge: Bridge;
    stdin: PassThrough;
    stdout: PassThrough;
    runPromise: Promise<void>;
  } {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const codec = new StdioCodec(stdin, stdout);
    const log = createLogger('silent' as never);
    const grant = new ClientCredentialsGrant(
      {
        tokenUrl: `http://127.0.0.1:${idpPort}/token`,
        clientId: 'cid',
        clientSecret: 'csec',
        authStyle: 'body',
      },
      undiciHttpClient,
    );
    const tm = new TokenManager({ grant, refreshSkewSeconds: 30, log });
    const bridge = new Bridge({
      upstreamUrl: `http://127.0.0.1:${upstreamPort}/mcp`,
      timeoutMs: 5000,
      openServerStream: opts?.openServerStream ?? false,
      tokenManager: tm,
      codec,
      log,
    });
    const runPromise = bridge.run();
    return { bridge, stdin, stdout, runPromise };
  }

  it('forwards a request, injects Bearer, returns JSON response on stdout', async () => {
    const { stdin, stdout, runPromise } = makeBridge();
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n');
    const msgs = await collectMessages(stdout, 1);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.id).toBe(1);
    expect((msgs[0]!.result as { ok: boolean }).ok).toBe(true);
    expect(upstreamState.seenAuth.at(-1)).toBe('Bearer tok-1');
    stdin.end();
    await runPromise;
  });

  it('echoes captured session id on subsequent requests', async () => {
    upstreamState.seenSessionIds.length = 0;
    const { stdin, stdout, runPromise } = makeBridge();
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n');
    await collectMessages(stdout, 1);
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    await collectMessages(stdout, 2);
    expect(upstreamState.seenSessionIds).toContain('srv-session');
    stdin.end();
    await runPromise;
  });

  it('parses SSE responses to POST and emits embedded JSON-RPC to stdout', async () => {
    upstreamState.postsToRespondWithSse = true;
    const { stdin, stdout, runPromise } = makeBridge();
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call' }) + '\n');
    const msgs = await collectMessages(stdout, 1);
    expect(msgs[0]!.id).toBe(7);
    upstreamState.postsToRespondWithSse = false;
    stdin.end();
    await runPromise;
  });

  it('refreshes token on upstream 401 and retries once', async () => {
    idpState.nextAccessToken = 'tok-2';
    upstreamState.rejectFirstWithUnauthorized = true;
    const tokensBefore = idpState.tokenCalls;
    const { stdin, stdout, runPromise } = makeBridge();
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'ping' }) + '\n');
    const msgs = await collectMessages(stdout, 1);
    expect(msgs[0]!.id).toBe(42);
    expect(upstreamState.seenAuth.at(-1)).toBe('Bearer tok-2');
    expect(idpState.tokenCalls).toBeGreaterThan(tokensBefore);
    stdin.end();
    await runPromise;
  });

  it('does not let a slow request block a concurrent ping (keepalive)', async () => {
    upstreamState.slowMethodDelayMs = 300;
    const { stdin, stdout, runPromise } = makeBridge();
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n');
    await collectMessages(stdout, 1);

    // Fire a slow call, then immediately a ping. The ping must come back well
    // before the slow call finishes, proving requests are not serialized.
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'slow' }) + '\n');
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }) + '\n');

    const pingFirst = await collectMessages(stdout, 2, 200);
    // Within 200ms (< the 300ms slow delay) we should already have the ping
    // response (id 3) back, while the slow response (id 2) is still pending.
    const ids = pingFirst.map((m) => m.id);
    expect(ids).toContain(3);
    expect(ids).not.toContain(2);

    // The slow response (id 2) arrives later; a fresh collector only sees new data.
    const rest = await collectMessages(stdout, 1, 1000);
    expect(rest.map((m) => m.id)).toContain(2);

    upstreamState.slowMethodDelayMs = 0;
    stdin.end();
    await runPromise;
  });

  it('clears the session id on upstream 404 so a later initialize re-establishes it', async () => {
    upstreamState.seenSessionIds.length = 0;
    const { bridge, stdin, stdout, runPromise } = makeBridge();
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n');
    await collectMessages(stdout, 1);
    expect((bridge as unknown as { sessionId?: string }).sessionId).toBe('srv-session');

    // Upstream now rejects this session id with 404 (expired session).
    upstreamState.respond404ForMethod = 'ping';
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');
    const msgs = await collectMessages(stdout, 2);
    const err = msgs.find((m) => m.id === 2);
    expect(err?.error).toBeDefined();
    // The stale session id must have been forgotten.
    expect((bridge as unknown as { sessionId?: string }).sessionId).toBeUndefined();

    upstreamState.respond404ForMethod = null;
    stdin.end();
    await runPromise;
  });

  it('disables the server-stream after a single 400 GET instead of retrying', async () => {
    upstreamState.serverStreamRequested = false;
    upstreamState.getRequestCount = 0;
    upstreamState.respond400OnGet = true;
    const { bridge, stdin, stdout, runPromise } = makeBridge({ openServerStream: true });
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n');
    await collectMessages(stdout, 1);
    // Give the server-stream attempt time to run; it must NOT retry on 400.
    await delay(300);
    expect(upstreamState.getRequestCount).toBe(1);
    expect((bridge as unknown as { serverStreamDisabled: boolean }).serverStreamDisabled).toBe(true);
    upstreamState.respond400OnGet = false;
    stdin.end();
    await runPromise;
  });
});
