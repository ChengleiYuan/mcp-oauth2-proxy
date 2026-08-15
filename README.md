# mcp-oauth2-proxy

[![npm version](https://img.shields.io/npm/v/mcp-oauth2-proxy.svg)](https://www.npmjs.com/package/mcp-oauth2-proxy)
[![node](https://img.shields.io/node/v/mcp-oauth2-proxy.svg)](https://nodejs.org/)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

> A local **stdio MCP server** that proxies to a remote, **OAuth2-protected
> HTTP MCP server**. Drop it into Claude Desktop, Cursor, VS Code Copilot,
> or any other MCP client — log in once in your browser — done.

```
MCP client ─stdio (JSON-RPC)─▶ mcp-oauth2-proxy ─HTTP+SSE + Bearer─▶ upstream MCP server
                                      │
                                      └─ OAuth2 token endpoint (IdP)
```

## Documentation

This README is a quick start. **Full documentation lives in the
[wiki](https://github.com/ChengleiYuan/mcp-oauth2-proxy/wiki).**

| Page | What's there |
| ---- | ------------ |
| [Getting Started](https://github.com/ChengleiYuan/mcp-oauth2-proxy/wiki/Getting-Started) | Install, first run, wiring into a client. |
| [Configuration](https://github.com/ChengleiYuan/mcp-oauth2-proxy/wiki/Configuration) | Every field and environment variable. |
| [OAuth2 Grants and Tokens](https://github.com/ChengleiYuan/mcp-oauth2-proxy/wiki/OAuth2-Grants-and-Tokens) | Grants, interactive login, token + cache lifecycle. |
| [Discovery](https://github.com/ChengleiYuan/mcp-oauth2-proxy/wiki/Discovery) | RFC 9728 / RFC 8414 endpoint discovery. |
| [Security](https://github.com/ChengleiYuan/mcp-oauth2-proxy/wiki/Security) | Threat model and built-in defenses. |
| [Remote Hosts (SSH Port Forwarding)](https://github.com/ChengleiYuan/mcp-oauth2-proxy/wiki/Remote-Hosts-%28SSH-Port-Forwarding%29) | Logging in when the proxy runs remotely. |
| [Troubleshooting](https://github.com/ChengleiYuan/mcp-oauth2-proxy/wiki/Troubleshooting) | Common problems and a FAQ. |
| [Architecture](https://github.com/ChengleiYuan/mcp-oauth2-proxy/wiki/Architecture) · [Bridge](https://github.com/ChengleiYuan/mcp-oauth2-proxy/wiki/Bridge-Internals) · [OAuth2](https://github.com/ChengleiYuan/mcp-oauth2-proxy/wiki/OAuth2-Internals) internals | How it works inside. |
| [Contributing and Releases](https://github.com/ChengleiYuan/mcp-oauth2-proxy/wiki/Contributing-and-Releases) | Dev setup, tests, release process. |

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Wire it into an MCP client](#wire-it-into-an-mcp-client)
- [Configuration](#configuration)
- [Security](#security)
- [Development](#development)
- [Out of scope](#out-of-scope)
- [License](#license)

## Features

- **Interactive `authorization_code` + PKCE** flow with a built-in local
  browser callback listener — no manual code copy/paste.
- **Refresh-token cache** on disk (AES‑256‑GCM, `0600`), so the browser
  only opens once per machine.
- **`client_credentials`** grant for headless / service-to-service use.
- **RFC 9728 + RFC 8414 discovery** of token and authorization endpoints
  from the upstream — usually zero OAuth config required.
- **Proactive token refresh** with skew, in-flight de-duplication, and a
  401 → invalidate → retry loop.
- **Streamable-HTTP** upstream support: single-shot JSON, SSE
  `text/event-stream` responses, and the optional long-lived
  server-notification channel. Honors `Mcp-Session-Id`.
- **Stderr-only logging** (pino) with redaction of tokens, secrets, and
  `Authorization` headers — stdout stays a clean JSON-RPC channel.

## How it works

1. **Discovery.** Optionally fetch RFC 9728/8414 metadata to fill in
   `tokenUrl`, `authorizationUrl`, `scope`, and `resource`.
2. **Token manager.** Wrap the configured `Grant` with caching,
   refresh-skew, in-flight dedup, and 401 invalidation.
3. **Prefetch.** Call `getToken()` once at startup so the interactive
   browser flow (if needed) happens before the first MCP message arrives.
4. **Bridge.** For each stdin JSON-RPC line, POST to `upstream.url` with a
   `Bearer` token; single-shot JSON responses become one stdout line, SSE
   responses one line per event. A `401` triggers `invalidate()` and a
   single retry.
5. **Server stream.** After `initialize`, optionally hold open a
   `GET text/event-stream` channel for server-initiated notifications.

For the full internals, see the
[Architecture](https://github.com/ChengleiYuan/mcp-oauth2-proxy/wiki/Architecture),
[Bridge Internals](https://github.com/ChengleiYuan/mcp-oauth2-proxy/wiki/Bridge-Internals),
and [OAuth2 Internals](https://github.com/ChengleiYuan/mcp-oauth2-proxy/wiki/OAuth2-Internals)
wiki pages.

## Requirements

- Node.js **20+**
- An OAuth2-protected MCP server speaking the
  [Streamable HTTP MCP transport](https://modelcontextprotocol.io/).
- An OAuth2 client registered with your IdP. For the interactive flow,
  register `http://127.0.0.1:53682/callback` as a redirect URI (or
  whatever you set `OAUTH2_CALLBACK_PORT` to).

## Install

You don't need to install anything — MCP clients can launch the proxy
directly via `npx`:

```sh
npx -y mcp-oauth2-proxy
```

For development against a local checkout:

```sh
git clone https://github.com/ChengleiYuan/mcp-oauth2-proxy.git
cd mcp-oauth2-proxy
npm install
npm run build
```

## Quick start

### Interactive login (recommended for end users)

```sh
UPSTREAM_URL=https://mcp.example.com/mcp \
OAUTH2_GRANT=authorization_code \
OAUTH2_CLIENT_ID=<your-client-id> \
  npx -y mcp-oauth2-proxy
```

On first launch the proxy discovers the OAuth endpoints, opens your browser
for a PKCE login, captures the code on `http://127.0.0.1:53682/callback`,
caches the refresh token (encrypted) under your OS config dir, and starts the
bridge. Subsequent launches reuse the cached token silently. Details:
[OAuth2 Grants and Tokens](https://github.com/ChengleiYuan/mcp-oauth2-proxy/wiki/OAuth2-Grants-and-Tokens).

### Headless / service account

```sh
UPSTREAM_URL=https://mcp.example.com/mcp \
OAUTH2_GRANT=client_credentials \
OAUTH2_TOKEN_URL=https://idp.example.com/oauth2/token \
OAUTH2_CLIENT_ID=my-service \
OAUTH2_CLIENT_SECRET='…' \
OAUTH2_SCOPE='mcp:read mcp:write' \
  npx -y mcp-oauth2-proxy
```

## Wire it into an MCP client

```jsonc
{
  "mcpServers": {
    "remote-oauth2-mcp": {
      "command": "npx",
      "args": ["-y", "mcp-oauth2-proxy"],
      "env": {
        "UPSTREAM_URL": "https://mcp.example.com/mcp",
        "OAUTH2_GRANT": "authorization_code",
        "OAUTH2_CLIENT_ID": "<your-client-id>"
      }
    }
  }
}
```

On Windows hosts that don't resolve `.cmd` shims (so `command: "npx"`
fails to start), use the explicit form:

```jsonc
{
  "command": "cmd",
  "args": ["/c", "npx", "-y", "mcp-oauth2-proxy"]
}
```

Paths in the `env` block must be absolute and use forward slashes on
every platform.

## Configuration

The proxy can be configured by a JSON file (`MCP_PROXY_CONFIG`), by
environment variables, or a mix — env vars override file values, then the
merged result is validated. Minimal example file:

```jsonc
{
  "upstream": { "url": "https://mcp.example.com/mcp" },
  "oauth2": {
    "grant": "authorization_code",
    "clientId": "my-client",
    "scope": "mcp:read mcp:write",
    "resource": "https://mcp.example.com/mcp"
  }
}
```

See [`config.example.json`](./config.example.json) for a fuller sample.

Most-used environment variables:

| Env var               | Maps to             |
| --------------------- | ------------------- |
| `UPSTREAM_URL`        | `upstream.url`      |
| `OAUTH2_GRANT`        | `oauth2.grant`      |
| `OAUTH2_CLIENT_ID`    | `oauth2.clientId`   |
| `OAUTH2_CLIENT_SECRET`| `oauth2.clientSecret` |
| `OAUTH2_TOKEN_URL`    | `oauth2.tokenUrl`   |
| `OAUTH2_SCOPE`        | `oauth2.scope`      |
| `OAUTH2_RESOURCE`     | `oauth2.resource`    |
| `LOG_LEVEL`           | `log.level`          |

> **Full reference:** every field, default, and environment variable is
> documented in the
> [Configuration](https://github.com/ChengleiYuan/mcp-oauth2-proxy/wiki/Configuration)
> wiki page. Endpoint auto-discovery is covered in
> [Discovery](https://github.com/ChengleiYuan/mcp-oauth2-proxy/wiki/Discovery).
> Running the proxy on a remote machine? See
> [Remote Hosts (SSH Port Forwarding)](https://github.com/ChengleiYuan/mcp-oauth2-proxy/wiki/Remote-Hosts-%28SSH-Port-Forwarding%29).
> Hitting a snag? See
> [Troubleshooting](https://github.com/ChengleiYuan/mcp-oauth2-proxy/wiki/Troubleshooting).

## Security

- Tokens are acquired by the proxy itself; the upstream `Authorization`
  header is always set by the proxy, never passed through from the client.
- Access tokens live in memory only. Refresh tokens are cached encrypted
  (AES‑256‑GCM, key file mode `0600`) — honest obfuscation against casual
  disk reads, **not** protection against a process running as the same OS
  user.
- Cleartext `http://` to non-loopback hosts is **rejected at startup**
  (override with `ALLOW_INSECURE_HTTP=true`); `https://` and loopback
  `http://` are always allowed. The interactive callback listener validates
  the `Host` header to defeat DNS-rebinding.
- All logs go to stderr with tokens, secrets, and `Authorization` headers
  redacted; stdout is reserved for JSON-RPC.

Full threat model and defenses:
[Security](https://github.com/ChengleiYuan/mcp-oauth2-proxy/wiki/Security).

## Development

```sh
npm install
npm run build       # compile TS to dist/
npm run dev         # tsx watch
npm test            # vitest (unit + integration)
```

The integration test spins up a mock OAuth2 token endpoint and a mock MCP
upstream in-process and drives the real bridge through `PassThrough`
streams — no network required. Project layout, the full test strategy, and
the automated release process are documented in
[Contributing and Releases](https://github.com/ChengleiYuan/mcp-oauth2-proxy/wiki/Contributing-and-Releases).

## Out of scope

- Multiple upstream MCP servers per process
- OS-keychain-backed refresh-token storage (DPAPI / Keychain / libsecret)
- mTLS / JWT-bearer / device-code / ROPC grants
- HTTP / SSE inbound transport (this is a stdio MCP server)

## License

[MIT](./LICENSE)
