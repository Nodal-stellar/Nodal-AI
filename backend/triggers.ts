/**
 * backend/triggers.ts
 *
 * Event-driven triggers for autonomous PayFi.
 * "when X arrives from Y, do Z" - persisted and deduplicated.
 */

import { PayFiAgent, AgentTask, TaskType, VALUE_MOVING_TASK_TYPES } from './agent';
import { config } from './config';
import { createLogger } from './utils/logger';
import { getStorage } from './db/storage';

const log = createLogger('triggers');

/**
 * Valid task types that can be used in triggers.
 */
const VALID_TRIGGER_TASK_TYPES: ReadonlySet<TaskType> = new Set<TaskType>([
  'stellar_payment',
  'soroban_invoke',
  'x402_respond',
  'change_trust',
  'multisig_payment',
  'batch_payment',
  'path_payment',
  'fee_bump',
  'dex_offer',
  'liquidity_pool',
  'data_entry',
  'sequence_number',
  'sponsored_account',
  'soroban_deploy',
  'swap',
  'set_options',
  'account_info',
  'balance_check',
  'stellar_toml',
  'soroban_query',
  'soroban_event_query',
  'stellar_identity_auth',
  'friendbot',
  'nano_payment',
  'ledger_info',
  'network_status',
  'offer_book',
  'soroban_storage',
]);

/**
 * Check if a task type is value-moving (changes ledger state).
 */
function isValueMovingTask(taskType: TaskType): boolean {
  return VALUE_MOVING_TASK_TYPES.has(taskType);
}

/**
 * Prune trigger_events rows older than the retention period.
 * Must be called with the triggers table locked to avoid race conditions.
 */
function pruneOldTriggerEvents(): void {
  const retentionMs = config.TRIGGER_EVENTS_RETENTION_MS ?? 7 * 24 * 60 * 60 * 1000; // 7 days default
  const cutoff = new Date(Date.now() - retentionMs).toISOString();

  getDb()
    .prepare('DELETE FROM trigger_events WHERE fired_at < ?')
    .run(cutoff);
}

export type TriggerSource = 'payment' | 'contract_event' | 'storage_change';

export interface TriggerFilter {
  /** Filter by source asset code (e.g., 'USDC') */
  assetCode?: string;
  /** Filter by asset issuer (required for non-XLM assets) */
  assetIssuer?: string;
  /** Filter by sender public key */
  from?: string;
  /** Filter by amount threshold */
  minAmount?: string;
  /** Filter by contract ID */
  contractId?: string;
  /** Filter by event topics */
  eventTopics?: string[];
  /** Filter by storage key */
  storageKey?: string;
}

export interface Trigger {
  id: string;
  source: TriggerSource;
  filter: TriggerFilter;
  /** Task to execute when trigger fires */
  task: AgentTask;
  enabled: boolean;
  createdAt: string;
  lastFiredAt?: string;
}

/**
 * Persist trigger to database.
 */
async function saveTrigger(trigger: Trigger): Promise<void> {
  await getStorage().saveTrigger(trigger);
}

/**
 * Load all triggers from database.
 */
async function loadTriggers(): Promise<Trigger[]> {
  return getStorage().loadTriggers();
}

/**
 * Generate a unique event ID from a Horizon payment event.
 * Uses tx hash + op index which is immutable and controlled by the network,
 * not the sender. This prevents replay attacks with different nonces.
 */
function generatePaymentEventId(payment: any): string {
  const txHash = payment.transaction_hash;
  const opIndex = payment.application_order ?? payment.order;
  return `payment:${txHash}:${opIndex}`;
}

/**
 * Generate a unique event ID from a Soroban contract event.
 * Uses the event's unique ID which is immutable and network-controlled.
 */
function generateContractEventId(event: any): string {
  return `contract_event:${event.id}`;
}

/**
 * Generate a unique event ID from a storage change event.
 * Uses contract ID + key hash + ledger sequence which is immutable.
 */
function generateStorageChangeEventId(change: StorageChangeEvent): string {
  // Key hash is derived from the ledger key which uniquely identifies the storage entry
  const keyHash = change.keyXdr;
  return `storage_change:${change.keyLedgerKey?.contractId ?? 'unknown'}:${keyHash}`;
}

/**
 * Record that a trigger fired for an event (dedupe).
 * Returns true if this is a new event (trigger should fire), false if already fired.
 * Prunes old records when the threshold is reached to prevent unbounded growth.
 */
async function recordTriggerFired(triggerId: string, eventId: string): Promise<boolean> {
  return getStorage().recordTriggerFired(triggerId, eventId);
}

/**
 * Drop trigger_events dedupe rows fired before `beforeIso` (#963). These
 * exist only to make `recordTriggerFired` idempotent for a bounded replay
 * window, so old rows carry no lasting value.
 */
export function pruneTriggerEvents(beforeIso: string): number {
  try {
    const result = getDb().prepare('DELETE FROM trigger_events WHERE fired_at < ?').run(beforeIso);
    return result.changes;
  } catch {
    // Table doesn't exist yet
    return 0;
  }
}

/**
 * Check if event matches trigger filter.
 */
export function matchesFilter(event: unknown, filter: TriggerFilter): boolean {
  const e = event as Record<string, unknown>;

  if (filter.assetCode) {
    const eventAssetCode = (e.assetCode as string) ?? (e.asset as string);
    // For non-XLM assets, require assetIssuer match too
    if (filter.assetCode !== 'XLM' && filter.assetIssuer) {
      const eventAssetIssuer = (e.assetIssuer as string) ?? '';
      if (eventAssetCode !== filter.assetCode || eventAssetIssuer !== filter.assetIssuer) {
        return false;
      }
    } else {
      // For XLM or when no issuer specified, match only on code
      if (eventAssetCode !== filter.assetCode) return false;
    }
  }

  if (filter.from) {
    if (e.from !== filter.from && e.source !== filter.from) return false;
  }

  if (filter.minAmount) {
    const eventStroops = tryToStroops(String(e.amount ?? e.value ?? '0'));
    const minStroops = tryToStroops(filter.minAmount);
    if (eventStroops !== null && minStroops !== null) {
      if (eventStroops < minStroops) return false;
    } else {
      return false;
    }
  }

  if (filter.contractId) {
    if (e.contractId !== filter.contractId) return false;
  }

  if (filter.eventTopics?.length) {
    const eventTopics = (e.topics as string[]) ?? [];
    if (!filter.eventTopics.some((t) => eventTopics.includes(t))) return false;
  }

  return true;
}

/**
 * TriggerManager - handles event-driven automation.
 */
export class TriggerManager {
  private triggers: Map<string, Trigger> = new Map();
  private agent: PayFiAgent;
  private paymentListenerHandle?: any;
  private contractListenerHandles: Map<string, any> = new Map();
  private storageWatcherHandles: Map<string, any> = new Map();

  constructor(agent: PayFiAgent) {
    this.agent = agent;
  }

  /**
   * Load triggers from database and start listening.
   */
  async start(): Promise<void> {
    const loaded = await loadTriggers();
    for (const trigger of loaded) {
      this.triggers.set(trigger.id, trigger);
    }
    log.info({ count: this.triggers.size }, 'Triggers loaded');

    // Set up listeners
    this.setupPaymentListener();
    this.setupContractListener();
    this.setupStorageListener();
  }

  private setupPaymentListener(): void {
    this.paymentListenerHandle = this.agent.startListening('trigger', async (challenge, rawPayment) => {
      const payment = {
        assetCode: challenge.assetCode,
        assetIssuer: challenge.assetIssuer,
        from: challenge.payTo, // Incoming payment
        amount: challenge.amount,
      };

      // Generate event ID from on-chain payment data (tx hash + op index)
      const eventId = generatePaymentEventId(rawPayment);

      for (const [id, trigger] of this.triggers) {
        if (!trigger.enabled || trigger.source !== 'payment') continue;
        if (!matchesFilter(payment, trigger.filter)) continue;

        // Dedupe by on-chain event ID (immutable, network-controlled)
        const isNew = await recordTriggerFired(id, eventId);
        if (!isNew) continue;

        // Check spending limit before execution
        const p = trigger.task.payload as Record<string, unknown>;
        if (p.amount) {
          const limitStroops = tryToStroops(config.AGENT_SPENDING_LIMIT);
          const amountStroops = tryToStroops(String(p.amount));
          if (amountStroops !== null && limitStroops !== null && amountStroops > limitStroops) {
            log.warn({ triggerId: id, amount: String(p.amount) }, 'Trigger exceeds spending limit');
            continue;
          }
        }

        log.info({ triggerId: id, eventId }, 'Trigger firing');
        await this.agent.run(trigger.task);

        // Update last fired
        trigger.lastFiredAt = new Date().toISOString();
        await saveTrigger(trigger);
      }
    });
  }

  private setupContractListener(): void {
    // Contract events are set up per-contract
    this.contractListenerHandles = new Map<string, any>();

    // Override agent's startContractListener to integrate with triggers
    const originalStartContractListener = this.agent.startContractListener.bind(this.agent);
    this.agent.startContractListener = async (
      contractId: string,
      eventTypes: string[],
      onEvent: (event: any) => void,
    ) => {
      if (this.contractListenerHandles.has(contractId)) {
        return; // Already listening to this contract
      }

      const handle = listenContractEvents(contractId, eventTypes, async (event) => {
        const eventId = generateContractEventId(event);
        for (const [id, trigger] of this.triggers) {
          if (!trigger.enabled || trigger.source !== 'contract_event') continue;
          if (!trigger.filter.contractId || trigger.filter.contractId !== contractId) continue;
          if (trigger.filter.eventTopics?.length) {
            const eventTopics = (event.topic as string[]) ?? [];
            if (!trigger.filter.eventTopics.some((t) => eventTopics.includes(t))) continue;
          }

          const isNew = await recordTriggerFired(id, eventId);
          if (!isNew) continue;

          log.info({ triggerId: id, eventId, contractId }, 'Trigger firing from contract event');
          await this.agent.run(trigger.task);

          // Update last fired
          trigger.lastFiredAt = new Date().toISOString();
          await saveTrigger(trigger);
        }
        onEvent(event);
      });

      this.contractListenerHandles.set(contractId, handle);
    };

    // Override stopContractListener
    const originalStopContractListener = this.agent.stopContractListener.bind(this.agent);
    this.agent.stopContractListener = async () => {
      for (const [contractId, handle] of this.contractListenerHandles) {
        if (handle && typeof handle === 'function') {
          handle();
        } else if (handle?.stop) {
          handle.stop();
        }
      }
      this.contractListenerHandles.clear();
      originalStopContractListener();
    };
  }

  private setupStorageListener(): void {
    // Storage changes are set up per-contract
    this.storageWatcherHandles = new Map<string, any>();

    // Override agent's startStorageWatcher to integrate with triggers
    const originalStartStorageWatcher = this.agent.startStorageWatcher.bind(this.agent);
    this.agent.startStorageWatcher = (
      options: any,
      onChange: (change: StorageChangeEvent) => void,
    ) => {
      const contractId = options.contractId;
      if (this.storageWatcherHandles.has(contractId)) {
        return; // Already watching this contract
      }

      const watcher = watchContractStorage(options);
      watcher.on('change', async (change: StorageChangeEvent) => {
        const eventId = generateStorageChangeEventId(change);
        for (const [id, trigger] of this.triggers) {
          if (!trigger.enabled || trigger.source !== 'storage_change') continue;
          if (trigger.filter.storageKey && trigger.filter.storageKey !== change.keyXdr) continue;

          const isNew = await recordTriggerFired(id, eventId);
          if (!isNew) continue;

          log.info({ triggerId: id, eventId, contractId }, 'Trigger firing from storage change');
          await this.agent.run(trigger.task);

          // Update last fired
          trigger.lastFiredAt = new Date().toISOString();
          await saveTrigger(trigger);
        }
        onChange(change);
      });

      this.storageWatcherHandles.set(contractId, watcher);
    };

    // Override stopStorageWatcher
    const originalStopStorageWatcher = this.agent.stopStorageWatcher.bind(this.agent);
    this.agent.stopStorageWatcher = async () => {
      for (const [contractId, watcher] of this.storageWatcherHandles) {
        if (watcher?.stop) {
          watcher.stop();
        }
      }
      this.storageWatcherHandles.clear();
      originalStopStorageWatcher();
    };
  }

  /**
   * Create a new trigger.
   * 
   * @throws Error if task type is not valid or value-moving task is not enabled
   */
  async createTrigger(options: {
    source: TriggerSource;
    filter: TriggerFilter;
    task: AgentTask;
  }): Promise<Trigger> {
    const { source, filter, task } = options;

    // Validate task type is supported
    if (!VALID_TRIGGER_TASK_TYPES.has(task.type)) {
      throw new Error(
        `Invalid task type "${task.type}" for trigger. Must be one of: ${Array.from(VALID_TRIGGER_TASK_TYPES).join(', ')}`,
      );
    }

    // Value-moving tasks require explicit permission
    if (isValueMovingTask(task.type)) {
      if (config.TRIGGER_ALLOW_PAYMENTS !== true) {
        throw new Error(
          'Value-moving triggers are disabled. Set TRIGGER_ALLOW_PAYMENTS=true to enable.',
        );
      }

      log.warn(
        { triggerSource: source, taskType: task.type },
        'Value-moving trigger created — payments enabled',
      );
    }

    const trigger: Trigger = {
      id: `trig_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      source,
      filter,
      task,
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    this.triggers.set(trigger.id, trigger);
    await saveTrigger(trigger);

    log.info({ triggerId: trigger.id, source: trigger.source, taskType: trigger.task.type }, 'Trigger created');
    return trigger;
  }

  /**
   * Enable/disable a trigger.
   */
  async setTriggerEnabled(id: string, enabled: boolean): Promise<void> {
    const trigger = this.triggers.get(id);
    if (!trigger) throw new Error(`Trigger not found: ${id}`);

    trigger.enabled = enabled;
    await saveTrigger(trigger);
    log.info({ triggerId: id, enabled }, 'Trigger updated');
  }

  /**
   * Delete a trigger.
   */
  async deleteTrigger(id: string): Promise<void> {
    this.triggers.delete(id);
    await getStorage().deleteTrigger(id);
    log.info({ triggerId: id }, 'Trigger deleted');
  }

  /**
   * Get all triggers.
   */
  getTriggers(): Trigger[] {
    return Array.from(this.triggers.values());
  }

  /**
   * Handle contract event and fire matching triggers.
   */
  private async handleContractEvent(contractId: string, event: any, triggers: Trigger[]): Promise<void> {
    const e = {
      contractId,
      topics: (event.topic ?? []).map((t: any) => t.toString()),
      value: event.value?.toXDR?.('base64') ?? event.value ?? null,
      ledger: event.ledger,
    };

    for (const trigger of triggers) {
      if (!trigger.enabled || trigger.filter.contractId !== contractId) continue;
      if (!matchesFilter(e, trigger.filter)) continue;

      // Dedupe by event ID (contract event ID)
      const eventId = event.id;
      const isNew = await recordTriggerFired(trigger.id, eventId);
      if (!isNew) continue;

      log.info({ triggerId: trigger.id, eventId }, 'Contract event trigger firing');
      await this.agent.run(trigger.task);

      // Update last fired
      trigger.lastFiredAt = new Date().toISOString();
      await saveTrigger(trigger);
    }
  }

  /**
   * Handle storage change and fire matching triggers.
   */
  private async handleStorageChange(contractId: string, change: any): Promise<void> {
    const e = {
      contractId,
      storageKey: change.keyXdr,
      oldValue: change.oldValue,
      newValue: change.newValue,
      ledger: change.ledger,
    };

    for (const [id, trigger] of this.triggers) {
      if (!trigger.enabled || trigger.source !== 'storage_change') continue;
      if (trigger.filter.contractId !== contractId) continue;
      if (trigger.filter.storageKey && trigger.filter.storageKey !== change.keyXdr) continue;

      // Dedupe by ledger + key
      const eventId = `${e.ledger ?? 'unknown'}:${change.keyXdr}`;
      const isNew = await recordTriggerFired(id, eventId);
      if (!isNew) continue;

      log.info({ triggerId: id, eventId }, 'Storage change trigger firing');
      await this.agent.run(trigger.task);

      // Update last fired
      trigger.lastFiredAt = new Date().toISOString();
      await saveTrigger(trigger);
    }
  }

  /**
   * Stop all listeners and cleanup.
   */
  stop(): void {
    this.agent.stopListening();
    this.agent.stopContractListener();
    this.agent.stopStorageWatcher();
    
    // Stop contract event watchers
    if (this.unlistenContract) {
      this.unlistenContract();
    }
    
    // Stop storage watchers
    if (this.unlistenStorage) {
      this.unlistenStorage();
    }
    
    this.triggers.clear();
    this.contractWatchers.clear();
    this.storageWatchers.clear();
    log.info('TriggerManager stopped');
  }
}


