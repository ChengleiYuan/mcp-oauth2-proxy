import type { OAuthHttpClient } from '../src/oauth2/grants/types.js';

export interface RecordedCall {
  url: string;
  body: Record<string, string>;
  headers: Record<string, string>;
}

export function mockHttpClient(
  responses: Array<{ status: number; body: unknown }>,
): OAuthHttpClient & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  return {
    calls,
    async postForm(url, body, headers) {
      const recorded: Record<string, string> = {};
      for (const [k, v] of body.entries()) recorded[k] = v;
      calls.push({ url, body: recorded, headers: { ...headers } });
      const r = responses[Math.min(i, responses.length - 1)]!;
      i++;
      return {
        status: r.status,
        bodyText: typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
      };
    },
  };
}
