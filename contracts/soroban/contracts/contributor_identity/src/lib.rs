#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, BytesN, Env, Map, String, Symbol,
    Vec,
};

#[cfg(test)]
mod test;

// ---------------------------------------------------------------------------
// Error enum
// ---------------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum IdentityError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    IdentityNotFound = 3,
    InvalidIndex = 4,
    Unauthorized = 5,
    NotApprovedIssuer = 6,
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Maximum reputation score a contributor can hold.
pub const MAX_REPUTATION: u32 = 1000;

const DAY_IN_LEDGERS: u32 = 17_280;
/// Identities and attestations are long-lived (an attestation may not expire
/// for a year), so keep entries live well beyond the 4096-ledger default.
pub const STORAGE_TTL_LEDGERS: u32 = 180 * DAY_IN_LEDGERS;
/// Entries are only re-extended once their remaining TTL drops this far below
/// the target, so back-to-back calls don't pay for redundant bumps.
const TTL_BUMP_SLACK: u32 = DAY_IN_LEDGERS;

// ---------------------------------------------------------------------------
// Storage key enum
// ---------------------------------------------------------------------------

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    /// Per-contributor identity record.
    Identity(Address),
    /// Approved attestation issuers (stored as a Map<Address, bool>).
    IssuersMap,
    /// Address of the platform contract that is allowed to call update_reputation.
    PlatformContract,
    /// Contract admin (initially set at deploy time).
    Admin,
    /// Guards against double-initialisation.
    IsInitialized,
}

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/// A single KYC / identity attestation issued by an approved issuer.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct Attestation {
    /// Stellar address of the issuer (platform admin or approved third-party).
    pub issuer: Address,
    /// Short symbol identifying the attestation class, e.g. `kyc_basic`.
    pub attestation_type: Symbol,
    /// Ledger timestamp at the time of issuance.
    pub issued_at: u64,
    /// Optional expiry ledger timestamp. `0` means no expiry.
    pub expires_at: u64,
    /// Whether this attestation has been revoked by its issuer.
    pub revoked: bool,
    /// SHA-256 hash of the off-chain KYC document reference — never the
    /// document itself.
    pub proof_hash: BytesN<32>,
}

/// The full on-chain identity record for a contributor.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ContributorIdentity {
    /// Decentralised identifier string: `did:stellar:<public_key>`.
    pub did: String,
    /// List of attestations attached to this identity.
    pub attestations: Vec<Attestation>,
    /// Reputation score in the range [0, 1000].
    pub reputation_score: u32,
    /// Ledger timestamp of the last write to this record.
    pub last_updated: u64,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct ContributorIdentityContract;

#[contractimpl]
impl ContributorIdentityContract {
    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    /// Initialise the contract.  Must be called exactly once.
    ///
    /// * `admin`             — wallet that governs the issuers list.
    /// * `platform_contract` — the address authorised to call `update_reputation`.
    pub fn initialize(
        env: Env,
        admin: Address,
        platform_contract: Address,
    ) -> Result<(), IdentityError> {
        if env.storage().instance().has(&DataKey::IsInitialized) {
            return Err(IdentityError::AlreadyInitialized);
        }
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::PlatformContract, &platform_contract);
        // Start with an empty issuers map.
        let issuers: Map<Address, bool> = Map::new(&env);
        env.storage().instance().set(&DataKey::IssuersMap, &issuers);
        env.storage().instance().set(&DataKey::IsInitialized, &true);
        Self::bump_instance(&env);
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Issuer management (admin-only)
    // -----------------------------------------------------------------------

    /// Grant attestation-issuing rights to `issuer`.
    pub fn add_issuer(env: Env, issuer: Address) -> Result<(), IdentityError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(IdentityError::NotInitialized)?;
        admin.require_auth();

        let mut issuers: Map<Address, bool> = env
            .storage()
            .instance()
            .get(&DataKey::IssuersMap)
            .unwrap_or_else(|| Map::new(&env));
        issuers.set(issuer.clone(), true);
        env.storage().instance().set(&DataKey::IssuersMap, &issuers);
        Self::bump_instance(&env);

        env.events()
            .publish((Symbol::new(&env, "issuer_added"), issuer), ());
        Ok(())
    }

    /// Revoke attestation-issuing rights from `issuer`.
    pub fn remove_issuer(env: Env, issuer: Address) -> Result<(), IdentityError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(IdentityError::NotInitialized)?;
        admin.require_auth();

        let mut issuers: Map<Address, bool> = env
            .storage()
            .instance()
            .get(&DataKey::IssuersMap)
            .unwrap_or_else(|| Map::new(&env));
        issuers.remove(issuer.clone());
        env.storage().instance().set(&DataKey::IssuersMap, &issuers);
        Self::bump_instance(&env);

        env.events()
            .publish((Symbol::new(&env, "issuer_removed"), issuer), ());
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Identity registration (self-service)
    // -----------------------------------------------------------------------

    /// Register a DID for the calling Stellar account.  Idempotent: calling a
    /// second time after the identity already exists is a no-op.
    ///
    /// The DID is formatted as `did:stellar:<public_key>`.
    pub fn register(env: Env, caller: Address, did: String) {
        caller.require_auth();

        // Idempotent — never overwrite an existing record.
        let key = DataKey::Identity(caller.clone());
        if env.storage().persistent().has(&key) {
            Self::bump_identity(&env, &key);
            return;
        }

        let identity = ContributorIdentity {
            did,
            attestations: Vec::new(&env),
            reputation_score: 0,
            last_updated: env.ledger().timestamp(),
        };
        env.storage().persistent().set(&key, &identity);
        Self::bump_identity(&env, &key);

        env.events()
            .publish((Symbol::new(&env, "identity_registered"), caller), ());
    }

    // -----------------------------------------------------------------------
    // Attestation management (approved issuers only)
    // -----------------------------------------------------------------------

    /// Attach an attestation to a subject's identity record.
    ///
    /// Callable only by addresses listed in the issuers map.
    pub fn add_attestation(
        env: Env,
        issuer: Address,
        subject: Address,
        attestation_type: Symbol,
        expires_at: u64,
        proof_hash: BytesN<32>,
    ) -> Result<(), IdentityError> {
        issuer.require_auth();
        Self::assert_approved_issuer(&env, &issuer)?;

        let key = DataKey::Identity(subject.clone());
        let mut identity: ContributorIdentity = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(IdentityError::IdentityNotFound)?;

        let attestation = Attestation {
            issuer: issuer.clone(),
            attestation_type: attestation_type.clone(),
            issued_at: env.ledger().timestamp(),
            expires_at,
            revoked: false,
            proof_hash,
        };
        identity.attestations.push_back(attestation);
        identity.last_updated = env.ledger().timestamp();

        env.storage().persistent().set(&key, &identity);
        Self::bump_identity(&env, &key);

        env.events().publish(
            (Symbol::new(&env, "attestation_added"), subject),
            attestation_type,
        );
        Ok(())
    }

    /// Revoke an attestation at `attestation_index` inside the subject's list.
    ///
    /// Only the original issuer of that specific attestation may revoke it.
    pub fn revoke_attestation(
        env: Env,
        issuer: Address,
        subject: Address,
        attestation_index: u32,
    ) -> Result<(), IdentityError> {
        issuer.require_auth();

        let key = DataKey::Identity(subject.clone());
        let mut identity: ContributorIdentity = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(IdentityError::IdentityNotFound)?;

        let idx = attestation_index as usize;
        if idx >= identity.attestations.len() as usize {
            return Err(IdentityError::InvalidIndex);
        }

        let mut att = identity
            .attestations
            .get(attestation_index)
            .ok_or(IdentityError::InvalidIndex)?;

        // Enforce that only the original issuer may revoke.
        if att.issuer != issuer {
            return Err(IdentityError::Unauthorized);
        }

        att.revoked = true;
        identity.attestations.set(attestation_index, att);
        identity.last_updated = env.ledger().timestamp();

        env.storage().persistent().set(&key, &identity);
        Self::bump_identity(&env, &key);

        env.events().publish(
            (Symbol::new(&env, "attestation_revoked"), subject),
            attestation_index,
        );
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Reputation management (platform contract only)
    // -----------------------------------------------------------------------

    /// Adjust the subject's reputation score by `delta` (positive or negative).
    /// The score is clamped to [0, MAX_REPUTATION].
    ///
    /// Callable only by the platform contract address set during initialisation.
    pub fn update_reputation(env: Env, subject: Address, delta: i32) -> Result<(), IdentityError> {
        let platform: Address = env
            .storage()
            .instance()
            .get(&DataKey::PlatformContract)
            .ok_or(IdentityError::NotInitialized)?;
        platform.require_auth();

        let key = DataKey::Identity(subject.clone());
        let mut identity: ContributorIdentity = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(IdentityError::IdentityNotFound)?;

        let current = identity.reputation_score as i64;
        let updated = (current + delta as i64).max(0).min(MAX_REPUTATION as i64) as u32;
        identity.reputation_score = updated;
        identity.last_updated = env.ledger().timestamp();

        env.storage().persistent().set(&key, &identity);
        Self::bump_identity(&env, &key);

        env.events()
            .publish((Symbol::new(&env, "reputation_updated"), subject), updated);
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Read-only queries
    // -----------------------------------------------------------------------

    /// Return the full identity record for `subject`.
    pub fn get_identity(env: Env, subject: Address) -> Result<ContributorIdentity, IdentityError> {
        let key = DataKey::Identity(subject);
        env.storage()
            .persistent()
            .get(&key)
            .ok_or(IdentityError::IdentityNotFound)
    }

    /// Return `true` if the subject has at least one non-revoked, non-expired
    /// attestation of `attestation_type`.
    pub fn has_attestation(env: Env, subject: Address, attestation_type: Symbol) -> bool {
        let key = DataKey::Identity(subject);
        let identity: ContributorIdentity = match env.storage().persistent().get(&key) {
            Some(id) => id,
            None => return false,
        };

        let now = env.ledger().timestamp();
        for i in 0..identity.attestations.len() {
            if let Some(att) = identity.attestations.get(i) {
                if att.attestation_type == attestation_type
                    && !att.revoked
                    && (att.expires_at == 0 || att.expires_at > now)
                {
                    return true;
                }
            }
        }
        false
    }

    /// Return `true` if the subject has a valid (non-revoked, non-expired)
    /// attestation of `attestation_type` whose `proof_hash` matches exactly.
    pub fn verify_proof(
        env: Env,
        subject: Address,
        attestation_type: Symbol,
        proof_hash: BytesN<32>,
    ) -> bool {
        let key = DataKey::Identity(subject);
        let identity: ContributorIdentity = match env.storage().persistent().get(&key) {
            Some(id) => id,
            None => return false,
        };

        let now = env.ledger().timestamp();
        for i in 0..identity.attestations.len() {
            if let Some(att) = identity.attestations.get(i) {
                if att.attestation_type == attestation_type
                    && !att.revoked
                    && (att.expires_at == 0 || att.expires_at > now)
                    && att.proof_hash == proof_hash
                {
                    return true;
                }
            }
        }
        false
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    fn ttl_window(env: &Env) -> (u32, u32) {
        let extend_to = STORAGE_TTL_LEDGERS.min(env.storage().max_ttl());
        (extend_to.saturating_sub(TTL_BUMP_SLACK), extend_to)
    }

    /// Extend the instance entry (admin, platform contract, issuers map).
    fn bump_instance(env: &Env) {
        let (threshold, extend_to) = Self::ttl_window(env);
        env.storage().instance().extend_ttl(threshold, extend_to);
    }

    /// Extend one contributor's identity record together with the instance, so
    /// any write to an identity also keeps the issuer list it depends on alive.
    fn bump_identity(env: &Env, key: &DataKey) {
        let (threshold, extend_to) = Self::ttl_window(env);
        env.storage()
            .persistent()
            .extend_ttl(key, threshold, extend_to);
        env.storage().instance().extend_ttl(threshold, extend_to);
    }

    fn assert_approved_issuer(env: &Env, issuer: &Address) -> Result<(), IdentityError> {
        let issuers: Map<Address, bool> = env
            .storage()
            .instance()
            .get(&DataKey::IssuersMap)
            .unwrap_or_else(|| Map::new(env));
        if !issuers.contains_key(issuer.clone()) {
            return Err(IdentityError::NotApprovedIssuer);
        }
        Ok(())
    }
}
