#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, Symbol,
};

#[cfg(test)]
mod test;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum MatchingPoolError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    InvalidAmount = 4,
    InvalidRatio = 5,
    PoolExhausted = 6,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct PoolStatus {
    /// Campaign ID (off-chain reference)
    pub campaign_id: u64,
    /// Sponsor address (Stellar account)
    pub sponsor: Address,
    /// Match ratio: 100 = 1:1, 200 = 2:1, 50 = 0.5:1, etc.
    pub match_ratio: i128,
    /// Total funds pledged by sponsor
    pub total_pool: i128,
    /// Funds already matched to contributions
    pub matched_amount: i128,
    /// Funds available for future matches
    pub remaining_pool: i128,
    /// Pool status: 'active', 'exhausted', or 'completed'
    pub status: Symbol,
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    State,
    Initialized,
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
    pub fn initialize(
        env: Env,
        sponsor: Address,
        campaign_id: u64,
        match_ratio: i128,
    ) -> Result<(), MatchingPoolError> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(MatchingPoolError::AlreadyInitialized);
        }
        if match_ratio <= 0 {
            return Err(MatchingPoolError::InvalidRatio);
        }

        sponsor.require_auth();

        let status = PoolStatus {
            campaign_id,
            sponsor: sponsor.clone(),
            match_ratio,
            total_pool: 0,
            matched_amount: 0,
            remaining_pool: 0,
            status: Symbol::new(&env, "active"),
        };

        env.storage().instance().set(&DataKey::State, &status);
        env.storage().instance().set(&DataKey::Initialized, &true);

        env.events()
            .publish((symbol_short!("init"), campaign_id), sponsor);

        Ok(())
    }

    /// Deposit funds into the matching pool.
    pub fn deposit(env: Env, from: Address, amount: i128) -> Result<(), MatchingPoolError> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(MatchingPoolError::NotInitialized);
        }
        if amount <= 0 {
            return Err(MatchingPoolError::InvalidAmount);
        }

        from.require_auth();

        let mut status: PoolStatus = env
            .storage()
            .instance()
            .get(&DataKey::State)
            .ok_or(MatchingPoolError::NotInitialized)?;

        status.total_pool += amount;
        status.remaining_pool += amount;
        if status.remaining_pool > 0 && status.status == Symbol::new(&env, "exhausted") {
            status.status = Symbol::new(&env, "active");
        }

        env.storage().instance().set(&DataKey::State, &status);

        env.events()
            .publish((symbol_short!("deposit"), from), amount);

        Ok(())
    }

    /// Release matching funds when a contribution is confirmed.
    ///
    /// Calculates match_amount = contribution_amount * match_ratio / 100
    /// capped at remaining_pool.
    pub fn release_match(
        env: Env,
        contribution_amount: i128,
        recipient: Address,
    ) -> Result<i128, MatchingPoolError> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(MatchingPoolError::NotInitialized);
        }
        if contribution_amount <= 0 {
            return Err(MatchingPoolError::InvalidAmount);
        }

        let mut status: PoolStatus = env
            .storage()
            .instance()
            .get(&DataKey::State)
            .ok_or(MatchingPoolError::NotInitialized)?;

        let match_amount = (contribution_amount * status.match_ratio) / 100;
        let actual_match = match_amount.min(status.remaining_pool);

        if actual_match > 0 {
            status.matched_amount += actual_match;
            status.remaining_pool -= actual_match;

            if status.remaining_pool == 0 {
                status.status = Symbol::new(&env, "exhausted");
            }

            env.storage().instance().set(&DataKey::State, &status);

            env.events().publish(
                (symbol_short!("match"), recipient),
                (contribution_amount, actual_match),
            );
        }

        Ok(actual_match)
    }

    /// Get current pool status.
    pub fn get_pool_status(env: Env) -> Result<PoolStatus, MatchingPoolError> {
        env.storage()
            .instance()
            .get(&DataKey::State)
            .ok_or(MatchingPoolError::NotInitialized)
    }

    /// Sponsor reclaims unmatched funds after campaign ends.
    pub fn reclaim(env: Env, caller: Address) -> Result<i128, MatchingPoolError> {
        let mut status: PoolStatus = env
            .storage()
            .instance()
            .get(&DataKey::State)
            .ok_or(MatchingPoolError::NotInitialized)?;

        if caller != status.sponsor {
            return Err(MatchingPoolError::Unauthorized);
        }

        caller.require_auth();

        let unclaimed = status.remaining_pool;
        if unclaimed > 0 {
            status.remaining_pool = 0;
            status.status = Symbol::new(&env, "completed");
            env.storage().instance().set(&DataKey::State, &status);

            env.events()
                .publish((symbol_short!("reclaim"), caller), unclaimed);
        }

        Ok(unclaimed)
    }
}
