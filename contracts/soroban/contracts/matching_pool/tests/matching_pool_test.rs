use matching_pool::{MatchingPoolContract, MatchingPoolContractClient, STORAGE_TTL_LEDGERS};
use soroban_sdk::testutils::storage::{Instance as _, Persistent as _};
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};
use soroban_sdk::{Address, Env, Symbol};

struct Fixture<'a> {
    sponsor: Address,
    caller: Address,
    recipient: Address,
    token_id: Address,
    token: TokenClient<'a>,
    token_admin: StellarAssetClient<'a>,
    client: MatchingPoolContractClient<'a>,
}

/// Registers a pool for campaign 7 with `initial` tokens pulled from the
/// sponsor. The sponsor is minted `initial + spare` so tests can top up later.
fn setup(env: &Env, match_ratio: i128, initial: i128, spare: i128) -> Fixture<'_> {
    let sponsor = Address::generate(env);
    let caller = Address::generate(env);
    let recipient = Address::generate(env);

    let token_id = env
        .register_stellar_asset_contract_v2(Address::generate(env))
        .address();
    let token = TokenClient::new(env, &token_id);
    let token_admin = StellarAssetClient::new(env, &token_id);
    if initial + spare > 0 {
        token_admin.mint(&sponsor, &(initial + spare));
    }

    let contract_id = env.register_contract(None, MatchingPoolContract);
    let client = MatchingPoolContractClient::new(env, &contract_id);
    client.initialize(&sponsor, &caller, &token_id, &7u64, &match_ratio, &initial);

    Fixture {
        sponsor,
        caller,
        recipient,
        token_id,
        token,
        token_admin,
        client,
    }
}

#[test]
fn initialization_records_sponsor_campaign_and_ratio() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env, 150, 0, 0);

    let status = f.client.get_pool_status();
    assert_eq!(status.campaign_id, 7);
    assert_eq!(status.sponsor, f.sponsor);
    assert_eq!(status.authorized_caller, f.caller);
    assert_eq!(status.token, f.token_id);
    assert_eq!(status.match_ratio, 150);
    assert_eq!(status.total_pool, 0);
    assert_eq!(status.matched_amount, 0);
    assert_eq!(status.remaining_pool, 0);
    assert_eq!(status.status, Symbol::new(&env, "active"));
}

#[test]
fn initialization_requires_sponsor_auth() {
    let env = Env::default();
    let sponsor = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let contract_id = env.register_contract(None, MatchingPoolContract);
    let client = MatchingPoolContractClient::new(&env, &contract_id);

    assert!(client
        .try_initialize(
            &sponsor,
            &Address::generate(&env),
            &token_id,
            &1u64,
            &100,
            &0
        )
        .is_err());
}

#[test]
fn fund_records_pledge_for_sponsor() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env, 100, 0, 1_500);

    assert_eq!(f.client.fund(&f.sponsor, &1_000), 1_000);
    assert_eq!(f.client.fund(&f.sponsor, &500), 1_500);

    let status = f.client.get_pool_status();
    assert_eq!(status.total_pool, 1_500);
    assert_eq!(status.remaining_pool, 1_500);
    assert_eq!(status.matched_amount, 0);
    assert_eq!(status.status, Symbol::new(&env, "active"));
    assert_eq!(f.token.balance(&f.client.address), 1_500);
    assert_eq!(f.token.balance(&f.sponsor), 0);
}

#[test]
fn fund_requires_sponsor_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env, 100, 0, 1_000);
    env.set_auths(&[]);

    assert!(f.client.try_fund(&f.sponsor, &1_000).is_err());
    assert_eq!(f.client.get_pool_status().total_pool, 0);
}

#[test]
fn fund_rejects_non_sponsor_even_with_mocked_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env, 100, 0, 0);
    let attacker = Address::generate(&env);
    f.token_admin.mint(&attacker, &1_000);

    assert!(f.client.try_fund(&attacker, &1_000).is_err());
    assert_eq!(f.client.get_pool_status().total_pool, 0);
}

#[test]
fn fund_rejects_non_positive_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env, 100, 0, 0);

    assert!(f.client.try_fund(&f.sponsor, &0).is_err());
    assert!(f.client.try_fund(&f.sponsor, &-1).is_err());
    assert_eq!(f.client.get_pool_status().total_pool, 0);
}

#[test]
fn release_match_applies_one_to_one_ratio() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env, 100, 10_000, 0);

    assert_eq!(
        f.client.release_match(&f.caller, &1_000, &f.recipient),
        1_000
    );

    let status = f.client.get_pool_status();
    assert_eq!(status.matched_amount, 1_000);
    assert_eq!(status.remaining_pool, 9_000);
    assert_eq!(status.status, Symbol::new(&env, "active"));
    assert_eq!(f.token.balance(&f.recipient), 1_000);
}

#[test]
fn release_match_applies_two_to_one_ratio() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env, 200, 10_000, 0);

    assert_eq!(
        f.client.release_match(&f.caller, &1_500, &f.recipient),
        3_000
    );

    let status = f.client.get_pool_status();
    assert_eq!(status.matched_amount, 3_000);
    assert_eq!(status.remaining_pool, 7_000);
}

#[test]
fn release_match_caps_at_remaining_pool_and_marks_exhausted() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env, 100, 500, 0);

    assert_eq!(f.client.release_match(&f.caller, &600, &f.recipient), 500);

    let status = f.client.get_pool_status();
    assert_eq!(status.matched_amount, 500);
    assert_eq!(status.remaining_pool, 0);
    assert_eq!(status.total_pool, 500);
    assert_eq!(status.status, Symbol::new(&env, "exhausted"));
}

#[test]
fn repeated_releases_exhaust_pool_and_return_zero_afterwards() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env, 100, 1_000, 0);

    assert_eq!(f.client.release_match(&f.caller, &400, &f.recipient), 400);
    assert_eq!(f.client.release_match(&f.caller, &400, &f.recipient), 400);
    assert_eq!(
        f.client.get_pool_status().status,
        Symbol::new(&env, "active")
    );

    assert_eq!(f.client.release_match(&f.caller, &400, &f.recipient), 200);
    assert_eq!(
        f.client.get_pool_status().status,
        Symbol::new(&env, "exhausted")
    );

    assert_eq!(f.client.release_match(&f.caller, &400, &f.recipient), 0);
    let status = f.client.get_pool_status();
    assert_eq!(status.matched_amount, 1_000);
    assert_eq!(status.remaining_pool, 0);
    assert_eq!(f.token.balance(&f.recipient), 1_000);
}

#[test]
fn release_match_on_empty_pool_returns_zero() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env, 100, 0, 0);

    assert_eq!(f.client.release_match(&f.caller, &1_000, &f.recipient), 0);

    let status = f.client.get_pool_status();
    assert_eq!(status.matched_amount, 0);
    assert_eq!(status.remaining_pool, 0);
    assert_eq!(status.status, Symbol::new(&env, "active"));
}

#[test]
fn release_match_ignores_non_positive_contribution() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env, 100, 1_000, 0);

    assert_eq!(f.client.release_match(&f.caller, &0, &f.recipient), 0);
    assert_eq!(f.client.release_match(&f.caller, &-50, &f.recipient), 0);
    assert_eq!(f.client.get_pool_status().remaining_pool, 1_000);
}

#[test]
fn deposit_reactivates_exhausted_pool() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env, 100, 500, 300);
    f.client.release_match(&f.caller, &500, &f.recipient);
    assert_eq!(
        f.client.get_pool_status().status,
        Symbol::new(&env, "exhausted")
    );

    f.client.deposit(&f.sponsor, &300);

    let status = f.client.get_pool_status();
    assert_eq!(status.status, Symbol::new(&env, "active"));
    assert_eq!(status.total_pool, 800);
    assert_eq!(status.remaining_pool, 300);
}

#[test]
fn reclaim_returns_unmatched_funds_and_marks_completed() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env, 100, 1_000, 0);
    f.client.release_match(&f.caller, &400, &f.recipient);

    assert_eq!(f.client.reclaim(&f.sponsor), 600);

    let status = f.client.get_pool_status();
    assert_eq!(status.remaining_pool, 0);
    assert_eq!(status.matched_amount, 400);
    assert_eq!(status.status, Symbol::new(&env, "completed"));
    assert_eq!(f.token.balance(&f.sponsor), 600);

    // A completed pool matches nothing further.
    assert_eq!(f.client.release_match(&f.caller, &100, &f.recipient), 0);
}

#[test]
fn reclaim_requires_sponsor_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env, 100, 1_000, 0);
    env.set_auths(&[]);

    assert!(f.client.try_reclaim(&f.sponsor).is_err());
    assert_eq!(
        f.client.get_pool_status().status,
        Symbol::new(&env, "active")
    );
}

#[test]
fn reclaim_rejects_non_sponsor_even_with_mocked_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env, 100, 1_000, 0);
    let attacker = Address::generate(&env);

    assert!(f.client.try_reclaim(&attacker).is_err());
    assert_eq!(
        f.client.get_pool_status().status,
        Symbol::new(&env, "active")
    );
}

#[test]
fn reclaim_returns_zero_when_pool_is_exhausted() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env, 100, 500, 0);
    f.client.release_match(&f.caller, &500, &f.recipient);

    assert_eq!(f.client.reclaim(&f.sponsor), 0);
    assert_eq!(
        f.client.get_pool_status().status,
        Symbol::new(&env, "completed")
    );
}

#[test]
fn pool_state_survives_past_default_ttl() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env, 100, 1_000, 0);
    f.client.release_match(&f.caller, &250, &f.recipient);

    env.as_contract(&f.client.address, || {
        let key = Symbol::new(&env, "state");
        assert!(env.storage().persistent().get_ttl(&key) >= STORAGE_TTL_LEDGERS - 1);
        assert!(env.storage().instance().get_ttl() >= STORAGE_TTL_LEDGERS - 1);
    });

    // Jump far past the default persistent TTL. Keep the test token alive; only
    // the pool's own storage is under test.
    let jump = env.ledger().get().min_persistent_entry_ttl * 100;
    env.as_contract(&f.token_id, || {
        env.storage()
            .instance()
            .extend_ttl(jump + 1000, jump + 1000);
    });
    env.ledger().with_mut(|li| li.sequence_number += jump);

    let status = f.client.get_pool_status();
    assert_eq!(status.matched_amount, 250);
    assert_eq!(status.remaining_pool, 750);

    assert_eq!(f.client.reclaim(&f.sponsor), 750);
    assert_eq!(f.token.balance(&f.sponsor), 750);
}
