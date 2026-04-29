//! Contribution Router Contract
//!
//! Enforces slippage ceiling and atomically splits the received amount between
//! the campaign wallet and the platform wallet in a single contract call.
//!
//! Entry point: `route_contribution`
//!
//! Slippage rule (enforced on-chain):
//!   send_max <= dest_amount * (10_000 + max_slippage_bps) / 10_000
//!
//! Fee split (atomic):
//!   campaign receives: dest_amount * (10_000 - fee_bps) / 10_000
//!   platform receives: dest_amount * fee_bps / 10_000

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    token, Address, Env, Vec,
};

// ── Event topic symbol ────────────────────────────────────────────────────────

const CONTRIBUTION_ROUTED: soroban_sdk::Symbol = symbol_short!("ROUTED");

// ── Event data ────────────────────────────────────────────────────────────────

/// Emitted after a successful contribution routing.
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
    /// - `send_asset`        – token the sender is spending
    /// - `send_max`          – maximum the sender is willing to spend (slippage ceiling)
    /// - `dest_asset`        – token the campaign receives
    /// - `dest_amount`       – exact amount the campaign+platform must receive in total
    /// - `path`              – intermediate assets for the DEX path (may be empty)
    /// - `campaign_wallet`   – campaign treasury address
    /// - `platform_wallet`   – platform fee recipient address
    /// - `fee_bps`           – platform fee in basis points (e.g. 100 = 1 %)
    /// - `max_slippage_bps`  – maximum allowed slippage in basis points (e.g. 500 = 5 %)
    ///
    /// # Returns
    /// Actual source amount spent.
    pub fn route_contribution(
        env:             Env,
        sender:          Address,
        send_asset:      Address,
        send_max:        i128,
        dest_asset:      Address,
        dest_amount:     i128,
        _path:           Vec<Address>,  // reserved for future DEX path hint; unused in token transfer
        campaign_wallet: Address,
        platform_wallet: Address,
        fee_bps:         u32,
        max_slippage_bps: u32,
    ) -> i128 {
        sender.require_auth();

        // ── Validate inputs ───────────────────────────────────────────────────
        assert!(dest_amount > 0,  "dest_amount must be positive");
        assert!(send_max   > 0,  "send_max must be positive");
        assert!(fee_bps    < 10_000, "fee_bps must be < 10000");

        // ── Slippage ceiling check ────────────────────────────────────────────
        // send_max <= dest_amount * (10_000 + max_slippage_bps) / 10_000
        let slippage_ceiling = dest_amount
            .checked_mul((10_000i128 + max_slippage_bps as i128))
            .expect("overflow")
            / 10_000i128;

        assert!(
            send_max <= slippage_ceiling,
            "send_max exceeds slippage ceiling"
        );

        // ── Fee split calculation ─────────────────────────────────────────────
        let fee_amount      = dest_amount * fee_bps as i128 / 10_000i128;
        let campaign_amount = dest_amount - fee_amount;

        assert!(campaign_amount > 0, "campaign_amount must be positive after fee");

        // ── Pull send_asset from sender into this contract ────────────────────
        // We use send_max as the pull amount; the contract acts as the router.
        // In a real DEX integration the contract would call the DEX here.
        // For the trustless slippage guarantee the key invariant is:
        //   the contract only forwards dest_amount total — never more.
        let send_token = token::Client::new(&env, &send_asset);
        send_token.transfer(&sender, &env.current_contract_address(), &send_max);

        // ── Forward dest_asset to campaign and platform ───────────────────────
        // (In production the DEX swap happens here; for the atomic split the
        //  contract holds dest_asset after the swap and distributes it.)
        let dest_token = token::Client::new(&env, &dest_asset);
        dest_token.transfer(&env.current_contract_address(), &campaign_wallet, &campaign_amount);
        if fee_amount > 0 {
            dest_token.transfer(&env.current_contract_address(), &platform_wallet, &fee_amount);
        }

        // ── Emit ContributionRouted event ─────────────────────────────────────
        env.events().publish(
            (CONTRIBUTION_ROUTED, sender.clone()),
            ContributionRoutedEvent {
                sender:        sender.clone(),
                campaign:      campaign_wallet.clone(),
                dest_amount,
                source_amount: send_max,
                fee_amount,
            },
        );

        send_max
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation},
        token::{Client as TokenClient, StellarAssetClient},
        Address, Env, Vec,
    };

    fn setup(env: &Env) -> (RouterContractClient, Address, Address, Address, Address, Address) {
        let contract_id = env.register_contract(None, RouterContract);
        let client      = RouterContractClient::new(env, &contract_id);

        let admin    = Address::generate(env);
        let sender   = Address::generate(env);
        let campaign = Address::generate(env);
        let platform = Address::generate(env);

        // Create two SAC tokens: send_asset and dest_asset
        let send_asset_id = env.register_stellar_asset_contract_v2(admin.clone()).address();
        let dest_asset_id = env.register_stellar_asset_contract_v2(admin.clone()).address();

        // Mint send_asset to sender
        StellarAssetClient::new(env, &send_asset_id).mint(&sender, &10_000);
        // Mint dest_asset to contract (simulates post-swap balance)
        StellarAssetClient::new(env, &dest_asset_id).mint(&contract_id, &10_000);

        (client, send_asset_id, dest_asset_id, sender, campaign, platform)
    }

    #[test]
    fn test_happy_path_splits_correctly() {
        let env = Env::default();
        env.mock_all_auths();

        let (client, send_asset, dest_asset, sender, campaign, platform) = setup(&env);

        // dest_amount=1000, fee_bps=100 (1%) → campaign=990, platform=10
        let source_spent = client.route_contribution(
            &sender,
            &send_asset,
            &1_050,   // send_max (within 5% slippage of 1000)
            &dest_asset,
            &1_000,
            &Vec::new(&env),
            &campaign,
            &platform,
            &100,  // fee_bps
            &500,  // max_slippage_bps
        );

        assert_eq!(source_spent, 1_050);

        let dest_token = TokenClient::new(&env, &dest_asset);
        assert_eq!(dest_token.balance(&campaign), 990);
        assert_eq!(dest_token.balance(&platform), 10);
    }

    #[test]
    #[should_panic(expected = "send_max exceeds slippage ceiling")]
    fn test_rejects_excessive_slippage() {
        let env = Env::default();
        env.mock_all_auths();

        let (client, send_asset, dest_asset, sender, campaign, platform) = setup(&env);

        // send_max=1_600 > 1_000 * 1.05 = 1_050 → should panic
        client.route_contribution(
            &sender,
            &send_asset,
            &1_600,
            &dest_asset,
            &1_000,
            &Vec::new(&env),
            &campaign,
            &platform,
            &100,
            &500,
        );
    }

    #[test]
    fn test_zero_fee_sends_full_amount_to_campaign() {
        let env = Env::default();
        env.mock_all_auths();

        let (client, send_asset, dest_asset, sender, campaign, platform) = setup(&env);

        client.route_contribution(
            &sender,
            &send_asset,
            &1_000,
            &dest_asset,
            &1_000,
            &Vec::new(&env),
            &campaign,
            &platform,
            &0,    // fee_bps = 0
            &500,
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

        let (client, send_asset, dest_asset, sender, campaign, platform) = setup(&env);

        client.route_contribution(
            &sender, &send_asset, &100, &dest_asset, &0,
            &Vec::new(&env), &campaign, &platform, &100, &500,
        );
    }
}
