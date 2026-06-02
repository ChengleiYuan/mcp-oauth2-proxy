import type { Readable, Writable } from 'node:stream';
import { createInterface, type Interface } from 'node:readline';

/**
 * MCP stdio transport: newline-delimited JSON-RPC messages.
 * Each message is a single JSON value terminated by a single `\n`.
 * Embedded newlines are not allowed in encoded messages.
 */
export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export class StdioCodec {
  private readonly rl: Interface;

  constructor(
    input: Readable,
    private readonly output: Writable,
  ) {
    this.rl = createInterface({ input, crlfDelay: Infinity });
  }

  async *messages(): AsyncGenerator<JsonRpcMessage> {
    for await (const line of this.rl) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(trimmed) as JsonRpcMessage;
      } catch {
        continue;
      }
      yield msg;
    }
  }

  write(msg: JsonRpcMessage | unknown): void {
    const line = JSON.stringify(msg) + '\n';
    try {
      this.output.write(line);
    } catch {
      // stdout may already be closed (e.g. client disconnected); suppress to avoid uncaught exception
    }
  }

  close(): void {
    this.rl.close();
  }
}

export function isRequest(msg: JsonRpcMessage): boolean {
  return typeof msg.method === 'string' && msg.id !== undefined && msg.id !== null;
}

export function isNotification(msg: JsonRpcMessage): boolean {
  return typeof msg.method === 'string' && (msg.id === undefined || msg.id === null);
}

export function isResponse(msg: JsonRpcMessage): boolean {
  return typeof msg.method !== 'string' && msg.id !== undefined;
}
