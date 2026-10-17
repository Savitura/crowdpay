#![cfg(test)]

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke};
use soroban_sdk::testutils::storage::{Instance as _, Persistent as _};
use soroban_sdk::IntoVal;
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
        Milestone { target: 1000, amount: 1000, released: false },
        Milestone { target: 2000, amount: 1000, released: false },
    ]);

    client.mock_all_auths().initialize(
        &symbol_short!("cp1"),
        &creator,
        &Address::generate(&env),
        &token_id,
        &2000,
        &10000,
        &milestones,
    );

    assert_eq!(client.get_status(), symbol_short!("Active"));
}

#[test]
#[should_panic]
fn test_initialize_requires_creator_auth() {
    let env = Env::default();
    let (creator, token_id, _token, _token_admin, client) = setup_test(&env);

    let milestones = Vec::from_array(&env, [
        Milestone { target: 1000, amount: 1000, released: false },
    ]);

    client.initialize(
        &symbol_short!("cp1"),
        &creator,
        &Address::generate(&env),
        &token_id,
        &1000,
        &10000,
        &milestones,
    );
}

#[test]
#[should_panic(expected = "Already initialized")]
fn test_double_initialization_rejection() {
    let env = Env::default();
    let (creator, token_id, _token, _token_admin, client) = setup_test(&env);

    let milestones = Vec::from_array(&env, [
        Milestone { target: 1000, amount: 1000, released: false },
    ]);

    client.mock_all_auths().initialize(&symbol_short!("cp1"), &creator, &Address::generate(&env), &token_id, &1000, &10000, &milestones);
    client.mock_all_auths().initialize(&symbol_short!("cp1"), &creator, &Address::generate(&env), &token_id, &1000, &10000, &milestones);
}

#[test]
fn test_contribute_and_goal_reached() {
    let env = Env::default();
    let (creator, token_id, token, token_admin, client) = setup_test(&env);
    let contributor = Address::generate(&env);

    let milestones = Vec::from_array(&env, [Milestone { target: 1000, amount: 1000, released: false }]);
    client.mock_all_auths().initialize(&symbol_short!("cp1"), &creator, &Address::generate(&env), &token_id, &1000, &10000, &milestones);

    token_admin.mock_all_auths().mint(&contributor, &1000);
    client.mock_all_auths().contribute(&contributor, &1000);

    assert_eq!(client.get_status(), symbol_short!("Funded"));
    assert_eq!(client.get_total_raised(), 1000);
    assert_eq!(token.balance(&client.address), 1000);
}

#[test]
#[should_panic(expected = "Deadline passed")]
fn test_contribute_after_deadline_fails() {
    let env = Env::default();
    let (creator, token_id, _token, token_admin, client) = setup_test(&env);
    let contributor = Address::generate(&env);

    let milestones = Vec::from_array(&env, [Milestone { target: 1000, amount: 1000, released: false }]);
    client.mock_all_auths().initialize(&symbol_short!("cp1"), &creator, &Address::generate(&env), &token_id, &1000, &1000, &milestones);

    token_admin.mock_all_auths().mint(&contributor, &500);

    // Advance time past deadline
    env.ledger().set_timestamp(1001);
    client.mock_all_auths().contribute(&contributor, &500);
}

#[test]
#[should_panic(expected = "Contribution amount must be positive")]
fn test_contribute_rejects_zero_amount() {
    let env = Env::default();
    let (creator, token_id, token, token_admin, client) = setup_test(&env);
    let contributor = Address::generate(&env);

    let milestones = Vec::from_array(&env, [Milestone { target: 1000, amount: 1000, released: false }]);
    client.mock_all_auths().initialize(&symbol_short!("cp1"), &creator, &Address::generate(&env), &token_id, &1000, &10000, &milestones);

    token_admin.mock_all_auths().mint(&contributor, &100);
    client.mock_all_auths().contribute(&contributor, &0);
}

#[test]
#[should_panic(expected = "Contribution amount must be positive")]
fn test_contribute_rejects_negative_amount() {
    let env = Env::default();
    let (creator, token_id, token, token_admin, client) = setup_test(&env);
    let contributor = Address::generate(&env);

    let milestones = Vec::from_array(&env, [Milestone { target: 1000, amount: 1000, released: false }]);
    client.mock_all_auths().initialize(&symbol_short!("cp1"), &creator, &token_id, &1000, &10000, &milestones);

    token_admin.mock_all_auths().mint(&contributor, &100);
    client.mock_all_auths().contribute(&contributor, &-1);
}

#[test]
fn test_milestone_release() {
    let env = Env::default();
    let (creator, token_id, token, token_admin, client) = setup_test(&env);
    let contributor = Address::generate(&env);

    let milestones = Vec::from_array(&env, [Milestone { target: 1000, amount: 1000, released: false }]);
    client.mock_all_auths().initialize(&symbol_short!("cp1"), &creator, &Address::generate(&env), &token_id, &1000, &10000, &milestones);

    token_admin.mock_all_auths().mint(&contributor, &1000);
    client.mock_all_auths().contribute(&contributor, &1000);

    client.mock_all_auths().approve_milestone(&0);

    client.mock_all_auths().release_milestone(&0);
    assert_eq!(token.balance(&creator), 1000);
    assert_eq!(token.balance(&client.address), 0);
    assert_eq!(client.get_total_released(), 1000);
}

#[test]
fn test_milestone_release_releases_only_milestone_amount() {
    let env = Env::default();
    let (creator, token_id, token, token_admin, client) = setup_test(&env);
    let contributor = Address::generate(&env);

    let milestones = Vec::from_array(&env, [
        Milestone { target: 1000, amount: 400, released: false },
        Milestone { target: 2000, amount: 600, released: false },
    ]);
    client.mock_all_auths().initialize(&symbol_short!("cp1"), &creator, &Address::generate(&env), &token_id, &2000, &10000, &milestones);

    token_admin.mock_all_auths().mint(&contributor, &2000);
    client.mock_all_auths().contribute(&contributor, &2000);

    // Total contract balance is 2000. Releasing milestone 0 (target 1000, amount 400)
    // should only transfer 400 to creator, leaving 1600 in contract.
    client.mock_all_auths().approve_milestone(&0);
    client.mock_all_auths().release_milestone(&0);
    assert_eq!(token.balance(&creator), 400);
    assert_eq!(token.balance(&client.address), 1600);
    assert_eq!(client.get_total_released(), 400);

    // Releasing milestone 1 (target 2000, amount 600) transfers 600 to creator
    client.mock_all_auths().approve_milestone(&1);
    client.mock_all_auths().release_milestone(&1);
    assert_eq!(token.balance(&creator), 1000);
    assert_eq!(token.balance(&client.address), 1000);
    assert_eq!(client.get_total_released(), 1000);
}

#[test]
fn test_multiple_milestone_releases() {
    let env = Env::default();
    let (creator, token_id, token, token_admin, client) = setup_test(&env);
    let contributor = Address::generate(&env);

    let milestones = Vec::from_array(&env, [
        Milestone { target: 1000, amount: 1000, released: false },
        Milestone { target: 2000, amount: 1000, released: false },
    ]);
    client.mock_all_auths().initialize(&symbol_short!("cp1"), &creator, &Address::generate(&env), &token_id, &2000, &10000, &milestones);

    token_admin.mock_all_auths().mint(&contributor, &2000);
    client.mock_all_auths().contribute(&contributor, &2000);

    assert_eq!(client.get_status(), symbol_short!("Funded"));

    // Release first milestone (releases 1000)
    client.mock_all_auths().approve_milestone(&0);
    client.mock_all_auths().release_milestone(&0);
    assert_eq!(token.balance(&creator), 1000);
    assert_eq!(token.balance(&client.address), 1000);

    // Release second milestone (releases 1000)
    client.mock_all_auths().approve_milestone(&1);
    client.mock_all_auths().release_milestone(&1);
    assert_eq!(token.balance(&creator), 2000);
    assert_eq!(token.balance(&client.address), 0);
    assert_eq!(client.get_total_released(), 2000);
}

#[test]
#[should_panic(expected = "Milestone already released")]
fn test_milestone_already_released_rejection() {
    let env = Env::default();
    let (creator, token_id, _token, token_admin, client) = setup_test(&env);
    let contributor = Address::generate(&env);

    let milestones = Vec::from_array(&env, [Milestone { target: 1000, amount: 1000, released: false }]);
    client.mock_all_auths().initialize(&symbol_short!("cp1"), &creator, &Address::generate(&env), &token_id, &1000, &10000, &milestones);

    token_admin.mock_all_auths().mint(&contributor, &1000);
    client.mock_all_auths().contribute(&contributor, &1000);

    client.mock_all_auths().approve_milestone(&0);

    client.mock_all_auths().release_milestone(&0);
    client.mock_all_auths().approve_milestone(&0);
    client.mock_all_auths().release_milestone(&0);
}

#[test]
#[should_panic(expected = "Milestone target not met")]
fn test_milestone_release_fails_if_target_not_met() {
    let env = Env::default();
    let (creator, token_id, _token, token_admin, client) = setup_test(&env);
    let contributor = Address::generate(&env);

    let milestones = Vec::from_array(&env, [Milestone { target: 1000, amount: 1000, released: false }]);
    client.mock_all_auths().initialize(&symbol_short!("cp1"), &creator, &Address::generate(&env), &token_id, &1000, &10000, &milestones);

    token_admin.mock_all_auths().mint(&contributor, &500);
    client.mock_all_auths().contribute(&contributor, &500);

    client.mock_all_auths().approve_milestone(&0);

    client.mock_all_auths().release_milestone(&0);
}

#[test]
fn test_refund_after_failure() {
    let env = Env::default();
    let (creator, token_id, token, token_admin, client) = setup_test(&env);
    let contributor = Address::generate(&env);

    let milestones = Vec::from_array(&env, [Milestone { target: 1000, amount: 1000, released: false }]);
    client.mock_all_auths().initialize(&symbol_short!("cp1"), &creator, &Address::generate(&env), &token_id, &1000, &100, &milestones);

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
    let (creator, token_id, _token, token_admin, client) = setup_test(&env);
    let contributor = Address::generate(&env);

    let milestones = Vec::from_array(&env, [Milestone { target: 1000, amount: 1000, released: false }]);
    client.mock_all_auths().initialize(&symbol_short!("cp1"), &creator, &Address::generate(&env), &token_id, &1000, &10000, &milestones);

    token_admin.mock_all_auths().mint(&contributor, &500);
    client.mock_all_auths().contribute(&contributor, &500);

    client.mock_all_auths().refund(&contributor);
}

fn setup_with_platform(
    env: &Env,
    goal: i128,
    deadline: u64,
    milestones: Vec<Milestone>,
) -> (Address, Address, token::Client, token::StellarAssetClient, CrowdPayContractClient) {
    let (creator, token_id, token, token_admin, client) = setup_test(env);
    let platform = Address::generate(env);
    client.mock_all_auths().initialize(&symbol_short!("cp1"), &creator, &platform, &token_id, &goal, &deadline, &milestones);
    (creator, platform, token, token_admin, client)
}

#[test]
#[should_panic(expected = "Milestone not approved")]
fn test_release_without_approval_panics() {
    let env = Env::default();
    let milestones = Vec::from_array(&env, [Milestone { target: 1000, amount: 1000, released: false }]);
    let (_creator, _platform, _token, token_admin, client) = setup_with_platform(&env, 1000, 10000, milestones);
    let contributor = Address::generate(&env);

    token_admin.mock_all_auths().mint(&contributor, &1000);
    client.mock_all_auths().contribute(&contributor, &1000);

    // Fully funded, but nobody approved the milestone: the creator can't pull it.
    client.mock_all_auths().release_milestone(&0);
}

#[test]
#[should_panic]
fn test_creator_cannot_approve_own_milestone() {
    let env = Env::default();
    let milestones = Vec::from_array(&env, [Milestone { target: 1000, amount: 1000, released: false }]);
    let (creator, _platform, _token, _token_admin, client) = setup_with_platform(&env, 1000, 10000, milestones);

    client
        .mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "approve_milestone",
                args: (0u32,).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .approve_milestone(&0);
}

#[test]
fn test_platform_approval_unlocks_release() {
    let env = Env::default();
    let milestones = Vec::from_array(&env, [Milestone { target: 1000, amount: 1000, released: false }]);
    let (creator, platform, token, token_admin, client) = setup_with_platform(&env, 1000, 10000, milestones);
    let contributor = Address::generate(&env);

    token_admin.mock_all_auths().mint(&contributor, &1000);
    client.mock_all_auths().contribute(&contributor, &1000);

    assert!(!client.is_milestone_approved(&0));
    client
        .mock_auths(&[MockAuth {
            address: &platform,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "approve_milestone",
                args: (0u32,).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .approve_milestone(&0);
    assert!(client.is_milestone_approved(&0));

    client.mock_all_auths().release_milestone(&0);
    assert_eq!(token.balance(&creator), 1000);
}

#[test]
#[should_panic(expected = "Campaign has failed")]
fn test_release_blocked_after_failure() {
    let env = Env::default();
    let milestones = Vec::from_array(&env, [Milestone { target: 1000, amount: 1000, released: false }]);
    let (_creator, _platform, _token, token_admin, client) = setup_with_platform(&env, 1000, 10000, milestones);
    let contributor = Address::generate(&env);

    token_admin.mock_all_auths().mint(&contributor, &1000);
    client.mock_all_auths().contribute(&contributor, &1000);
    client.mock_all_auths().approve_milestone(&0);
    client.mock_all_auths().set_failed();

    client.mock_all_auths().release_milestone(&0);
}

#[test]
#[should_panic(expected = "Creator and platform must be distinct")]
fn test_initialize_rejects_creator_as_platform() {
    let env = Env::default();
    let (creator, token_id, _token, _token_admin, client) = setup_test(&env);
    let milestones = Vec::from_array(&env, [Milestone { target: 1000, amount: 1000, released: false }]);
    client.mock_all_auths().initialize(&symbol_short!("cp1"), &creator, &creator, &token_id, &1000, &10000, &milestones);
}

#[test]
fn test_refund_is_pro_rata_after_partial_release() {
    let env = Env::default();
    let milestones = Vec::from_array(&env, [
        Milestone { target: 3000, amount: 1500, released: false },
        Milestone { target: 3000, amount: 1500, released: false },
    ]);
    let (creator, _platform, token, token_admin, client) = setup_with_platform(&env, 3000, 10000, milestones);

    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);
    for (who, amt) in [(&a, 500i128), (&b, 1000), (&c, 1500)] {
        token_admin.mock_all_auths().mint(who, &amt);
        client.mock_all_auths().contribute(who, &amt);
    }

    client.mock_all_auths().approve_milestone(&0);
    client.mock_all_auths().release_milestone(&0);
    assert_eq!(token.balance(&creator), 1500);

    client.mock_all_auths().set_failed();

    // Half of the funds are gone, so everyone gets half back, in any order.
    client.mock_all_auths().refund(&c);
    client.mock_all_auths().refund(&a);
    client.mock_all_auths().refund(&b);

    assert_eq!(token.balance(&a), 250);
    assert_eq!(token.balance(&b), 500);
    assert_eq!(token.balance(&c), 750);
    assert_eq!(token.balance(&client.address), 0);
}

#[test]
#[should_panic(expected = "No contribution to refund")]
fn test_double_refund_rejected() {
    let env = Env::default();
    let milestones = Vec::from_array(&env, [Milestone { target: 1000, amount: 1000, released: false }]);
    let (_creator, _platform, _token, token_admin, client) = setup_with_platform(&env, 1000, 100, milestones);
    let contributor = Address::generate(&env);

    token_admin.mock_all_auths().mint(&contributor, &500);
    client.mock_all_auths().contribute(&contributor, &500);
    env.ledger().set_timestamp(101);
    client.set_failed();

    client.mock_all_auths().refund(&contributor);
    client.mock_all_auths().refund(&contributor);
}

#[test]
fn test_storage_ttl_outlives_default_and_refund_survives() {
    let env = Env::default();
    // Deadline 30 days out: well past the 4096-ledger default TTL.
    let deadline: u64 = 30 * 24 * 60 * 60;
    let milestones = Vec::from_array(&env, [Milestone { target: 1000, amount: 1000, released: false }]);
    let (_creator, _platform, token, token_admin, client) = setup_with_platform(&env, 1000, deadline, milestones);
    let contributor = Address::generate(&env);

    token_admin.mock_all_auths().mint(&contributor, &500);
    client.mock_all_auths().contribute(&contributor, &500);

    let default_ttl = env.ledger().get().min_persistent_entry_ttl;
    env.as_contract(&client.address, || {
        let key = DataKey::Contributions(contributor.clone());
        let expected = (deadline / LEDGER_SECONDS) as u32 + REFUND_WINDOW_LEDGERS;
        assert!(env.storage().persistent().get_ttl(&key) >= expected);
        assert!(env.storage().instance().get_ttl() >= expected);
    });

    // Keep the test token alive; only this contract's storage is under test.
    let jump = default_ttl * 100;
    env.as_contract(&token.address, || {
        env.storage().instance().extend_ttl(jump + 1000, jump + 1000);
    });

    // Jump well past the default TTL and past the deadline.
    env.ledger().with_mut(|li| {
        li.sequence_number += jump;
        li.timestamp = deadline + 1;
    });

    client.set_failed();
    client.mock_all_auths().refund(&contributor);
    assert_eq!(token.balance(&contributor), 500);
}
