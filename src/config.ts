import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { assertSecureUrl } from './security.js';

const UpstreamSchema = z.object({
  url: z.string().url(),
  timeoutMs: z.number().int().positive().default(300_000),
  openServerStream: z.boolean().default(true),
  protocolVersion: z.string().optional(),
});

const BaseOAuthSchema = z.object({
  tokenUrl: z.string().url().optional(),
  clientId: z.string().min(1),
  clientSecret: z.string().optional(),
  scope: z.string().optional(),
  audience: z.string().optional(),
  authStyle: z.enum(['header', 'body']).default('body'),
  refreshSkewSeconds: z.number().int().nonnegative().default(30),
  extraParams: z.record(z.string()).optional(),
});

const ClientCredentialsSchema = BaseOAuthSchema.extend({
  grant: z.literal('client_credentials'),
});

const AuthorizationCodeSchema = BaseOAuthSchema.extend({
  grant: z.literal('authorization_code'),
  authorizationCode: z.string().min(1).optional(),
  authorizationUrl: z.string().url().optional(),
  redirectUri: z.string().url().optional(),
  codeVerifier: z.string().min(1).optional(),
  refreshToken: z.string().min(1).optional(),
  interactive: z.boolean().default(true),
  callbackHost: z.string().min(1).default('127.0.0.1'),
  callbackPort: z.number().int().min(0).max(65535).default(53682),
  callbackTimeoutSeconds: z.number().int().positive().default(300),
  tokenCacheDir: z.string().min(1).optional(),
});

const OAuthSchema = z.discriminatedUnion('grant', [
  ClientCredentialsSchema,
  AuthorizationCodeSchema,
]);

const DiscoverySchema = z
  .object({
    enabled: z.boolean().default(true),
  })
  .default({});

const LogSchema = z.object({
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

const ConfigSchema = z.object({
  upstream: UpstreamSchema,
  oauth2: OAuthSchema,
  discovery: DiscoverySchema,
  log: LogSchema.default({}),
  allowInsecureHttp: z.boolean().default(false),
});

export type Config = z.infer<typeof ConfigSchema>;
export type OAuthConfig = z.infer<typeof OAuthSchema>;

function applyEnvOverrides(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const cfg = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  const oauth = (cfg.oauth2 ?? {}) as Record<string, unknown>;

  const env = process.env;
  if (env.OAUTH2_GRANT) oauth.grant = env.OAUTH2_GRANT;
  if (env.OAUTH2_TOKEN_URL) oauth.tokenUrl = env.OAUTH2_TOKEN_URL;
  if (env.OAUTH2_CLIENT_ID) oauth.clientId = env.OAUTH2_CLIENT_ID;
  if (env.OAUTH2_CLIENT_SECRET) oauth.clientSecret = env.OAUTH2_CLIENT_SECRET;
  if (env.OAUTH2_REFRESH_TOKEN) oauth.refreshToken = env.OAUTH2_REFRESH_TOKEN;
  if (env.OAUTH2_AUTHORIZATION_CODE) oauth.authorizationCode = env.OAUTH2_AUTHORIZATION_CODE;
  if (env.OAUTH2_AUTHORIZATION_URL) oauth.authorizationUrl = env.OAUTH2_AUTHORIZATION_URL;
  if (env.OAUTH2_CODE_VERIFIER) oauth.codeVerifier = env.OAUTH2_CODE_VERIFIER;
  if (env.OAUTH2_REDIRECT_URI) oauth.redirectUri = env.OAUTH2_REDIRECT_URI;
  if (env.OAUTH2_INTERACTIVE !== undefined) oauth.interactive = parseBool(env.OAUTH2_INTERACTIVE);
  if (env.OAUTH2_CALLBACK_HOST) oauth.callbackHost = env.OAUTH2_CALLBACK_HOST;
  if (env.OAUTH2_CALLBACK_PORT)
    oauth.callbackPort = parseIntEnv('OAUTH2_CALLBACK_PORT', env.OAUTH2_CALLBACK_PORT);
  if (env.OAUTH2_CALLBACK_TIMEOUT_SECONDS)
    oauth.callbackTimeoutSeconds = parseIntEnv(
      'OAUTH2_CALLBACK_TIMEOUT_SECONDS',
      env.OAUTH2_CALLBACK_TIMEOUT_SECONDS,
    );
  if (env.OAUTH2_TOKEN_CACHE_DIR) oauth.tokenCacheDir = env.OAUTH2_TOKEN_CACHE_DIR;
  if (env.OAUTH2_SCOPE) oauth.scope = env.OAUTH2_SCOPE;
  if (env.OAUTH2_AUDIENCE) oauth.audience = env.OAUTH2_AUDIENCE;
  if (env.OAUTH2_AUTH_STYLE) oauth.authStyle = env.OAUTH2_AUTH_STYLE;
  if (env.OAUTH2_REFRESH_SKEW_SECONDS)
    oauth.refreshSkewSeconds = parseIntEnv(
      'OAUTH2_REFRESH_SKEW_SECONDS',
      env.OAUTH2_REFRESH_SKEW_SECONDS,
    );
  if (env.OAUTH2_EXTRA_PARAMS) {
    try {
      oauth.extraParams = JSON.parse(env.OAUTH2_EXTRA_PARAMS);
    } catch (err) {
      throw new Error(`OAUTH2_EXTRA_PARAMS is not valid JSON: ${(err as Error).message}`);
    }
  }
  cfg.oauth2 = oauth;

  const upstream = (cfg.upstream ?? {}) as Record<string, unknown>;
  if (env.UPSTREAM_URL) upstream.url = env.UPSTREAM_URL;
  if (env.UPSTREAM_TIMEOUT_MS)
    upstream.timeoutMs = parseIntEnv('UPSTREAM_TIMEOUT_MS', env.UPSTREAM_TIMEOUT_MS);
  if (env.UPSTREAM_PROTOCOL_VERSION) upstream.protocolVersion = env.UPSTREAM_PROTOCOL_VERSION;
  if (env.UPSTREAM_OPEN_SERVER_STREAM)
    upstream.openServerStream = parseBool(env.UPSTREAM_OPEN_SERVER_STREAM);
  cfg.upstream = upstream;

  const discovery = (cfg.discovery ?? {}) as Record<string, unknown>;
  if (env.DISCOVERY_ENABLED !== undefined) discovery.enabled = parseBool(env.DISCOVERY_ENABLED);
  cfg.discovery = discovery;

  const log = (cfg.log ?? {}) as Record<string, unknown>;
  if (env.LOG_LEVEL) log.level = env.LOG_LEVEL;
  cfg.log = log;

  if (env.ALLOW_INSECURE_HTTP !== undefined)
    cfg.allowInsecureHttp = parseBool(env.ALLOW_INSECURE_HTTP);

  return cfg;
}

function parseBool(v: string): boolean {
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function parseIntEnv(name: string, raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === '' || !/^-?\d+$/.test(trimmed)) {
    throw new Error(`${name} must be an integer, got "${raw}"`);
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n)) {
    throw new Error(`${name} is out of range: "${raw}"`);
  }
  return n;
}

export function loadConfig(path?: string): Config {
  const file = path ?? process.env.MCP_PROXY_CONFIG;
  let raw: unknown = {};
  if (file) {
    const text = readFileSync(file, 'utf8');
    raw = JSON.parse(text);
  }
  const merged = applyEnvOverrides(raw);
  const cfg = ConfigSchema.parse(merged);

  assertSecureUrl(cfg.upstream.url, {
    allowInsecureHttp: cfg.allowInsecureHttp,
    label: 'upstream.url',
  });
  if (cfg.oauth2.tokenUrl) {
    assertSecureUrl(cfg.oauth2.tokenUrl, {
      allowInsecureHttp: cfg.allowInsecureHttp,
      label: 'oauth2.tokenUrl',
    });
  }
  if (cfg.oauth2.grant === 'authorization_code' && cfg.oauth2.authorizationUrl) {
    assertSecureUrl(cfg.oauth2.authorizationUrl, {
      allowInsecureHttp: cfg.allowInsecureHttp,
      label: 'oauth2.authorizationUrl',
    });
  }
  return cfg;
}
