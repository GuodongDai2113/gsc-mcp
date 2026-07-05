# GSC MCP Server

Google Search Console MCP Server — a TypeScript [Model Context Protocol](https://modelcontextprotocol.io) server that provides tools for interacting with the Google Search Console API through AI assistants like Claude Desktop.

This is a TypeScript port of the [mcp-gsc](https://github.com/aminforoutan/mcp-gsc) Python server, fully compatible with the MCP specification.

## Features

- **21 MCP Tools** covering all aspects of Google Search Console
- **Dual Authentication** — OAuth 2.0 (browser login) and Service Account
- **Cross-platform** — Windows, macOS, Linux
- **STDIO and SSE transport** support
- **Zero-config fallbacks** — sensible defaults for all settings
- **Safety-first** — destructive operations disabled by default

## Tools Overview

| Category | Tool | Description |
|----------|------|-------------|
| **Auth** | `reauthenticate` | Log out and re-login with a different Google account |
| **Properties** | `list_properties` | List all GSC sites you have access to |
| | `get_site_details` | Get verification and ownership info for a site |
| | `add_site` | Add a new property *(destructive — disabled by default)* |
| | `delete_site` | Remove a property *(destructive — disabled by default)* |
| **Analytics** | `get_search_analytics` | Top queries/pages with clicks, impressions, CTR, position |
| | `get_performance_overview` | Summary + daily trend for a time period |
| | `compare_search_periods` | Compare performance between two date ranges |
| | `get_search_by_page_query` | Queries driving traffic to a specific page |
| | `get_advanced_search_analytics` | Advanced filtering, sorting, and pagination |
| **URL Inspection** | `inspect_url_enhanced` | Detailed crawl/index/rich-result status for a URL |
| | `batch_url_inspection` | Inspect up to 10 URLs at once |
| | `check_indexing_issues` | Check multiple URLs for indexing problems |
| **Sitemaps** | `get_sitemaps` | List all sitemaps for a site |
| | `list_sitemaps_enhanced` | Detailed sitemap info with errors and warnings |
| | `get_sitemap_details` | Detailed info for a specific sitemap |
| | `submit_sitemap` | Submit or resubmit a sitemap |
| | `delete_sitemap` | Remove a sitemap *(destructive — disabled by default)* |
| | `manage_sitemaps` | All-in-one: list, details, submit, delete |
| **Info** | `get_capabilities` | List all tools, auth status, and getting started guide |

## Prerequisites

- **Node.js** 18+ (LTS recommended)
- A Google Cloud project with the **Search Console API** enabled
- At least one authentication method set up (see below)

## Installation

```bash
# Clone the repository
git clone <repo-url> gsc-mcp
cd gsc-mcp

# Install dependencies
npm install

# Build
npm run build
```

## Authentication Setup

You must configure one of two authentication methods:

### Option 1: OAuth 2.0 (Recommended)

Best for individual users. Opens a browser window for Google login.

1. Create a Google Cloud project at [console.cloud.google.com](https://console.cloud.google.com)
2. Enable the **Google Search Console API**
3. Create **OAuth 2.0 Client ID** credentials (Desktop application type)
4. Download the client secrets JSON file

Set the environment variable:

```bash
# Windows (PowerShell)
$env:GSC_OAUTH_CLIENT_SECRETS_FILE = "C:\path\to\client_secrets.json"

# macOS / Linux
export GSC_OAUTH_CLIENT_SECRETS_FILE="/path/to/client_secrets.json"
```

Or place the file as `client_secrets.json` in the project source directory.

On first use, the server will automatically open your browser for authentication. No manual token management needed.

### Option 2: Service Account

Best for server/automation use cases.

1. Create a service account in your Google Cloud project
2. Download the JSON key file
3. Add the service account email as a user in GSC for each property

```bash
# Windows (PowerShell)
$env:GSC_CREDENTIALS_PATH = "C:\path\to\service_account_credentials.json"

# macOS / Linux
export GSC_CREDENTIALS_PATH="/path/to/service_account_credentials.json"
```

## Claude Desktop Configuration

Edit `claude_desktop_config.json`:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "gsc": {
      "command": "node",
      "args": [
        "C:\\path\\to\\gsc-mcp\\build\\index.js"
      ],
      "env": {
        "GSC_OAUTH_CLIENT_SECRETS_FILE": "C:\\path\\to\\client_secrets.json"
      }
    }
  }
}
```

For macOS/Linux, use forward slashes and the `export`-style environment configuration.

Restart Claude Desktop after saving. You should see the hammer icon in the input box.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GSC_OAUTH_CLIENT_SECRETS_FILE` | (none) | Absolute path to OAuth client secrets JSON |
| `GSC_CREDENTIALS_PATH` | (none) | Absolute path to service account credentials JSON |
| `GSC_SKIP_OAUTH` | `false` | Set to `true` to skip OAuth and use service account only |
| `GSC_ALLOW_DESTRUCTIVE` | `false` | Set to `true` to enable add/delete operations |
| `GSC_DATA_STATE` | `all` | `all` (matches GSC dashboard) or `final` (confirmed data only, 2-3 day lag) |
| `GSC_CONFIG_DIR` | Platform default | Override config directory for token storage |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `sse` (HTTP SSE) |
| `MCP_HOST` | `127.0.0.1` | Host to bind when using SSE transport |
| `MCP_PORT` | `3001` | Port to bind when using SSE transport |

## Running with SSE Transport

```bash
# Windows (PowerShell)
$env:MCP_TRANSPORT = "sse"
$env:MCP_HOST = "0.0.0.0"
$env:MCP_PORT = "3001"
npm run start

# macOS / Linux
MCP_TRANSPORT=sse MCP_HOST=0.0.0.0 MCP_PORT=3001 npm run start
```

## Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run (stdio)
npm run start
```

## Project Structure

```
gsc-mcp/
├── src/
│   ├── index.ts    # MCP server entry point + all 21 tool registrations
│   └── auth.ts     # Google authentication (OAuth 2.0 + Service Account)
├── build/          # Compiled JavaScript output
├── package.json
└── tsconfig.json
```

## Credits

Original Python MCP-GSC server created by [Amin Foroutan](https://aminforoutan.com/).

## License

ISC
