# Connect an MCP Client to Nodal AI

This tutorial connects Claude Desktop or Cursor to Nodal AI over the Model Context
Protocol (MCP). You will:

1. Connect a client in a locked-down, read-only setup
2. Ask it for an account balance and the latest ledger on testnet
3. Optionally enable payments, with a person approving each one

**Time required:** about 10 minutes
**Prerequisites:** Node.js 22+, Git, and Claude Desktop or Cursor

::: warning Verification status
These steps have **not been run on testnet** yet. The responses below show the
expected shape with placeholders, not recorded output. See
[Record your output](#record-your-output) to add a real transcript.
:::

---

## Step 1: Build the server

```bash
git clone https://github.com/Nodal-stellar/Nodal-AI.git
cd Nodal-AI
npm install
npm run build
```

The server is now at `dist/backend/mcp/index.js`. You will need its absolute path.

## Step 2: Create a testnet account

Generate a keypair and fund it with Friendbot:

```bash
node -e "const { Keypair } = require('@stellar/stellar-sdk'); const k = Keypair.random(); console.log(k.publicKey()); console.log(k.secret())"
curl -s "https://friendbot.stellar.org/?addr=<PUBLIC_KEY>" > /dev/null
```

Use a throwaway key. The client configuration stores the secret in plain text.

## Step 3: Configure your client

Both configurations below set:

- `MCP_ALLOW_PAYMENTS=false`, which hides tools that move funds
- `PAUSED=true`, the kill switch, which halts value-moving tasks
- `DB_PATH` as an absolute path, because the client chooses the working directory

Replace the two paths and `AGENT_SECRET_KEY`. On Windows, use forward slashes or
doubled backslashes in paths.

### Claude Desktop

Edit `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

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

Quit and reopen Claude Desktop.

### Cursor

Create `~/.cursor/mcp.json` for every project, or `.cursor/mcp.json` in one
project. Do not commit a project file that contains a key.

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

Then enable `nodal-ai` in Cursor's MCP settings.

Use stdio for both clients. The HTTP transport does not implement MCP's Streamable
HTTP or SSE transports.

## Step 4: Read-only demo

Ask your client:

> Use nodal-ai to check the XLM balance of `<PUBLIC_KEY>`, then tell me the latest
> testnet ledger.

It should call these two tools.

**`balance_check`**

```json
{ "publicKey": "G...", "assetCode": "XLM" }
```

Expected result: the balance as a decimal string.

```json
{ "content": [{ "type": "text", "text": "\"<balance>\"" }] }
```

**`ledger_info`**

```json
{}
```

Expected result: the ledger sequence and protocol version.

```json
{ "content": [{ "type": "text", "text": "{\"sequence\":<n>,\"protocolVersion\":<n>}" }] }
```

### Check that payments are off

Ask the client to list its nodal-ai tools. `stellar_payment` must not be among
them. If it is, stop and review your configuration.

### Without a client

You can send the same calls from a terminal. Set the variables from the `env`
block first.

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ledger_info","arguments":{}}}' \
  | node dist/backend/mcp/index.js
```

## Step 5: Enable payments with approvals

The launcher below starts the MCP server with two additions: it sets
`requireApproval` on every value-moving task, and it serves the approval API from
the same process, so you can decide held tasks over HTTP.

Save it as `mcp-with-approvals.js` in the repository root:

```js
// Send everything but JSON-RPC to stderr while the modules load.
process.env.MCP_TRANSPORT = 'stdio';
const write = process.stdout.write;
process.stdout.write = process.stderr.write.bind(process.stderr);

const { PayFiAgent, VALUE_MOVING_TASK_TYPES } = require('./dist/backend/agent');
const { db } = require('./dist/backend/db/client');
const { startMCPServer } = require('./dist/backend/mcp/server');
const { createHealthServer } = require('./dist/backend/server');

async function main() {
  if (!process.env.ADMIN_API_TOKEN) throw new Error('ADMIN_API_TOKEN is required');
  await db.migrate();

  const agent = new PayFiAgent();
  agent.use((task, next) => {
    if (VALUE_MOVING_TASK_TYPES.has(task.type)) task.requireApproval = true;
    return next();
  });

  createHealthServer(agent).listen(3000, '127.0.0.1');
  process.stdout.write = write;
  await startMCPServer(agent);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
```

Point the client at it, with tight limits and an allowlist:

```json
{
  "mcpServers": {
    "nodal-ai": {
      "command": "node",
      "args": ["/absolute/path/to/Nodal-AI/mcp-with-approvals.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "MCP_ALLOW_PAYMENTS": "true",
        "PAUSED": "true",
        "ADMIN_API_TOKEN": "<random token>",
        "AGENT_SPENDING_LIMIT": "5",
        "PAYMENT_DESTINATION_POLICY": "allowlist",
        "PAYMENT_DESTINATIONS": "G...",
        "APPROVAL_TTL_MS": "600000",
        "NANO_ENABLED": "false",
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

Leave `APPROVAL_THRESHOLD` unset; the launcher already holds these tasks.

Keep `ADMIN_API_TOKEN` away from the model. Anyone holding it can approve.

### Work up to a payment

Do these in order, and stop if one does not behave as described.

1. **Still paused.** Ask the client to send 1 XLM to your allowlisted address. It
   must fail with `Agent is paused`.

2. **Resume.**

   ```bash
   curl -s -X POST http://127.0.0.1:3000/admin/resume \
     -H "Authorization: Bearer $ADMIN_API_TOKEN"
   ```

3. **Wrong destination.** Ask for a payment to another address. It must fail with
   `is not permitted by the allowlist payment destination policy`.

4. **Held payment.** Ask for 1 XLM to the allowlisted address again. It must fail
   with `stellar_payment requires human approval — awaiting approval`. If you get a
   transaction hash instead, pause at once and remove `MCP_ALLOW_PAYMENTS`.

5. **Review it yourself.** Check the destination and amount, not the client's
   description of them.

   ```bash
   curl -s http://127.0.0.1:3000/approvals -H "Authorization: Bearer $ADMIN_API_TOKEN"
   ```

6. **Deny it**, confirm that the balance did not change, request it again, and
   **approve** the new one.

   ```bash
   curl -s -X POST "http://127.0.0.1:3000/approvals/$APPROVAL_ID" \
     -H "Authorization: Bearer $ADMIN_API_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"decision":"approve"}'
   ```

7. **Pause again** when you finish: `POST /admin/pause`.

Read [AI payment safety](../guide/ai-safety.md) before using mainnet.

## Record your output

Replace the placeholder responses in Step 4 with a real
transcript, and remove the verification notice. Record:

- the commit (`git rev-parse HEAD`), date, client name, and version
- each tool call with its arguments and response
- the tool list from Step 4
- for Step 5, the held, denied, and approved responses, with the testnet
  transaction hash

Remove the secret key and the admin token before you paste anything.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Client reports the server exited | A required variable is missing; check the client's MCP log for `❌ [Config]` |
| Client reports invalid JSON on startup | The configuration banner is printed to stdout; the launcher in Step 5 avoids it |
| `no such table` | The database has not been migrated; start the agent once with the same `DB_PATH`, or use the launcher |
| Address in use on port 3000 | Another agent is running; change the port in the launcher |

## Next steps

- [MCP server reference](../guide/mcp.md)
- [Approvals](../guide/approvals.md)
- [AI payment safety](../guide/ai-safety.md)
