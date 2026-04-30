//! Contribution Router Contract
//!
//! Performs an on-chain path payment (swap) via a DEX router contract,
//! enforces a slippage ceiling, then atomically splits the received
//! dest_amount between the campaign wallet and the platform wallet.
//!
//! Entry point: `route_contribution`
//!
//! Slippage rule (enforced on-chain):
//!   actual_spent <= dest_amount * (10_000 + max_slippage_bps) / 10_000
//!
//! Fee split (atomic, on dest_asset):
//!   campaign receives: dest_amount * (10_000 - fee_bps) / 10_000
//!   platform receives: dest_amount * fee_bps / 10_000

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    token, Address, Env, Vec,
};

// ── DEX router interface ──────────────────────────────────────────────────────
// Matches the standard Soroban DEX aggregator interface (Phoenix / Soroswap).
// `swap_exact_tokens_for_tokens`:
//   - pulls `amount_in` of `path[0]` from `to` (this contract)
//   - swaps through `path`
//   - delivers at least `amount_out_min` of `path[last]` to `to`
//   - returns a Vec<i128> of amounts at each hop (first = spent, last = received)
#[soroban_sdk::contractclient(name = "DexRouterClient")]
pub trait DexRouter {
    fn swap_exact_tokens_for_tokens(
        env: Env,
        amount_in: i128,
        amount_out_min: i128,
        path: Vec<Address>,
        to: Address,
        deadline: u64,
    ) -> Vec<i128>;
}

// ── Event topic symbol ────────────────────────────────────────────────────────

const CONTRIBUTION_ROUTED: soroban_sdk::Symbol = symbol_short!("ROUTED");

// ── Event data ────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug)]
pub struct ContributionRoutedEvent {
    pub sender:        Address,
    pub campaign:      Address,
    pub dest_amount:   i128,
    pub source_amount: i128,
    pub fee_amount:    i128,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct RouterContract;

#[contractimpl]
impl RouterContract {
    /// Route a contribution through the DEX with on-chain slippage enforcement
    /// and atomic fee split.
    ///
    /// # Parameters
    /// - `sender`            – contributor; must have authorised this call
    /// - `dex_router`        – address of the on-chain DEX router contract
    /// - `send_asset`        – token the sender is spending (path[0])
    /// - `send_max`          – maximum the sender is willing to spend (slippage ceiling)
    /// - `dest_asset`        – token the campaign receives (path[last])
    /// - `dest_amount`       – minimum dest tokens the campaign+platform must receive
    /// - `path`              – full swap path including send_asset and dest_asset
    /// - `campaign_wallet`   – campaign treasury address
    /// - `platform_wallet`   – platform fee recipient address
    /// - `fee_bps`           – platform fee in basis points (e.g. 100 = 1 %)
    /// - `max_slippage_bps`  – maximum allowed slippage in basis points (e.g. 500 = 5 %)
    ///
    /// # Returns
    /// Actual source amount spent.
    pub fn route_contribution(
        env:              Env,
        sender:           Address,
        dex_router:       Address,
        send_asset:       Address,
        send_max:         i128,
        dest_asset:       Address,
        dest_amount:      i128,
        path:             Vec<Address>,
        campaign_wallet:  Address,
        platform_wallet:  Address,
        fee_bps:          u32,
        max_slippage_bps: u32,
    ) -> i128 {
        sender.require_auth();

        // ── Validate inputs ───────────────────────────────────────────────────
        assert!(dest_amount > 0,       "dest_amount must be positive");
        assert!(send_max   > 0,        "send_max must be positive");
        assert!(fee_bps    < 10_000,   "fee_bps must be < 10000");
        assert!(path.len() >= 2,       "path must have at least 2 assets");

        // ── Slippage ceiling: send_max <= dest_amount * (10_000 + slippage) / 10_000
        let slippage_ceiling = dest_amount
            .checked_mul(10_000i128 + max_slippage_bps as i128)
            .expect("overflow")
            / 10_000i128;
        assert!(send_max <= slippage_ceiling, "send_max exceeds slippage ceiling");

        // ── Pull send_asset from sender into this contract ────────────────────
        let send_token = token::Client::new(&env, &send_asset);
        send_token.transfer(&sender, &env.current_contract_address(), &send_max);

        // ── Approve DEX router to spend send_asset ────────────────────────────
        send_token.approve(
            &env.current_contract_address(),
            &dex_router,
            &send_max,
            &(env.ledger().sequence() + 1),
        );

        // ── Execute on-chain swap via DEX router ──────────────────────────────
        // The DEX router pulls send_asset from this contract, swaps through
        // `path`, and delivers dest_asset back to this contract.
        let dex = DexRouterClient::new(&env, &dex_router);
        let amounts = dex.swap_exact_tokens_for_tokens(
            &send_max,
            &dest_amount,          // amount_out_min = dest_amount (exact-out guarantee)
            &path,
            &env.current_contract_address(),
            &(env.ledger().timestamp() + 300), // 5-minute deadline
        );

        // actual dest tokens received (last element of amounts vector)
        let received = amounts.get(amounts.len() - 1).expect("empty amounts");
        assert!(received >= dest_amount, "swap returned less than dest_amount");

        // actual source tokens spent (first element)
        let source_spent = amounts.get(0).expect("empty amounts");

        // ── Refund any unspent send_asset back to sender ──────────────────────
        let unspent = send_max - source_spent;
        if unspent > 0 {
            send_token.transfer(&env.current_contract_address(), &sender, &unspent);
        }

        // ── Fee split on dest_asset ───────────────────────────────────────────
        let fee_amount      = dest_amount * fee_bps as i128 / 10_000i128;
        let campaign_amount = dest_amount - fee_amount;
        assert!(campaign_amount > 0, "campaign_amount must be positive after fee");

        let dest_token = token::Client::new(&env, &dest_asset);
        dest_token.transfer(&env.current_contract_address(), &campaign_wallet,  &campaign_amount);
        if fee_amount > 0 {
            dest_token.transfer(&env.current_contract_address(), &platform_wallet, &fee_amount);
        }

        // ── Emit event ────────────────────────────────────────────────────────
        env.events().publish(
            (CONTRIBUTION_ROUTED, sender.clone()),
            ContributionRoutedEvent {
                sender:        sender.clone(),
                campaign:      campaign_wallet.clone(),
                dest_amount,
                source_amount: source_spent,
                fee_amount,
            },
        );

        source_spent
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::Address as _,
        token::{Client as TokenClient, StellarAssetClient},
        Address, Env, Vec,
    };

    // ── Minimal mock DEX router ───────────────────────────────────────────────
    // Simulates a 1:1 swap: spends exactly `amount_in` of path[0] via allowance,
    // delivers exactly `amount_in` of path[last] to `to`.
    #[contract]
    pub struct MockDex;

    #[contractimpl]
    impl MockDex {
        pub fn swap_exact_tokens_for_tokens(
            env:             Env,
            amount_in:       i128,
            _amount_out_min: i128,
            path:            Vec<Address>,
            to:              Address,
            _deadline:       u64,
        ) -> Vec<i128> {
            let src = path.get(0).unwrap();
            let dst = path.get(path.len() - 1).unwrap();
            let dex = env.current_contract_address();

            // Pull send_asset from `to` (router) via pre-approved allowance
            TokenClient::new(&env, &src).transfer_from(&dex, &to, &dex, &amount_in);
            // Push dest_asset to `to` (router)
            TokenClient::new(&env, &dst).transfer(&dex, &to, &amount_in);

            let mut out = Vec::new(&env);
            out.push_back(amount_in); // source spent
            out.push_back(amount_in); // dest received
            out
        }
    }

    fn setup(env: &Env) -> (
        RouterContractClient,
        Address, // dex_router
        Address, // send_asset
        Address, // dest_asset
        Address, // sender
        Address, // campaign
        Address, // platform
    ) {
        let admin    = Address::generate(env);
        let sender   = Address::generate(env);
        let campaign = Address::generate(env);
        let platform = Address::generate(env);

        let send_asset = env.register_stellar_asset_contract_v2(admin.clone()).address();
        let dest_asset = env.register_stellar_asset_contract_v2(admin.clone()).address();

        let dex_id     = env.register_contract(None, MockDex);
        let router_id  = env.register_contract(None, RouterContract);
        let client     = RouterContractClient::new(env, &router_id);

        // Mint send_asset to sender
        StellarAssetClient::new(env, &send_asset).mint(&sender, &10_000);
        // Mint dest_asset to mock DEX (it will deliver it after swap)
        StellarAssetClient::new(env, &dest_asset).mint(&dex_id, &10_000);

        (client, dex_id, send_asset, dest_asset, sender, campaign, platform)
    }

    fn make_path(env: &Env, send: &Address, dest: &Address) -> Vec<Address> {
        let mut p = Vec::new(env);
        p.push_back(send.clone());
        p.push_back(dest.clone());
        p
    }

    #[test]
    fn test_happy_path_splits_correctly() {
        let env = Env::default();
        env.mock_all_auths();

        let (client, dex, send_asset, dest_asset, sender, campaign, platform) = setup(&env);
        let path = make_path(&env, &send_asset, &dest_asset);

        // dest_amount=1000, fee_bps=100 (1%) → campaign=990, platform=10
        let source_spent = client.route_contribution(
            &sender, &dex, &send_asset, &1_050,
            &dest_asset, &1_000, &path,
            &campaign, &platform, &100, &500,
        );

        assert_eq!(source_spent, 1_050); // mock DEX spends all of send_max (1:1 swap)

        let dest_token = TokenClient::new(&env, &dest_asset);
        assert_eq!(dest_token.balance(&campaign), 990);
        assert_eq!(dest_token.balance(&platform), 10);
    }

    #[test]
    #[should_panic(expected = "send_max exceeds slippage ceiling")]
    fn test_rejects_excessive_slippage() {
        let env = Env::default();
        env.mock_all_auths();

        let (client, dex, send_asset, dest_asset, sender, campaign, platform) = setup(&env);
        let path = make_path(&env, &send_asset, &dest_asset);

        // send_max=1_600 > 1_000 * 1.05 = 1_050 → should panic
        client.route_contribution(
            &sender, &dex, &send_asset, &1_600,
            &dest_asset, &1_000, &path,
            &campaign, &platform, &100, &500,
        );
    }

    #[test]
    fn test_zero_fee_sends_full_amount_to_campaign() {
        let env = Env::default();
        env.mock_all_auths();

        let (client, dex, send_asset, dest_asset, sender, campaign, platform) = setup(&env);
        let path = make_path(&env, &send_asset, &dest_asset);

        client.route_contribution(
            &sender, &dex, &send_asset, &1_000,
            &dest_asset, &1_000, &path,
            &campaign, &platform, &0, &500,
        );

        let dest_token = TokenClient::new(&env, &dest_asset);
        assert_eq!(dest_token.balance(&campaign), 1_000);
        assert_eq!(dest_token.balance(&platform), 0);
    }

    #[test]
    #[should_panic(expected = "dest_amount must be positive")]
    fn test_rejects_zero_dest_amount() {
        let env = Env::default();
        env.mock_all_auths();

        let (client, dex, send_asset, dest_asset, sender, campaign, platform) = setup(&env);
        let path = make_path(&env, &send_asset, &dest_asset);

        client.route_contribution(
            &sender, &dex, &send_asset, &100,
            &dest_asset, &0, &path,
            &campaign, &platform, &100, &500,
        );
    }

    #[test]
    #[should_panic(expected = "path must have at least 2 assets")]
    fn test_rejects_empty_path() {
        let env = Env::default();
        env.mock_all_auths();

        let (client, dex, send_asset, dest_asset, sender, campaign, platform) = setup(&env);

        client.route_contribution(
            &sender, &dex, &send_asset, &1_000,
            &dest_asset, &1_000, &Vec::new(&env),
            &campaign, &platform, &100, &500,
        );
    }
}
