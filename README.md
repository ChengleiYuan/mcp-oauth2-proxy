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

On first launch the proxy:

1. Discovers `token_endpoint` and `authorization_endpoint` from the
   upstream (RFC 9728 + RFC 8414).
2. Opens your default browser at the IdP authorization endpoint with a
   PKCE S256 challenge.
3. Captures the code on `http://127.0.0.1:53682/callback`.
4. Persists the refresh token under the OS user config dir, encrypted at
   rest.
5. Starts the MCP stdio bridge.

Subsequent launches reuse the cached refresh token silently — no
browser, no prompts.

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

You can configure the proxy in three ways, mixed freely:

1. **JSON file** at `MCP_PROXY_CONFIG`.
2. **Environment variables** only (no file required).
3. A **mix** — env vars override file values, validation runs on the
   merged result.

### Example file

```jsonc
{
  "upstream": {
    "url": "https://mcp.example.com/mcp",
    "timeoutMs": 300000,
    "openServerStream": true,
    "protocolVersion": "2025-06-18"
  },
  "oauth2": {
    "grant": "authorization_code",
    "clientId": "my-client",
    "scope": "mcp:read mcp:write",
    "callbackPort": 53682
  },
  "log": { "level": "info" }
}
```

See [`config.example.json`](./config.example.json).

### Upstream

| Field              | Default    | Description                                                                                    |
| ------------------ | ---------- | ---------------------------------------------------------------------------------------------- |
| `url`              | (required) | Upstream MCP streamable-HTTP endpoint.                                                         |
| `timeoutMs`        | `300000`   | Hard per-request deadline (ms, default 5 min). Aborts the upstream call after this many ms even if data is still trickling in. Should be ≥ your MCP client's tool-call timeout. |
| `openServerStream` | `true`     | After `initialize`, open a `GET text/event-stream` channel for server-initiated notifications. |
| `protocolVersion`  | (unset)    | Value sent in the `MCP-Protocol-Version` header.                                               |

### OAuth2 — common

| Field                | Description                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `grant`              | `client_credentials` or `authorization_code`.                                                 |
| `tokenUrl`           | Token endpoint URL. Optional if discovery is enabled.                                         |
| `clientId`           | OAuth2 client id.                                                                             |
| `clientSecret`       | OAuth2 client secret (optional for public clients).                                           |
| `scope`              | Space-separated scopes.                                                                       |
| `audience`           | `audience` form param (used by some IdPs, e.g. Auth0).                                        |
| `authStyle`          | `"body"` (default) or `"header"` (HTTP Basic auth).                                           |
| `refreshSkewSeconds` | Refresh `expires_in - skew` seconds before expiry. Default `30`.                              |
| `extraParams`        | Map of additional form parameters to send to the token endpoint.                              |

### OAuth2 — `authorization_code` specifics

| Field                     | Default            | Description                                                                                       |
| ------------------------- | ------------------ | ------------------------------------------------------------------------------------------------- |
| `authorizationUrl`        | (discoverable)     | IdP authorization endpoint.                                                                       |
| `interactive`             | `true`             | Open a browser for first-time login.                                                              |
| `callbackHost`            | `127.0.0.1`        | Host the local callback listener binds to.                                                        |
| `callbackPort`            | `53682`            | Port the local callback listener binds to. Must match a redirect URI registered with your IdP.    |
| `callbackTimeoutSeconds`  | `300`              | How long to wait for the user to complete the browser login.                                      |
| `redirectUri`             | derived            | Override the auto-derived `http://<host>:<port>/callback`.                                        |
| `authorizationCode`       | (unset)            | Pre-supply a one-shot code (skips the browser flow).                                              |
| `codeVerifier`            | (unset)            | PKCE verifier matching a pre-supplied code.                                                       |
| `refreshToken`            | (unset)            | Pre-supply a refresh token (skips the browser flow entirely).                                     |
| `tokenCacheDir`           | per-OS config dir  | Where the encrypted refresh-token cache lives.                                                    |

#### Refresh-token cache

The proxy persists every refresh token it receives — from the
interactive flow and from subsequent IdP rotations — so the browser
opens only once per `(clientId, tokenUrl)` pair per machine.

| OS      | Default location                                       |
| ------- | ------------------------------------------------------ |
| Windows | `%APPDATA%\mcp-oauth2-proxy\`                          |
| macOS   | `~/Library/Application Support/mcp-oauth2-proxy/`      |
| Linux   | `${XDG_CONFIG_HOME:-~/.config}/mcp-oauth2-proxy/`      |

Override with `OAUTH2_TOKEN_CACHE_DIR`. Cache files are AES‑256‑GCM
encrypted with a randomly-generated `key.bin` stored alongside (file
mode `0600`).

> **Security note:** This is honest obfuscation against casual disk
> reads, **not** protection against a process running as the same OS
> user. OS-keychain integration (DPAPI / Keychain / libsecret) is on
> the roadmap.

### Discovery (RFC 9728)

If `tokenUrl` (or `authorizationUrl`) is not configured, the proxy
discovers it from the upstream:

1. `GET <upstream-origin>/.well-known/oauth-protected-resource`
   → reads `authorization_servers[0]`.
2. `GET <as>/.well-known/oauth-authorization-server`
   (falls back to `.well-known/openid-configuration`)
   → reads `token_endpoint`, `authorization_endpoint`, `scopes_supported`.

Explicit config or env vars always win over discovery. Disable with
`"discovery": { "enabled": false }` or `DISCOVERY_ENABLED=false`.

### Environment variables

| Env var                           | Maps to                          |
| --------------------------------- | -------------------------------- |
| `MCP_PROXY_CONFIG`                | Path to config JSON (optional).  |
| `UPSTREAM_URL`                    | `upstream.url`                   |
| `UPSTREAM_TIMEOUT_MS`             | `upstream.timeoutMs`             |
| `UPSTREAM_OPEN_SERVER_STREAM`     | `upstream.openServerStream`      |
| `UPSTREAM_PROTOCOL_VERSION`       | `upstream.protocolVersion`       |
| `LOG_LEVEL`                       | `log.level`                      |
| `OAUTH2_GRANT`                    | `oauth2.grant`                   |
| `OAUTH2_TOKEN_URL`                | `oauth2.tokenUrl`                |
| `OAUTH2_CLIENT_ID`                | `oauth2.clientId`                |
| `OAUTH2_CLIENT_SECRET`            | `oauth2.clientSecret`            |
| `OAUTH2_SCOPE`                    | `oauth2.scope`                   |
| `OAUTH2_AUDIENCE`                 | `oauth2.audience`                |
| `OAUTH2_AUTH_STYLE`               | `oauth2.authStyle`               |
| `OAUTH2_REFRESH_SKEW_SECONDS`     | `oauth2.refreshSkewSeconds`      |
| `OAUTH2_EXTRA_PARAMS`             | `oauth2.extraParams` (JSON)      |
| `OAUTH2_AUTHORIZATION_URL`        | `oauth2.authorizationUrl`        |
| `OAUTH2_AUTHORIZATION_CODE`       | `oauth2.authorizationCode`       |
| `OAUTH2_CODE_VERIFIER`            | `oauth2.codeVerifier`            |
| `OAUTH2_REFRESH_TOKEN`            | `oauth2.refreshToken`            |
| `OAUTH2_REDIRECT_URI`             | `oauth2.redirectUri`             |
| `OAUTH2_INTERACTIVE`              | `oauth2.interactive`             |
| `OAUTH2_CALLBACK_HOST`            | `oauth2.callbackHost`            |
| `OAUTH2_CALLBACK_PORT`            | `oauth2.callbackPort`            |
| `OAUTH2_CALLBACK_TIMEOUT_SECONDS` | `oauth2.callbackTimeoutSeconds`  |
| `OAUTH2_TOKEN_CACHE_DIR`          | `oauth2.tokenCacheDir`           |
| `DISCOVERY_ENABLED`               | `discovery.enabled`              |

Booleans accept `true`/`false`/`1`/`0`/`yes`/`no`/`on`/`off`. Prefer
env vars for secrets so they don't end up on disk.

## How it works

1. **Discovery.** Optionally fetch RFC 9728/8414 metadata to fill in
   `tokenUrl`, `authorizationUrl`, and `scope`.
2. **Token manager.** Wrap the configured `Grant` with caching,
   refresh-skew, in-flight dedup, and 401 invalidation.
3. **Prefetch.** Call `getToken()` once at startup so the interactive
   browser flow (if needed) happens before the first MCP message
   arrives.
4. **Bridge.** For each stdin JSON-RPC line, POST to `upstream.url` with
   `Authorization: Bearer <token>`,
   `Accept: application/json, text/event-stream`,
   `Mcp-Session-Id` (once known), `MCP-Protocol-Version` (if configured).
   Single-shot JSON responses become one stdout line; SSE responses
   become one line per event. A `401` triggers
   `tokenManager.invalidate()` and a single retry.
5. **Server stream.** After `initialize`, optionally hold open a
   `GET text/event-stream` channel for server-initiated notifications.
   Reconnects with backoff; gives up after 10 consecutive failures or a
   `404`/`405` from the upstream.

## Remote hosts (SSH port forwarding)

If the proxy runs on a **remote machine** (a dev VM, container, WSL, or
production host) but your browser lives on your **local laptop**, the
local callback listener on the remote `127.0.0.1:53682` is not reachable
by your local browser — and `xdg-open` on the remote either fails or
launches a browser nobody can see. SSH local port forwarding bridges
the gap.

### 1. Open the tunnel

On your **local** machine, before launching the MCP client (or the
proxy):

```sh
ssh -N -L 53682:127.0.0.1:53682 user@remote-host
```

This forwards local `http://127.0.0.1:53682/*` to the same address on
the remote host. Add `-L` flags for every port you need; leave the
session open until you finish logging in.

VS Code Remote / Cursor Remote / JetBrains Gateway already provide
automatic port forwarding — if you launch the proxy from an integrated
terminal there, port `53682` is usually forwarded for you automatically.

### 2. Launch the proxy on the remote

```sh
# On the remote host
UPSTREAM_URL=https://mcp.example.com/mcp \
OAUTH2_GRANT=authorization_code \
OAUTH2_CLIENT_ID=<your-client-id> \
  npx -y mcp-oauth2-proxy
```

### 3. Open the URL in your local browser

The proxy prints the authorization URL to **stderr**:

```
[mcp-oauth2-proxy] Open this URL to log in:
  https://idp.example.com/authorize?response_type=code&client_id=…&redirect_uri=http%3A%2F%2F127.0.0.1%3A53682%2Fcallback&…
```

Copy that URL into the browser on your **local** machine. Auto-open on
the remote is expected to fail; the URL on stderr is the canonical
prompt.

After you log in, the IdP redirects your local browser to
`http://127.0.0.1:53682/callback?code=…`, which the SSH tunnel
forwards to the proxy on the remote host. The proxy exchanges the code
and caches the refresh token under the remote user's config dir — so
subsequent launches on that remote host don't need the tunnel.

### Notes

- **Redirect URI registration.** Your IdP still sees
  `http://127.0.0.1:53682/callback`. Register that exact URL (the IdP
  doesn't know or care that there's an SSH tunnel in between).
- **Port collisions on the local side.** If `53682` is already in use
  locally, forward to a different local port and override the proxy's
  port so they match:
  `ssh -L 9000:127.0.0.1:9000 …` plus `OAUTH2_CALLBACK_PORT=9000` on
  the remote — and register `http://127.0.0.1:9000/callback` with your
  IdP.
- **Windows.** `ssh -L` is built into Windows 10/11. From PowerShell or
  WSL it works the same way.
- **Containers / Docker.** Publish the port with
  `docker run -p 127.0.0.1:53682:53682 …`, then SSH-forward to the
  Docker host (or skip SSH if the container runs on your machine).
- **Bastion / multi-hop.** Use OpenSSH `ProxyJump` or chain `-L` flags
  through your bastion the same way you would for any other service.

## Troubleshooting

- **Browser opens to a truncated URL** (e.g. only `response_type=code`).
  Upgrade to ≥ `0.1.3` — earlier Windows builds launched the URL through
  `cmd /c start`, which mangled the `&` separators.
- **`EADDRINUSE` on the callback port.** Another instance already holds
  `OAUTH2_CALLBACK_PORT`. Wait for it to finish or set a different
  port (and update the redirect URI registered with your IdP).
- **`redirect_uri_mismatch`.** Register the exact URL the proxy is
  using — by default `http://127.0.0.1:53682/callback`.
- **No browser, stdin hangs.** Confirm `oauth2.authorizationUrl` is set
  or discoverable and `oauth2.interactive` isn't `false`. The proxy
  logs the URL to stderr even when auto-open fails — open it manually.
- **`failed to acquire initial oauth2 token`.** The proxy prefetches a
  token at startup; read the stderr log for the IdP's error message.
- **Force re-login.** Delete the file under the cache dir (see
  [Refresh-token cache](#refresh-token-cache)).

## Development

```sh
npm install
npm run build       # compile TS to dist/
npm run dev         # tsx watch
npm test            # vitest (unit + integration)
```

The integration test spins up a mock OAuth2 token endpoint and a mock
MCP upstream HTTP server in-process and drives the bridge through
`PassThrough` streams — no real network required.

You can also drive the proxy from a terminal:

```sh
UPSTREAM_URL=https://mcp.example.com/mcp \
OAUTH2_GRANT=authorization_code \
OAUTH2_CLIENT_ID=<your-client-id> \
LOG_LEVEL=debug \
  node dist/index.js
```

Then paste a JSON-RPC line and press Enter:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}
```

stdout shows the upstream's response; stderr shows the pino log lines.

Inspect end-to-end behaviour with the official MCP inspector:

```sh
npx @modelcontextprotocol/inspector \
  --command node \
  --args dist/index.js \
  -e UPSTREAM_URL=https://mcp.example.com/mcp \
  -e OAUTH2_GRANT=authorization_code \
  -e OAUTH2_CLIENT_ID=<your-client-id>
```

## Security model

- The proxy uses a single operator-configured OAuth2 identity per MCP
  client instance. There is no per-end-user delegation.
- Access tokens live in process memory only. Refresh tokens are
  persisted with the caveats above.
- Any `Authorization` header sent by the MCP client over stdio is
  stripped — the proxy always uses the token it acquired itself.
- All logs go to stderr with tokens, secrets, and `Authorization`
  headers redacted. stdout is reserved for JSON-RPC.

## Out of scope

- Multiple upstream MCP servers per process
- OS-keychain-backed refresh-token storage (DPAPI / Keychain / libsecret)
- mTLS / JWT-bearer / device-code / ROPC grants
- HTTP / SSE inbound transport (this is a stdio MCP server)

## Releases

Releases are fully automated via
[release-please](https://github.com/googleapis/release-please) and
**Conventional Commits**.

1. Every PR title must follow Conventional Commits
   (`feat: …`, `fix: …`, `docs: …`, `chore: …`, …). A `PR Title Lint`
   check enforces this on every PR.
2. PRs are **squash-merged** so the PR title becomes the commit message
   on `main`.
3. On each push to `main`, a "Release PR" is opened / updated by
   release-please that bumps `package.json` and updates `CHANGELOG.md`.
4. Merging the Release PR creates a `vX.Y.Z` tag + GitHub Release.
5. The `Publish to npm` workflow fires on the new tag and publishes via
   npm OIDC trusted publishing — no `NPM_TOKEN` secret is used.

Bump rules (pre-1.0, with `bump-minor-pre-major: true`):

| Commit prefix          | Bump   |
|------------------------|--------|
| `fix:`                 | patch  |
| `feat:`                | minor  |
| `feat!:` / `BREAKING CHANGE:` footer | minor (until 1.0.0, then major) |
| `docs:` / `chore:` / `refactor:` / `test:` / `ci:` / `build:` / `perf:` | no release |

Required repo settings (one-time):

- Default merge strategy: **Squash and merge**.
- Settings → Actions → General → **Allow GitHub Actions to create and
  approve pull requests** = on.

## License

[MIT](./LICENSE)
