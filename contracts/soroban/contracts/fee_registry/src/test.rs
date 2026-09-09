#[cfg(test)]
mod test {
    use soroban_sdk::{testutils::Address as _, Address, Env};
    use crate::{FeeRegistry, FeeRegistryClient, ProposalStatus, DataKey};

    fn setup_contract(env: &Env) -> (Address, FeeRegistryClient) {
        let contract_id = env.register_contract(None, FeeRegistry);
        let client = FeeRegistryClient::new(env, &contract_id);
        (contract_id, client)
    }

    #[test]
    fn test_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let (_contract_id, client) = setup_contract(&env);
        let admin = Address::generate(&env);
        let governance_token = Address::generate(&env);
        
        client.initialize(
            &admin,
            &governance_token,
            &250, // 2.5% platform fee
            &500, // 5% creator share
        );

        assert_eq!(client.get_fee(), 250);
        assert_eq!(client.get_creator_share(), 500);
        assert_eq!(client.get_admin(), admin);
        assert_eq!(client.get_governance_token(), governance_token);
    }

    #[test]
    #[should_panic]
    fn test_initialize_requires_admin_auth() {
        let env = Env::default();
        let (_contract_id, client) = setup_contract(&env);
        let admin = Address::generate(&env);
        let governance_token = Address::generate(&env);

        client.initialize(
            &admin,
            &governance_token,
            &250,
            &500,
        );
    }

    #[test]
    fn test_get_fee() {
        let env = Env::default();
        env.mock_all_auths();
        let (_contract_id, client) = setup_contract(&env);
        let admin = Address::generate(&env);
        let governance_token = Address::generate(&env);
        
        client.initialize(&admin, &governance_token, &300, &400);
        
        assert_eq!(client.get_fee(), 300);
    }

    #[test]
    #[should_panic(expected = "Already initialized")]
    fn test_double_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let (_contract_id, client) = setup_contract(&env);
        let admin = Address::generate(&env);
        let governance_token = Address::generate(&env);
        
        client.initialize(&admin, &governance_token, &250, &500);
        client.initialize(&admin, &governance_token, &300, &400);
    }

    #[test]
    fn test_admin_set_fee() {
        let env = Env::default();
        env.mock_all_auths();
        let (_contract_id, client) = setup_contract(&env);
        let admin = Address::generate(&env);
        let governance_token = Address::generate(&env);
        
        client.initialize(&admin, &governance_token, &250, &500);
        
        client.admin_set_fee(&admin, &350, &450);
        
        assert_eq!(client.get_fee(), 350);
        assert_eq!(client.get_creator_share(), 450);
    }
}
