# MCP Server

Nodal AI exposes its agent tools to Model Context Protocol (MCP) clients such
as Claude Desktop and Cursor. Tools that move funds are listed only when
`MCP_ALLOW_PAYMENTS=true`.

::: warning Experimental
Start on testnet with a dedicated account, `MCP_ALLOW_PAYMENTS=false`, and
`PAUSED=true`. See [AI payment safety](./ai-safety.md) before enabling payments.
:::

To connect a client step by step, follow the
[MCP client tutorial](../tutorials/mcp-client.md).

## Entrypoint

`npm run build` compiles the server to `dist/backend/mcp/index.js`. It needs only
production dependencies and ships in the production Docker image.

```bash
npm run build
node dist/backend/mcp/index.js      # or: npm run mcp:start
```

Clients that use stdio should launch `node` directly: `npm run` prints its own
lines to stdout, which is reserved for the protocol.

## Configuration

The server reads the same environment as the agent. `HORIZON_URL`,
`SOROBAN_RPC_URL`, `AGENT_SECRET_KEY`, and `X402_ASSET_ISSUER` are required, plus:

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_TRANSPORT` | `stdio` | `stdio` for local clients, `http` for the HTTP transport |
| `MCP_ALLOW_PAYMENTS` | `false` | List and allow funds-moving tools |
| `MCP_PORT` | `3001` | Port of the HTTP transport |
| `MCP_HOST` | `127.0.0.1` | Address the HTTP transport binds to |
| `MCP_API_TOKEN` | unset | When set, every HTTP request needs `Authorization: Bearer <token>`; required when payments are on |
| `MCP_MAX_BODY_BYTES` | `1048576` | Largest accepted HTTP request body |

During development, `npm run mcp` still runs the TypeScript source with
ts-node.

## HTTP transport

```bash
MCP_TRANSPORT=http MCP_API_TOKEN=$(openssl rand -hex 32) node dist/backend/mcp/index.js
```

```bash
curl -s http://127.0.0.1:3001/mcp/tools -H "Authorization: Bearer $MCP_API_TOKEN"
```

The endpoint answers JSON-RPC requests at `POST /mcp`. It does not implement the
Streamable HTTP or SSE transports, so desktop clients should use stdio.

## Docker Compose profile

The `mcp` profile runs the compiled entrypoint from the production image with
the HTTP transport. It is published on the host loopback interface only
(`127.0.0.1:3002`) and refuses to start without `ADMIN_API_TOKEN`:

```bash
ADMIN_API_TOKEN=$(openssl rand -hex 32) \
AGENT_SECRET_KEY=S... X402_ASSET_ISSUER=G... \
  docker compose --profile mcp up --build mcp
```

## Client configuration

Use a throwaway testnet key: the file stores it in plain text.

### Claude Desktop

Add the server to `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`). Claude
Desktop launches it over stdio:

```json
{
  "mcpServers": {
    "nodal-ai": {
      "command": "node",
      "args": ["/absolute/path/to/Nodal-AI/dist/backend/mcp/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "MCP_ALLOW_PAYMENTS": "false",
        "PAUSED": "true",
        "NODE_ENV": "production",
        "STELLAR_NETWORK": "testnet",
        "HORIZON_URL": "https://horizon-testnet.stellar.org",
        "SOROBAN_RPC_URL": "https://soroban-testnet.stellar.org",
        "AGENT_SECRET_KEY": "S...",
        "X402_ASSET_ISSUER": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        "DB_PATH": "/absolute/path/to/Nodal-AI/mcp-demo.db"
      }
    }
  }
}
```

### Cursor

Add the same block to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project).

Keep `MCP_ALLOW_PAYMENTS=false` unless the client is trusted to move funds.

## Next steps

- [MCP client tutorial](../tutorials/mcp-client.md): connect, try it, and enable payments safely
- [AI payment safety](./ai-safety.md): which controls apply to MCP calls
