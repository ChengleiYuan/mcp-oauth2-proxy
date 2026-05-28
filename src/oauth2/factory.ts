import type { OAuthConfig } from '../config.js';
import { undiciHttpClient } from './http.js';
import { ClientCredentialsGrant } from './grants/clientCredentials.js';
import { AuthorizationCodeGrant } from './grants/authorizationCode.js';
import type { Grant } from './grants/types.js';

export function buildGrant(cfg: OAuthConfig): Grant {
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
    extraParams: cfg.extraParams,
  };

  switch (cfg.grant) {
    case 'client_credentials':
      return new ClientCredentialsGrant({ ...base, audience: cfg.audience }, http);
    case 'authorization_code':
      return new AuthorizationCodeGrant(
        {
          ...base,
          authorizationCode: cfg.authorizationCode,
          redirectUri: cfg.redirectUri,
          codeVerifier: cfg.codeVerifier,
          initialRefreshToken: cfg.refreshToken,
        },
        http,
      );
  }
}
