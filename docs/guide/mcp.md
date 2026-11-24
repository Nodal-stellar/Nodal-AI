# MCP Server

Nodal AI exposes its agent tools to Model Context Protocol (MCP) clients such
as Claude Desktop and Cursor. Read-only tools are always listed; value-moving
tools are only exposed when `MCP_ALLOW_PAYMENTS=true`.

## Entrypoint

`npm run build` compiles the server to `dist/backend/mcp/index.js`, which is
also published as the `nodal-mcp` bin. It needs only production dependencies
and ships in the production Docker image.

```bash
npm run build
node dist/backend/mcp/index.js      # or: npm run mcp:start
```

The server reads the same environment as the agent (`AGENT_SECRET_KEY`,
`STELLAR_NETWORK`, ...) plus:

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_TRANSPORT` | `stdio` | `stdio` for local clients, `http` for the HTTP transport |
| `MCP_PORT` | `3001` | Port of the HTTP transport |
| `MCP_ALLOW_PAYMENTS` | `false` | Expose value-moving tools |
| `ADMIN_API_TOKEN` | — | When set, the HTTP transport requires `Authorization: Bearer <token>` |

During development, `npm run mcp` still runs the TypeScript source with
ts-node.

## Docker Compose profile

The `mcp` profile runs the compiled entrypoint from the production image with
the HTTP transport. It is published on the host loopback interface only
(`127.0.0.1:3002`) and refuses to start without `ADMIN_API_TOKEN`:

```bash
ADMIN_API_TOKEN=$(openssl rand -hex 32) \
AGENT_SECRET_KEY=S... X402_ASSET_ISSUER=G... \
  docker compose --profile mcp up --build mcp
```

```bash
curl -s http://127.0.0.1:3002/mcp/tools -H "Authorization: Bearer $ADMIN_API_TOKEN"
```

## Client configuration

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
        "STELLAR_NETWORK": "testnet",
        "AGENT_SECRET_KEY": "S...",
        "X402_ASSET_ISSUER": "G..."
      }
    }
  }
}
```

### Cursor

Add the server to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project).
Either launch it over stdio exactly like Claude Desktop above, or point Cursor
at the Compose profile's HTTP endpoint:

```json
{
  "mcpServers": {
    "nodal-ai": {
      "url": "http://127.0.0.1:3002/mcp",
      "headers": {
        "Authorization": "Bearer <ADMIN_API_TOKEN>"
      }
    }
  }
}
```

Keep `MCP_ALLOW_PAYMENTS=false` unless the client is trusted to move funds.
