use super::*;
use soroban_sdk::testutils::storage::{Instance as _, Persistent as _};
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{symbol_short, Address, BytesN, Env, String};

struct Harness<'a> {
    contract_id: Address,
    issuer: Address,
    client: ContributorIdentityContractClient<'a>,
}

fn setup(env: &Env) -> Harness<'_> {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let platform = Address::generate(env);
    let issuer = Address::generate(env);

    let contract_id = env.register_contract(None, ContributorIdentityContract);
    let client = ContributorIdentityContractClient::new(env, &contract_id);
    client.initialize(&admin, &platform);
    client.add_issuer(&issuer);

    Harness {
        contract_id,
        issuer,
        client,
    }
}

fn register(env: &Env, h: &Harness, subject: &Address) {
    h.client
        .register(subject, &String::from_str(env, "did:stellar:subject"));
}

fn jump_past_default_ttl(env: &Env) {
    let jump = env.ledger().get().min_persistent_entry_ttl * 100;
    env.ledger().with_mut(|li| li.sequence_number += jump);
}

#[test]
fn register_attest_and_update_reputation() {
    let env = Env::default();
    let h = setup(&env);
    let subject = Address::generate(&env);
    register(&env, &h, &subject);

    let proof = BytesN::from_array(&env, &[7u8; 32]);
    h.client
        .add_attestation(&h.issuer, &subject, &symbol_short!("kyc"), &0, &proof);
    h.client.update_reputation(&subject, &1_500);

    let identity = h.client.get_identity(&subject);
    assert_eq!(identity.attestations.len(), 1);
    assert_eq!(identity.reputation_score, MAX_REPUTATION);
    assert!(h.client.has_attestation(&subject, &symbol_short!("kyc")));
    assert!(h
        .client
        .verify_proof(&subject, &symbol_short!("kyc"), &proof));
}

#[test]
fn writes_extend_instance_and_identity_ttl() {
    let env = Env::default();
    let h = setup(&env);
    let subject = Address::generate(&env);
    register(&env, &h, &subject);

    env.as_contract(&h.contract_id, || {
        let key = DataKey::Identity(subject.clone());
        assert!(env.storage().persistent().get_ttl(&key) >= STORAGE_TTL_LEDGERS - 1);
        assert!(env.storage().instance().get_ttl() >= STORAGE_TTL_LEDGERS - 1);
    });
}

#[test]
fn identity_and_issuers_survive_past_default_ttl() {
    let env = Env::default();
    let h = setup(&env);
    let subject = Address::generate(&env);
    register(&env, &h, &subject);
    let proof = BytesN::from_array(&env, &[9u8; 32]);
    h.client
        .add_attestation(&h.issuer, &subject, &symbol_short!("kyc"), &0, &proof);

    jump_past_default_ttl(&env);

    // The identity record and its attestation are still readable...
    assert!(h.client.has_attestation(&subject, &symbol_short!("kyc")));
    assert_eq!(h.client.get_identity(&subject).attestations.len(), 1);

    // ...and the issuers map / platform address in instance storage still
    // authorise writes.
    h.client
        .add_attestation(&h.issuer, &subject, &symbol_short!("kyc2"), &0, &proof);
    h.client.update_reputation(&subject, &10);
    h.client.revoke_attestation(&h.issuer, &subject, &0);

    let identity = h.client.get_identity(&subject);
    assert_eq!(identity.attestations.len(), 2);
    assert_eq!(identity.reputation_score, 10);
    assert!(!h.client.has_attestation(&subject, &symbol_short!("kyc")));
}

#[test]
fn repeat_register_keeps_an_idle_identity_alive() {
    let env = Env::default();
    let h = setup(&env);
    let subject = Address::generate(&env);
    register(&env, &h, &subject);

    // Two jumps, each well short of the extended TTL but together past it;
    // the idempotent re-register in between re-extends the record.
    let half = STORAGE_TTL_LEDGERS / 2 + 1;
    env.ledger().with_mut(|li| li.sequence_number += half);
    register(&env, &h, &subject);
    env.ledger().with_mut(|li| li.sequence_number += half);

    assert_eq!(h.client.get_identity(&subject).reputation_score, 0);
}
