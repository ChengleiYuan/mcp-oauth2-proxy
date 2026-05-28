import { request } from 'undici';
import type { Logger } from '../log.js';

/**
 * OAuth2 metadata discovery for MCP servers per RFC 9728 (OAuth 2.0 Protected
 * Resource Metadata) + RFC 8414 (OAuth 2.0 Authorization Server Metadata).
 *
 * Given an upstream MCP URL, attempts to:
 *   1. GET <upstream-origin>/.well-known/oauth-protected-resource[/<path>]
 *      → parse `authorization_servers[0]`
 *   2. GET <as>/.well-known/oauth-authorization-server (RFC 8414) or
 *      <as>/.well-known/openid-configuration (OpenID Connect Discovery)
 *      → parse `token_endpoint`, `authorization_endpoint`
 *
 * Returns whatever endpoints were found; callers should treat all fields as
 * optional and fail gracefully if a required endpoint is missing.
 */
export interface DiscoveryResult {
  resourceMetadataUrl?: string;
  authorizationServer?: string;
  tokenEndpoint?: string;
  authorizationEndpoint?: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
}

interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

interface AuthorizationServerMetadata {
  issuer?: string;
  token_endpoint?: string;
  authorization_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
}

export async function discoverFromUpstream(
  upstreamUrl: string,
  log: Logger,
): Promise<DiscoveryResult> {
  const result: DiscoveryResult = {};

  const resourceMetadataUrls = buildResourceMetadataUrls(upstreamUrl);
  const prm = await fetchFirstJson<ProtectedResourceMetadata>(resourceMetadataUrls, log);
  if (!prm) {
    log.warn(
      { tried: resourceMetadataUrls },
      'discovery: protected-resource metadata not found on upstream',
    );
    return result;
  }
  result.resourceMetadataUrl = prm.url;
  result.scopesSupported = prm.body.scopes_supported;
  log.info(
    {
      url: prm.url,
      resource: prm.body.resource,
      authorization_servers: prm.body.authorization_servers,
      scopes_supported: prm.body.scopes_supported,
    },
    'discovery: protected-resource metadata',
  );

  const asUrl = prm.body.authorization_servers?.[0];
  if (!asUrl) {
    log.warn('discovery: protected-resource metadata has no authorization_servers');
    return result;
  }
  result.authorizationServer = asUrl;

  const asMetadataUrls = buildAsMetadataUrls(asUrl);
  const as = await fetchFirstJson<AuthorizationServerMetadata>(asMetadataUrls, log);
  if (!as) {
    log.warn(
      { tried: asMetadataUrls },
      'discovery: authorization-server metadata not found',
    );
    return result;
  }
  result.tokenEndpoint = as.body.token_endpoint;
  result.authorizationEndpoint = as.body.authorization_endpoint;
  result.registrationEndpoint = as.body.registration_endpoint;
  if (!result.scopesSupported) result.scopesSupported = as.body.scopes_supported;
  log.info(
    {
      url: as.url,
      issuer: as.body.issuer,
      token_endpoint: as.body.token_endpoint,
      authorization_endpoint: as.body.authorization_endpoint,
    },
    'discovery: authorization-server metadata',
  );
  return result;
}

function buildResourceMetadataUrls(upstreamUrl: string): string[] {
  const u = new URL(upstreamUrl);
  return [`${u.origin}/.well-known/oauth-protected-resource`];
}

function buildAsMetadataUrls(asUrl: string): string[] {
  const u = new URL(asUrl);
  const path = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  const origin = u.origin;
  const urls: string[] = [];
  if (path) {
    urls.push(`${origin}/.well-known/oauth-authorization-server/${path}`);
    urls.push(`${origin}/${path}/.well-known/oauth-authorization-server`);
    urls.push(`${origin}/.well-known/openid-configuration/${path}`);
    urls.push(`${origin}/${path}/.well-known/openid-configuration`);
  } else {
    urls.push(`${origin}/.well-known/oauth-authorization-server`);
    urls.push(`${origin}/.well-known/openid-configuration`);
  }
  return urls;
}

async function fetchFirstJson<T>(
  urls: string[],
  log: Logger,
): Promise<{ url: string; body: T } | undefined> {
  for (const url of urls) {
    try {
      log.debug({ url }, 'discovery: GET');
      const res = await request(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        bodyTimeout: 5000,
        headersTimeout: 5000,
      });
      if (res.statusCode < 200 || res.statusCode >= 300) {
        log.debug({ url, status: res.statusCode }, 'discovery: non-2xx, trying next');
        await res.body.dump();
        continue;
      }
      const text = await res.body.text();
      try {
        const body = JSON.parse(text) as T;
        return { url, body };
      } catch (err) {
        log.debug({ url, err }, 'discovery: non-JSON body, trying next');
      }
    } catch (err) {
      log.debug({ url, err }, 'discovery: request error, trying next');
    }
  }
  return undefined;
}
