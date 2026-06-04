import { request, type Dispatcher } from 'undici';
import type { Logger } from './log.js';
import type { TokenManager } from './oauth2/tokenManager.js';
import { type JsonRpcMessage, StdioCodec, isRequest } from './stdio.js';

export interface BridgeOptions {
  upstreamUrl: string;
  timeoutMs: number;
  openServerStream: boolean;
  protocolVersion?: string;
  tokenManager: TokenManager;
  codec: StdioCodec;
  log: Logger;
}

interface UpstreamHeaders {
  authorization: string;
  accept: string;
  'content-type': string;
  'mcp-protocol-version'?: string;
  'mcp-session-id'?: string;
}

/**
 * Bridges an MCP stdio client to an OAuth2-protected MCP streamable-HTTP
 * upstream. Each inbound JSON-RPC message is POSTed to the upstream with a
 * Bearer token. Upstream responses (single JSON or SSE stream) are written
 * back to stdout as newline-delimited JSON-RPC.
 *
 * Optionally opens a long-lived GET SSE channel for server-initiated
 * notifications after the upstream returns a session id.
 */
export class Bridge {
  private sessionId?: string;
  private serverStreamCtrl?: AbortController;
  private serverStreamRunning = false;
  private serverStreamDisabled = false;

  constructor(private readonly opts: BridgeOptions) {}

  async run(): Promise<void> {
    this.opts.log.info('bridge.run: waiting for messages on stdin');
    let count = 0;
    let pending = Promise.resolve();
    for await (const msg of this.opts.codec.messages()) {
      count++;
      this.opts.log.debug(
        { count, method: msg.method, id: msg.id, hasResult: msg.result !== undefined },
        'bridge.run: received message from stdin',
      );
      pending = pending.then(() => this.handleClientMessage(msg));
    }
    this.opts.log.info({ count }, 'bridge.run: stdin closed, exiting message loop');
    this.serverStreamCtrl?.abort();
  }

  private async buildHeaders(extra?: Record<string, string>): Promise<UpstreamHeaders> {
    this.opts.log.debug('buildHeaders: fetching access token');
    const { accessToken, tokenType } = await this.opts.tokenManager.getToken();
    this.opts.log.debug({ tokenType, tokenLen: accessToken.length }, 'buildHeaders: got token');
    const headers: UpstreamHeaders = {
      authorization: `${tokenType} ${accessToken}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    if (this.opts.protocolVersion) headers['mcp-protocol-version'] = this.opts.protocolVersion;
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    return { ...headers, ...(extra as Partial<UpstreamHeaders>) };
  }

  private async handleClientMessage(msg: JsonRpcMessage): Promise<void> {
    const isInit = msg.method === 'initialize';
    const tag = { method: msg.method, id: msg.id };
    try {
      const body = JSON.stringify(msg);
      this.opts.log.debug({ ...tag, bytes: body.length }, 'forwarding to upstream');
      const res = await this.post(body);
      this.opts.log.debug(
        { ...tag, status: res.statusCode, contentType: headerString(res.headers['content-type']) },
        'upstream response received',
      );

      if (res.statusCode === 401) {
        this.opts.log.warn(tag, 'upstream returned 401, refreshing token and retrying');
        await res.body.dump();
        this.opts.tokenManager.invalidate();
        const retry = await this.post(body);
        this.opts.log.debug({ ...tag, status: retry.statusCode }, 'retry upstream response');
        await this.processUpstreamResponse(retry, msg, isInit);
        return;
      }
      await this.processUpstreamResponse(res, msg, isInit);
    } catch (err) {
      const e = err as { message?: string; code?: string; cause?: { message?: string } };
      const reason = e.cause?.message ?? e.message ?? String(err);
      const isTimeout =
        e.code === 'UND_ERR_BODY_TIMEOUT' ||
        e.code === 'UND_ERR_HEADERS_TIMEOUT' ||
        /deadline exceeded|timeout/i.test(reason);
      this.opts.log.error({ err, ...tag, isTimeout }, 'failed to forward to upstream');
      if (isRequest(msg)) {
        this.opts.codec.write({
          jsonrpc: '2.0',
          id: msg.id!,
          error: {
            code: -32000,
            message: isTimeout
              ? `mcp-oauth2-proxy: upstream timed out after ${this.opts.timeoutMs} ms`
              : 'mcp-oauth2-proxy: upstream request failed',
            data: { reason, code: e.code },
          },
        });
      }
    }
  }

  private async post(body: string): Promise<Dispatcher.ResponseData> {
    const headers = await this.buildHeaders();
    this.opts.log.debug(
      { url: this.opts.upstreamUrl, hasSession: !!this.sessionId },
      'POST upstream',
    );
    const ctrl = new AbortController();
    const deadline = setTimeout(() => ctrl.abort(new Error('upstream deadline exceeded')), this.opts.timeoutMs);
    try {
      return await request(this.opts.upstreamUrl, {
        method: 'POST',
        headers: headers as unknown as Record<string, string>,
        body,
        signal: ctrl.signal,
        bodyTimeout: this.opts.timeoutMs,
        headersTimeout: this.opts.timeoutMs,
      });
    } finally {
      clearTimeout(deadline);
    }
  }

  private async processUpstreamResponse(
    res: Dispatcher.ResponseData,
    requestMsg: JsonRpcMessage,
    isInit: boolean,
  ): Promise<void> {
    const sid = headerString(res.headers['mcp-session-id']);
    if (sid && !this.sessionId) {
      this.sessionId = sid;
      this.opts.log.info({ sessionId: sid }, 'captured mcp session id');
    }

    if (res.statusCode === 202) {
      await res.body.dump();
      if (isInit && this.opts.openServerStream) this.ensureServerStream();
      return;
    }

    if (res.statusCode < 200 || res.statusCode >= 300) {
      const text = await res.body.text();
      this.opts.log.error({ status: res.statusCode, body: text.slice(0, 500) }, 'upstream error');
      if (isRequest(requestMsg)) {
        this.opts.codec.write({
          jsonrpc: '2.0',
          id: requestMsg.id!,
          error: {
            code: -32001,
            message: `mcp-oauth2-proxy: upstream returned ${res.statusCode}`,
            data: { status: res.statusCode, body: text.slice(0, 500) },
          },
        });
      }
      return;
    }

    const contentType = headerString(res.headers['content-type']) ?? '';
    if (contentType.includes('text/event-stream')) {
      this.opts.log.debug('consuming SSE stream from upstream');
      await this.consumeSse(res.body);
    } else {
      const text = await res.body.text();
      if (text.length === 0) {
        this.opts.log.debug('upstream returned empty body');
        return;
      }
      try {
        const parsed = JSON.parse(text) as JsonRpcMessage | JsonRpcMessage[];
        const count = Array.isArray(parsed) ? parsed.length : 1;
        this.opts.log.debug({ count }, 'writing JSON response to stdout');
        if (Array.isArray(parsed)) for (const m of parsed) this.opts.codec.write(m);
        else this.opts.codec.write(parsed);
      } catch (err) {
        this.opts.log.error({ err, text: text.slice(0, 500) }, 'failed to parse upstream JSON');
      }
    }

    if (isInit && this.opts.openServerStream) this.ensureServerStream();
  }

  private async consumeSse(body: Dispatcher.ResponseData['body']): Promise<void> {
    const MAX_BUF = 8 * 1024 * 1024; // 8 MB guard
    let buf = '';
    for await (const chunk of body) {
      buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      if (buf.length > MAX_BUF) {
        this.opts.log.error({ bufLen: buf.length }, 'SSE buffer exceeded 8 MB limit, aborting stream');
        break;
      }
      let idx: number;
      while ((idx = findEventBoundary(buf)) !== -1) {
        const event = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^(\r?\n)+/, '');
        this.emitSseEvent(event);
      }
    }
    if (buf.trim().length > 0) this.emitSseEvent(buf);
  }

  private emitSseEvent(raw: string): void {
    const dataLines: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length === 0) return;
    const payload = dataLines.join('\n');
    try {
      const parsed = JSON.parse(payload) as JsonRpcMessage | JsonRpcMessage[];
      const count = Array.isArray(parsed) ? parsed.length : 1;
      this.opts.log.debug({ count }, 'writing SSE event to stdout');
      if (Array.isArray(parsed)) for (const m of parsed) this.opts.codec.write(m);
      else this.opts.codec.write(parsed);
    } catch (err) {
      this.opts.log.warn({ err, payload: payload.slice(0, 200) }, 'non-JSON SSE data, dropping');
    }
  }

  private ensureServerStream(): void {
    if (this.serverStreamDisabled || this.serverStreamRunning) return;
    this.serverStreamRunning = true;
    void this.runServerStream().finally(() => {
      this.serverStreamRunning = false;
    });
  }

  private async runServerStream(): Promise<void> {
    const maxRetries = 10;
    let retries = 0;
    while (true) {
      if (retries >= maxRetries) {
        this.opts.log.warn(
          { retries },
          'server-stream exceeded max retries; will not attempt again',
        );
        this.serverStreamDisabled = true;
        return;
      }
      this.serverStreamCtrl = new AbortController();
      try {
        const headers = await this.buildHeaders({ accept: 'text/event-stream' });
        const res = await request(this.opts.upstreamUrl, {
          method: 'GET',
          headers: headers as unknown as Record<string, string>,
          signal: this.serverStreamCtrl.signal,
        });
        if (res.statusCode === 401) {
          this.opts.log.warn('server-stream 401, refreshing token');
          await res.body.dump();
          this.opts.tokenManager.invalidate();
          retries++;
          await sleep(backoffMs(retries));
          continue;
        }
        if (res.statusCode === 405 || res.statusCode === 404) {
          this.opts.log.info(
            { status: res.statusCode },
            'upstream does not support server stream; will not attempt again',
          );
          this.serverStreamDisabled = true;
          await res.body.dump();
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          this.opts.log.warn({ status: res.statusCode }, 'server-stream error; reconnecting');
          await res.body.dump();
          retries++;
          await sleep(backoffMs(retries));
          continue;
        }
        const contentType = headerString(res.headers['content-type']) ?? '';
        if (!contentType.includes('text/event-stream')) {
          await res.body.dump();
          return;
        }
        retries = 0;
        await this.consumeSse(res.body);
        await sleep(500);
      } catch (err) {
        if ((err as { name?: string }).name === 'AbortError') return;
        this.opts.log.warn({ err }, 'server-stream connection error; backing off');
        retries++;
        await sleep(backoffMs(retries));
      }
    }
  }
}

function headerString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function findEventBoundary(buf: string): number {
  const a = buf.indexOf('\n\n');
  const b = buf.indexOf('\r\n\r\n');
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Exponential backoff with jitter: base 500 ms, cap 30 s */
function backoffMs(attempt: number): number {
  const base = 500;
  const cap = 30_000;
  const exp = Math.min(cap, base * 2 ** (attempt - 1));
  return exp / 2 + Math.random() * (exp / 2);
}
