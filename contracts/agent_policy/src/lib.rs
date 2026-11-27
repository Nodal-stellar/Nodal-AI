/*!
 * contracts/agent_policy/src/lib.rs
 *
 * Agent Spending-Policy Account — Soroban (Stellar) — PROTOTYPE (issue #813)
 *
 * A custom account contract that holds the agent's funds and only lets the
 * agent's ed25519 key spend up to `limit` token units per rolling `window`
 * seconds. The limit lives in `__check_auth`, so it is enforced by the
 * network itself: a stolen agent key or a compromised Node process cannot
 * exceed it. See docs/design/onchain-policy.md for the design rationale and
 * the OpenZeppelin smart-account comparison.
 *
 * Lifecycle:
 *   1. `init`       — owner deploys + configures (agent key, token, limit, window)
 *   2. agent signs  — any tx that needs this account's auth runs `__check_auth`
 *   3. `set_policy` — owner (separate key) can raise/lower the limit
 *
 * Security invariants:
 *   - Every authorised value-moving call (`transfer`, `transfer_from`,
 *     `approve`, `burn`, `burn_from`) on the policy token is counted against
 *     the current window; the window total never exceeds `limit`.
 *   - Value-moving calls on any other token are rejected (deny by default).
 *   - The agent key can never authorise calls to this contract itself, nor
 *     contract deployments, so it cannot rewrite its own policy.
 *   - Only `owner` can change the policy.
 */

#![cfg_attr(not(test), no_std)]
#![allow(unexpected_cfgs)]

use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    BytesN, Env, Symbol, TryIntoVal, Val, Vec,
};

/// Owner can withdraw funds from the contract account without spending limits.
/// This provides a recovery path if the agent key is lost.
#[contractimpl]
impl AgentPolicyAccount {
    pub fn owner_withdraw(env: Env, to: Address, amount: i128) {
        // Load the stored owner address.
        let owner: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Owner)
            .expect("owner not set");
        // Require explicit auth from the owner.
        owner.require_auth();
        // Load the token address used for spending.
        let token: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Token)
            .expect("token not set");
        // Transfer the requested amount from this contract to the destination.
        token.transfer(&env.current_contract_address(), &to, &amount);
    }
}

// ─── Storage keys ─────────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    AgentKey,
    Owner,
    Token,
    Limit,
    Window,
    WindowStart,
    Spent,
    Allowlist,
}

// ─── Policy State ─────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AllowlistEntry {
    pub contract: Address,
    pub fn_name: Symbol,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyState {
    // NOTE: This struct is part of the `agent_policy` crate which should be included in the workspace defined at `contracts/Cargo.toml`.

    pub owner: Address,
    pub agent_key: BytesN<32>,
    pub token: Address,
    pub limit: i128,
    pub window: u64,
    pub window_start: u64,
    pub spent: i128,
    pub allowlist: Vec<AllowlistEntry>,
}

// ─── Contract Errors ──────────────────────────────────────────────────────────

/// Errors that can be returned by the policy account.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum PolicyError {
    /// The account has already been initialised.
    AlreadyInitialized = 1,
    /// The account has not been initialised yet.
    NotInitialized = 2,
    /// `limit` must be positive and `window` non-zero.
    InvalidPolicy = 3,
    /// The spend would push the current window over `limit`.
    OverLimit = 4,
    /// The agent key is not allowed to authorise this call.
    ForbiddenContext = 5,
    /// The call is not present in the owner-managed allowlist.
    NotAllowlisted = 6,
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct AgentPolicyAccount;

const INSTANCE_TTL_THRESHOLD: u32 = 100_000;
const INSTANCE_TTL_EXTEND_TO: u32 = 200_000;

#[contractimpl]
impl AgentPolicyAccount {
    /// Configure the account.
    ///
    /// # Arguments
    /// * `agent_key` - ed25519 public key the Node agent signs with.
    /// * `owner`     - Separate (ideally cold / multisig) address that may change the policy.
    /// * `token`     - SAC token the limit applies to.
    /// * `limit`     - Maximum token units spendable per window.
    /// * `window`    - Window length in seconds.
    ///
    /// # Panics
    /// * `AlreadyInitialized` - If called twice.
    /// * `InvalidPolicy` - If `limit <= 0` or `window == 0`.
    pub fn init(
        env: Env,
        agent_key: BytesN<32>,
        owner: Address,
        token: Address,
        limit: i128,
        window: u64,
    ) {
        if env.storage().instance().has(&DataKey::AgentKey) {
            panic_with_error!(&env, PolicyError::AlreadyInitialized);
        }
        owner.require_auth();
        if limit <= 0 || window == 0 {
            panic_with_error!(&env, PolicyError::InvalidPolicy);
        }

        let now = env.ledger().timestamp();
        env.storage().instance().set(&DataKey::AgentKey, &agent_key);
        env.storage().instance().set(&DataKey::Owner, &owner);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::Limit, &limit);
        env.storage().instance().set(&DataKey::Window, &window);
        env.storage().instance().set(&DataKey::WindowStart, &now);
        env.storage().instance().set(&DataKey::Spent, &0i128);
        env.storage().instance().set(&DataKey::Allowlist, &Vec::<AllowlistEntry>::new(&env));
        Self::extend_instance_ttl(&env);

        env.events().publish(
            (
                Symbol::new(&env, "policy"),
                Symbol::new(&env, "initialized"),
            ),
            (owner, token, limit, window),
        );
    }

    /// Change the spending limit and window. Only callable by the owner.
    ///
    /// The amount already spent in the current window is kept, so lowering
    /// the limit takes effect immediately.
    ///
    /// # Panics
    /// * `NotInitialized` - If called before `init`.
    /// * `InvalidPolicy` - If `limit <= 0` or `window == 0`.
    pub fn set_policy(env: Env, limit: i128, window: u64) {
        let owner = Self::owner(&env);
        owner.require_auth();
        if limit <= 0 || window == 0 {
            panic_with_error!(&env, PolicyError::InvalidPolicy);
        }
        env.storage().instance().set(&DataKey::Limit, &limit);
        env.storage().instance().set(&DataKey::Window, &window);

        env.events().publish(
            (Symbol::new(&env, "policy"), Symbol::new(&env, "updated")),
            (limit, window),
        );
    }

    /// Replace the non-token contract-call allowlist. Token value calls remain
    /// governed by the configured token and spending limit.
    pub fn set_allowlist(env: Env, entries: Vec<AllowlistEntry>) {
        let owner = Self::owner(&env);
        owner.require_auth();
        env.storage().instance().set(&DataKey::Allowlist, &entries);
        Self::extend_instance_ttl(&env);
        env.events().publish(
            (Symbol::new(&env, "policy"), Symbol::new(&env, "allowlist_set")),
            entries,
        );
    }

    /// Add one contract/function pair to the allowlist.
    pub fn allow(env: Env, contract: Address, fn_name: Symbol) {
        let owner = Self::owner(&env);
        owner.require_auth();
        let mut entries: Vec<AllowlistEntry> = env.storage().instance().get(&DataKey::Allowlist).unwrap_or(Vec::new(&env));
        if !entries.iter().any(|entry| entry.contract == contract && entry.fn_name == fn_name) {
            entries.push_back(AllowlistEntry { contract: contract.clone(), fn_name: fn_name.clone() });
            env.storage().instance().set(&DataKey::Allowlist, &entries);
        }
        Self::extend_instance_ttl(&env);
        env.events().publish(
            (Symbol::new(&env, "policy"), Symbol::new(&env, "allowlist_added")),
            (contract, fn_name),
        );
    }

    /// Remove one contract/function pair from the allowlist.
    pub fn disallow(env: Env, contract: Address, fn_name: Symbol) {
        let owner = Self::owner(&env);
        owner.require_auth();
        let entries: Vec<AllowlistEntry> = env.storage().instance().get(&DataKey::Allowlist).unwrap_or(Vec::new(&env));
        let mut retained = Vec::new(&env);
        for entry in entries.iter() {
            if entry.contract != contract || entry.fn_name != fn_name { retained.push_back(entry); }
        }
        env.storage().instance().set(&DataKey::Allowlist, &retained);
        Self::extend_instance_ttl(&env);
        env.events().publish(
            (Symbol::new(&env, "policy"), Symbol::new(&env, "allowlist_removed")),
            (contract, fn_name),
        );
    }

    /// Return the configured non-token contract-call allowlist.
    pub fn get_allowlist(env: Env) -> Vec<AllowlistEntry> {
        Self::owner(&env);
        env.storage().instance().get(&DataKey::Allowlist).unwrap_or(Vec::new(&env))
    }

    /// Extend the instance storage TTL. Anyone may call this maintenance method.
    pub fn bump(env: Env) {
        Self::owner(&env);
        Self::extend_instance_ttl(&env);
    }

    /// Return the current policy and window accounting.
    ///
    /// # Panics
    /// * `NotInitialized` - If called before `init`.
    pub fn get_policy(env: Env) -> PolicyState {
        PolicyState {
            owner: Self::owner(&env),
            agent_key: env
                .storage()
                .instance()
                .get(&DataKey::AgentKey)
                .expect("policy: state corrupted"),
            token: env
                .storage()
                .instance()
                .get(&DataKey::Token)
                .expect("policy: state corrupted"),
            limit: env
                .storage()
                .instance()
                .get(&DataKey::Limit)
                .expect("policy: state corrupted"),
            window: env
                .storage()
                .instance()
                .get(&DataKey::Window)
                .expect("policy: state corrupted"),
            window_start: env
                .storage()
                .instance()
                .get(&DataKey::WindowStart)
                .expect("policy: state corrupted"),
            spent: env
                .storage()
                .instance()
                .get(&DataKey::Spent)
                .expect("policy: state corrupted"),
            allowlist: env.storage().instance().get(&DataKey::Allowlist).unwrap_or(Vec::new(&env)),
        }
    }

    // ─── Internal helpers ────────────────────────────────────────────────────

    fn extend_instance_ttl(env: &Env) {
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
    }

    fn owner(env: &Env) -> Address {
        match env.storage().instance().get(&DataKey::Owner) {
            Some(owner) => owner,
            None => panic_with_error!(env, PolicyError::NotInitialized),
        }
    }

    /// Amount moved out of this account by a token call, or `None` when the
    /// function does not move value. The argument index follows the SEP-41
    /// token interface.
    fn spend_amount(env: &Env, fn_name: &Symbol, args: &Vec<Val>) -> Option<i128> {
        let index: u32 = if *fn_name == symbol_short!("burn") {
            1
        } else if *fn_name == symbol_short!("transfer")
            || *fn_name == symbol_short!("approve")
            || *fn_name == symbol_short!("burn_from")
        {
            2
        } else if *fn_name == Symbol::new(env, "transfer_from") {
            3
        } else {
            return None;
        };
        // A malformed argument list is treated as an unbounded spend so it
        // can never slip past the limit.
        Some(
            args.get(index)
                .and_then(|v| v.try_into_val(env).ok())
                .unwrap_or(i128::MAX),
        )
    }
}

#[contractimpl]
impl CustomAccountInterface for AgentPolicyAccount {
    type Signature = BytesN<64>;
    type Error = PolicyError;

    /// Authenticate the agent signature, then enforce the spending policy over
    /// every invocation being authorised.
    #[allow(non_snake_case)]
    fn __check_auth(
        env: Env,
        signature_payload: BytesN<32>,
        signature: BytesN<64>,
        auth_contexts: Vec<Context>,
    ) -> Result<(), PolicyError> {
        let agent_key: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::AgentKey)
            .ok_or(PolicyError::NotInitialized)?;
        // Panics (rejecting the tx) if the signature is not from the agent key.
        env.crypto()
            .ed25519_verify(&agent_key, &signature_payload.into(), &signature);

        let token: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(PolicyError::NotInitialized)?;
        let self_address = env.current_contract_address();

        let mut total: i128 = 0;
        for context in auth_contexts.iter() {
            let call = match context {
                Context::Contract(call) => call,
                // The agent key may not deploy contracts on the account's behalf.
                Context::CreateContractHostFn(_) => return Err(PolicyError::ForbiddenContext),
            };
            // The agent key may never call this account directly (e.g. to
            // reconfigure it); policy changes go through `owner`.
            if call.contract == self_address {
                return Err(PolicyError::ForbiddenContext);
            }
            if let Some(amount) = Self::spend_amount(&env, &call.fn_name, &call.args) {
                // Deny value movement of any asset the policy does not cover.
                if call.contract != token || amount < 0 {
                    return Err(PolicyError::ForbiddenContext);
                }
                total = total.checked_add(amount).ok_or(PolicyError::OverLimit)?;
            } else if call.contract != token {
                let allowlist: Vec<AllowlistEntry> = env.storage().instance().get(&DataKey::Allowlist).unwrap_or(Vec::new(&env));
                if !allowlist.iter().any(|entry| entry.contract == call.contract && entry.fn_name == call.fn_name) {
                    return Err(PolicyError::NotAllowlisted);
                }
            }
        }

        if total == 0 {
            Self::extend_instance_ttl(&env);
            return Ok(());
        }

        let frozen: bool = env
            .storage()
            .instance()
            .get(&DataKey::Frozen)
            .ok_or(PolicyError::NotInitialized)?;
        if frozen {
            return Err(PolicyError::Frozen);
        }

        let limit: i128 = env
            .storage()
            .instance()
            .get(&DataKey::Limit)
            .ok_or(PolicyError::NotInitialized)?;
        let window: u64 = env
            .storage()
            .instance()
            .get(&DataKey::Window)
            .ok_or(PolicyError::NotInitialized)?;
        let mut window_start: u64 = env
            .storage()
            .instance()
            .get(&DataKey::WindowStart)
            .ok_or(PolicyError::NotInitialized)?;
        let mut spent: i128 = env
            .storage()
            .instance()
            .get(&DataKey::Spent)
            .ok_or(PolicyError::NotInitialized)?;

        // Fixed (tumbling) window: once it has elapsed, start a new one.
        let now = env.ledger().timestamp();
        if now >= window_start.saturating_add(window) {
            window_start = now;
            spent = 0;
        }

        let new_spent = spent.checked_add(total).ok_or(PolicyError::OverLimit)?;
        if new_spent > limit {
            return Err(PolicyError::OverLimit);
        }

        env.storage()
            .instance()
            .set(&DataKey::WindowStart, &window_start);
        env.storage().instance().set(&DataKey::Spent, &new_spent);
        Self::extend_instance_ttl(&env);
        Ok(())
    }
}

#[cfg(test)]
mod test;
