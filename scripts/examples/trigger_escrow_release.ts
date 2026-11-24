/**
 * scripts/examples/trigger_escrow_release.ts
 *
 * Event-driven escrow release on testnet: the seller locks 5 XLM in an escrow
 * contract, and the escrow is released to the buyer when the buyer's token
 * payment reaches the agent.
 *
 *   1. Fund throwaway seller, buyer and issuer accounts, and issue a demo asset.
 *   2. Deploy the escrow and lock the seller's XLM (arbiter = this agent).
 *   3. Create a payment trigger filtered by asset code AND issuer whose task is
 *      `soroban_invoke release`.
 *   4. Send the buyer's payment.
 *   5. Match the payment, fire the trigger once, and observe the release.
 *
 * With `--approval` the trigger's task carries `requireApproval: true`, so it
 * is held as `pending_approval` and you approve or deny it at the prompt.
 *
 * Roles: the seller is the depositor, the buyer the recipient and the agent the
 * arbiter. The contract requires all three to differ. Only the agent's calls go
 * through `PayFiAgent`; the throwaway parties sign their own transactions here,
 * so their spending never touches the agent's spending window.
 *
 * Two details this script has to handle itself:
 *
 *   - Payment delivery. `TriggerManager.start()` listens through
 *     `agent.startListening()`, which forwards payments carrying an `x402:`
 *     memo. The buyer's payment is an ordinary one, so this script polls Horizon and applies the same `matchesFilter` / `recordTriggerFired`
 *     / `agent.run` steps. It does not call `TriggerManager.start()`.
 *
 *   - Contract arguments. Triggers and pending approvals are stored as JSON,
 *     which cannot represent `xdr.ScVal`. `jsonSafeScVal` and the
 *     `restoreScVals` middleware round-trip the arguments as base64 XDR.
 *
 * Usage:
 *   npx ts-node scripts/examples/trigger_escrow_release.ts
 *   npx ts-node scripts/examples/trigger_escrow_release.ts --approval
 *
 * Required .env vars:
 *   AGENT_SECRET_KEY (a funded testnet account), HORIZON_URL, SOROBAN_RPC_URL,
 *   X402_ASSET_ISSUER
 *   STELLAR_NETWORK=testnet
 *   TRIGGER_ALLOW_PAYMENTS=true - `soroban_invoke` is a value-moving task type
 *   CONTRACT_WASM_PATH - Path to the compiled escrow WASM; build it with
 *     `bash scripts/build_escrow_wasm.sh`
 *
 * Walkthrough: docs/tutorials/trigger-escrow-release.md
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import { createInterface } from 'readline/promises';
import {
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { PayFiAgent, type AgentResult, type AgentTask } from '../../backend/agent';
import { config } from '../../backend/config';
import {
  decodeEscrowState,
  escrowCall,
  type EscrowCall,
  type EscrowState,
} from '../../backend/contracts/escrow';
import { db } from '../../backend/db/client';
import { getStorage } from '../../backend/db/storage';
import { ErrorType } from '../../backend/errors';
import { isPaused } from '../../backend/kill_switch';
import { resolveNetworkPassphrase } from '../../backend/rpc_client';
import { FriendBotTool } from '../../backend/tools/FriendBotTool';
import {
  TriggerManager,
  matchesFilter,
  type Trigger,
  type TriggerFilter,
} from '../../backend/triggers';

// Amount the seller locks, in XLM's 7-decimal stroop units (5 XLM).
const ESCROW_AMOUNT_STROOPS = 50_000_000n;

// What the buyer pays for it, in the demo asset.
const PRICE = '25.0000000';
const ASSET_CODE = 'DEMOUSD';

// How long until the seller could reclaim the escrow.
const EXPIRY_WINDOW_SECONDS = 3600;

const TX_TIMEOUT_SECONDS = 60;
const POLL_INTERVAL_MS = 3_000;
const PAYMENT_WAIT_TIMEOUT_MS = 90_000;
const RELEASE_WAIT_TIMEOUT_MS = 90_000;

const networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Contract arguments as JSON ───────────────────────────────────────────────

/** How an `xdr.ScVal` is stored in the triggers and pending_approvals tables. */
interface EncodedScVal {
  scvalXdr: string;
}

/** Make `JSON.stringify` encode `value` as {@link EncodedScVal}. */
function jsonSafeScVal(value: xdr.ScVal): xdr.ScVal {
  const encoded: EncodedScVal = { scvalXdr: value.toXDR('base64') };
  return Object.defineProperty(value, 'toJSON', { value: () => encoded });
}

function isEncodedScVal(value: unknown): value is EncodedScVal {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Partial<EncodedScVal>).scvalXdr === 'string'
  );
}

/** Middleware: turn arguments that came back from storage into `xdr.ScVal` again. */
async function restoreScVals(
  task: AgentTask,
  next: () => Promise<AgentResult>
): Promise<AgentResult> {
  const payload = task.payload as { args?: unknown } | null;
  if (task.type === 'soroban_invoke' && payload && Array.isArray(payload.args)) {
    task.payload = {
      ...payload,
      args: payload.args.map((arg: unknown) =>
        isEncodedScVal(arg) ? jsonSafeScVal(xdr.ScVal.fromXDR(arg.scvalXdr, 'base64')) : arg
      ),
    };
  }
  return next();
}

// ─── Transactions signed by the throwaway parties ─────────────────────────────

/** Submit a classic transaction paid for by the first signer. */
async function submitClassic(
  horizon: Horizon.Server,
  signers: [Keypair, ...Keypair[]],
  operations: xdr.Operation[]
): Promise<string> {
  const source = await horizon.loadAccount(signers[0].publicKey());
  const builder = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase });
  for (const operation of operations) builder.addOperation(operation);
  const tx = builder.setTimeout(TX_TIMEOUT_SECONDS).build();
  tx.sign(...signers);
  const { hash } = await horizon.submitTransaction(tx);
  return hash;
}

/** Build, simulate, sign and submit a single-operation Soroban transaction. */
async function submitSoroban(
  soroban: rpc.Server,
  signer: Keypair,
  operation: xdr.Operation
): Promise<{ hash: string; returnValue: xdr.ScVal | undefined }> {
  const account = await soroban.getAccount(signer.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(operation)
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();

  const prepared = await soroban.prepareTransaction(tx);
  prepared.sign(signer);

  const sent = await soroban.sendTransaction(prepared);
  if (sent.status === 'ERROR' || sent.status === 'TRY_AGAIN_LATER') {
    throw new Error(`Transaction rejected (${sent.status}): ${sent.hash}`);
  }

  const deadline = Date.now() + TX_TIMEOUT_SECONDS * 1_000;
  while (Date.now() < deadline) {
    const status = await soroban.getTransaction(sent.hash);
    if (status.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return { hash: sent.hash, returnValue: status.returnValue };
    }
    if (status.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`Transaction ${sent.hash} failed on-chain`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Transaction ${sent.hash} was not confirmed in time`);
}

// ─── Escrow ───────────────────────────────────────────────────────────────────

/** Upload and instantiate the escrow WASM; returns the contract ID. */
async function deployEscrow(soroban: rpc.Server, deployer: Keypair, wasm: Buffer): Promise<string> {
  const upload = await submitSoroban(soroban, deployer, Operation.uploadContractWasm({ wasm }));
  if (!upload.returnValue) throw new Error('WASM upload returned no hash');

  const deploy = await submitSoroban(
    soroban,
    deployer,
    Operation.createCustomContract({
      address: Address.fromString(deployer.publicKey()),
      wasmHash: Buffer.from(upload.returnValue.bytes()),
      salt: randomBytes(32),
    })
  );
  if (!deploy.returnValue) throw new Error('Contract creation returned no address');
  return Address.fromScVal(deploy.returnValue).toString();
}

async function callEscrow(
  soroban: rpc.Server,
  signer: Keypair,
  contractId: string,
  call: EscrowCall
): Promise<string> {
  const operation = new Contract(contractId).call(call.method, ...call.args);
  const { hash } = await submitSoroban(soroban, signer, operation);
  return hash;
}

async function readEscrowState(soroban: rpc.Server, contractId: string): Promise<EscrowState> {
  const { method, args } = escrowCall.get_state();
  const account = await soroban.getAccount(config.AGENT_PUBLIC_KEY);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();
  const simulation = await soroban.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
    throw new Error('Could not simulate get_state');
  }
  return decodeEscrowState(simulation.result.retval);
}

// ─── Payment observation ──────────────────────────────────────────────────────

/** The fields of a Horizon payment record this script reads. */
interface PaymentRecord {
  id: string;
  type: string;
  paging_token: string;
  transaction_hash: string;
  from: string;
  to: string;
  amount: string;
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
}

/** The newest payment cursor, so only payments made from now on are considered. */
async function latestPaymentCursor(horizon: Horizon.Server): Promise<string> {
  const page = await horizon
    .payments()
    .forAccount(config.AGENT_PUBLIC_KEY)
    .order('desc')
    .limit(1)
    .call();
  return page.records[0]?.paging_token ?? '0';
}

/** Horizon record → the event shape `matchesFilter` expects. */
function toTriggerEvent(payment: PaymentRecord): Record<string, string> {
  return {
    assetCode: payment.asset_type === 'native' ? 'XLM' : (payment.asset_code ?? ''),
    assetIssuer: payment.asset_issuer ?? '',
    from: payment.from,
    amount: payment.amount,
  };
}

/**
 * Wait for an incoming payment that matches `trigger`, claim it in the dedupe
 * table, and run the trigger's task. The trigger is disabled before its task
 * runs, so a second matching payment cannot fire it again.
 */
async function waitAndFire(
  horizon: Horizon.Server,
  agent: PayFiAgent,
  manager: TriggerManager,
  trigger: Trigger,
  startCursor: string
): Promise<AgentResult> {
  let cursor = startCursor;
  const deadline = Date.now() + PAYMENT_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const page = await horizon
      .payments()
      .forAccount(config.AGENT_PUBLIC_KEY)
      .cursor(cursor)
      .order('asc')
      .limit(50)
      .call();

    for (const payment of page.records as unknown as PaymentRecord[]) {
      cursor = payment.paging_token;
      // Plain payments only; path payments and account creation are ignored.
      if (payment.type !== 'payment' || payment.to !== config.AGENT_PUBLIC_KEY) continue;
      if (!matchesFilter(toTriggerEvent(payment), trigger.filter)) {
        console.log(`   Ignored payment ${payment.transaction_hash} (filter did not match)`);
        continue;
      }

      const eventId = `payment:${payment.transaction_hash}:${payment.id}`;
      if (!(await getStorage().recordTriggerFired(trigger.id, eventId))) continue;

      console.log(`   Matched payment ${payment.transaction_hash}; firing ${trigger.id}`);
      await manager.setTriggerEnabled(trigger.id, false);
      return agent.run(trigger.task);
    }

    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`No matching payment arrived within ${PAYMENT_WAIT_TIMEOUT_MS}ms`);
}

/** Prove the filter rejects a same-code asset from a different issuer. */
function assertFilterRejectsImpostor(filter: TriggerFilter, buyer: string): void {
  const impostor = {
    assetCode: ASSET_CODE,
    assetIssuer: Keypair.random().publicKey(),
    from: buyer,
    amount: PRICE,
  };
  if (matchesFilter(impostor, filter)) {
    throw new Error(`Trigger filter accepted ${ASSET_CODE} from an untrusted issuer`);
  }
}

// ─── Approval variant ─────────────────────────────────────────────────────────

/** Ask the operator for a decision. Anything but "approve" denies. */
async function askForDecision(approvalId: string): Promise<'approve' | 'deny'> {
  if (!process.stdin.isTTY) {
    console.log('   No interactive terminal; denying.');
    return 'deny';
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`   Approval ${approvalId}. Type "approve" or "deny": `);
    return answer.trim().toLowerCase() === 'approve' ? 'approve' : 'deny';
  } finally {
    prompt.close();
  }
}

/** Decide a held release; returns the executed result, or null when denied. */
async function resolveApproval(agent: PayFiAgent, held: AgentResult): Promise<AgentResult | null> {
  const { approvalId, expiresAt } = held.data as { approvalId: string; expiresAt: string };
  console.log(`   Release held as pending_approval until ${expiresAt}; nothing has moved.`);

  if ((await askForDecision(approvalId)) === 'deny') {
    const approval = agent.deny(approvalId, 'example-operator');
    console.log(`   Approval is now "${approval?.status ?? 'unknown'}".`);
    return null;
  }

  const outcome = await agent.approve(approvalId, 'example-operator');
  if (!outcome?.result) {
    throw new Error(`Approval ${approvalId} was not executed (${outcome?.approval.status})`);
  }
  return outcome.result;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/** Check the configuration this example depends on; returns the escrow WASM. */
function preflight(): Buffer {
  if (config.STELLAR_NETWORK !== 'testnet') {
    throw new Error('This example only runs on testnet. Set STELLAR_NETWORK=testnet.');
  }
  if (!config.TRIGGER_ALLOW_PAYMENTS) {
    throw new Error('soroban_invoke is value-moving. Set TRIGGER_ALLOW_PAYMENTS=true.');
  }
  if (isPaused()) {
    throw new Error('The kill switch is engaged. Resume the agent before running this example.');
  }
  const wasmPath = process.env.CONTRACT_WASM_PATH;
  if (!wasmPath || !fs.existsSync(wasmPath)) {
    throw new Error(
      'Set CONTRACT_WASM_PATH to the compiled escrow WASM (bash scripts/build_escrow_wasm.sh).'
    );
  }
  return fs.readFileSync(wasmPath);
}

async function main(): Promise<void> {
  const requireApproval = process.argv.includes('--approval');
  const wasm = preflight();

  await db.migrate();
  const horizon = new Horizon.Server(config.HORIZON_URL);
  const soroban = new rpc.Server(config.SOROBAN_RPC_URL);
  const friendbot = new FriendBotTool();
  const agent = new PayFiAgent(); // the arbiter
  agent.use(restoreScVals);
  const manager = new TriggerManager(agent);
  let trigger: Trigger | undefined;

  try {
    // ── 1. Accounts and demo asset ─────────────────────────────────────────
    console.log('Step 1: Funding throwaway accounts and issuing the demo asset...');
    const seller = Keypair.random();
    const buyer = Keypair.random();
    const issuer = Keypair.random();
    await Promise.all(
      [seller, buyer, issuer].map((kp) => friendbot.execute({ publicKey: kp.publicKey() }))
    );

    const asset = new Asset(ASSET_CODE, issuer.publicKey());
    const trust = await agent.run({
      type: 'change_trust',
      payload: { assetCode: ASSET_CODE, assetIssuer: issuer.publicKey(), action: 'add' },
    });
    if (!trust.success) throw new Error(`Agent trustline failed: ${trust.error}`);

    await submitClassic(
      horizon,
      [buyer, issuer],
      [
        Operation.changeTrust({ asset }),
        Operation.payment({
          destination: buyer.publicKey(),
          asset,
          amount: PRICE,
          source: issuer.publicKey(),
        }),
      ]
    );
    console.log(`   Asset  : ${ASSET_CODE}:${issuer.publicKey()}`);
    console.log(`   Seller : ${seller.publicKey()}`);
    console.log(`   Buyer  : ${buyer.publicKey()}`);
    console.log(`   Agent  : ${config.AGENT_PUBLIC_KEY}`);

    // ── 2. Escrow ──────────────────────────────────────────────────────────
    console.log('\nStep 2: Deploying the escrow and locking 5 XLM...');
    const contractId = await deployEscrow(soroban, seller, wasm);
    const nativeToken = Asset.native().contractId(networkPassphrase);
    await callEscrow(
      soroban,
      seller,
      contractId,
      escrowCall.set_allowed_tokens({ tokens: [nativeToken] })
    );
    const initHash = await callEscrow(
      soroban,
      seller,
      contractId,
      escrowCall.initialize({
        depositor: seller.publicKey(),
        recipient: buyer.publicKey(),
        arbiter: config.AGENT_PUBLIC_KEY,
        token: nativeToken,
        amount: ESCROW_AMOUNT_STROOPS,
        expiry: BigInt(Math.floor(Date.now() / 1000) + EXPIRY_WINDOW_SECONDS),
      })
    );
    console.log(`   Contract   : ${contractId}`);
    console.log(`   Initialize : ${initHash}`);

    // ── 3. Trigger ─────────────────────────────────────────────────────────
    console.log('\nStep 3: Creating the payment trigger...');
    const filter: TriggerFilter = {
      assetCode: ASSET_CODE,
      assetIssuer: issuer.publicKey(),
      from: buyer.publicKey(),
      minAmount: PRICE,
    };
    assertFilterRejectsImpostor(filter, buyer.publicKey());

    const release = escrowCall.release({ arbiter: config.AGENT_PUBLIC_KEY });
    const task: AgentTask = {
      type: 'soroban_invoke',
      payload: {
        contractId,
        method: release.method,
        args: release.args.map(jsonSafeScVal),
        simulateOnly: false,
      },
      ...(requireApproval ? { requireApproval: true } : {}),
    };
    trigger = await manager.createTrigger({ source: 'payment', filter, task });
    console.log(`   Trigger  : ${trigger.id}`);
    console.log(`   Approval : ${requireApproval ? 'required' : 'not required'}`);

    // ── 4. Payment ─────────────────────────────────────────────────────────
    console.log(`\nStep 4: Buyer pays ${PRICE} ${ASSET_CODE} to the agent...`);
    // Start the listener before the payment so the release cannot be missed.
    // Topics arrive as ScVals, so decode them rather than filtering by string.
    const observed = { released: false };
    agent.startContractListener(contractId, [], (event) => {
      if (event.topic.some((topic) => scValToNative(topic) === 'released')) {
        observed.released = true;
      }
    });
    const cursor = await latestPaymentCursor(horizon);
    const paymentHash = await submitClassic(
      horizon,
      [buyer],
      [Operation.payment({ destination: config.AGENT_PUBLIC_KEY, asset, amount: PRICE })]
    );
    console.log(`   Payment : ${paymentHash}`);

    // ── 5. Fire and observe ────────────────────────────────────────────────
    console.log('\nStep 5: Waiting for the trigger to fire...');
    let result: AgentResult | null = await waitAndFire(horizon, agent, manager, trigger, cursor);
    if (result.errorType === ErrorType.PendingApproval) {
      result = await resolveApproval(agent, result);
    } else if (requireApproval) {
      throw new Error('Expected the release to be held for approval, but it was not');
    }

    if (result === null) {
      const state = await readEscrowState(soroban, contractId);
      if (state.released) throw new Error('Escrow was released despite the denial');
      console.log('\nDenied: the escrow is still locked. The seller can refund it after expiry.');
      return;
    }
    if (!result.success) throw new Error(`Release failed: ${result.error}`);
    console.log(`   Release : ${(result.data as { txHash: string }).txHash}`);

    const deadline = Date.now() + RELEASE_WAIT_TIMEOUT_MS;
    while (!observed.released && Date.now() < deadline) await sleep(POLL_INTERVAL_MS);
    if (!observed.released) throw new Error('The "released" contract event was not observed');

    const state = await readEscrowState(soroban, contractId);
    if (!state.released) throw new Error('get_state still reports the escrow as locked');
    console.log('   Observed the "released" event and released=true.');
    console.log('\nDone: payment received → trigger fired → escrow released to the buyer.');
  } finally {
    if (trigger) await manager.deleteTrigger(trigger.id);
    agent.destroy();
    await db.close();
  }
}

main().catch((err) => {
  console.error('\nTrigger escrow example failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
