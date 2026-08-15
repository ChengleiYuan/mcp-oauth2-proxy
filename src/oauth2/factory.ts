import type { OAuthConfig } from '../config.js';
import { undiciHttpClient } from './http.js';
import { ClientCredentialsGrant } from './grants/clientCredentials.js';
import { AuthorizationCodeGrant } from './grants/authorizationCode.js';
import { TokenCache } from './tokenCache.js';
import type { Grant } from './grants/types.js';
import type { Logger } from '../log.js';

export interface BuildGrantOptions {
  cfg: OAuthConfig;
  log: Logger;
}

export function buildGrant(arg: OAuthConfig | BuildGrantOptions, log?: Logger): Grant {
  const cfg: OAuthConfig = isBuildGrantOptions(arg) ? arg.cfg : arg;
  const effectiveLog: Logger | undefined = isBuildGrantOptions(arg) ? arg.log : log;
  if (!cfg.tokenUrl) {
    throw new Error('OAuth2 token endpoint is not set; provide tokenUrl or enable discovery');
  }
  const http = undiciHttpClient;
  const base = {
    tokenUrl: cfg.tokenUrl,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    authStyle: cfg.authStyle,
    scope: cfg.scope,
    resource: cfg.resource,
    extraParams: cfg.extraParams,
  };

  switch (cfg.grant) {
    case 'client_credentials':
      return new ClientCredentialsGrant({ ...base, audience: cfg.audience }, http);
    case 'authorization_code': {
      if (!effectiveLog) {
        throw new Error('buildGrant: logger is required for authorization_code grant');
      }
      const cache = new TokenCache({
        clientId: cfg.clientId,
        tokenUrl: cfg.tokenUrl,
        dir: cfg.tokenCacheDir,
        log: effectiveLog,
      });
      const cached = cache.load();
      const initialRefreshToken = cfg.refreshToken ?? cached?.refreshToken;
      if (cached && !cfg.refreshToken) {
        effectiveLog.info('authorization_code: using cached refresh token from disk');
      }
      return new AuthorizationCodeGrant(
        {
          ...base,
          authorizationCode: cfg.authorizationCode,
          authorizationUrl: cfg.authorizationUrl,
          redirectUri: cfg.redirectUri,
          codeVerifier: cfg.codeVerifier,
          initialRefreshToken,
          interactive: cfg.interactive,
          callbackHost: cfg.callbackHost,
          callbackPort: cfg.callbackPort,
          callbackTimeoutSeconds: cfg.callbackTimeoutSeconds,
          log: effectiveLog,
          onRefreshTokenUpdated: (rt) => {
            cache.save(rt, cfg.clientId, cfg.tokenUrl!);
          },
        },
        http,
      );
    }
  }
}

function isBuildGrantOptions(v: OAuthConfig | BuildGrantOptions): v is BuildGrantOptions {
  return typeof v === 'object' && v !== null && 'cfg' in v && 'log' in v;
}
