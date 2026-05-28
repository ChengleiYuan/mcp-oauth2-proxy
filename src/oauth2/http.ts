import { request } from 'undici';
import type { OAuthHttpClient, TokenResponse } from './grants/types.js';

export const undiciHttpClient: OAuthHttpClient = {
  async postForm(url, body, headers) {
    const res = await request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        ...headers,
      },
      body: body.toString(),
    });
    const bodyText = await res.body.text();
    return { status: res.statusCode, bodyText };
  },
};

interface RawTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

export function parseTokenResponse(status: number, bodyText: string): TokenResponse {
  let parsed: RawTokenResponse;
  try {
    parsed = JSON.parse(bodyText) as RawTokenResponse;
  } catch {
    throw new Error(
      `OAuth2 token endpoint returned non-JSON body (status ${status}): ${bodyText.slice(0, 200)}`,
    );
  }
  if (status < 200 || status >= 300 || !parsed.access_token) {
    const desc = parsed.error_description ?? parsed.error ?? bodyText.slice(0, 200);
    throw new Error(`OAuth2 token request failed (status ${status}): ${desc}`);
  }
  return {
    accessToken: parsed.access_token,
    expiresInSeconds: typeof parsed.expires_in === 'number' ? parsed.expires_in : 3600,
    refreshToken: parsed.refresh_token,
    tokenType: parsed.token_type ?? 'Bearer',
    scope: parsed.scope,
  };
}

export function basicAuthHeader(clientId: string, clientSecret: string): string {
  return (
    'Basic ' +
    Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString(
      'base64',
    )
  );
}

export function applyClientAuth(
  body: URLSearchParams,
  headers: Record<string, string>,
  opts: {
    clientId: string;
    clientSecret?: string;
    authStyle: 'header' | 'body';
  },
): void {
  if (opts.authStyle === 'header' && opts.clientSecret) {
    headers.authorization = basicAuthHeader(opts.clientId, opts.clientSecret);
    body.set('client_id', opts.clientId);
  } else {
    body.set('client_id', opts.clientId);
    if (opts.clientSecret) body.set('client_secret', opts.clientSecret);
  }
}
