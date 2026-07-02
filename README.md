# qURL MCP

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
| `http` | Remote MCP server | `npm run start:http` | GPT / ChatGPT / public server deployment |

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
      "args": ["@layervai/qurl-mcp"]
    }
  }
}
```

## Configuration Files

This project uses two configuration files:

- `qurl-mcp.config.json`
- `qurl-mcp.http.json`

Their responsibilities are:

| File | Purpose |
| --- | --- |
| `qurl-mcp.config.json` | Shared runtime config used by both `stdio` and `http` modes |
| `qurl-mcp.http.json` | HTTP-only server listener and public access config |

## qurl-mcp.config.json Reference

### Shared Core Settings

| Field | Purpose |
| --- | --- |
| `maxUploadFileDataBytes` | Limits the decoded file size accepted by `upload_file_data_qurl` |
| `defaultQurlApiUrl` | Base URL of the qURL backend API |
| `defaultQurlConnectorUrl` | Base URL of the upload connector |
| `qurlApiKey` | API key used by the server to call qURL |

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

These settings are used when email delivery is requested by tools such as:

- `create_qurl`
- `mint_link`
- `upload_text_qurl`
- `upload_file_data_qurl`

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

## Configuration Priority

By default, configuration is loaded from the two JSON files above.

The following environment variables can override the config file paths:

- `QURL_MCP_CONFIG`
- `QURL_MCP_HTTP_CONFIG`

> For the current deployment model, it is recommended to manage the main runtime settings in the JSON files.

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

## OpenAI / GPT / ChatGPT Configuration

The current `HTTP MCP` mode is:

- `No Auth`

So when configuring the remote MCP server in OpenAI Platform or GPT:

| Setting | Recommended Value |
| --- | --- |
| MCP Server URL | Your public HTTPS URL plus `/mcp` |
| Authentication | `No Auth` |

Notes:

- the project no longer depends on client-provided access tokens
- the real qURL API key is read by the server from `qurl-mcp.config.json`

## How to Verify Deployment

### Service-Level Checks

Start with:

- `/healthz`
- `/mcp`

### Public Page Checks

If public pages are enabled, also verify:

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
docker run -i qurl-mcp
```

If you deploy with Docker, make sure the container can still access the correct config files, or override the config file paths with environment variables.

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

1. Update `qurl-mcp.config.json`
2. Update `qurl-mcp.http.json`
3. Run `npm install`
4. Run `npm run build`
5. Run `npm run start:http`
6. Verify `/healthz`
7. Configure nginx reverse proxy
8. Verify public access to `/mcp`, legal pages, and the video page
9. Configure the remote MCP server in OpenAI Platform with `No Auth`

## Notes

For a more polished public release, it is recommended to add:

- a dedicated nginx deployment guide
- a dedicated domain verification guide
- a dedicated GPT / OpenAI Platform submission guide
- a more secure production key management model

## License

MIT
