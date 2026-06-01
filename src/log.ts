import pino, { type Logger, type LoggerOptions } from 'pino';

/**
 * Logs MUST go to stderr — stdout is reserved for MCP JSON-RPC messages
 * on the stdio transport.
 */
export function createLogger(level: LoggerOptions['level'] = 'info'): Logger {
  return pino(
    {
      level,
      redact: {
        paths: [
          'access_token',
          'refresh_token',
          'client_secret',
          'authorization',
          'Authorization',
          '*.access_token',
          '*.refresh_token',
          '*.client_secret',
          'headers.authorization',
          'headers.Authorization',
          'oauth2.clientSecret',
          'oauth2.refreshToken',
          'oauth2.authorizationCode',
          'oauth2.codeVerifier',
        ],
        censor: '[redacted]',
      },
    },
    pino.destination(2),
  );
}

export type { Logger };
