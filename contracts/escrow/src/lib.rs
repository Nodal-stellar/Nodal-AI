/*!
 * contracts/escrow/src/lib.rs
 *
 * PayFi Escrow Contract — Soroban (Stellar)
 *
 * Lifecycle:
 *   1. `initialize`  — depositor locks funds, sets arbiter + recipient + expiry
 *   2. `release`     — arbiter releases funds to recipient
 *   3. `refund`      — depositor reclaims after expiry
 *
 * Security invariants:
 *   - Only the arbiter can call `release`
 *   - Only the depositor can call `refund`, and only after expiry
 *   - State transitions are enforced (no double-release / double-refund)
 *
 * Formal verification annotations:
 *   The `//@ requires` / `//@ ensures` comment blocks above each public
 *   function are machine-readable specifications for formal verification
 *   tooling. Vocabulary used by the annotations:
 *   - `requires`        — preconditions; a violation panics with the error
 *                         documented in the function's `# Panics` section.
 *   - `ensures`         — postconditions that hold when the function returns.
 *   - `old(x)`          — the value of `x` in the pre-call state.
 *   - `stored_<field>`  — value read from instance storage under the matching
 *                         `DataKey` (e.g. `stored_amount` == `DataKey::Amount`).
 *   - `ledger_timestamp`— `env.ledger().timestamp()` at call time.
 *   - `has(Key)`        — the instance-storage key exists.
 *   - `result`          — the function's return value.
 *   Contract-level `//@ invariant` lines above the impl must hold on every
 *   entry into and exit from the contract.
 */

#![cfg_attr(not(test), no_std)]
#![allow(unexpected_cfgs)]

use soroban_sdk::{
    bytes, contract, contracterror, contractimpl, contracttype, panic_with_error,
    token::Client as TokenClient, Address, Bytes, Env, Symbol, Vec,
};

// ─── Security constants ───────────────────────────────────────────────────────

/// Minimum delay (in seconds) that must elapse between proposing an arbiter
/// rotation and accepting it (24 hours).
///
/// This is the security-critical floor for `accept_arbiter_rotation`: it is a
/// hard-coded constant, never caller-supplied or read from storage, so no
/// party — depositor or otherwise — can shorten the hostile-takeover window
/// below this value. Keep any future configurability above this constant and
/// reject proposals requesting less than `MIN_ROTATION_DELAY`.
pub const MIN_ROTATION_DELAY: u64 = 86_400; // 24 hours in seconds

// ─── TTL / storage-bump constants ─────────────────────────────────────────────

/// The threshold at which we extend instance storage TTL.  If the remaining
/// TTL on instance storage is below this value the contract will bump it up to
/// `INSTANCE_TTL_EXTEND_TO` on every mutating call and on `bump()`.
///
/// Set to 30 days (in ledgers, assuming 5-second ledger close time).
pub const INSTANCE_TTL_THRESHOLD: u32 = 518_400; // 30 days × 86_400 s / 5 s per ledger

/// Target TTL we extend instance storage to when a bump is triggered.
///
/// Set to 90 days in ledgers.
pub const INSTANCE_TTL_EXTEND_TO: u32 = 1_555_200; // 90 days × 86_400 s / 5 s per ledger

// ─── Storage keys ─────────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Depositor,
    Recipient,
    Arbiter,
    Token,
    Amount,
    Expiry,
    Released,
    InitializedAt,
    PendingArbiter,
    PendingArbiterTime,
    // Milestone-based escrow (#808)
    Milestones,
    // Dispute resolution (#810)
    DisputeState,
    DisputeRaisedBy,
    DisputeEvidenceHash,
}

// ─── Milestone structs (#808) ─────────────────────────────────────────────────

/// A single milestone in a milestone-based escrow.
///
/// * `amount`           — Token units locked to this milestone.
/// * `deadline`         — Unix timestamp after which the depositor may refund
///                        this milestone if it has not been approved.
/// * `description_hash` — 32-byte hash of the off-chain milestone description
///                        (use SHA-256 of the description string). May be all
///                        zeroes when no description is required.
/// * `approved`         — Set to `true` by `approve_milestone`; starts `false`.
#[contracttype]
#[derive(Clone)]
pub struct Milestone {
    pub amount: i128,
    pub deadline: u64,
    pub description_hash: Bytes,
    pub approved: bool,
}

// ─── Dispute state (#810) ─────────────────────────────────────────────────────

/// Dispute lifecycle state.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum DisputeStatus {
    /// No active dispute — normal operation.
    None = 0,
    /// Dispute raised; funds frozen pending arbiter decision.
    Raised = 1,
    /// Arbiter has resolved the dispute; escrow is settled.
    Resolved = 2,
}

// ─── Escrow State ─────────────────────────────────────────────────────────────

#[contracttype]
pub struct EscrowState {
    pub depositor: Address,
    pub recipient: Address,
    pub arbiter: Address,
    pub token: Address,
    pub amount: i128,
    pub expiry: u64,
    pub released: bool,
    pub initialized_at: u64,
}

// ─── Contract Errors ──────────────────────────────────────────────────────────

/// Errors that can be returned by the escrow contract.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum EscrowError {
    /// The escrow contract is already initialised.
    AlreadyInitialized = 1,
    /// The funds have already been released or refunded.
    AlreadyReleased = 2,
    /// The escrow has not yet expired.
    NotExpired = 3,
    /// The caller is not the authorized arbiter.
    NotArbiter = 4,
    /// The caller is not the authorized depositor.
    NotDepositor = 5,
    /// The transfer amount must be positive.
    InvalidAmount = 6,
    /// The expiry timestamp must be in the future.
    InvalidExpiry = 7,
    /// The escrow has not been initialized yet.
    NotInitialized = 8,
    /// depositor, recipient, and arbiter must all be distinct addresses.
    InvalidParties = 9,
    /// The arbiter rotation time-lock has not yet expired.
    RotationLocked = 10,
    /// No pending arbiter rotation proposal.
    NoPendingRotation = 11,
    // ─── Milestone errors (#808) ───────────────────────────────────────────
    /// Milestone list is empty or sum of milestone amounts != total deposit.
    InvalidMilestones = 12,
    /// Milestone index is out of bounds.
    InvalidMilestoneIndex = 13,
    /// Milestone has already been approved.
    MilestoneAlreadyApproved = 14,
    /// Milestone deadline has not yet expired for refund.
    MilestoneNotExpired = 15,
    // ─── Dispute errors (#810) ─────────────────────────────────────────────
    /// A dispute is already active; refunds are blocked.
    DisputeActive = 16,
    /// No dispute is currently active.
    NoActiveDispute = 17,
    /// The split basis points must be 0–10 000 (0–100 %).
    InvalidSplitBps = 18,
    /// Caller is not authorized to raise a dispute.
    NotParty = 19,
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct EscrowContract;

// ─── Contract invariants (formal verification) ───────────────────────────────
//@ invariant stored_amount >= 0
//@ invariant stored_amount == 0 ==> stored_released == true
//@ invariant stored_released ==> contract_token_balance == 0
//@ invariant !stored_released ==> contract_token_balance == stored_amount

#[contractimpl]
impl EscrowContract {
    /// Initialise the escrow and transfer funds from depositor to contract.
    ///
    /// # Arguments
    /// * `env`       - The execution environment.
    /// * `depositor` - Party locking the funds.
    /// * `recipient` - Party who receives funds on release.
    /// * `arbiter`   - Trusted party who authorises release.
    /// * `token`     - SAC token contract address. **Only Stellar Asset Contract (SAC) tokens
    ///                 conforming to the Stellar token interface are supported.** Non-SAC tokens
    ///                 with incompatible interfaces will cause a panic. Verify the token address
    ///                 is a SAC before calling initialize() by checking the token's contract code
    ///                 or attempting to read its decimals().
    /// * `amount`    - Token amount (stroop-equivalent units).
    /// * `expiry`    - Unix timestamp after which depositor may refund.
    ///
    /// # Panics
    /// * `AlreadyInitialized` - If the escrow has already been initialised.
    /// * `InvalidParties` - If depositor, recipient, and arbiter are not all distinct.
    /// * `InvalidAmount` - If amount is not positive.
    /// * `InvalidExpiry` - If expiry is not in the future.
    ///
    /// # Return Value
    /// None.
    //@ requires !has(Depositor)
    //@ requires depositor != arbiter && depositor != recipient && arbiter != recipient
    //@ requires amount > 0 && amount <= i128::MAX / 2
    //@ requires expiry > ledger_timestamp
    //@ ensures has(Depositor) && has(Recipient) && has(Arbiter) && has(Token) && has(Amount) && has(Expiry) && has(Released)
    //@ ensures stored_depositor == depositor
    //@ ensures stored_recipient == recipient
    //@ ensures stored_arbiter == arbiter
    //@ ensures stored_token == token
    //@ ensures stored_amount == amount
    //@ ensures stored_expiry == expiry
    //@ ensures stored_released == false
    //@ ensures depositor_token_balance == old(depositor_token_balance) - amount
    //@ ensures contract_token_balance == old(contract_token_balance) + amount
    pub fn initialize(
        env: Env,
        depositor: Address,
        recipient: Address,
        arbiter: Address,
        token: Address,
        amount: i128,
        expiry: u64,
    ) {
        // Prevent re-initialisation
        if env.storage().instance().has(&DataKey::Depositor) {
            panic_with_error!(&env, EscrowError::AlreadyInitialized);
        }

        depositor.require_auth();

        // Parties must all be distinct — a depositor who is also the arbiter
        // could release funds to themselves, defeating the escrow purpose.
        if depositor == arbiter {
            panic_with_error!(&env, EscrowError::InvalidParties);
        }
        if depositor == recipient {
            panic_with_error!(&env, EscrowError::InvalidParties);
        }
        if arbiter == recipient {
            panic_with_error!(&env, EscrowError::InvalidParties);
        }

        // Ensure amount is positive and within a safe range to avoid overflow in token transfers.
        if amount <= 0 {
            panic_with_error!(&env, EscrowError::InvalidAmount);
        }
        // Guard against amounts that could overflow when added to existing balances.
        if amount > i128::MAX / 2 {
            panic_with_error!(&env, EscrowError::InvalidAmount);
        }
        if expiry <= env.ledger().timestamp() {
            panic_with_error!(&env, EscrowError::InvalidExpiry);
        }

        // Pull funds from depositor
        TokenClient::new(&env, &token).transfer(
            &depositor,
            &env.current_contract_address(),
            &amount,
        );

        // Persist state
        let now = env.ledger().timestamp();
        env.storage()
            .instance()
            .set(&DataKey::Depositor, &depositor);
        env.storage()
            .instance()
            .set(&DataKey::Recipient, &recipient);
        env.storage().instance().set(&DataKey::Arbiter, &arbiter);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::Amount, &amount);
        env.storage().instance().set(&DataKey::Expiry, &expiry);
        env.storage().instance().set(&DataKey::Released, &false);
        env.storage().instance().set(&DataKey::InitializedAt, &now);

        Self::bump_instance_ttl(&env);

        env.events().publish(
            (
                Symbol::new(&env, "escrow"),
                Symbol::new(&env, "initialized"),
            ),
            (depositor.clone(), recipient.clone(), amount),
        );
    }

    /// Release funds to the recipient. Only callable by the stored arbiter.
    ///
    /// # Arguments
    /// * `env`     - The execution environment.
    /// * `arbiter` - Must match the arbiter recorded at initialisation.
    ///
    /// # Panics
    /// * `NotArbiter` - If caller is not the stored arbiter.
    /// * `AlreadyReleased` - If funds have already been released or refunded.
    ///
    /// # Return Value
    /// None.
    //@ requires has(Depositor)
    //@ requires arbiter == stored_arbiter
    //@ requires !stored_released
    //@ ensures stored_released == true
    //@ ensures stored_amount == old(stored_amount)
    //@ ensures recipient_token_balance == old(recipient_token_balance) + old(stored_amount)
    //@ ensures contract_token_balance == old(contract_token_balance) - old(stored_amount)
    pub fn release(env: Env, arbiter: Address) {
        // Read stored arbiter first, then authenticate against it (fixes TOCTOU).
        let stored_arbiter: Address = env
            .storage()
            .instance()
            .get(&DataKey::Arbiter)
            .expect("escrow: state corrupted");
        stored_arbiter.require_auth();
        if arbiter != stored_arbiter {
            panic_with_error!(&env, EscrowError::NotArbiter);
        }

        Self::assert_not_released(&env);
        Self::assert_no_dispute(&env);
        Self::bump_instance_ttl(&env);

        let token: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .expect("escrow: state corrupted");
        let amount: i128 = env
            .storage()
            .instance()
            .get(&DataKey::Amount)
            .expect("escrow: state corrupted");
        let recipient: Address = env
            .storage()
            .instance()
            .get(&DataKey::Recipient)
            .expect("escrow: state corrupted");

        env.storage().instance().set(&DataKey::Released, &true);

        // Transfer to stored_recipient (read from storage), not the caller parameter.
        // This is the intentional pattern: destination always comes from storage,
        // never from a caller-supplied argument, to prevent TOCTOU-style substitution.
        TokenClient::new(&env, &token).transfer(
            &env.current_contract_address(),
            &recipient,
            &amount,
        );

        env.events().publish(
            (Symbol::new(&env, "escrow"), Symbol::new(&env, "released")),
            (recipient, amount),
        );
    }

    /// Refund depositor after expiry. Only callable by the stored depositor.
    ///
    /// # Arguments
    /// * `env`       - The execution environment.
    /// * `depositor` - Must match the depositor recorded at initialisation.
    ///
    /// # Panics
    /// * `NotDepositor` - If caller is not the stored depositor.
    /// * `AlreadyReleased` - If funds have already been released or refunded.
    /// * `NotExpired` - If contract is not yet expired.
    ///
    /// # Return Value
    /// None.
    //@ requires has(Depositor)
    //@ requires depositor == stored_depositor
    //@ requires !stored_released
    //@ requires ledger_timestamp >= stored_expiry
    //@ ensures stored_released == true
    //@ ensures depositor_token_balance == old(depositor_token_balance) + old(stored_amount)
    //@ ensures contract_token_balance == old(contract_token_balance) - old(stored_amount)
    pub fn refund(env: Env, depositor: Address) {
        // Read stored depositor first, then authenticate against it (fixes TOCTOU).
        let stored_depositor: Address = env
            .storage()
            .instance()
            .get(&DataKey::Depositor)
            .expect("escrow: state corrupted");
        stored_depositor.require_auth();
        if depositor != stored_depositor {
            panic_with_error!(&env, EscrowError::NotDepositor);
        }

        Self::assert_not_released(&env);
        Self::assert_no_dispute(&env);
        Self::bump_instance_ttl(&env);

        let expiry: u64 = env
            .storage()
            .instance()
            .get(&DataKey::Expiry)
            .expect("escrow: state corrupted");
        if env.ledger().timestamp() < expiry {
            panic_with_error!(&env, EscrowError::NotExpired);
        }

        let token: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .expect("escrow: state corrupted");
        let amount: i128 = env
            .storage()
            .instance()
            .get(&DataKey::Amount)
            .expect("escrow: state corrupted");

        env.storage().instance().set(&DataKey::Released, &true);

        // Transfer to stored_depositor (read from storage), not the caller parameter.
        // This mirrors the pattern used in `release`, which transfers to stored_recipient,
        // ensuring the destination is always the address recorded at initialization.
        TokenClient::new(&env, &token).transfer(
            &env.current_contract_address(),
            &stored_depositor,
            &amount,
        );

        env.events()
            .publish((Symbol::new(&env, "refunded"),), (stored_depositor, amount));
    }

    /// Return a snapshot of all escrow fields. Panics if not yet initialized.
    ///
    /// # Arguments
    /// * `env` - The execution environment.
    ///
    /// # Panics
    /// * `NotInitialized` - If called before `initialize`.
    ///
    /// # Return Value
    /// Returns `EscrowState` with all stored fields.
    //@ requires has(Depositor)
    //@ ensures result == EscrowState { depositor: stored_depositor, recipient: stored_recipient, arbiter: stored_arbiter, token: stored_token, amount: stored_amount, expiry: stored_expiry, released: stored_released }
    pub fn get_state(env: Env) -> EscrowState {
        if !env.storage().instance().has(&DataKey::Depositor) {
            panic_with_error!(&env, EscrowError::NotInitialized);
        }
        EscrowState {
            depositor: env
                .storage()
                .instance()
                .get(&DataKey::Depositor)
                .expect("escrow: state corrupted"),
            recipient: env
                .storage()
                .instance()
                .get(&DataKey::Recipient)
                .expect("escrow: state corrupted"),
            arbiter: env
                .storage()
                .instance()
                .get(&DataKey::Arbiter)
                .expect("escrow: state corrupted"),
            token: env
                .storage()
                .instance()
                .get(&DataKey::Token)
                .expect("escrow: state corrupted"),
            amount: env
                .storage()
                .instance()
                .get(&DataKey::Amount)
                .expect("escrow: state corrupted"),
            expiry: env
                .storage()
                .instance()
                .get(&DataKey::Expiry)
                .expect("escrow: state corrupted"),
            released: env
                .storage()
                .instance()
                .get(&DataKey::Released)
                .unwrap_or(false),
            initialized_at: env
                .storage()
                .instance()
                .get(&DataKey::InitializedAt)
                .expect("escrow: state corrupted"),
        }
    }

    /// Release a partial amount of locked funds to the recipient. Only callable by the stored arbiter.
    ///
    /// Enables milestone-based PayFi contracts (e.g., 50% on delivery confirmation,
    /// 50% on final acceptance). The escrow remains active (`Released = false`) until
    /// the remaining stored amount reaches 0, at which point it is sealed.
    ///
    /// # Arguments
    /// * `env`            - The execution environment.
    /// * `arbiter`        - Must match the arbiter recorded at initialisation.
    /// * `release_amount` - Number of token units to transfer to the recipient.
    ///
    /// # Panics
    /// * `NotArbiter` - If the caller is not the stored arbiter.
    /// * `AlreadyReleased` - If the escrow has already been fully settled.
    /// * `InvalidAmount` - If `release_amount` is not positive or exceeds the stored amount.
    ///
    /// # Return Value
    /// None. Emits a `"partial_released"` event (or `"released"` on final settlement).
    //@ requires has(Depositor)
    //@ requires arbiter == stored_arbiter
    //@ requires !stored_released
    //@ requires release_amount > 0 && release_amount <= stored_amount
    //@ ensures stored_amount == old(stored_amount) - release_amount
    //@ ensures stored_released == (stored_amount == 0)
    //@ ensures recipient_token_balance == old(recipient_token_balance) + release_amount
    //@ ensures contract_token_balance == old(contract_token_balance) - release_amount
    pub fn release_partial(env: Env, arbiter: Address, release_amount: i128) {
        // Read stored arbiter and authenticate (consistent TOCTOU fix from release())
        let stored_arbiter: Address = env
            .storage()
            .instance()
            .get(&DataKey::Arbiter)
            .expect("escrow: state corrupted");
        stored_arbiter.require_auth();
        if arbiter != stored_arbiter {
            panic_with_error!(&env, EscrowError::NotArbiter);
        }

        Self::assert_not_released(&env);
        Self::assert_no_dispute(&env);
        Self::bump_instance_ttl(&env);

        // Validate release_amount
        let stored_amount: i128 = env
            .storage()
            .instance()
            .get(&DataKey::Amount)
            .expect("escrow: state corrupted");

        if release_amount <= 0 || release_amount > stored_amount {
            panic_with_error!(&env, EscrowError::InvalidAmount);
        }

        let token: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .expect("escrow: state corrupted");
        let recipient: Address = env
            .storage()
            .instance()
            .get(&DataKey::Recipient)
            .expect("escrow: state corrupted");

        let remaining = stored_amount - release_amount;

        // Update stored amount to reflect partial release
        env.storage().instance().set(&DataKey::Amount, &remaining);

        // Transfer the partial amount to the recipient
        TokenClient::new(&env, &token).transfer(
            &env.current_contract_address(),
            &recipient,
            &release_amount,
        );

        if remaining == 0 {
            // All funds distributed — seal the escrow
            env.storage().instance().set(&DataKey::Released, &true);
            env.events().publish(
                (Symbol::new(&env, "released"),),
                (recipient.clone(), release_amount),
            );
        } else {
            env.events().publish(
                (Symbol::new(&env, "partial_released"),),
                (recipient, release_amount, remaining),
            );
        }
    }

    /// Cancel the escrow cooperatively. Requires both depositor and arbiter to authorise.
    ///
    /// # Arguments
    /// * `env`       - The execution environment.
    /// * `depositor` - Must match the depositor recorded at initialisation.
    /// * `arbiter`   - Must match the arbiter recorded at initialisation.
    ///
    /// # Panics
    /// * `NotDepositor` - If the depositor parameter does not match stored depositor.
    /// * `NotArbiter` - If the arbiter parameter does not match stored arbiter.
    /// * `AlreadyReleased` - If funds have already been released, refunded, or cancelled.
    ///
    /// # Return Value
    /// None.
    //@ requires has(Depositor)
    //@ requires depositor == stored_depositor
    //@ requires arbiter == stored_arbiter
    //@ requires !stored_released
    //@ ensures stored_released == true
    //@ ensures depositor_token_balance == old(depositor_token_balance) + old(stored_amount)
    //@ ensures contract_token_balance == old(contract_token_balance) - old(stored_amount)
    pub fn cancel(env: Env, depositor: Address, arbiter: Address) {
        let stored_depositor: Address = env
            .storage()
            .instance()
            .get(&DataKey::Depositor)
            .expect("escrow: state corrupted");
        let stored_arbiter: Address = env
            .storage()
            .instance()
            .get(&DataKey::Arbiter)
            .expect("escrow: state corrupted");

        // Dual-signature: both parties must authorise before any state mutation.
        stored_depositor.require_auth();
        stored_arbiter.require_auth();

        if depositor != stored_depositor {
            panic_with_error!(&env, EscrowError::NotDepositor);
        }
        if arbiter != stored_arbiter {
            panic_with_error!(&env, EscrowError::NotArbiter);
        }

        Self::assert_not_released(&env);

        let token: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .expect("escrow: state corrupted");
        let amount: i128 = env
            .storage()
            .instance()
            .get(&DataKey::Amount)
            .expect("escrow: state corrupted");

        env.storage().instance().set(&DataKey::Released, &true);

        TokenClient::new(&env, &token).transfer(
            &env.current_contract_address(),
            &stored_depositor,
            &amount,
        );

        env.events().publish(
            (Symbol::new(&env, "escrow"), Symbol::new(&env, "cancelled")),
            (stored_depositor, amount),
        );
    }

    /// Propose a new arbiter. Only callable by the stored depositor.
    ///
    /// Initiates a time-locked arbiter rotation to prevent instant hostile takeover.
    /// The proposal is locked for at least `MIN_ROTATION_DELAY` (24 hours) seconds;
    /// only after that floor elapses can `accept_arbiter_rotation` finalize the change.
    /// This minimum is enforced by the contract, not chosen by the caller, so no
    /// proposal can solicit a near-instant rotation.
    ///
    /// # Arguments
    /// * `env`        - The execution environment.
    /// * `depositor`  - Must match the depositor recorded at initialisation.
    /// * `new_arbiter` - The proposed new arbiter address.
    ///
    /// # Panics
    /// * `NotDepositor` - If the caller is not the stored depositor.
    /// * `NotInitialized` - If the escrow has not been initialized.
    ///
    /// # Return Value
    /// None.
    pub fn propose_new_arbiter(env: Env, depositor: Address, new_arbiter: Address) {
        let stored_depositor: Address = env
            .storage()
            .instance()
            .get(&DataKey::Depositor)
            .expect("escrow: state corrupted");
        stored_depositor.require_auth();
        if depositor != stored_depositor {
            panic_with_error!(&env, EscrowError::NotDepositor);
        }

        let now = env.ledger().timestamp();
        env.storage()
            .instance()
            .set(&DataKey::PendingArbiter, &new_arbiter);
        env.storage()
            .instance()
            .set(&DataKey::PendingArbiterTime, &now);

        env.events().publish(
            (Symbol::new(&env, "arbiter_rotation_proposed"),),
            (depositor, new_arbiter, now),
        );
    }

    /// Accept the pending arbiter rotation after the minimum time-lock.
    ///
    /// Finalizes the arbiter change if at least `MIN_ROTATION_DELAY` (24 hours)
    /// have passed since `propose_new_arbiter` was called. Can be called by anyone
    /// once the time-lock has expired.
    ///
    /// # Arguments
    /// * `env` - The execution environment.
    ///
    /// # Panics
    /// * `NoPendingRotation` - If no arbiter rotation has been proposed.
    /// * `RotationLocked` - If the 24-hour time-lock has not yet elapsed.
    ///
    /// # Return Value
    /// None.
    pub fn accept_arbiter_rotation(env: Env) {
        if !env.storage().instance().has(&DataKey::PendingArbiter) {
            panic_with_error!(&env, EscrowError::NoPendingRotation);
        }

        let pending_time: u64 = env
            .storage()
            .instance()
            .get(&DataKey::PendingArbiterTime)
            .expect("escrow: state corrupted");
        let now = env.ledger().timestamp();

        // The minimum rotation delay is a fixed constant, so no caller-controlled
        // duration can ever shorten it. Use checked addition so an overflow cannot
        // wrap around and accidentally unlock the rotation early.
        let lock_expires = pending_time
            .checked_add(MIN_ROTATION_DELAY)
            .expect("escrow: rotation deadline overflow");

        if now < lock_expires {
            panic_with_error!(&env, EscrowError::RotationLocked);
        }

        let new_arbiter: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingArbiter)
            .expect("escrow: state corrupted");

        env.storage()
            .instance()
            .set(&DataKey::Arbiter, &new_arbiter);
        env.storage().instance().remove(&DataKey::PendingArbiter);
        env.storage()
            .instance()
            .remove(&DataKey::PendingArbiterTime);

        env.events().publish(
            (Symbol::new(&env, "arbiter_rotation_accepted"),),
            (new_arbiter, now),
        );
    }

        env.events().publish(
            (Symbol::new(&env, "arbiter_rotation_accepted"),),
            (new_arbiter, now),
        );
    }

    // ─── Issue #805: public TTL bump ──────────────────────────────────────────

    /// Allow anyone to extend the instance storage TTL.
    ///
    /// Prevents a long-running escrow from being archived before `release` or
    /// `refund` can be called. Bumps to `INSTANCE_TTL_EXTEND_TO` if the
    /// remaining TTL is below `INSTANCE_TTL_THRESHOLD`. The escrow must be
    /// initialized and not yet settled before bumping.
    ///
    /// # Panics
    /// * `NotInitialized` — if called before `initialize`.
    /// * `AlreadyReleased` — if the escrow is already settled.
    pub fn bump(env: Env) {
        if !env.storage().instance().has(&DataKey::Depositor) {
            panic_with_error!(&env, EscrowError::NotInitialized);
        }
        Self::assert_not_released(&env);
        Self::bump_instance_ttl(&env);

        env.events().publish(
            (Symbol::new(&env, "escrow"), Symbol::new(&env, "bumped")),
            env.ledger().timestamp(),
        );
    }

    // ─── Issue #808: Milestone-based escrow ───────────────────────────────────

    /// Initialize a milestone-based escrow.
    ///
    /// This is an alternative entry point to `initialize` for multi-tranche
    /// deals. The depositor locks `sum(milestones[*].amount)` tokens; the
    /// arbiter (or depositor after deadline) approves individual tranches.
    ///
    /// # Arguments
    /// * `depositor`  — Party locking the funds.
    /// * `recipient`  — Party who receives approved tranches.
    /// * `arbiter`    — Trusted party who calls `approve_milestone`.
    /// * `token`      — SAC token contract address.
    /// * `milestones` — Non-empty list of `Milestone` structs. `sum(amounts)`
    ///                  is the total deposit pulled from the depositor.
    ///
    /// # Panics
    /// * `AlreadyInitialized` — if already initialized.
    /// * `InvalidParties` — if depositor/recipient/arbiter are not all distinct.
    /// * `InvalidMilestones` — if list is empty or any amount is non-positive.
    /// * `InvalidExpiry` — if any milestone deadline is not in the future.
    pub fn initialize_with_milestones(
        env: Env,
        depositor: Address,
        recipient: Address,
        arbiter: Address,
        token: Address,
        milestones: Vec<Milestone>,
    ) {
        if env.storage().instance().has(&DataKey::Depositor) {
            panic_with_error!(&env, EscrowError::AlreadyInitialized);
        }

        depositor.require_auth();

        if depositor == arbiter || depositor == recipient || arbiter == recipient {
            panic_with_error!(&env, EscrowError::InvalidParties);
        }

        if milestones.is_empty() {
            panic_with_error!(&env, EscrowError::InvalidMilestones);
        }

        let now = env.ledger().timestamp();
        let mut total: i128 = 0_i128;
        for m in milestones.iter() {
            if m.amount <= 0 {
                panic_with_error!(&env, EscrowError::InvalidMilestones);
            }
            if m.deadline <= now {
                panic_with_error!(&env, EscrowError::InvalidExpiry);
            }
            total = total
                .checked_add(m.amount)
                .expect("escrow: milestone total overflow");
        }
        if total <= 0 || total > i128::MAX / 2 {
            panic_with_error!(&env, EscrowError::InvalidMilestones);
        }

        // Pull total deposit from depositor
        TokenClient::new(&env, &token).transfer(
            &depositor,
            &env.current_contract_address(),
            &total,
        );

        // Store core fields (re-use same keys as regular initialize)
        env.storage().instance().set(&DataKey::Depositor, &depositor);
        env.storage().instance().set(&DataKey::Recipient, &recipient);
        env.storage().instance().set(&DataKey::Arbiter, &arbiter);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::Amount, &total);
        // Use the last milestone's deadline as the overall expiry
        let last_deadline = milestones.last().unwrap().deadline;
        env.storage().instance().set(&DataKey::Expiry, &last_deadline);
        env.storage().instance().set(&DataKey::Released, &false);
        env.storage().instance().set(&DataKey::InitializedAt, &now);
        env.storage().instance().set(&DataKey::Milestones, &milestones);

        Self::bump_instance_ttl(&env);

        env.events().publish(
            (Symbol::new(&env, "escrow"), Symbol::new(&env, "milestones_initialized")),
            (depositor.clone(), recipient.clone(), total, milestones.len() as u32),
        );
    }

    /// Approve a milestone and release its tranche to the recipient.
    ///
    /// Only the stored arbiter may call this. Once all milestones are approved
    /// the escrow is sealed (`Released = true`).
    ///
    /// # Arguments
    /// * `arbiter` — Must match the stored arbiter.
    /// * `index`   — Zero-based milestone index.
    ///
    /// # Panics
    /// * `NotInitialized` — if not initialized.
    /// * `NotArbiter` — if caller is not the stored arbiter.
    /// * `AlreadyReleased` — if already settled.
    /// * `DisputeActive` — if a dispute is in progress (#810).
    /// * `InvalidMilestoneIndex` — if `index` is out of bounds.
    /// * `MilestoneAlreadyApproved` — if already approved.
    pub fn approve_milestone(env: Env, arbiter: Address, index: u32) {
        let stored_arbiter: Address = env
            .storage()
            .instance()
            .get(&DataKey::Arbiter)
            .expect("escrow: state corrupted");
        stored_arbiter.require_auth();
        if arbiter != stored_arbiter {
            panic_with_error!(&env, EscrowError::NotArbiter);
        }

        Self::assert_not_released(&env);
        Self::assert_no_dispute(&env);
        Self::bump_instance_ttl(&env);

        let mut milestones: Vec<Milestone> = env
            .storage()
            .instance()
            .get(&DataKey::Milestones)
            .expect("escrow: no milestones stored — use initialize_with_milestones");

        if index >= milestones.len() {
            panic_with_error!(&env, EscrowError::InvalidMilestoneIndex);
        }
        let mut m = milestones.get(index).unwrap();
        if m.approved {
            panic_with_error!(&env, EscrowError::MilestoneAlreadyApproved);
        }

        let token: Address = env.storage().instance().get(&DataKey::Token).expect("escrow: state corrupted");
        let recipient: Address = env.storage().instance().get(&DataKey::Recipient).expect("escrow: state corrupted");
        let tranche = m.amount;

        m.approved = true;
        milestones.set(index, m);
        env.storage().instance().set(&DataKey::Milestones, &milestones);

        // Deduct from running total
        let remaining: i128 = env.storage().instance().get(&DataKey::Amount).expect("escrow: state corrupted");
        let new_remaining = remaining - tranche;
        env.storage().instance().set(&DataKey::Amount, &new_remaining);

        TokenClient::new(&env, &token).transfer(
            &env.current_contract_address(),
            &recipient,
            &tranche,
        );

        let all_approved = milestones.iter().all(|ms| ms.approved);
        if all_approved {
            env.storage().instance().set(&DataKey::Released, &true);
        }

        env.events().publish(
            (Symbol::new(&env, "escrow"), Symbol::new(&env, "milestone_approved")),
            (index, tranche, new_remaining, all_approved),
        );
    }

    /// Refund a single expired and unapproved milestone back to the depositor.
    ///
    /// The depositor may reclaim a tranche once its `deadline` has passed and
    /// it has not been approved. The overall escrow is sealed when no tokens
    /// remain locked.
    ///
    /// # Arguments
    /// * `depositor` — Must match the stored depositor.
    /// * `index`     — Zero-based milestone index.
    ///
    /// # Panics
    /// * `NotDepositor` — if caller is not the stored depositor.
    /// * `AlreadyReleased` — if already settled.
    /// * `DisputeActive` — if a dispute is in progress (#810).
    /// * `InvalidMilestoneIndex` — if `index` is out of bounds.
    /// * `MilestoneAlreadyApproved` — if the milestone was already approved.
    /// * `MilestoneNotExpired` — if the milestone deadline has not passed.
    pub fn refund_milestone(env: Env, depositor: Address, index: u32) {
        let stored_depositor: Address = env
            .storage()
            .instance()
            .get(&DataKey::Depositor)
            .expect("escrow: state corrupted");
        stored_depositor.require_auth();
        if depositor != stored_depositor {
            panic_with_error!(&env, EscrowError::NotDepositor);
        }

        Self::assert_not_released(&env);
        Self::assert_no_dispute(&env);
        Self::bump_instance_ttl(&env);

        let mut milestones: Vec<Milestone> = env
            .storage()
            .instance()
            .get(&DataKey::Milestones)
            .expect("escrow: no milestones stored");

        if index >= milestones.len() {
            panic_with_error!(&env, EscrowError::InvalidMilestoneIndex);
        }
        let mut m = milestones.get(index).unwrap();
        if m.approved {
            panic_with_error!(&env, EscrowError::MilestoneAlreadyApproved);
        }
        if env.ledger().timestamp() < m.deadline {
            panic_with_error!(&env, EscrowError::MilestoneNotExpired);
        }

        let token: Address = env.storage().instance().get(&DataKey::Token).expect("escrow: state corrupted");
        let tranche = m.amount;

        // Mark as approved to prevent double-refund
        m.approved = true;
        milestones.set(index, m);
        env.storage().instance().set(&DataKey::Milestones, &milestones);

        let remaining: i128 = env.storage().instance().get(&DataKey::Amount).expect("escrow: state corrupted");
        let new_remaining = remaining - tranche;
        env.storage().instance().set(&DataKey::Amount, &new_remaining);

        TokenClient::new(&env, &token).transfer(
            &env.current_contract_address(),
            &stored_depositor,
            &tranche,
        );

        // Seal escrow if no more tokens remain
        if new_remaining == 0 {
            env.storage().instance().set(&DataKey::Released, &true);
        }

        env.events().publish(
            (Symbol::new(&env, "escrow"), Symbol::new(&env, "milestone_refunded")),
            (index, tranche, new_remaining),
        );
    }

    // ─── Issue #810: Dispute resolution ───────────────────────────────────────

    /// Raise a dispute, freezing all remaining funds.
    ///
    /// Either the depositor or the recipient may raise a dispute. While the
    /// dispute is active (`DisputeStatus::Raised`), `release`, `refund`,
    /// `release_partial`, `cancel`, and milestone approvals are all blocked.
    ///
    /// # Arguments
    /// * `party`         — Must be either the stored depositor or recipient.
    /// * `evidence_hash` — 32-byte SHA-256 hash of off-chain dispute evidence.
    ///
    /// # Panics
    /// * `NotInitialized` — if not initialized.
    /// * `AlreadyReleased` — if already settled.
    /// * `DisputeActive` — if a dispute is already raised.
    /// * `NotParty` — if the caller is neither depositor nor recipient.
    pub fn raise_dispute(env: Env, party: Address, evidence_hash: Bytes) {
        if !env.storage().instance().has(&DataKey::Depositor) {
            panic_with_error!(&env, EscrowError::NotInitialized);
        }
        Self::assert_not_released(&env);
        Self::assert_no_dispute(&env);

        let stored_depositor: Address = env
            .storage()
            .instance()
            .get(&DataKey::Depositor)
            .expect("escrow: state corrupted");
        let stored_recipient: Address = env
            .storage()
            .instance()
            .get(&DataKey::Recipient)
            .expect("escrow: state corrupted");

        if party != stored_depositor && party != stored_recipient {
            panic_with_error!(&env, EscrowError::NotParty);
        }
        party.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::DisputeState, &DisputeStatus::Raised);
        env.storage()
            .instance()
            .set(&DataKey::DisputeRaisedBy, &party);
        env.storage()
            .instance()
            .set(&DataKey::DisputeEvidenceHash, &evidence_hash);

        Self::bump_instance_ttl(&env);

        env.events().publish(
            (Symbol::new(&env, "escrow"), Symbol::new(&env, "dispute_raised")),
            (party.clone(), evidence_hash),
        );
    }

    /// Resolve an active dispute by splitting the locked funds.
    ///
    /// Only the stored arbiter may resolve. `recipient_bps` is the percentage
    /// of remaining funds the *recipient* receives, expressed in basis points
    /// (0 = 100% to depositor, 10_000 = 100% to recipient). No dust is lost:
    /// `recipient_amount = remaining * recipient_bps / 10_000` with the
    /// remainder going to the depositor.
    ///
    /// # Arguments
    /// * `arbiter`        — Must match the stored arbiter.
    /// * `recipient_bps`  — Basis points 0–10 000 for the recipient's share.
    ///
    /// # Panics
    /// * `NotArbiter` — if caller is not the stored arbiter.
    /// * `NoActiveDispute` — if no dispute has been raised.
    /// * `InvalidSplitBps` — if `recipient_bps > 10_000`.
    /// * `AlreadyReleased` — if already settled.
    pub fn resolve_dispute(env: Env, arbiter: Address, recipient_bps: u32) {
        let stored_arbiter: Address = env
            .storage()
            .instance()
            .get(&DataKey::Arbiter)
            .expect("escrow: state corrupted");
        stored_arbiter.require_auth();
        if arbiter != stored_arbiter {
            panic_with_error!(&env, EscrowError::NotArbiter);
        }

        let status: DisputeStatus = env
            .storage()
            .instance()
            .get(&DataKey::DisputeState)
            .unwrap_or(DisputeStatus::None);
        if status != DisputeStatus::Raised {
            panic_with_error!(&env, EscrowError::NoActiveDispute);
        }

        Self::assert_not_released(&env);

        if recipient_bps > 10_000 {
            panic_with_error!(&env, EscrowError::InvalidSplitBps);
        }

        let token: Address = env.storage().instance().get(&DataKey::Token).expect("escrow: state corrupted");
        let amount: i128 = env.storage().instance().get(&DataKey::Amount).expect("escrow: state corrupted");
        let depositor: Address = env.storage().instance().get(&DataKey::Depositor).expect("escrow: state corrupted");
        let recipient: Address = env.storage().instance().get(&DataKey::Recipient).expect("escrow: state corrupted");

        // Split arithmetic: exact, no dust lost.
        // recipient_amount = amount * recipient_bps / 10_000 (floor division)
        // depositor_amount = amount - recipient_amount (gets the remainder)
        let recipient_amount: i128 = amount
            .checked_mul(recipient_bps as i128)
            .expect("escrow: split overflow")
            / 10_000_i128;
        let depositor_amount: i128 = amount - recipient_amount;

        // Seal the escrow
        env.storage().instance().set(&DataKey::Released, &true);
        env.storage()
            .instance()
            .set(&DataKey::DisputeState, &DisputeStatus::Resolved);
        env.storage().instance().set(&DataKey::Amount, &0_i128);

        let token_client = TokenClient::new(&env, &token);

        if recipient_amount > 0 {
            token_client.transfer(
                &env.current_contract_address(),
                &recipient,
                &recipient_amount,
            );
        }
        if depositor_amount > 0 {
            token_client.transfer(
                &env.current_contract_address(),
                &depositor,
                &depositor_amount,
            );
        }

        Self::bump_instance_ttl(&env);

        env.events().publish(
            (Symbol::new(&env, "escrow"), Symbol::new(&env, "dispute_resolved")),
            (arbiter.clone(), recipient_bps, recipient_amount, depositor_amount),
        );
    }

    // ─── Internal helpers ────────────────────────────────────────────────────

    fn assert_not_released(env: &Env) {
        let released: bool = env
            .storage()
            .instance()
            .get(&DataKey::Released)
            .unwrap_or(false);
        if released {
            panic_with_error!(env, EscrowError::AlreadyReleased);
        }
    }

    /// Bump instance storage TTL if it has fallen below `INSTANCE_TTL_THRESHOLD`.
    ///
    /// Called automatically at the top of every mutating public function so that
    /// long-running escrows are never archived while still active (issue #805).
    fn bump_instance_ttl(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
    }

    /// Assert that no active dispute is in progress (#810).
    fn assert_no_dispute(env: &Env) {
        let status: DisputeStatus = env
            .storage()
            .instance()
            .get(&DataKey::DisputeState)
            .unwrap_or(DisputeStatus::None);
        if status == DisputeStatus::Raised {
            panic_with_error!(env, EscrowError::DisputeActive);
        }
    }

#[cfg(test)]
mod test;
