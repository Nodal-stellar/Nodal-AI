# Your First Nodal AI Agent

This tutorial will guide you through setting up and running your first Nodal AI agent on Stellar testnet. By the end, you'll have:

- A funded Stellar testnet account
- Your agent configured and running
- Sent your first payment
- Responded to an x402 payment challenge

**Time required:** ~15 minutes  
**Prerequisites:** Node.js 22+, Git, and a terminal

---

## Step 1: Clone and Install

First, clone the repository and install dependencies:

```bash
git clone https://github.com/Nodal-stellar/Nodal-AI.git
cd Nodal-AI
npm install
```

Verify the installation:

```bash
npm run build
```

**Expected output:** No errors; TypeScript compilation succeeds.

---

## Step 2: Create a Stellar Testnet Account

You need a Stellar account to sign transactions. We'll use the Stellar Laboratory to create one on testnet.

1. Open [Stellar Laboratory](https://laboratory.stellar.org/#account-creator?network=testnet)
2. Click **"Create Account"** in the "Account Creator" section
3. A new account will be created with a **Secret Key** (starts with `S`) and a **Public Key** (starts with `G`)

**Important:** Save your secret key securely. It looks like this:
```
SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X
```

Keep this secret key safe — it controls your funds!

---

## Step 3: Fund Your Account

Testnet accounts need XLM to pay transaction fees. Use Friendbot to get free testnet XLM.

1. Go to [Stellar Laboratory → Friendbot](https://laboratory.stellar.org/#friendbot?network=testnet)
2. Paste your **Public Key** (starts with `G`) into the input field
3. Click **"Fund"**

**Expected output:** A success message showing your account was funded with 10,000 XLM.

---

## Step 4: Configure Your Agent

Copy the example environment file and fill in your credentials:

```bash
cp .env.example .env
```

Open `.env` in your editor and set these required variables:

```bash
# Your Stellar secret key (from Step 2)
AGENT_SECRET_KEY=SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X

# Stellar testnet endpoints
STELLAR_NETWORK=testnet
HORIZON_URL=https://horizon-testnet.stellar.org
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org

# x402 configuration (use the default USDC issuer for testnet)
X402_ASSET_CODE=USDC
X402_ASSET_ISSUER=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN

# Spending limit (per transaction, in asset units)
AGENT_SPENDING_LIMIT=100
```

**Other useful settings:**

```bash
# Database path (SQLite, default is ./agent.db)
DB_PATH=./agent.db

# Spending window duration (default: 24 hours)
SPENDING_WINDOW_MS=86400000

# x402 rate limit (payments per minute, default: 10)
MAX_X402_PAYMENTS_PER_MINUTE=10
```

---

## Step 5: Verify Configuration

Run the configuration check to ensure everything is set up correctly:

```bash
npx ts-node -e "
import { config } from './backend/config';
console.log('Network:', config.STELLAR_NETWORK);
console.log('Agent Public Key:', config.AGENT_PUBLIC_KEY);
console.log('Spending Limit:', config.AGENT_SPENDING_LIMIT);
"
```

**Expected output:**
```
Network: testnet
Agent Public Key: GBD... (your public key)
Spending Limit: 100
```

---

## Step 6: Send Your First Payment

Now let's send some XLM to another account using the `StellarPaymentTool`.

First, get a recipient address. You can use any testnet address, or create a second account in Stellar Laboratory.

Create a test script `my_first_payment.ts`:

```typescript
import { PayFiAgent } from './backend/agent';
import { config } from './backend/config';

const agent = new PayFiAgent();

async function main() {
  const recipient = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'; // Example address

  const result = await agent.run({
    type: 'stellar_payment',
    payload: {
      destination: recipient,
      amount: '1.5', // 1.5 XLM
      assetCode: 'XLM',
    },
  });

  console.log('Payment result:', result);
}

main().catch(console.error);
```

Run it:

```bash
npx ts-node my_first_payment.ts
```

**Expected output:**
```
Payment result: {
  success: true,
  taskType: 'stellar_payment',
  data: {
    txHash: 'abc123...',
    ledger: 12345,
    destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    amount: '1.5'
  },
  correlationId: '...',
  durationMs: 1234
}
```

The transaction hash confirms your payment was submitted to the Stellar network.

---

## Step 7: Add a Trustline (Optional)

To send custom assets (like USDC), you need a trustline. Let's add a USDC trustline.

Create `add_trustline.ts`:

```typescript
import { PayFiAgent } from './backend/agent';

const agent = new PayFiAgent();

async function main() {
  const result = await agent.run({
    type: 'change_trust',
    payload: {
      assetCode: 'USDC',
      assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      limit: '10000', // Maximum you're willing to hold
    },
  });

  console.log('Trustline result:', result);
}

main().catch(console.error);
```

Run it:

```bash
npx ts-node add_trustline.ts
```

**Expected output:** Success with a transaction hash.

---

## Step 8: Respond to an x402 Payment Challenge

x402 is the machine-to-machine payment standard. Let's simulate responding to a payment challenge.

Create `respond_x402.ts`:

```typescript
import { X402PaymentTool } from './backend/tools/X402PaymentTool';
import { createAgentSigner } from './backend/signer';

const tool = new X402PaymentTool();

async function main() {
  const challenge = {
    resource: 'https://api.example.com/data',
    amount: '0.5',
    assetCode: 'USDC',
    assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    payTo: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    nonce: '550e8400-e29b-41d4-a716-446655440000', // UUID
    expiresAt: new Date(Date.now() + 60000).toISOString(), // 1 minute from now
  };

  const proof = await tool.respond(challenge);

  console.log('Payment proof:', proof);
  console.log('Transaction hash:', proof.txHash);
}

main().catch(console.error);
```

Run it:

```bash
npx ts-node respond_x402.ts
```

**Expected output:**
```
Payment proof: {
  protocol: 'x402',
  network: 'stellar:testnet',
  txHash: 'def456...',
  nonce: '550e8400-e29b-41d4-a716-446655440000',
  payer: 'G... (your public key)',
  signedAt: '2024-01-01T00:00:00Z'
}
Transaction hash: def456...
```

The proof can be sent back to the resource server to unlock the paywalled content.

---

## Step 9: Check Your Balance

Verify your account balance after these transactions:

Create `check_balance.ts`:

```typescript
import { PayFiAgent } from './backend/agent';

const agent = new PayFiAgent();

async function main() {
  const result = await agent.run({
    type: 'account_info',
    payload: {},
  });

  console.log('Account info:', result);
}

main().catch(console.error);
```

Run it:

```bash
npx ts-node check_balance.ts
```

**Expected output:** Your current XLM and asset balances.

---

## Step 10: Run the Full AI x402 Example

The repository includes a complete example of an autonomous AI agent that discovers a paywalled endpoint and automatically pays for it.

```bash
npx ts-node scripts/examples/ai_x402_agent.ts
```

This demonstrates:
- Discovery of a 402 Payment Required response
- Autonomous analysis and payment planning
- x402 challenge response
- Proof generation and verification

---

## Common Issues

### "Insufficient funds" error

Your account doesn't have enough XLM. Use Friendbot to fund it again (Step 3).

### "Trustline required" error

You need to add a trustline for the asset (Step 7).

### "Rate limit exceeded" error

You've hit the x402 rate limit (default: 10 payments per minute). Wait a minute or adjust `MAX_X402_PAYMENTS_PER_MINUTE` in `.env`.

### "Cumulative spending exceeds limit" error

You've hit your spending limit within the rolling window. Wait for old payments to expire or increase `AGENT_SPENDING_LIMIT`.

### "Network connection failed"

Check your internet connection and verify `HORIZON_URL` and `SOROBAN_RPC_URL` are correct for testnet.

---

## Next Steps

Now that you've run your first agent, explore more:

- **[Architecture Guide](../ARCHITECTURE.md)** — Deep dive into system design
- **[Glossary](../GLOSSARY.md)** — Stellar terminology explained
- **[Examples](../../scripts/examples/)** — More runnable examples
- **[Roadmap](../../ROADMAP.md)** — Upcoming features and milestones
- **[Contributing](../../CONTRIBUTING.md)** — How to contribute to Nodal AI

---

## Security Best Practices

1. **Never commit `.env`** — Your secret key gives full control of your account
2. **Use different keys for testnet and mainnet** — Never reuse testnet keys on mainnet
3. **Keep spending limits low** — Start with small limits to limit exposure
4. **Monitor transactions** — Check your account activity regularly
5. **Use a hardware wallet for mainnet** — Consider using HashiCorp Vault or HSM for production

---

## Going to Mainnet

When you're ready to deploy to mainnet:

1. **Change network:** Set `STELLAR_NETWORK=mainnet` in `.env`
2. **Use mainnet endpoints:** Update `HORIZON_URL` and `SOROBAN_RPC_URL`
3. **Use real issuers:** Update `X402_ASSET_ISSUER` to mainnet addresses
4. **Set spending limit:** Keep `AGENT_SPENDING_LIMIT` below 10,000
5. **Test thoroughly:** Run extensive tests on testnet first

See the [Mainnet Checklist](../../README.md#mainnet-checklist) for details.

---

## Need Help?

- **[Issues](https://github.com/Nodal-stellar/Nodal-AI/issues)** — Report bugs or request features
- **[Discussions](https://github.com/Nodal-stellar/Nodal-AI/discussions)** — Ask questions and share ideas
- **[Stellar Discord](https://discord.gg/stellar)** — Join the Stellar community

Happy building! 🚀
