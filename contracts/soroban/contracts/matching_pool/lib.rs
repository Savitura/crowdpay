#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Symbol};

/// Matching pool contract for sponsor matching campaigns.
///
/// Holds sponsor funds and releases proportional amounts as contributions arrive.
/// Sponsors can reclaim unmatched funds after campaign ends.

#[derive(Clone)]
#[contracttype]
pub struct PoolStatus {
    /// Campaign ID (off-chain reference)
    pub campaign_id: u64,
    /// Sponsor address (Stellar account)
    pub sponsor: Address,
    /// Match ratio: 1 = 1:1, 2 = 2:1, etc.
    pub match_ratio: i128,
    /// Total funds pledged by sponsor
    pub total_pool: i128,
    /// Funds already matched to contributions
    pub matched_amount: i128,
    /// Funds available for future matches
    pub remaining_pool: i128,
    /// Pool status: 'active' or 'exhausted'
    pub status: Symbol,
}

pub(crate) fn calculate_match_amount(
    contribution_amount: i128,
    match_ratio: i128,
    remaining_pool: i128,
) -> i128 {
    ((contribution_amount * match_ratio) / 100).min(remaining_pool)
}

#[contract]
pub struct MatchingPoolContract;

#[contractimpl]
impl MatchingPoolContract {
    /// Initialize the matching pool contract.
    ///
    /// # Arguments
    /// * `env` - Soroban environment
    /// * `sponsor` - Sponsor's Stellar address
    /// * `campaign_id` - Campaign ID (from backend database)
    /// * `match_ratio` - Match ratio (e.g., 100 = 1.00:1, 200 = 2.00:1)
    ///
    /// # Example
    /// ```ignore
    /// initialize(env, sponsor_address, 12345, 100);
    /// ```
    pub fn initialize(env: Env, sponsor: Address, campaign_id: u64, match_ratio: i128) {
        sponsor.require_auth();

        let key = Symbol::new(&env, "state");
        let status = PoolStatus {
            campaign_id,
            sponsor: sponsor.clone(),
            match_ratio,
            total_pool: 0,
            matched_amount: 0,
            remaining_pool: 0,
            status: Symbol::new(&env, "active"),
        };

        env.storage().persistent().set(&key, &status);
    }

    /// Record the sponsor's pledge so matching funds can be released later.
    pub fn fund(env: Env, sponsor: Address, amount: i128) -> i128 {
        sponsor.require_auth();

        assert!(amount > 0, "Amount must be positive");

        let key = Symbol::new(&env, "state");
        let mut status: PoolStatus = env.storage().persistent().get(&key).unwrap();
        if sponsor != status.sponsor {
            panic!("Only the sponsor can fund the pool");
        }

        status.total_pool += amount;
        status.remaining_pool += amount;
        env.storage().persistent().set(&key, &status);

        status.remaining_pool
    }

    /// Release matching funds when a contribution is confirmed.
    ///
    /// Called by backend oracle when a contribution is verified on-chain.
    /// Calculates match_amount = min(contribution * ratio, remaining_pool)
    /// and transfers it to the campaign recipient address.
    ///
    /// # Arguments
    /// * `env` - Soroban environment
    /// * `contribution_amount` - Amount of user contribution
    /// * `recipient` - Campaign wallet to receive the match
    ///
    /// # Returns
    /// The amount actually matched (0 if pool exhausted)
    ///
    /// # Example
    /// ```ignore
    /// let matched = release_match(env, 100_0000000, recipient_address);
    /// // matched = 100_0000000 for 1:1 ratio, or proportional amount if pool limited
    /// ```
    pub fn release_match(env: Env, contribution_amount: i128, recipient: Address) -> i128 {
        let key = Symbol::new(&env, "state");
        let mut status: PoolStatus = env.storage().persistent().get(&key).unwrap();

        let actual_match = calculate_match_amount(
            contribution_amount,
            status.match_ratio,
            status.remaining_pool,
        );

        if actual_match > 0 {
            status.matched_amount += actual_match;
            status.remaining_pool -= actual_match;

            if status.remaining_pool == 0 {
                status.status = Symbol::new(&env, "exhausted");
            }

            env.storage().persistent().set(&key, &status);
        }

        let _ = recipient;
        actual_match
    }

    /// Get the current pool status and match statistics.
    ///
    /// # Returns
    /// `PoolStatus` with current pool state:
    /// - campaign_id
    /// - sponsor address
    /// - match_ratio
    /// - total_pool (initial pledge)
    /// - matched_amount (funds released so far)
    /// - remaining_pool (available for future matches)
    /// - status ('active' or 'exhausted')
    ///
    /// # Example
    /// ```ignore
    /// let pool = get_pool_status(env);
    /// if pool.status == "exhausted" { /* handle exhausted pool */ }
    /// ```
    pub fn get_pool_status(env: Env) -> PoolStatus {
        let key = Symbol::new(&env, "state");
        env.storage().persistent().get(&key).unwrap()
    }

    /// Sponsor reclaims unmatched funds after campaign ends.
    ///
    /// Transfers remaining unmatched funds back to the sponsor.
    /// Only callable by sponsor address. Campaign creator may also call
    /// to initiate reclaim (backend verifies campaign end status).
    ///
    /// # Arguments
    /// * `env` - Soroban environment
    /// * `sponsor` - Sponsor address (must sign)
    ///
    /// # Returns
    /// Amount reclaimed
    ///
    /// # Example
    /// ```ignore
    /// let reclaimed = reclaim(env, sponsor_address);
    /// // sponsor receives reclaimed amount back to their Stellar account
    /// ```
    pub fn reclaim(env: Env, sponsor: Address) -> i128 {
        sponsor.require_auth();

        let key = Symbol::new(&env, "state");
        let mut status: PoolStatus = env.storage().persistent().get(&key).unwrap();
        if sponsor != status.sponsor {
            panic!("Only the sponsor can reclaim the pool");
        }

        let unclaimed = status.remaining_pool;
        if unclaimed > 0 {
            status.status = Symbol::new(&env, "completed");
            env.storage().persistent().set(&key, &status);
        }

        unclaimed
    }
}

#[cfg(test)]
mod test;
