use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env};

fn setup_pool(env: &Env) -> (Address, MatchingPoolContractClient<'_>) {
    let contract_id = env.register_contract(None, MatchingPoolContract);
    let client = MatchingPoolContractClient::new(env, &contract_id);
    (contract_id, client)
}

#[test]
fn test_initialize_pool() {
    let env = Env::default();
    env.mock_all_auths();
    let (_contract_id, client) = setup_pool(&env);
    let sponsor = Address::generate(&env);

    client.initialize(&sponsor, &12345, &100);

    let status = client.get_pool_status();
    assert_eq!(status.campaign_id, 12345);
    assert_eq!(status.sponsor, sponsor);
    assert_eq!(status.match_ratio, 100);
    assert_eq!(status.total_pool, 0);
    assert_eq!(status.matched_amount, 0);
    assert_eq!(status.remaining_pool, 0);
    assert_eq!(status.status, Symbol::new(&env, "active"));
}

#[test]
fn test_double_initialize_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (_contract_id, client) = setup_pool(&env);
    let sponsor = Address::generate(&env);

    assert!(client.try_initialize(&sponsor, &12345, &100).is_ok());
    assert_eq!(
        client.try_initialize(&sponsor, &12345, &100),
        Err(Ok(MatchingPoolError::AlreadyInitialized))
    );
}

#[test]
fn test_deposit_and_status() {
    let env = Env::default();
    env.mock_all_auths();
    let (_contract_id, client) = setup_pool(&env);
    let sponsor = Address::generate(&env);

    client.initialize(&sponsor, &12345, &100);
    client.deposit(&sponsor, &500_000);

    let status = client.get_pool_status();
    assert_eq!(status.total_pool, 500_000);
    assert_eq!(status.remaining_pool, 500_000);
    assert_eq!(status.matched_amount, 0);
    assert_eq!(status.status, Symbol::new(&env, "active"));
}

#[test]
fn test_match_ratio_calculation() {
    let env = Env::default();
    env.mock_all_auths();
    let (_contract_id, client) = setup_pool(&env);
    let sponsor = Address::generate(&env);
    let recipient = Address::generate(&env);

    // 2:1 ratio (200)
    client.initialize(&sponsor, &100, &200);
    client.deposit(&sponsor, &10_000);

    // Contribution of 1,000 matches 2,000
    let matched = client.release_match(&1_000, &recipient);
    assert_eq!(matched, 2_000);

    let status = client.get_pool_status();
    assert_eq!(status.matched_amount, 2_000);
    assert_eq!(status.remaining_pool, 8_000);
}

#[test]
fn test_pool_exhaustion() {
    let env = Env::default();
    env.mock_all_auths();
    let (_contract_id, client) = setup_pool(&env);
    let sponsor = Address::generate(&env);
    let recipient = Address::generate(&env);

    // 1:1 ratio (100) with pool of 500
    client.initialize(&sponsor, &101, &100);
    client.deposit(&sponsor, &500);

    // Contribution of 600 only matches 500 (capped at remaining pool)
    let matched1 = client.release_match(&600, &recipient);
    assert_eq!(matched1, 500);

    let status = client.get_pool_status();
    assert_eq!(status.matched_amount, 500);
    assert_eq!(status.remaining_pool, 0);
    assert_eq!(status.status, Symbol::new(&env, "exhausted"));

    // Next match returns 0 because pool is exhausted
    let matched2 = client.release_match(&100, &recipient);
    assert_eq!(matched2, 0);
}

#[test]
fn test_unauthorized_reclaim_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (_contract_id, client) = setup_pool(&env);
    let sponsor = Address::generate(&env);
    let attacker = Address::generate(&env);

    client.initialize(&sponsor, &102, &100);
    client.deposit(&sponsor, &1_000);

    // Attacker tries to reclaim funds
    let res = client.try_reclaim(&attacker);
    assert_eq!(res, Err(Ok(MatchingPoolError::Unauthorized)));
}

#[test]
fn test_sponsor_reclaim() {
    let env = Env::default();
    env.mock_all_auths();
    let (_contract_id, client) = setup_pool(&env);
    let sponsor = Address::generate(&env);
    let recipient = Address::generate(&env);

    client.initialize(&sponsor, &103, &100);
    client.deposit(&sponsor, &1_000);

    // Match 400
    let matched = client.release_match(&400, &recipient);
    assert_eq!(matched, 400);

    // Sponsor reclaims the remaining 600
    let reclaimed = client.reclaim(&sponsor);
    assert_eq!(reclaimed, 600);

    let status = client.get_pool_status();
    assert_eq!(status.remaining_pool, 0);
    assert_eq!(status.matched_amount, 400);
    assert_eq!(status.status, Symbol::new(&env, "completed"));

    // Subsequent reclaim yields 0
    let reclaimed_again = client.reclaim(&sponsor);
    assert_eq!(reclaimed_again, 0);
}
