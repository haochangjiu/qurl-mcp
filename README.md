# @layervai/qurl-mcp

[![npm version](https://img.shields.io/npm/v/@layervai/qurl-mcp.svg)](https://www.npmjs.com/package/@layervai/qurl-mcp)

> **⚠️ Renamed from `@layerv/qurl-mcp` in v0.4.0.** The old package is deprecated and will not receive further updates. If you're using `@layerv/qurl-mcp@0.3.x`, swap the scope in your MCP client config — same binary, same API key, no other changes.

> A qURL MCP Server that supports both local `stdio` mode and remote `HTTP` mode for creating, managing, resolving, and sharing secure access links.

## Overview

`qURL MCP` exposes qURL capabilities to MCP clients, GPTs, ChatGPT, and other remote integrations.

It currently supports:

- creating, reading, updating, and deleting qURLs
- resolving access tokens
- managing qURL tokens and sessions
- uploading text or file content and generating qURLs
- serving public legal pages
- serving a configurable MP4 video playback page

## Runtime Modes

| Mode | Purpose | Start Command | Typical Use Case |
| --- | --- | --- | --- |
| `stdio` | Local subprocess MCP server | `npm run start` | Claude Desktop, Cursor, Codex, and other local MCP clients |
| `http` | Authenticated remote MCP server | `npm run start:http` | Remote agent runtimes behind HTTPS |

## Feature Map

### qURL Management Tools

| Tool | Description |
| --- | --- |
| `create_qurl` | Create a new qURL |
| `resolve_qurl` | Resolve an access token into a protected target URL |
| `list_qurls` | List qURL resources |
| `get_qurl` | Fetch details for a single qURL |
| `delete_qurl` | Delete a qURL |
| `extend_qurl` | Extend qURL expiration |
| `update_qurl` | Update qURL metadata or expiration |
| `mint_link` | Mint a new access link for an existing resource |
| `batch_create_qurls` | Create multiple qURLs in one request |
| `revoke_qurl_token` | Revoke a specific token |
| `update_qurl_token` | Update a specific token |
| `list_qurl_sessions` | List active access sessions |
| `terminate_qurl_sessions` | Terminate one or all active sessions |

### Upload Tools

| Tool | Mode | Description |
| --- | --- | --- |
| `upload_file_qurl` | `stdio` | Upload a local file and mint a qURL |
| `upload_file_data_qurl` | `http` | Upload base64 file content and mint a qURL |
| `upload_text_qurl` | `http` | Upload text content and mint a qURL |

### MCP Resources

| URI | Description |
| --- | --- |
| `qurl://links` | Current qURL list |
| `qurl://usage` | Current quota and usage information |

### MCP Prompts

| Prompt | Description |
| --- | --- |
| `secure_a_service` | Secure service integration prompt |
| `audit_links` | Link audit prompt |
| `rotate_access` | Access rotation prompt |

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Build

```bash
npm run build
```

### 3. Start

Local `stdio` mode:

```bash
npm run start
```

Remote `HTTP` mode:

```bash
npm run start:http
```

## MCP Client Example

If you want to use this server in `stdio` mode with a local MCP client:

```json
{
  "mcpServers": {
    "qurl": {
      "command": "npx",
      "args": ["@layervai/qurl-mcp"],
      "env": { "QURL_API_KEY": "lv_live_xxx" }
    }
  }
}
```

## Configuration Files

Copy the tracked examples to create local configuration files:

```bash
cp qurl-mcp.config.example.json qurl-mcp.config.json
cp qurl-mcp.http.example.json qurl-mcp.http.json
```

The local files are gitignored so credentials and machine-specific paths are
not committed.

Their responsibilities are:

| File | Purpose |
| --- | --- |
| `qurl-mcp.config.json` | Shared runtime config used by both `stdio` and `http` modes |
| `qurl-mcp.http.json` | HTTP-only server listener and public access config |

## qurl-mcp.config.json Reference

### Shared Core Settings

| Field | Purpose |
| --- | --- |
| `maxUploadFileDataBytes` | Limits decoded and local file uploads (default `10mb`) |
| `defaultQurlApiUrl` | Base URL of the qURL backend API |
| `defaultQurlConnectorUrl` | Base URL of the upload connector |

Set `QURL_API_KEY` in the environment for `stdio` mode. In HTTP mode, every
client request supplies its own qURL API key as a bearer token.

### SMTP Settings

| Field | Purpose |
| --- | --- |
| `smtp.host` | SMTP server hostname |
| `smtp.port` | SMTP server port |
| `smtp.secure` | Whether SMTP uses a secure connection |
| `smtp.username` | SMTP login username |
| `smtp.password` | SMTP login password or app-specific code |
| `smtp.fromEmail` | Sender email address |
| `smtp.fromName` | Sender display name |
| `smtp.allowedRecipients` | Optional exact-address allowlist |
| `smtp.allowedRecipientDomains` | Optional domain allowlist |
| `smtp.maxRecipientsPerMessage` | Per-message recipient cap (default `10`) |
| `smtp.maxRecipientsPerHour` | Per-qURL-key rolling hourly attempted-recipient cap (default `100`) |

These settings are used when email delivery is requested by tools such as:

- `create_qurl`
- `mint_link`
- `upload_text_qurl`
- `upload_file_data_qurl`

If either recipient allowlist is configured, only an exact address or domain
match is delivered. If both are empty, the message and hourly caps still apply.
The SMTP transport uses bounded connection/socket timeouts and is closed after
each delivery batch. Failed SMTP attempts still consume quota so repeated
failures cannot bypass the abuse limit.

Prefer environment variables for SMTP credentials and policy:
`QURL_SMTP_USERNAME`, `QURL_SMTP_PASSWORD`, `QURL_SMTP_FROM_EMAIL`,
`QURL_SMTP_ALLOWED_RECIPIENTS`, `QURL_SMTP_ALLOWED_RECIPIENT_DOMAINS`,
`QURL_SMTP_MAX_RECIPIENTS_PER_MESSAGE`, and
`QURL_SMTP_MAX_RECIPIENTS_PER_HOUR`.

### Public Video Page Settings

| Field | Purpose |
| --- | --- |
| `publicVideo.title` | Title shown on the public video page |
| `publicVideo.pagePath` | Public path of the video playback page |
| `publicVideo.filePath` | Absolute server path of the MP4 file |

When configured, the HTTP server additionally exposes:

- a public video playback page
- a streaming endpoint for the MP4 file

## qurl-mcp.http.json Reference

| Field | Purpose |
| --- | --- |
| `port` | HTTP MCP listener port |
| `host` | HTTP MCP bind address |
| `baseUrl` | Public base URL of the service |
| `allowedHosts` | Host allowlist for Host header validation |
| `trustProxyHops` | Exact trusted reverse-proxy hop count (default `0`) |
| `maxSessions` | Hard cap on live MCP sessions (default `1000`) |
| `maxUnvalidatedSessions` | Cap on sessions that have not completed a downstream qURL API call (default `100`) |
| `sessionIdleTtlMs` | Idle session eviction window (default 15 minutes) |
| `unvalidatedSessionTtlMs` | Short idle window for never-validated bearer sessions (default 1 minute) |
| `mcpRateLimitPerMinute` | Per-client `/mcp` request limit (default `120`) |
| `publicFileRateLimitPerMinute` | Per-client video-stream request limit (default `300`) |

The listener defaults to `127.0.0.1`. A non-loopback `host` is rejected unless
`allowedHosts` is explicitly configured. Set `trustProxyHops` (or
`MCP_TRUST_PROXY_HOPS`) to the exact number of trusted proxy hops; leave it at
`0` for direct connections so forwarded IP headers cannot spoof rate-limit keys.
Bearer credentials are conclusively validated by the first downstream qURL API
call. Until then, sessions use the smaller pending-session cap and one-minute
idle window, so arbitrary non-empty bearer strings cannot occupy the full
session pool for the normal 15-minute TTL.

## Configuration Priority

By default, configuration is loaded from the two local JSON files above. If a
file is absent, built-in defaults and environment variables are used.

The following environment variables independently override the config file paths:

- `QURL_MCP_CONFIG`
- `QURL_MCP_HTTP_CONFIG`

`QURL_MCP_HTTP_CONFIG` never replaces the shared runtime config path. This keeps
listener settings from silently shadowing SMTP, connector, or API settings.

`server.json` and `smithery.yaml` describe the published stdio transport, so
they include shared upload/SMTP settings but intentionally omit HTTP-only
listener variables such as `QURL_MCP_HTTP_CONFIG` and `MCP_MAX_SESSIONS`.

Do not commit API keys, SMTP credentials, or private file-system paths.

## HTTP Routes

After starting in `http` mode, the common routes are:

| Route | Purpose |
| --- | --- |
| `/mcp` | Main remote MCP endpoint |
| `/healthz` | Health check endpoint |
| `/legal/privacy` | Public privacy policy page |
| `/legal/terms` | Public terms of service page |
| `publicVideo.pagePath` | Public video playback page |
| `publicVideo.pagePath + /file` | MP4 streaming endpoint |

## HTTP Authentication

The `/mcp` endpoint requires `Authorization: Bearer <qURL API key>` on every
request. The bearer token is bound to the resulting MCP session, so a session
ID cannot be reused with a different credential.

Configure remote MCP clients with:

| Setting | Value |
| --- | --- |
| MCP Server URL | Your public HTTPS URL plus `/mcp` |
| Authentication | Bearer token |
| Token | The caller's qURL API key |

If a client only supports OAuth discovery, place an OAuth-compatible gateway
in front of this server rather than exposing `/mcp` without authentication.

## How to Verify Deployment

### Service-Level Checks

Start with:

- `/healthz`
- `/mcp`

### Public Page Checks

Also verify the legal pages and, when configured, the video page:

- `/legal/privacy`
- `/legal/terms`
- the configured public video page path

### Domain Verification

If you plan to use OpenAI Platform, make sure the following root-level path exists:

```text
/.well-known/openai-apps-challenge
```

> This verification file must live under the domain root `.well-known` path, not under `/mcp`.

## Docker

The repository includes a Dockerfile for containerized deployment.

Example:

```bash
docker build -t qurl-mcp .
docker run -i -e QURL_API_KEY=lv_live_xxx qurl-mcp
```

If you deploy with Docker, make sure the container can still access the correct config files, or override the config file paths with environment variables.

Run HTTP mode locally in Docker:

```bash
docker run --rm -p 3000:3000 \
  -e MCP_HOST=0.0.0.0 \
  -e MCP_ALLOWED_HOSTS=127.0.0.1,localhost \
  qurl-mcp node dist/http.js
```

For a single trusted production reverse proxy, set
`MCP_TRUST_PROXY_HOPS=1`, use the public HTTPS origin in `MCP_BASE_URL`, and
set `MCP_ALLOWED_HOSTS` to the public hostname. Do not expose the container's
listener directly when proxy trust is enabled.

## Common Commands

| Command | Purpose |
| --- | --- |
| `npm run build` | Compile TypeScript |
| `npm test` | Run tests |
| `npm run lint` | Run ESLint |
| `npm run dev` | TypeScript watch mode |
| `npm run format` | Format source code |
| `npm run format:check` | Check formatting |
| `npm run start` | Start stdio mode |
| `npm run start:http` | Start HTTP mode |

## Recommended Deployment Order

1. Copy and update the two example config files
2. Set credentials through environment variables
3. Run `npm install`
4. Run `npm run build`
5. Run `npm run start:http`
6. Verify `/healthz`
7. Verify unauthenticated `/mcp` requests receive `401`
8. Configure the HTTPS reverse proxy
9. Verify an authenticated MCP initialization and the optional public pages

## Third-Party Assets

Text-to-PDF generation bundles Noto Sans SC for multilingual glyph coverage.
Its SIL Open Font License and copyright notice are included in
`assets/fonts/OFL.txt`.

## License

MIT -- [LayerV AI](https://layerv.ai)
