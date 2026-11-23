use matching_pool::{MatchingPoolContract, MatchingPoolContractClient, MatchingPoolError};
use soroban_sdk::{testutils::Address as _, Address, Env, Symbol};

fn setup_pool(env: &Env) -> (Address, MatchingPoolContractClient<'_>) {
    let contract_id = env.register_contract(None, MatchingPoolContract);
    let client = MatchingPoolContractClient::new(env, &contract_id);
    (contract_id, client)
}

#[test]
fn test_integration_full_lifecycle() {
    let env = Env::default();
    env.mock_all_auths();
    let (_contract_id, client) = setup_pool(&env);

    let sponsor = Address::generate(&env);
    let _donor_1 = Address::generate(&env);
    let _donor_2 = Address::generate(&env);
    let campaign_wallet = Address::generate(&env);

    // 1. Initialize pool: campaign 999, 1:1 match ratio (100)
    client.initialize(&sponsor, &999, &100);

    // 2. Sponsor deposits 5,000 stroops
    client.deposit(&sponsor, &5_000);

    let initial_status = client.get_pool_status();
    assert_eq!(initial_status.total_pool, 5_000);
    assert_eq!(initial_status.remaining_pool, 5_000);

    // 3. First donor contributes 2,000 -> 2,000 matched
    let match1 = client.release_match(&2_000, &campaign_wallet);
    assert_eq!(match1, 2_000);

    // 4. Second donor contributes 4,000 -> only 3,000 remaining in pool, so 3,000 matched
    let match2 = client.release_match(&4_000, &campaign_wallet);
    assert_eq!(match2, 3_000);

    // 5. Pool is exhausted
    let status_exhausted = client.get_pool_status();
    assert_eq!(status_exhausted.remaining_pool, 0);
    assert_eq!(status_exhausted.matched_amount, 5_000);
    assert_eq!(status_exhausted.status, Symbol::new(&env, "exhausted"));

    // 6. Third donor contributes 1,000 -> 0 matched
    let match3 = client.release_match(&1_000, &campaign_wallet);
    assert_eq!(match3, 0);

    // 7. Reclaim when empty returns 0
    let reclaimed = client.reclaim(&sponsor);
    assert_eq!(reclaimed, 0);
}

#[test]
fn test_integration_partial_match_and_reclaim() {
    let env = Env::default();
    env.mock_all_auths();
    let (_contract_id, client) = setup_pool(&env);

    let sponsor = Address::generate(&env);
    let recipient = Address::generate(&env);
    let non_sponsor = Address::generate(&env);

    // 1. Initialize with 2:1 ratio (200)
    client.initialize(&sponsor, &888, &200);
    client.deposit(&sponsor, &10_000);

    // 2. Release match: 3,000 contribution -> 6,000 match
    let matched = client.release_match(&3_000, &recipient);
    assert_eq!(matched, 6_000);

    let mid_status = client.get_pool_status();
    assert_eq!(mid_status.remaining_pool, 4_000);

    // 3. Non-sponsor tries to reclaim -> rejected
    let unauthorized_err = client.try_reclaim(&non_sponsor);
    assert_eq!(unauthorized_err, Err(Ok(MatchingPoolError::Unauthorized)));

    // 4. Sponsor reclaims remaining 4,000
    let reclaimed = client.reclaim(&sponsor);
    assert_eq!(reclaimed, 4_000);

    let final_status = client.get_pool_status();
    assert_eq!(final_status.remaining_pool, 0);
    assert_eq!(final_status.status, Symbol::new(&env, "completed"));
}
