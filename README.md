# @layervai/qurl-mcp

[![npm version](https://img.shields.io/npm/v/@layervai/qurl-mcp.svg)](https://www.npmjs.com/package/@layervai/qurl-mcp)

> **⚠️ Renamed from `@layerv/qurl-mcp` in v0.4.0.** The old package is deprecated and will not receive further updates. If you're using `@layerv/qurl-mcp@0.3.x`, swap the scope in your MCP client config — same binary, same API key, no other changes.

MCP server for qURL™ secure link management.

> **Quantum URL (qURL)** · The internet has a hidden layer. This is how you enter.

## What it does

qURL MCP Server is a [Model Context Protocol](https://modelcontextprotocol.io/) server that lets AI agents (Claude, GPT, Cursor, etc.) create, resolve, list, and manage qURL secure links natively. It supports local stdio clients and authenticated remote Streamable HTTP clients.

## Quick Start

Add the server to your MCP client configuration (Claude Desktop, Claude Code, etc.):

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

Replace `lv_live_xxx` with your actual API key. The key must have the appropriate scopes for the tools you intend to use (see below).

### Remote HTTP mode

Build and start the remote server:

```bash
npm run build
npm run start:http
```

The HTTP server defaults to `127.0.0.1:3000` and exposes:

| Route | Purpose |
|------|---------|
| `POST /mcp` | Stateless MCP Streamable HTTP endpoint |
| `GET /healthz` | Health check |

Every `/mcp` request must include the caller's qURL API key:

```http
Authorization: Bearer lv_live_xxx
```

The server never uses a shared privileged key in HTTP mode. The downstream qURL API validates each caller's key, scopes, expiry, and revocation state. `GET` and `DELETE` requests to `/mcp` return `405`; this server intentionally uses stateless POST requests because it does not emit server-initiated notifications.

For a non-loopback listener, explicitly configure both the bind address and Host-header allowlist:

```bash
MCP_HOST=0.0.0.0 \
MCP_ALLOWED_HOSTS=mcp.example.com \
MCP_TRUST_PROXY_HOPS=1 \
npm run start:http
```

`MCP_TRUST_PROXY_HOPS=1` is appropriate for a single trusted reverse proxy such as nginx. Leave it at `0` when clients connect directly. The server refuses a non-loopback bind without `MCP_ALLOWED_HOSTS`.

## Available Tools

| Tool | Description | Required Scope |
|------|-------------|----------------|
| `create_qurl` | Create a secure, policy-bound link to a protected resource | `qurl:write` |
| `resolve_qurl` | Resolve an access token to get the target URL and grant network access | `qurl:resolve` |
| `list_qurls` | List active qURLs with optional pagination | `qurl:read` |
| `get_qurl` | Get details of a specific qURL by resource ID | `qurl:read` |
| `delete_qurl` | Revoke a qURL, immediately invalidating the link | `qurl:write` |
| `extend_qurl` | Extend the expiration of an active qURL (alias for `update_qurl`) | `qurl:write` |
| `update_qurl` | Update expiration, tags, or description on an active qURL | `qurl:write` |
| `mint_link` | Mint a new access link for an existing protected resource | `qurl:write` |
| `batch_create_qurls` | Create multiple qURLs in a single call | `qurl:write` |
| `revoke_qurl_token` | Revoke one qURL token without revoking sibling tokens on the resource | `qurl:write` |
| `update_qurl_token` | Update expiry, label, policy, or session limits on one qURL token | `qurl:write` |
| `list_qurl_sessions` | List active access sessions for a qURL resource | `qurl:read` |
| `terminate_qurl_sessions` | Terminate one or all active sessions for a qURL resource | `qurl:write` |

## Available Resources

| URI | Name | Description |
|-----|------|-------------|
| `qurl://links` | Active qURL Links | List of all active qURL links |
| `qurl://usage` | qURL Usage & Quota | Current quota and usage information |

## Configuration

| Environment Variable | Required | Description | Default |
|---------------------|----------|-------------|---------|
| `QURL_API_KEY` | Conditional (see description) | API key with appropriate scopes (`qurl:read`, `qurl:write`, `qurl:resolve`). The server boots without it so MCP introspection (`tools/list`, `resources/list`, `prompts/list`) works for directory probes — required only on the first tool call or resource read, where invocations surface a typed `missing_api_key` error until the key is set. | -- |
| `QURL_API_URL` | No | qURL API base URL | `https://api.layerv.ai` |
| `MCP_HOST` | HTTP only | HTTP bind address. Non-loopback values require `MCP_ALLOWED_HOSTS`. | `127.0.0.1` |
| `MCP_PORT` | HTTP only | HTTP listener port. | `3000` |
| `MCP_ALLOWED_HOSTS` | HTTP only | Comma-separated Host-header allowlist. Required for non-loopback binds. | localhost protection |
| `MCP_TRUST_PROXY_HOPS` | HTTP only | Number of trusted reverse-proxy hops used to determine the client IP for rate limiting. | `0` |
| `MCP_RATE_LIMIT_PER_MINUTE` | HTTP only | Per-client `/mcp` request limit. | `120` |
| `MCP_MAX_JSON_BODY_BYTES` | HTTP only | Maximum authenticated JSON request size, from 1 KiB through 10 MiB. | `1048576` |

## Docker

A multi-stage Dockerfile is included for container-based deployment:

```bash
docker build -t qurl-mcp .
docker run -i -e QURL_API_KEY=lv_live_xxx qurl-mcp
```

Run the HTTP entry point behind one trusted reverse proxy:

```bash
docker run --rm -p 3000:3000 \
  -e MCP_HOST=0.0.0.0 \
  -e MCP_ALLOWED_HOSTS=mcp.example.com \
  -e MCP_TRUST_PROXY_HOPS=1 \
  qurl-mcp node dist/http.js
```

The image runs as the non-root `node` user, ships only production dependencies, and uses `tini` as PID 1 for clean signal handling.

If a tool call returns `missing_api_key` despite `QURL_API_KEY` looking set, check stderr for the boot-time warning — some MCP hosts hide stderr, and the warning is the fastest way to spot a whitespace-only or unset value:

```bash
docker logs <container>          # if running detached
docker run -i -e QURL_API_KEY=lv_live_xxx qurl-mcp 2>&1  # interactive
```

## Development

```bash
npm install
npm run build
npm test
npm run lint
```

Additional commands:

```bash
npm run dev          # Watch mode (rebuild on changes)
npm run start:http   # Start authenticated Streamable HTTP mode
npm run format       # Format source with Prettier
npm run format:check # Check formatting without modifying files
```

## License

MIT -- [LayerV AI](https://layerv.ai)
