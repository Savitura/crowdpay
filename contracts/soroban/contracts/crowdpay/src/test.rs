#![cfg(test)]

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{token, Address, Env, Vec, symbol_short};

fn setup_test(env: &Env) -> (Address, Address, token::Client, token::StellarAssetClient, CrowdPayContractClient) {
    let creator = Address::generate(env);
    let token_admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract(token_admin);
    let token = token::Client::new(env, &token_id);
    let token_admin_client = token::StellarAssetClient::new(env, &token_id);

    let contract_id = env.register_contract(None, CrowdPayContract);
    let client = CrowdPayContractClient::new(env, &contract_id);

    (creator, token_id, token, token_admin_client, client)
}

#[test]
fn test_initialize() {
    let env = Env::default();
    let (creator, token_id, _token, _token_admin, client) = setup_test(&env);

    let milestones = Vec::from_array(&env, [
        Milestone { target: 1000, released: false },
        Milestone { target: 2000, released: false },
    ]);

    client.initialize(
        &symbol_short!("cp1"),
        &creator,
        &token_id,
        &2000,
        &10000,
        &milestones,
    );

    assert_eq!(client.get_status(), symbol_short!("Active"));
}

#[test]
fn test_contribute_and_goal_reached() {
    let env = Env::default();
    let (creator, token_id, token, token_admin, client) = setup_test(&env);
    let contributor = Address::generate(&env);

    let milestones = Vec::from_array(&env, [Milestone { target: 1000, released: false }]);
    client.initialize(&symbol_short!("cp1"), &creator, &token_id, &1000, &10000, &milestones);

    token_admin.mock_all_auths().mint(&contributor, &1000);
    client.mock_all_auths().contribute(&contributor, &1000);

    assert_eq!(client.get_status(), symbol_short!("Funded"));
    assert_eq!(client.get_total_raised(), 1000);
    assert_eq!(token.balance(&client.address), 1000);
}

#[test]
fn test_milestone_release() {
    let env = Env::default();
    let (creator, token_id, token, token_admin, client) = setup_test(&env);
    let contributor = Address::generate(&env);

    let milestones = Vec::from_array(&env, [Milestone { target: 1000, released: false }]);
    client.initialize(&symbol_short!("cp1"), &creator, &token_id, &1000, &10000, &milestones);

    token_admin.mock_all_auths().mint(&contributor, &1000);
    client.mock_all_auths().contribute(&contributor, &1000);

    client.mock_all_auths().release_milestone(&0);
    assert_eq!(token.balance(&creator), 1000);
    assert_eq!(token.balance(&client.address), 0);
}

#[test]
#[should_panic(expected = "Milestone target not met")]
fn test_milestone_release_fails_if_target_not_met() {
    let env = Env::default();
    let (creator, token_id, token, token_admin, client) = setup_test(&env);
    let contributor = Address::generate(&env);

    let milestones = Vec::from_array(&env, [Milestone { target: 1000, released: false }]);
    client.initialize(&symbol_short!("cp1"), &creator, &token_id, &1000, &10000, &milestones);

    token_admin.mock_all_auths().mint(&contributor, &500);
    client.mock_all_auths().contribute(&contributor, &500);

    client.mock_all_auths().release_milestone(&0);
}

#[test]
fn test_refund_after_failure() {
    let env = Env::default();
    let (creator, token_id, token, token_admin, client) = setup_test(&env);
    let contributor = Address::generate(&env);

    let milestones = Vec::from_array(&env, [Milestone { target: 1000, released: false }]);
    client.initialize(&symbol_short!("cp1"), &creator, &token_id, &1000, &100, &milestones);

    token_admin.mock_all_auths().mint(&contributor, &500);
    client.mock_all_auths().contribute(&contributor, &500);

    // Advance time
    env.ledger().set_timestamp(101);
    client.set_failed();
    assert_eq!(client.get_status(), symbol_short!("Failed"));

    client.mock_all_auths().refund(&contributor);
    assert_eq!(token.balance(&contributor), 500);
    assert_eq!(token.balance(&client.address), 0);
}

#[test]
#[should_panic(expected = "Campaign has not failed")]
fn test_refund_fails_if_active() {
    let env = Env::default();
    let (creator, token_id, token, token_admin, client) = setup_test(&env);
    let contributor = Address::generate(&env);

    let milestones = Vec::from_array(&env, [Milestone { target: 1000, released: false }]);
    client.initialize(&symbol_short!("cp1"), &creator, &token_id, &1000, &10000, &milestones);

    token_admin.mock_all_auths().mint(&contributor, &500);
    client.mock_all_auths().contribute(&contributor, &500);

    client.mock_all_auths().refund(&contributor);
}
