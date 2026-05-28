#!/usr/bin/env node
import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { TokenManager } from './oauth2/tokenManager.js';
import { buildGrant } from './oauth2/factory.js';
import { discoverFromUpstream } from './oauth2/discovery.js';
import { StdioCodec } from './stdio.js';
import { Bridge } from './bridge.js';

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    process.stderr.write(`failed to load config: ${(err as Error).message}\n`);
    process.exit(2);
  }
  const log = createLogger(cfg.log.level);
  log.debug(
    {
      upstream: cfg.upstream,
      discovery: cfg.discovery,
      oauth2: {
        grant: cfg.oauth2.grant,
        tokenUrl: cfg.oauth2.tokenUrl,
        clientId: cfg.oauth2.clientId,
        clientSecretSet: !!cfg.oauth2.clientSecret,
        clientSecretLen: cfg.oauth2.clientSecret?.length ?? 0,
        scope: cfg.oauth2.scope,
        audience: cfg.oauth2.audience,
        authStyle: cfg.oauth2.authStyle,
        refreshSkewSeconds: cfg.oauth2.refreshSkewSeconds,
        extraParams: cfg.oauth2.extraParams,
      },
    },
    'loaded config (secrets redacted)',
  );

  if (cfg.discovery.enabled) {
    try {
      const discovered = await discoverFromUpstream(cfg.upstream.url, log);
      if (!cfg.oauth2.tokenUrl && discovered.tokenEndpoint) {
        cfg.oauth2.tokenUrl = discovered.tokenEndpoint;
        log.info({ tokenUrl: discovered.tokenEndpoint }, 'discovery: using discovered token endpoint');
      }
      if (!cfg.oauth2.scope && discovered.scopesSupported?.length) {
        cfg.oauth2.scope = discovered.scopesSupported.join(' ');
        log.info({ scope: cfg.oauth2.scope }, 'discovery: using discovered scopes');
      }
    } catch (err) {
      log.warn({ err }, 'discovery failed; continuing with configured values');
    }
  }

  let grant;
  try {
    grant = buildGrant(cfg.oauth2);
  } catch (err) {
    process.stderr.write(`failed to build oauth2 grant: ${(err as Error).message}\n`);
    process.exit(2);
  }
  const tokenManager = new TokenManager({
    grant,
    refreshSkewSeconds: cfg.oauth2.refreshSkewSeconds,
    log,
  });
  const codec = new StdioCodec(process.stdin, process.stdout);
  const bridge = new Bridge({
    upstreamUrl: cfg.upstream.url,
    timeoutMs: cfg.upstream.timeoutMs,
    openServerStream: cfg.upstream.openServerStream,
    protocolVersion: cfg.upstream.protocolVersion,
    tokenManager,
    codec,
    log,
  });

  const shutdown = (signal: string): void => {
    log.info({ signal }, 'shutting down');
    codec.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  log.info(
    {
      upstream: cfg.upstream.url,
      grant: cfg.oauth2.grant,
      pid: process.pid,
      stdinIsTTY: process.stdin.isTTY ?? false,
      logLevel: cfg.log.level,
    },
    'mcp-oauth2-proxy stdio bridge started',
  );
  if (process.stdin.isTTY) {
    log.warn(
      'stdin is a TTY — you are running interactively. Paste a single-line JSON-RPC request and press Enter. ' +
        'If launched via `tsx watch`/`npm run dev`, stdin may not be forwarded to the child process; ' +
        'use `npm run dev:once` or `node dist/index.js` for manual testing.',
    );
  }
  process.stdin.on('end', () => log.info('process.stdin: end event'));
  process.stdin.on('close', () => log.info('process.stdin: close event'));
  process.stdin.on('error', (err) => log.error({ err }, 'process.stdin: error event'));

  await bridge.run();
  log.info('stdin closed, exiting');
}

main().catch((err) => {
  process.stderr.write(`fatal error: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});

