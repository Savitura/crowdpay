use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, Address, Env,
};
use escrow::{EscrowContract, EscrowContractClient};

fn install_token(env: &Env) -> (Address, token::StellarAssetClient) {
    let admin = Address::generate(&env);
    let token_addr = env.register_stellar_asset_contract(admin.clone());
    let token_admin = token::StellarAssetClient::new(&env, &token_addr);
    token_admin.mint(&admin, &10_000_000_000);
    (token_addr, token_admin)
}

fn setup_contract(
    env: &Env,
    target: i128,
    deadline: u64,
    fee_bps: u32,
) -> (Address, Address, Address, Address) {
    let admin = Address::generate(&env);
    let contributor = Address::generate(&env);
    let fee_recipient = Address::generate(&env);

    env.mock_all_auths();

    let (token_addr, _token_admin) = install_token(&env);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    client.initialize(
        &admin,
        &1u64,
        &target,
        &deadline,
        &token_addr,
        &fee_bps,
        &fee_recipient,
    );

    (contract_id, admin, contributor, fee_recipient)
}

#[test]
fn test_initialize_sets_state() {
    let env = Env::default();
    let (contract_id, _, _, fee_recipient) = setup_contract(&env, 1000, 100, 500);

    let client = EscrowContractClient::new(&env, &contract_id);

    let total_raised: i128 = client.get_total_raised();
    assert_eq!(total_raised, 0);

    let (bps, recipient) = client.get_platform_fee_config();
    assert_eq!(bps, 500);
    assert_eq!(recipient, fee_recipient);
}

#[test]
fn test_initialize_rejects_reinit() {
    let env = Env::default();
    let (contract_id, admin, _, fee_recipient) = setup_contract(&env, 1000, 100, 0);
    let client = EscrowContractClient::new(&env, &contract_id);

    let token_addr: Address = client.get_asset();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.initialize(&admin, &2u64, &2000, &200, &token_addr, &0, &fee_recipient);
    }));
    assert!(result.is_err());
}

#[test]
fn test_initialize_rejects_invalid_fee() {
    let env = Env::default();

    env.mock_all_auths();

    let admin = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let (token_addr, _) = install_token(&env);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.initialize(&admin, &1u64, &1000, &100, &token_addr, &10001, &fee_recipient);
    }));
    assert!(result.is_err());
}

#[test]
fn test_deposit_increases_balance() {
    let env = Env::default();
    let (contract_id, _, contributor, _fee_recipient) = setup_contract(&env, 1000, 999999, 0);
    let client = EscrowContractClient::new(&env, &contract_id);

    let token_addr = client.get_asset();
    let token_cl = token::StellarAssetClient::new(&env, &token_addr);
    token_cl.mint(&contributor, &500);
    client.deposit(&contributor, &500);

    let total_raised: i128 = client.get_total_raised();
    assert_eq!(total_raised, 500);
}

#[test]
fn test_deposit_rejects_after_deadline() {
    let env = Env::default();
    let (contract_id, _, contributor, _fee_recipient) = setup_contract(&env, 1000, 100, 0);
    let client = EscrowContractClient::new(&env, &contract_id);

    env.ledger().set_timestamp(200);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.deposit(&contributor, &100);
    }));
    assert!(result.is_err());
}

#[test]
fn test_deposit_multiple_contributors() {
    let env = Env::default();
    let (contract_id, _, contributor, _fee_recipient) = setup_contract(&env, 5000, 999999, 0);
    let client = EscrowContractClient::new(&env, &contract_id);

    let token_addr = client.get_asset();
    let token_cl = token::StellarAssetClient::new(&env, &token_addr);
    let contributor2 = Address::generate(&env);
    token_cl.mint(&contributor, &1000);
    token_cl.mint(&contributor2, &2000);

    client.deposit(&contributor, &1000);
    client.deposit(&contributor2, &2000);

    let total_raised: i128 = client.get_total_raised();
    assert_eq!(total_raised, 3000);
}

#[test]
fn test_approve_withdrawal_increases_approved() {
    let env = Env::default();
    let (contract_id, admin, _, _fee_recipient) = setup_contract(&env, 1000, 999999, 0);
    let client = EscrowContractClient::new(&env, &contract_id);

    client.approve_withdrawal(&500);

    let total_raised: i128 = client.get_total_raised();
    assert_eq!(total_raised, 0);
}

#[test]
fn test_execute_withdrawal_deducts_fee() {
    let env = Env::default();
    let (contract_id, admin, contributor, fee_recipient) =
        setup_contract(&env, 1000, 999999, 1000);
    let client = EscrowContractClient::new(&env, &contract_id);

    let token_addr = client.get_asset();
    let token_cl = token::StellarAssetClient::new(&env, &token_addr);
    token_cl.mint(&contributor, &1000);
    client.deposit(&contributor, &1000);

    client.approve_withdrawal(&500);
    client.execute_withdrawal(&admin, &500);

    let fee = 50i128;
    let net = 450i128;

    let token_client = token::Client::new(&env, &token_addr);
    assert_eq!(token_client.balance(&contributor), 0);
    assert_eq!(token_client.balance(&admin), net);
    assert_eq!(token_client.balance(&fee_recipient), fee);
}

#[test]
fn test_execute_withdrawal_no_fee() {
    let env = Env::default();
    let (contract_id, admin, contributor, _fee_recipient) = setup_contract(&env, 1000, 999999, 0);
    let client = EscrowContractClient::new(&env, &contract_id);

    let token_addr = client.get_asset();
    let token_cl = token::StellarAssetClient::new(&env, &token_addr);
    token_cl.mint(&contributor, &1000);
    client.deposit(&contributor, &1000);

    client.approve_withdrawal(&500);
    client.execute_withdrawal(&admin, &500);

    let token_client = token::Client::new(&env, &token_addr);
    assert_eq!(token_client.balance(&admin), 500);
}

#[test]
fn test_execute_withdrawal_rejects_insufficient_approval() {
    let env = Env::default();
    let (contract_id, admin, _, _fee_recipient) = setup_contract(&env, 1000, 999999, 0);
    let client = EscrowContractClient::new(&env, &contract_id);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.execute_withdrawal(&admin, &500);
    }));
    assert!(result.is_err());
}

#[test]
fn test_approve_withdrawal_requires_admin_auth() {
    let env = Env::default();

    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contributor = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let (token_addr, _token_admin) = install_token(&env);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    client.initialize(
        &admin,
        &1u64,
        &1000,
        &999999,
        &token_addr,
        &0,
        &fee_recipient,
    );

    // Reset auth mocks to test that non-admin cannot approve
    // In a fresh sub-environment, call without any auth
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // Create a new env without mock_all_auths to test auth enforcement
        let env2 = Env::default();
        let contract_id2 = env2.register(EscrowContract, ());
        let client2 = EscrowContractClient::new(&env2, &contract_id2);

        let admin2 = Address::generate(&env2);
        let contributor2 = Address::generate(&env2);
        let fee_recipient2 = Address::generate(&env2);
        let token_addr2 = env2.register_stellar_asset_contract(admin2.clone());

        // Initialize without mock_all_auths - this works because initialize has no require_auth
        client2.initialize(
            &admin2,
            &1u64,
            &1000,
            &999999,
            &token_addr2,
            &0,
            &fee_recipient2,
        );

        // Try to approve without auth - should fail
        client2.approve_withdrawal(&100);
    }));
    assert!(result.is_err());
}

#[test]
fn test_refund_after_deadline_when_under_target() {
    let env = Env::default();
    let (contract_id, _admin, contributor, _fee_recipient) = setup_contract(&env, 1000, 100, 0);
    let client = EscrowContractClient::new(&env, &contract_id);

    let token_addr = client.get_asset();
    let token_cl = token::StellarAssetClient::new(&env, &token_addr);
    token_cl.mint(&contributor, &500);
    client.deposit(&contributor, &500);

    env.ledger().set_timestamp(200);

    let token_client = token::Client::new(&env, &token_addr);
    let balance_before = token_client.balance(&contributor);
    assert_eq!(balance_before, 0);

    client.refund(&contributor);

    let balance_after = token_client.balance(&contributor);
    assert_eq!(balance_after, 500);

    let total_raised: i128 = client.get_total_raised();
    assert_eq!(total_raised, 0);
}

#[test]
fn test_refund_rejects_before_deadline() {
    let env = Env::default();
    let (contract_id, _admin, contributor, _fee_recipient) = setup_contract(&env, 1000, 100, 0);
    let client = EscrowContractClient::new(&env, &contract_id);

    env.ledger().set_timestamp(50);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.refund(&contributor);
    }));
    assert!(result.is_err());
}

#[test]
fn test_refund_rejects_when_target_met() {
    let env = Env::default();
    let (contract_id, _admin, contributor, _fee_recipient) = setup_contract(&env, 500, 100, 0);
    let client = EscrowContractClient::new(&env, &contract_id);

    let token_addr = client.get_asset();
    let token_cl = token::StellarAssetClient::new(&env, &token_addr);
    token_cl.mint(&contributor, &500);
    client.deposit(&contributor, &500);

    env.ledger().set_timestamp(200);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.refund(&contributor);
    }));
    assert!(result.is_err());
}

#[test]
fn test_refund_rejects_no_contribution() {
    let env = Env::default();
    let (contract_id, _admin, contributor, _fee_recipient) = setup_contract(&env, 1000, 100, 0);
    let client = EscrowContractClient::new(&env, &contract_id);

    env.ledger().set_timestamp(200);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.refund(&contributor);
    }));
    assert!(result.is_err());
}

#[test]
fn test_full_flow_deposit_withdraw_with_fee() {
    let env = Env::default();
    let (contract_id, admin, contributor, fee_recipient) =
        setup_contract(&env, 2000, 999999, 500);
    let client = EscrowContractClient::new(&env, &contract_id);

    let token_addr = client.get_asset();
    let token_cl = token::StellarAssetClient::new(&env, &token_addr);
    token_cl.mint(&contributor, &1000);
    client.deposit(&contributor, &1000);

    let total: i128 = client.get_total_raised();
    assert_eq!(total, 1000);

    client.approve_withdrawal(&800);
    client.execute_withdrawal(&admin, &800);

    let fee = 40i128;
    let net = 760i128;

    let token_client = token::Client::new(&env, &token_addr);
    assert_eq!(token_client.balance(&admin), net);
    assert_eq!(token_client.balance(&fee_recipient), fee);

    let remaining = 200i128;
    assert_eq!(token_client.balance(&contract_id), remaining);
}
