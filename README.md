# mcp-oauth2-proxy

A **local stdio MCP server** that proxies to a remote, **OAuth2-protected
HTTP MCP server**.

MCP clients (Claude Desktop, Cursor, VS Code Copilot, etc.) launch
`mcp-oauth2-proxy` as a subprocess and speak the standard MCP stdio
transport (newline-delimited JSON-RPC). The proxy acquires/refreshes an
OAuth2 access token and forwards every message to the upstream MCP server
over HTTP with `Authorization: Bearer …`.

Supported OAuth2 grants:

- `client_credentials`
- `refresh_token`
- `authorization_code` (with PKCE; interactive browser login by default,
  or operator pre-supplies the code / a refresh token)
- `password` (Resource Owner Password Credentials)

## Topology

```
MCP client ──stdio (JSON-RPC)──▶ mcp-oauth2-proxy ──HTTP+SSE + Bearer──▶ upstream MCP server
                                       │
                                       └── OAuth2 token endpoint (IdP)
```

- Inbound: MCP **stdio** transport on stdin/stdout. Logs go to **stderr**.
- Outbound: MCP **streamable HTTP** to the upstream:
  - One POST per client JSON-RPC message
  - Responses may be `application/json` (single message) or
    `text/event-stream` (one or more messages)
  - Optional long-lived `GET text/event-stream` channel for
    server-initiated notifications
- `Mcp-Session-Id` is captured from the first upstream response and echoed
  on subsequent requests.

## Requirements

- Node.js 20+

## Install

Once published, no clone is required — your MCP client can launch the
proxy directly via `npx`:

```sh
npx -y mcp-oauth2-proxy
```

To work on the proxy locally:

```sh
git clone https://github.com/<owner>/mcp-oauth2-proxy.git
cd mcp-oauth2-proxy
npm install
npm run build
```

## Use as a stdio MCP server

Configure your MCP client to launch the proxy. The recommended invocation
is via **`npx`** so the client doesn't need to know where the package
lives on disk and the user doesn't need to clone anything.

### Via npx (recommended)

```jsonc
{
  "mcpServers": {
    "remote-oauth2-mcp": {
      "command": "npx",
      "args": ["-y", "mcp-oauth2-proxy"],
      "env": {
        "MCP_PROXY_CONFIG": "<absolute path to config.json>",
        "OAUTH2_CLIENT_SECRET": "<your client secret>"
      }
    }
  }
}
```

Paths in the `env` block must be absolute and use forward slashes on every
platform — for example `C:/Users/alice/mcp-oauth2-proxy.json` on Windows,
`/Users/alice/mcp-oauth2-proxy.json` on macOS, or
`/home/alice/mcp-oauth2-proxy.json` on Linux.

On Windows MCP clients that don't resolve `.cmd` shims (so `command: "npx"`
fails to start), use the explicit form:

```jsonc
{
  "command": "cmd",
  "args": ["/c", "npx", "-y", "mcp-oauth2-proxy"]
}
```

You can avoid the config file entirely by passing every setting via env —
see [Environment variables](#environment-variables) below.

### From a local clone

```jsonc
{
  "mcpServers": {
    "remote-oauth2-mcp": {
      "command": "node",
      "args": ["<absolute path>/mcp-oauth2-proxy/dist/index.js"],
      "env": {
        "MCP_PROXY_CONFIG": "<absolute path>/config.json",
        "OAUTH2_CLIENT_SECRET": "<your client secret>"
      }
    }
  }
}
```

For local debugging you can drive stdio yourself:

```sh
MCP_PROXY_CONFIG=./config.json OAUTH2_CLIENT_SECRET='<your secret>' \
  npx -y mcp-oauth2-proxy
```

Then type a JSON-RPC line and press Enter, e.g.:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}
```

Logs appear on stderr; MCP messages on stdout.

## Configuration

You can configure the proxy in **three** ways — pick whichever fits best:

1. **JSON config file** pointed to by `MCP_PROXY_CONFIG`
2. **Environment variables only** (no file required)
3. **A mix**: load defaults from the file, override individual fields via env

Validation runs after the file and env vars are merged, so as long as every
required field ends up set, the source doesn't matter. Env vars always
take precedence over the file.

### Example

```jsonc
{
  "upstream": {
    "url": "https://mcp.example.com/mcp",
    "timeoutMs": 30000,
    "openServerStream": true,
    "protocolVersion": "2025-06-18"
  },
  "oauth2": {
    "grant": "client_credentials",
    "tokenUrl": "https://idp.example.com/oauth2/token",
    "clientId": "my-client",
    "clientSecret": "set-via-env",
    "scope": "mcp:read mcp:write",
    "audience": "https://mcp.example.com",
    "authStyle": "body",
    "refreshSkewSeconds": 30,
    "extraParams": { "resource": "https://mcp.example.com" }
  },
  "log": { "level": "info" }
}
```

See [`config.example.json`](./config.example.json).

### Upstream options

| Field              | Default    | Description                                                                                    |
| ------------------ | ---------- | ---------------------------------------------------------------------------------------------- |
| `url`              | (required) | Upstream MCP streamable-HTTP endpoint.                                                         |
| `timeoutMs`        | `30000`    | Per-request body/headers timeout.                                                              |
| `openServerStream` | `true`     | After `initialize`, open a `GET text/event-stream` channel for server-initiated notifications. |
| `protocolVersion`  | (unset)    | Value sent in the `MCP-Protocol-Version` header.                                               |

### OAuth2 — common fields

| Field                | Description                                                                |
| -------------------- | -------------------------------------------------------------------------- |
| `grant`              | One of `client_credentials`, `authorization_code`.                         |
| `tokenUrl`           | Token endpoint URL. Optional if discovery is enabled (see below).          |
| `clientId`           | OAuth2 client id.                                                          |
| `clientSecret`       | OAuth2 client secret (optional for public clients).                        |
| `scope`              | Space-separated scopes.                                                    |
| `audience`           | `audience` form param (used by some IdPs, e.g. Auth0).                     |
| `authStyle`          | `"body"` (`client_id`+`client_secret` in form body, default) or `"header"` (HTTP Basic auth). |
| `refreshSkewSeconds` | Refresh the token this many seconds before `expires_in`. Default `30`.     |
| `extraParams`        | Map of additional form parameters to send to the token endpoint.           |

### OAuth2 — grant-specific fields

| Grant                | Additional required / optional fields                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `client_credentials` | —                                                                                                                                     |
| `authorization_code` | One of: `refreshToken` · `authorizationCode` (one-shot; optional `redirectUri`, `codeVerifier`) · **interactive browser login** (default; needs `authorizationUrl` from discovery or `OAUTH2_AUTHORIZATION_URL`) |

For `authorization_code` the proxy supports three input modes, resolved
on first token fetch:

1. **Pre-existing refresh token** (`refreshToken` / `OAUTH2_REFRESH_TOKEN`) — used immediately.
2. **Pre-supplied one-shot code** (`authorizationCode`) — exchanged once; if the IdP returns a `refresh_token` it is used for renewals.
3. **Interactive browser login** (default when neither of the above is set): the proxy starts a local listener on `http://127.0.0.1:53682/callback` (configurable), generates a PKCE `S256` challenge, opens the user's default browser at the IdP's authorization endpoint, and exchanges the returned code. The refresh token is then persisted under the OS user config directory so subsequent launches are silent.

The redirect URI used in interactive mode is
`http://<callbackHost>:<callbackPort>/callback` and must be registered
with your IdP (most IdPs require explicit registration of redirect URIs;
many accept arbitrary `http://127.0.0.1:*` URIs for public/native
clients per RFC 8252).

Disable interactive mode with `"interactive": false` or
`OAUTH2_INTERACTIVE=false` — the proxy then fails fast at first token
fetch unless a code or refresh token is configured.

#### Refresh-token cache

When interactive auth completes (or whenever the IdP rotates the refresh
token), the new value is encrypted (AES‑256‑GCM) with a random key and
stored under:

- Windows: `%APPDATA%\mcp-oauth2-proxy\`
- macOS: `~/Library/Application Support/mcp-oauth2-proxy/`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/mcp-oauth2-proxy/`

The location can be overridden with `OAUTH2_TOKEN_CACHE_DIR`. Cache
files are keyed by `sha256(clientId|tokenUrl)`, so multiple
configurations co-exist.

> **Security note:** The cache encryption is *obfuscation*, not strong
> protection. The key file (`key.bin`) lives alongside the cached token
> with `0600` permissions; any process running as the same OS user can
> read both. Use OS-level user isolation (or an OS keychain integration,
> not yet supported) if you need stronger guarantees.

### Discovery (RFC 9728)

If `tokenUrl` is not configured, the proxy can discover it from the
upstream MCP server's OAuth 2.0 Protected Resource Metadata
(RFC 9728) plus Authorization Server Metadata (RFC 8414):

1. `GET <upstream-origin>/.well-known/oauth-protected-resource`
   → reads `authorization_servers[0]`
2. `GET <as>/.well-known/oauth-authorization-server` (falls back to
   `.well-known/openid-configuration`) → reads `token_endpoint`,
   `authorization_endpoint`, and `scopes_supported`

Discovered values fill in any missing `tokenUrl`, `scope`, and
`authorizationUrl` (used by the interactive `authorization_code` flow).
Explicit config or env vars always win over discovery.

Disable with `"discovery": { "enabled": false }` or `DISCOVERY_ENABLED=false`.

### Environment variables

Every field can also be set via env vars. With these alone (no
`MCP_PROXY_CONFIG`), the proxy starts up fine.

| Env var                       | Maps to                    | Notes                                       |
| ----------------------------- | -------------------------- | ------------------------------------------- |
| `MCP_PROXY_CONFIG`            | —                          | Path to config JSON (optional).             |
| `UPSTREAM_URL`                | `upstream.url`             |                                             |
| `UPSTREAM_TIMEOUT_MS`         | `upstream.timeoutMs`       | integer ms                                  |
| `UPSTREAM_OPEN_SERVER_STREAM` | `upstream.openServerStream`| `true`/`false`/`1`/`0`/`yes`/`no`/`on`/`off`|
| `UPSTREAM_PROTOCOL_VERSION`   | `upstream.protocolVersion` |                                             |
| `LOG_LEVEL`                   | `log.level`                | `trace`/`debug`/`info`/`warn`/`error`/`fatal` |
| `OAUTH2_GRANT`                | `oauth2.grant`             |                                             |
| `OAUTH2_TOKEN_URL`            | `oauth2.tokenUrl`          |                                             |
| `OAUTH2_CLIENT_ID`            | `oauth2.clientId`          |                                             |
| `OAUTH2_CLIENT_SECRET`        | `oauth2.clientSecret`      |                                             |
| `OAUTH2_REFRESH_TOKEN`        | `oauth2.refreshToken`      | for `authorization_code` grant              |
| `OAUTH2_AUTHORIZATION_CODE`   | `oauth2.authorizationCode` |                                             |
| `OAUTH2_AUTHORIZATION_URL`    | `oauth2.authorizationUrl`  | IdP authorization endpoint (interactive)    |
| `OAUTH2_CODE_VERIFIER`        | `oauth2.codeVerifier`      |                                             |
| `OAUTH2_REDIRECT_URI`         | `oauth2.redirectUri`       | overrides the auto-derived callback URL     |
| `OAUTH2_INTERACTIVE`          | `oauth2.interactive`       | default `true`; set to `false` to disable browser flow |
| `OAUTH2_CALLBACK_HOST`        | `oauth2.callbackHost`      | default `127.0.0.1`                         |
| `OAUTH2_CALLBACK_PORT`        | `oauth2.callbackPort`      | default `53682`                             |
| `OAUTH2_CALLBACK_TIMEOUT_SECONDS` | `oauth2.callbackTimeoutSeconds` | default `300`                          |
| `OAUTH2_TOKEN_CACHE_DIR`      | `oauth2.tokenCacheDir`     | overrides the per-OS config dir             |
| `OAUTH2_SCOPE`                | `oauth2.scope`             |                                             |
| `OAUTH2_AUDIENCE`             | `oauth2.audience`          |                                             |
| `OAUTH2_AUTH_STYLE`           | `oauth2.authStyle`         | `header` or `body`                          |
| `OAUTH2_REFRESH_SKEW_SECONDS` | `oauth2.refreshSkewSeconds`| integer seconds                             |
| `OAUTH2_EXTRA_PARAMS`         | `oauth2.extraParams`       | JSON object string, e.g. `{"resource":"…"}` |
| `DISCOVERY_ENABLED`           | `discovery.enabled`        | `true`/`false`; default `true`              |

Prefer env vars for secrets so they don't end up on disk.

#### Example: env-only `mcpServers` entry

```jsonc
{
  "mcpServers": {
    "remote-oauth2-mcp": {
      "command": "npx",
      "args": ["-y", "mcp-oauth2-proxy"],
      "env": {
        "UPSTREAM_URL": "https://mcp.example.com/mcp",
        "OAUTH2_GRANT": "client_credentials",
        "OAUTH2_TOKEN_URL": "https://idp.example.com/oauth2/token",
        "OAUTH2_CLIENT_ID": "my-client",
        "OAUTH2_CLIENT_SECRET": "…",
        "OAUTH2_SCOPE": "mcp:read mcp:write",
        "OAUTH2_AUDIENCE": "https://mcp.example.com"
      }
    }
  }
}
```

## How it works

1. On startup the proxy builds a `Grant` strategy from `oauth2.grant` and
   wraps it in a `TokenManager` that:
   - caches the access token until `expires_in - refreshSkewSeconds`
   - deduplicates concurrent refresh requests
   - exposes `invalidate()` so the bridge can force a refresh after 401
2. The bridge reads newline-delimited JSON-RPC messages from stdin. For
   each message it:
   - acquires the current access token
   - POSTs the raw message to `upstream.url` with
     `Authorization: Bearer <token>`,
     `Accept: application/json, text/event-stream`,
     `Mcp-Session-Id` (once known), `MCP-Protocol-Version` (if configured)
   - if the response is `application/json`, writes the body to stdout as
     a single JSON-RPC line
   - if the response is `text/event-stream`, parses each event's `data:`
     payload as JSON-RPC and writes one line per event to stdout
   - if the upstream returns `401`, invalidates the token and retries
     once
3. After `initialize`, the bridge optionally opens a long-lived
   `GET … Accept: text/event-stream` channel; received messages are
   written to stdout. Reconnects with backoff on transient errors; stops
   if the upstream answers `404`/`405`.

## Development

```sh
npm run build     # compile TS to dist/
npm run dev       # tsx watch
npm test          # vitest (unit + integration)
```

The integration test spins up a mock OAuth2 token endpoint and a mock MCP
upstream HTTP server in-process, then drives the bridge through
`PassThrough` streams — no real network required.

## Testing locally

### 1. Run the test suite

```sh
npm test
```

Covers the token manager (cache, refresh dedup, 401 invalidate), every
OAuth2 grant, the JSON-RPC stdio codec, and an end-to-end bridge test
against an in-process mock IdP + mock MCP upstream.

### 2. Smoke-test the binary by hand

After `npm run build`, you can drive the proxy from a terminal:

```sh
MCP_PROXY_CONFIG=./config.json OAUTH2_CLIENT_SECRET='<your secret>' \
  node dist/index.js
```

…or via `npx` against the local checkout:

```sh
npm link
mcp-oauth2-proxy   # uses your linked global bin
```

Paste a JSON-RPC line and press Enter:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}
```

stdout will show the upstream's response as a JSON-RPC line; stderr will
show the structured pino log lines. Press `Ctrl+C` to stop.

### 3. Inspect with the MCP Inspector

[`@modelcontextprotocol/inspector`](https://github.com/modelcontextprotocol/inspector)
is a UI that speaks the stdio MCP transport. Point it at the proxy:

```sh
npx @modelcontextprotocol/inspector \
  --command "node" \
  --args "dist/index.js" \
  -e MCP_PROXY_CONFIG=./config.json \
  -e OAUTH2_CLIENT_SECRET='<your secret>'
```

You can then list tools, call them, and watch the JSON-RPC traffic.

### 4. Test against a fake upstream + IdP (no real OAuth2 server needed)

If you don't have a real OAuth2-protected MCP server to point at, you can
reuse the in-process mock from the integration test
(`test/bridge.integration.test.ts`) as a template: it boots a tiny
`http.Server` for the token endpoint and another for the MCP upstream.
Adapt it into a small script (e.g. `scripts/fake-upstream.mjs`) listening
on fixed ports, then run the proxy against it:

```sh
node scripts/fake-upstream.mjs &        # token on :9001, upstream on :9002
UPSTREAM_URL=http://127.0.0.1:9002/mcp \
OAUTH2_GRANT=client_credentials \
OAUTH2_TOKEN_URL=http://127.0.0.1:9001/token \
OAUTH2_CLIENT_ID=cid \
OAUTH2_CLIENT_SECRET=csec \
OAUTH2_AUTH_STYLE=body \
LOG_LEVEL=debug \
  node dist/index.js
```

### 5. Wire it into your MCP client

Once the smoke test works, point your real MCP client at the same
command — see [Use as a stdio MCP server](#use-as-a-stdio-mcp-server)
above for `mcpServers` snippets.

## Security notes

- Tokens, secrets, and `Authorization` headers are redacted from log
  output (stderr).
- Tokens live in process memory only; restarting the proxy forces a fresh
  acquisition.
- The proxy uses a single operator-configured OAuth2 identity for the
  spawning MCP client. There is no per-end-user delegation.
- The proxy strips any `Authorization` header coming from the client and
  always uses the token it acquired itself.

## Out of scope (v1)

- Multiple upstream MCP servers
- OS-keychain-backed refresh-token storage (DPAPI / Keychain / libsecret)
- mTLS / JWT-bearer / device-code grants
- HTTP / SSE inbound transport (this is a stdio MCP server)

## License

MIT
