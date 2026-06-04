# Copilot instructions for mcp-oauth2-proxy

A local **stdio MCP server** that proxies JSON-RPC to a remote, OAuth2-protected
**streamable-HTTP** MCP server. It acquires/renews OAuth2 tokens itself and
attaches a Bearer token to every upstream request. TypeScript, ESM, Node >= 20.

## Build, test, lint

```sh
npm run build            # tsc -> dist/ (also the publish gate via prepublishOnly)
npm test                 # vitest run (all unit + integration tests)
npm run test:watch       # vitest watch
npm run dev:once         # tsx src/index.ts (use this, NOT `npm run dev`, for manual stdin testing)
npm run format           # prettier --write
```

- Run a single test file: `npx vitest run test/oauth2/tokenManager.test.ts`
- Run tests matching a name: `npx vitest run -t "refresh"`
- `npm run lint` is currently **broken** (ESLint 9 expects `eslint.config.js`
  but the repo ships `.eslintrc.cjs`). Do not rely on it; use `npm run build`
  + `npm test` as the validation gate.

## Architecture (request lifecycle)

`src/index.ts` wires everything: `loadConfig()` → optional `discoverFromUpstream()`
→ `buildGrant()` → `TokenManager` → prefetch a token → `Bridge.run()`.

1. **`config.ts`** — Zod schemas validate a JSON config file (`MCP_PROXY_CONFIG`
   env or default path) merged with env-var overrides (env wins). `oauth2` is a
   `discriminatedUnion('grant', ...)` over `client_credentials` and
   `authorization_code`.
2. **`oauth2/discovery.ts`** — optionally fills missing `tokenUrl` / `scope` /
   `authorizationUrl` from the upstream's protected-resource + AS metadata.
3. **`oauth2/factory.ts` (`buildGrant`)** — picks the concrete `Grant`
   (`grants/clientCredentials.ts` or `grants/authorizationCode.ts`). The
   authorization_code grant wires a `TokenCache` and an interactive browser
   PKCE flow (`oauth2/interactive.ts`).
4. **`oauth2/tokenManager.ts`** — caches the access token, refreshes proactively
   within the skew window, **dedupes in-flight refreshes**, and exposes
   `invalidate()` for forced refresh on a 401.
5. **`bridge.ts`** — reads newline-delimited JSON-RPC from stdin via
   `StdioCodec` (`stdio.ts`), POSTs each message to the upstream with a Bearer
   token, and writes responses back to stdout. Handles single-JSON and SSE
   (`text/event-stream`) upstream responses, captures `mcp-session-id`, retries
   once on 401, and can hold a long-lived GET SSE channel for server-initiated
   notifications.

## Key conventions

- **stdout is sacred.** stdout carries only MCP JSON-RPC. **All logging goes to
  stderr** — `log.ts` hard-codes `pino.destination(2)`. Never `console.log` to
  stdout; write protocol messages through `StdioCodec.write`.
- **Secret redaction is centralized** in `log.ts`'s pino `redact` paths
  (access_token, refresh_token, client_secret, authorization, etc.). When you
  add a field that may carry a secret, add its path there rather than scrubbing
  ad hoc.
- **Transport security.** All credential-bearing URLs pass through
  `security.ts` `assertSecureUrl`: cleartext `http://` to a non-loopback host is
  rejected at startup unless `ALLOW_INSECURE_HTTP=true`; `https` and loopback
  `http` always pass. Reuse `assertSecureUrl` / `isLoopbackHost` for any new
  outbound URL.
- **Grant abstraction.** New OAuth2 flows implement the `Grant` interface
  (`oauth2/grants/types.ts`: `name`, `fetchToken()`, `supportsRenewal()`) and
  are constructed in `buildGrant`. Grants take an injected `OAuthHttpClient`
  (real one is `oauth2/http.ts` `undiciHttpClient`).
- **HTTP via undici.** Outbound calls use `undici` `request`, not `fetch`.
  Token endpoints are called with `postForm` (`application/x-www-form-urlencoded`).
- **ESM + `.js` import specifiers.** `"type": "module"` with NodeNext: relative
  imports MUST use the `.js` extension even though sources are `.ts`
  (e.g. `import { Bridge } from './bridge.js'`).
- **Config = file + env.** Every config field has a JSON path and a matching
  env-var override applied in `config.ts` (`UPSTREAM_URL`, `OAUTH2_*`,
  `LOG_LEVEL`, `ALLOW_INSECURE_HTTP`, ...). Add both when introducing a setting.
- **Strict TS.** `strict`, `noUncheckedIndexedAccess`, and `noImplicitOverride`
  are on; handle possibly-undefined indexed access explicitly.

## Tests

- Vitest. The integration test (`test/bridge.integration.test.ts`) spins up
  in-process mock OAuth2 + MCP upstream servers and drives the real `Bridge`
  over `PassThrough` streams — **no network required**.
- For unit tests, inject `mockHttpClient(...)` from `test/helpers.ts` (records
  calls, returns scripted responses) instead of hitting real endpoints.

## Docs

Deep reference lives in the GitHub wiki (also checked out under
`mcp-oauth2-proxy.wiki/`, git-ignored with its own `.git`). The README is the
slim entry point and links out to it. Keep wiki content out of edits unless the
task is specifically about the wiki.
