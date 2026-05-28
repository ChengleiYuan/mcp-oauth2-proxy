export interface TokenResponse {
  accessToken: string;
  expiresInSeconds: number;
  refreshToken?: string;
  tokenType: string;
  scope?: string;
}

export interface Grant {
  readonly name: string;
  fetchToken(): Promise<TokenResponse>;
  supportsRenewal(): boolean;
}

export interface OAuthHttpClient {
  postForm(
    url: string,
    body: URLSearchParams,
    headers: Record<string, string>,
  ): Promise<{ status: number; bodyText: string }>;
}
