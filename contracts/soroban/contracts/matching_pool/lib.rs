#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, Symbol};

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
    /// Authorized caller/platform address allowed to apply matches
    pub authorized_caller: Address,
    /// Stellar token contract address
    pub token: Address,
    /// Match ratio: 100 = 1:1, 200 = 2:1, etc.
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
    /// * `authorized_caller` - Address authorized to apply matches (e.g. platform or escrow)
    /// * `token` - Token address (USDC/XLM)
    /// * `campaign_id` - Campaign ID (from backend database)
    /// * `match_ratio` - Match ratio (e.g., 100 = 1.00:1, 200 = 2.00:1)
    /// * `total_pool` - Initial pledge amount deposited into contract
    pub fn initialize(
        env: Env,
        sponsor: Address,
        authorized_caller: Address,
        token: Address,
        campaign_id: u64,
        match_ratio: i128,
        total_pool: i128,
    ) {
        sponsor.require_auth();

        let key = Symbol::new(&env, "state");
        if env.storage().persistent().has(&key) {
            panic!("Already initialized");
        }
        if match_ratio <= 0 {
            panic!("Match ratio must be positive");
        }
        if total_pool < 0 {
            panic!("Total pool cannot be negative");
        }

        if total_pool > 0 {
            token::Client::new(&env, &token).transfer(
                &sponsor,
                &env.current_contract_address(),
                &total_pool,
            );
        }

        let status = PoolStatus {
            campaign_id,
            sponsor: sponsor.clone(),
            authorized_caller: authorized_caller.clone(),
            token: token.clone(),
            match_ratio,
            total_pool: 0,
            matched_amount: 0,
            remaining_pool: total_pool,
            status: Symbol::new(&env, "active"),
        };

        env.storage().persistent().set(&key, &status);

        env.events().publish(
            (Symbol::new(&env, "pool_initialized"), campaign_id),
            (sponsor, authorized_caller, token, total_pool, match_ratio),
        );
    }

    /// Deposit additional funds into the matching pool.
    pub fn deposit(env: Env, from: Address, amount: i128) {
        from.require_auth();
        if amount <= 0 {
            panic!("Deposit amount must be positive");
        }
        let key = Symbol::new(&env, "state");
        let mut status: PoolStatus = env.storage().persistent().get(&key).unwrap();

        token::Client::new(&env, &status.token).transfer(
            &from,
            &env.current_contract_address(),
            &amount,
        );

        status.total_pool += amount;
        status.remaining_pool += amount;
        if status.status == Symbol::new(&env, "exhausted") && status.remaining_pool > 0 {
            status.status = Symbol::new(&env, "active");
        }

        env.storage().persistent().set(&key, &status);

        env.events().publish(
            (Symbol::new(&env, "pool_deposited"), status.campaign_id),
            (from, amount, status.remaining_pool),
        );
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
    /// Requires authorization from the designated authorized_caller (admin/platform/escrow).
    /// Calculates match_amount = contribution * ratio / 100 capped by remaining_pool,
    /// transfers actual_match to the recipient, emits event, and updates state.
    pub fn apply_match(
        env: Env,
        caller: Address,
        contribution_amount: i128,
        recipient: Address,
    ) -> i128 {
        caller.require_auth();

        let key = Symbol::new(&env, "state");
        let mut status: PoolStatus = env.storage().persistent().get(&key).unwrap();

        if caller != status.authorized_caller {
            panic!("Unauthorized caller");
        }

        if status.status != Symbol::new(&env, "active") || status.remaining_pool <= 0 {
            return 0;
        }

        let match_amount = (contribution_amount * status.match_ratio) / 100;
        let actual_match = match_amount.min(status.remaining_pool);
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

            token::Client::new(&env, &status.token).transfer(
                &env.current_contract_address(),
                &recipient,
                &actual_match,
            );

            env.events().publish(
                (Symbol::new(&env, "match_applied"), status.campaign_id),
                (recipient, actual_match, status.remaining_pool),
            );
        }

        }

        let _ = recipient;
        actual_match
    }

    /// Alias for apply_match for backwards compatibility.
    pub fn release_match(
        env: Env,
        caller: Address,
        contribution_amount: i128,
        recipient: Address,
    ) -> i128 {
        Self::apply_match(env, caller, contribution_amount, recipient)
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
    /// Enforces that caller is the registered sponsor, sets remaining_pool to 0,
    /// marks status as 'completed', transfers unclaimed balance to sponsor,
    /// and emits pool_reclaimed event.
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
        status.remaining_pool = 0;
        status.status = Symbol::new(&env, "completed");
        env.storage().persistent().set(&key, &status);

        if unclaimed > 0 {
            token::Client::new(&env, &status.token).transfer(
                &env.current_contract_address(),
                &sponsor,
                &unclaimed,
            );

            env.events().publish(
                (Symbol::new(&env, "pool_reclaimed"), status.campaign_id),
                (sponsor, unclaimed),
            );
            status.status = Symbol::new(&env, "completed");
            env.storage().persistent().set(&key, &status);
        }

        unclaimed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};

    struct TestFixture {
        env: Env,
        sponsor: Address,
        authorized_caller: Address,
        recipient: Address,
        token_id: Address,
        token_client: TokenClient<'static>,
        token_admin_client: StellarAssetClient<'static>,
        client: MatchingPoolContractClient<'static>,
    }

    fn setup_fixture(total_pool: i128) -> TestFixture {
        let env = Env::default();
        env.mock_all_auths();

        let sponsor = Address::generate(&env);
        let authorized_caller = Address::generate(&env);
        let recipient = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_client = TokenClient::new(&env, &token_id);
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        if total_pool > 0 {
            token_admin_client.mint(&sponsor, &total_pool);
        }

        let contract_id = env.register_contract(None, MatchingPoolContract);
        let client = MatchingPoolContractClient::new(&env, &contract_id);

        TestFixture {
            env,
            sponsor,
            authorized_caller,
            recipient,
            token_id,
            token_client,
            token_admin_client,
            client,
        }
    }

    #[test]
    fn test_initialize_pool() {
        let f = setup_fixture(1_000);

        f.client.initialize(
            &f.sponsor,
            &f.authorized_caller,
            &f.token_id,
            &42,
            &100, // 1:1 match
            &1_000,
        );

        let status = f.client.get_pool_status();
        assert_eq!(status.campaign_id, 42);
        assert_eq!(status.sponsor, f.sponsor);
        assert_eq!(status.authorized_caller, f.authorized_caller);
        assert_eq!(status.token, f.token_id);
        assert_eq!(status.match_ratio, 100);
        assert_eq!(status.total_pool, 1_000);
        assert_eq!(status.matched_amount, 0);
        assert_eq!(status.remaining_pool, 1_000);
        assert_eq!(status.status, Symbol::new(&f.env, "active"));

        assert_eq!(f.token_client.balance(&f.client.address), 1_000);
        assert_eq!(f.token_client.balance(&f.sponsor), 0);
    }

    #[test]
    fn test_release_match_calculates_ratio_and_transfers_tokens() {
        let f = setup_fixture(1_000);
        f.client.initialize(
            &f.sponsor,
            &f.authorized_caller,
            &f.token_id,
            &10,
            &100, // 1:1
            &1_000,
        );

        // Contribution 250 with 1:1 ratio => match 250
        let matched = f
            .client
            .apply_match(&f.authorized_caller, &250, &f.recipient);
        assert_eq!(matched, 250);

        let status = f.client.get_pool_status();
        assert_eq!(status.matched_amount, 250);
        assert_eq!(status.remaining_pool, 750);
        assert_eq!(status.status, Symbol::new(&f.env, "active"));

        assert_eq!(f.token_client.balance(&f.recipient), 250);
        assert_eq!(f.token_client.balance(&f.client.address), 750);

        // Also test release_match alias
        let matched2 = f
            .client
            .release_match(&f.authorized_caller, &100, &f.recipient);
        assert_eq!(matched2, 100);
        assert_eq!(f.token_client.balance(&f.recipient), 350);
    }

    #[test]
    fn test_release_match_caps_at_pool() {
        let f = setup_fixture(300);
        f.client.initialize(
            &f.sponsor,
            &f.authorized_caller,
            &f.token_id,
            &10,
            &100,
            &300,
        );

        // Contribution 500 would match 500, but only 300 remaining
        let matched = f
            .client
            .apply_match(&f.authorized_caller, &500, &f.recipient);
        assert_eq!(matched, 300);

        let status = f.client.get_pool_status();
        assert_eq!(status.matched_amount, 300);
        assert_eq!(status.remaining_pool, 0);
        assert_eq!(status.status, Symbol::new(&f.env, "exhausted"));

        assert_eq!(f.token_client.balance(&f.recipient), 300);
        assert_eq!(f.token_client.balance(&f.client.address), 0);
    }

    #[test]
    fn test_exhaust_pool() {
        let f = setup_fixture(200);
        f.client.initialize(
            &f.sponsor,
            &f.authorized_caller,
            &f.token_id,
            &10,
            &200, // 2:1 ratio
            &200,
        );

        // Contribution 100 at 2:1 matches 200, exactly exhausting pool
        let matched = f
            .client
            .apply_match(&f.authorized_caller, &100, &f.recipient);
        assert_eq!(matched, 200);

        let status = f.client.get_pool_status();
        assert_eq!(status.status, Symbol::new(&f.env, "exhausted"));
        assert_eq!(status.remaining_pool, 0);

        // Further attempts return 0
        let matched_after = f
            .client
            .apply_match(&f.authorized_caller, &50, &f.recipient);
        assert_eq!(matched_after, 0);
    }

    #[test]
    #[should_panic(expected = "Unauthorized caller")]
    fn test_apply_match_rejects_unauthorized_caller() {
        let f = setup_fixture(1_000);
        f.client.initialize(
            &f.sponsor,
            &f.authorized_caller,
            &f.token_id,
            &10,
            &100,
            &1_000,
        );

        let attacker = Address::generate(&f.env);
        // Attacker attempts to apply match
        f.client.apply_match(&attacker, &100, &attacker);
    }

    #[test]
    #[should_panic]
    fn test_apply_match_requires_auth() {
        let env = Env::default();
        let sponsor = Address::generate(&env);
        let authorized_caller = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();

        let contract_id = env.register_contract(None, MatchingPoolContract);
        let client = MatchingPoolContractClient::new(&env, &contract_id);

        env.mock_all_auths();
        client.initialize(&sponsor, &authorized_caller, &token_id, &1, &100, &0);

        // Call without auth mocking
        let unauthed_env = Env::default();
        let unauthed_client = MatchingPoolContractClient::new(&unauthed_env, &contract_id);
        unauthed_client.apply_match(&authorized_caller, &100, &recipient);
    }

    #[test]
    fn test_reclaim_unmatched_and_zeros_out_pool() {
        let f = setup_fixture(1_000);
        f.client.initialize(
            &f.sponsor,
            &f.authorized_caller,
            &f.token_id,
            &10,
            &100,
            &1_000,
        );

        // Match 400
        f.client
            .apply_match(&f.authorized_caller, &400, &f.recipient);

        // Sponsor reclaims remaining 600
        let reclaimed = f.client.reclaim(&f.sponsor);
        assert_eq!(reclaimed, 600);

        let status = f.client.get_pool_status();
        assert_eq!(status.remaining_pool, 0); // Must be zeroed out
        assert_eq!(status.status, Symbol::new(&f.env, "completed"));

        assert_eq!(f.token_client.balance(&f.sponsor), 600);
        assert_eq!(f.token_client.balance(&f.client.address), 0);

        // Second reclaim must return 0 and not fail
        let second_reclaim = f.client.reclaim(&f.sponsor);
        assert_eq!(second_reclaim, 0);
        let status2 = f.client.get_pool_status();
        assert_eq!(status2.remaining_pool, 0);
    }

    #[test]
    #[should_panic(expected = "Unauthorized sponsor")]
    fn test_reclaim_rejects_unauthorized_sponsor() {
        let f = setup_fixture(1_000);
        f.client.initialize(
            &f.sponsor,
            &f.authorized_caller,
            &f.token_id,
            &10,
            &100,
            &1_000,
        );

        let attacker = Address::generate(&f.env);
        // Attacker attempts to reclaim sponsor's pool
        f.client.reclaim(&attacker);
    }

    #[test]
    #[should_panic]
    fn test_reclaim_requires_auth() {
        let env = Env::default();
        let sponsor = Address::generate(&env);
        let authorized_caller = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();

        let contract_id = env.register_contract(None, MatchingPoolContract);
        let client = MatchingPoolContractClient::new(&env, &contract_id);

        env.mock_all_auths();
        client.initialize(&sponsor, &authorized_caller, &token_id, &1, &100, &0);

        // Call without auth mocking
        let unauthed_env = Env::default();
        let unauthed_client = MatchingPoolContractClient::new(&unauthed_env, &contract_id);
        unauthed_client.reclaim(&sponsor);
    }

    #[test]
    fn test_deposit_additional_funds() {
        let f = setup_fixture(500);
        f.client.initialize(
            &f.sponsor,
            &f.authorized_caller,
            &f.token_id,
            &10,
            &100,
            &500,
        );

        f.token_admin_client.mint(&f.sponsor, &500);
        f.client.deposit(&f.sponsor, &500);

        let status = f.client.get_pool_status();
        assert_eq!(status.total_pool, 1_000);
        assert_eq!(status.remaining_pool, 1_000);
        assert_eq!(f.token_client.balance(&f.client.address), 1_000);
    }
}
mod test;
