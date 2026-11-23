use matching_pool::{MatchingPoolContract, MatchingPoolContractClient};
use soroban_sdk::{testutils::Address as _, Address, Env, Symbol};

fn setup(
    env: &Env,
    campaign_id: u64,
    match_ratio: i128,
) -> (Address, MatchingPoolContractClient<'_>) {
    let sponsor = Address::generate(env);
    let contract_id = env.register_contract(None, MatchingPoolContract);
    let client = MatchingPoolContractClient::new(env, &contract_id);
    client.initialize(&sponsor, &campaign_id, &match_ratio);
    (sponsor, client)
}

fn funded_setup(
    env: &Env,
    match_ratio: i128,
    amount: i128,
) -> (Address, Address, MatchingPoolContractClient<'_>) {
    let (sponsor, client) = setup(env, 7, match_ratio);
    let recipient = Address::generate(env);
    client.fund(&sponsor, &amount);
    (sponsor, recipient, client)
}

#[test]
fn initialization_records_sponsor_campaign_and_ratio() {
    let env = Env::default();
    env.mock_all_auths();
    let sponsor = Address::generate(&env);
    let contract_id = env.register_contract(None, MatchingPoolContract);
    let client = MatchingPoolContractClient::new(&env, &contract_id);

    client.initialize(&sponsor, &42u64, &150);

    let status = client.get_pool_status();
    assert_eq!(status.campaign_id, 42);
    assert_eq!(status.sponsor, sponsor);
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
    let contract_id = env.register_contract(None, MatchingPoolContract);
    let client = MatchingPoolContractClient::new(&env, &contract_id);

    assert!(client.try_initialize(&sponsor, &1u64, &100).is_err());
}

#[test]
fn fund_records_pledge_for_sponsor() {
    let env = Env::default();
    env.mock_all_auths();
    let (sponsor, client) = setup(&env, 1, 100);

    assert_eq!(client.fund(&sponsor, &1_000), 1_000);
    assert_eq!(client.fund(&sponsor, &500), 1_500);

    let status = client.get_pool_status();
    assert_eq!(status.total_pool, 1_500);
    assert_eq!(status.remaining_pool, 1_500);
    assert_eq!(status.matched_amount, 0);
    assert_eq!(status.status, Symbol::new(&env, "active"));
}

#[test]
fn fund_requires_sponsor_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let (sponsor, client) = setup(&env, 1, 100);
    env.set_auths(&[]);

    assert!(client.try_fund(&sponsor, &1_000).is_err());
    assert_eq!(client.get_pool_status().total_pool, 0);
}

#[test]
fn fund_rejects_non_sponsor_even_with_mocked_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let (_sponsor, client) = setup(&env, 1, 100);
    let attacker = Address::generate(&env);

    assert!(client.try_fund(&attacker, &1_000).is_err());
    assert_eq!(client.get_pool_status().total_pool, 0);
}

#[test]
fn fund_rejects_non_positive_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let (sponsor, client) = setup(&env, 1, 100);

    assert!(client.try_fund(&sponsor, &0).is_err());
    assert!(client.try_fund(&sponsor, &-1).is_err());
    assert_eq!(client.get_pool_status().total_pool, 0);
}

#[test]
fn release_match_applies_one_to_one_ratio() {
    let env = Env::default();
    env.mock_all_auths();
    let (_sponsor, recipient, client) = funded_setup(&env, 100, 10_000);

    assert_eq!(client.release_match(&1_000, &recipient), 1_000);

    let status = client.get_pool_status();
    assert_eq!(status.matched_amount, 1_000);
    assert_eq!(status.remaining_pool, 9_000);
    assert_eq!(status.status, Symbol::new(&env, "active"));
}

#[test]
fn release_match_applies_two_to_one_ratio() {
    let env = Env::default();
    env.mock_all_auths();
    let (_sponsor, recipient, client) = funded_setup(&env, 200, 10_000);

    assert_eq!(client.release_match(&1_500, &recipient), 3_000);

    let status = client.get_pool_status();
    assert_eq!(status.matched_amount, 3_000);
    assert_eq!(status.remaining_pool, 7_000);
}

#[test]
fn release_match_caps_at_remaining_pool_and_marks_exhausted() {
    let env = Env::default();
    env.mock_all_auths();
    let (_sponsor, recipient, client) = funded_setup(&env, 100, 500);

    assert_eq!(client.release_match(&600, &recipient), 500);

    let status = client.get_pool_status();
    assert_eq!(status.matched_amount, 500);
    assert_eq!(status.remaining_pool, 0);
    assert_eq!(status.total_pool, 500);
    assert_eq!(status.status, Symbol::new(&env, "exhausted"));
}

#[test]
fn repeated_releases_exhaust_pool_and_return_zero_afterwards() {
    let env = Env::default();
    env.mock_all_auths();
    let (_sponsor, recipient, client) = funded_setup(&env, 100, 1_000);

    assert_eq!(client.release_match(&400, &recipient), 400);
    assert_eq!(client.release_match(&400, &recipient), 400);
    assert_eq!(client.get_pool_status().status, Symbol::new(&env, "active"));

    assert_eq!(client.release_match(&400, &recipient), 200);
    assert_eq!(
        client.get_pool_status().status,
        Symbol::new(&env, "exhausted")
    );

    assert_eq!(client.release_match(&400, &recipient), 0);
    let status = client.get_pool_status();
    assert_eq!(status.matched_amount, 1_000);
    assert_eq!(status.remaining_pool, 0);
}

#[test]
fn release_match_on_empty_pool_returns_zero() {
    let env = Env::default();
    env.mock_all_auths();
    let (_sponsor, client) = setup(&env, 1, 100);
    let recipient = Address::generate(&env);

    assert_eq!(client.release_match(&1_000, &recipient), 0);

    let status = client.get_pool_status();
    assert_eq!(status.matched_amount, 0);
    assert_eq!(status.remaining_pool, 0);
    assert_eq!(status.status, Symbol::new(&env, "active"));
}

#[test]
fn reclaim_returns_unmatched_funds_and_marks_completed() {
    let env = Env::default();
    env.mock_all_auths();
    let (sponsor, recipient, client) = funded_setup(&env, 100, 1_000);
    client.release_match(&400, &recipient);

    assert_eq!(client.reclaim(&sponsor), 600);

    let status = client.get_pool_status();
    assert_eq!(status.remaining_pool, 600);
    assert_eq!(status.matched_amount, 400);
    assert_eq!(status.status, Symbol::new(&env, "completed"));
}

#[test]
fn reclaim_requires_sponsor_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let (sponsor, _recipient, client) = funded_setup(&env, 100, 1_000);
    env.set_auths(&[]);

    assert!(client.try_reclaim(&sponsor).is_err());
    assert_eq!(client.get_pool_status().status, Symbol::new(&env, "active"));
}

#[test]
fn reclaim_rejects_non_sponsor_even_with_mocked_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let (_sponsor, _recipient, client) = funded_setup(&env, 100, 1_000);
    let attacker = Address::generate(&env);

    assert!(client.try_reclaim(&attacker).is_err());
    assert_eq!(client.get_pool_status().status, Symbol::new(&env, "active"));
}

#[test]
fn reclaim_returns_zero_when_pool_is_exhausted() {
    let env = Env::default();
    env.mock_all_auths();
    let (sponsor, recipient, client) = funded_setup(&env, 100, 500);
    client.release_match(&500, &recipient);

    assert_eq!(client.reclaim(&sponsor), 0);
    assert_eq!(
        client.get_pool_status().status,
        Symbol::new(&env, "exhausted")
    );
}
