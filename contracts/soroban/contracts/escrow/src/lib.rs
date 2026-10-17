#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, Symbol};

/// Maximum platform fee the contract will ever accept, in basis points (10% = 1000 BPS).
///
/// This guards against configuration typos (e.g. `1000` instead of `100`, or `10000`
/// instead of `100`) that would otherwise route an unreasonable share — or all — of a
/// campaign's funds to the platform. Any fee above this cap is rejected outright.
pub const MAX_FEE_BPS: u32 = 1000;

/// Ledgers close roughly every 5 seconds on Stellar.
const LEDGER_SECONDS: u64 = 5;
const DAY_IN_LEDGERS: u32 = 17_280;
/// How long contributor balances must stay live after the deadline so that
/// refunds still work without someone first restoring archived entries.
pub const REFUND_WINDOW_LEDGERS: u32 = 60 * DAY_IN_LEDGERS;
/// Entries are only re-extended once their remaining TTL drops this far
/// below the target, so back-to-back calls don't pay for redundant bumps.
const TTL_BUMP_SLACK: u32 = DAY_IN_LEDGERS;

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    CampaignId,
    Target,
    Deadline,
    Asset,
    Balances(Address),
    TotalRaised,
    ApprovedWithdrawal,
    ApprovedWithdrawalFor(Address),
    IsInitialized,
    PlatformFeeBps,
    PlatformFeeRecipient,
    PendingFeeBps,
    MilestonesContract,
    IsRefunding,
    CampaignFailed,
    SecondSigner,
    RefundPool,
    RefundBase,
}

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    pub fn initialize(
        env: Env,
        admin: Address,
        campaign_id: u64,
        target: i128,
        deadline: u64,
        asset: Address,
        platform_fee_bps: u32,
        platform_fee_recipient: Address,
    ) {
        if env.storage().instance().has(&DataKey::IsInitialized) {
            panic!("Contract is already initialized");
        }
        platform_fee_recipient.require_auth();

        if target <= 0 {
            panic!("Target must be positive");
        }
        if platform_fee_bps > MAX_FEE_BPS {
            panic!("Platform fee BPS must not exceed MAX_FEE_BPS");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::CampaignId, &campaign_id);
        env.storage().instance().set(&DataKey::Target, &target);
        env.storage().instance().set(&DataKey::Deadline, &deadline);
        env.storage().instance().set(&DataKey::Asset, &asset);
        env.storage().instance().set(&DataKey::TotalRaised, &0i128);
        env.storage().instance().set(&DataKey::ApprovedWithdrawal, &0i128);
        env.storage().instance().set(&DataKey::IsInitialized, &true);
        env.storage().instance().set(&DataKey::PlatformFeeBps, &platform_fee_bps);
        env.storage().instance().set(&DataKey::PlatformFeeRecipient, &platform_fee_recipient);
        Self::bump_instance(&env);
    }

    pub fn set_milestones_contract(env: Env, milestones: Address) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&DataKey::MilestonesContract, &milestones);
    }

    pub fn get_milestones_contract(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::MilestonesContract)
    }

    pub fn set_second_signer(env: Env, second_signer: Address) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        if second_signer == admin {
            panic!("Second signer must be distinct from admin");
        }
        env.storage().instance().set(&DataKey::SecondSigner, &second_signer);
    }

    pub fn get_second_signer(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::SecondSigner)
    }

    pub fn mark_campaign_failed(env: Env) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&DataKey::CampaignFailed, &true);
        Self::bump_instance(&env);
        env.events().publish((Symbol::new(&env, "campaign_failed"), admin), ());
    }

    pub fn is_campaign_failed(env: Env) -> bool {
        if env.storage().instance().get(&DataKey::CampaignFailed).unwrap_or(false) {
            return true;
        }
        let deadline: u64 = env.storage().instance().get(&DataKey::Deadline).unwrap();
        let total_raised: i128 = env.storage().instance().get(&DataKey::TotalRaised).unwrap_or(0);
        let target: i128 = env.storage().instance().get(&DataKey::Target).unwrap();
        env.ledger().timestamp() > deadline && total_raised < target
    }

    pub fn is_refunding(env: Env) -> bool {
        env.storage().instance().get(&DataKey::IsRefunding).unwrap_or(false)
    }

    pub fn deposit(env: Env, from: Address, amount: i128) {
        if amount <= 0 {
            panic!("Deposit amount must be positive");
        }

        from.require_auth();

        if Self::is_campaign_failed(env.clone()) || Self::is_refunding(env.clone()) {
            panic!("Campaign is closed for contributions");
        }

        let deadline: u64 = env.storage().instance().get(&DataKey::Deadline).unwrap();
        let current_time = env.ledger().timestamp();
        if current_time > deadline {
            panic!("Campaign deadline has passed");
        }

        let asset: Address = env.storage().instance().get(&DataKey::Asset).unwrap();
        let client = token::Client::new(&env, &asset);
        client.transfer(&from, &env.current_contract_address(), &amount);

        let balance_key = DataKey::Balances(from.clone());
        let current_balance: i128 = env.storage().persistent().get(&balance_key).unwrap_or(0);
        env.storage().persistent().set(&balance_key, &(current_balance + amount));
        Self::bump_persistent(&env, &balance_key);

        let total_raised: i128 = env.storage().instance().get(&DataKey::TotalRaised).unwrap_or(0);
        env.storage().instance().set(&DataKey::TotalRaised, &(total_raised + amount));
        Self::bump_instance(&env);

        env.events().publish(
            (Symbol::new(&env, "deposit"), from),
            amount,
        );
    }

    pub fn approve_withdrawal(env: Env, to: Address, release_amount: i128) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        if Self::is_campaign_failed(env.clone()) || Self::is_refunding(env.clone()) {
            panic!("Campaign has failed or is refunding; withdrawals blocked");
        }

        let total_raised: i128 = env.storage().instance().get(&DataKey::TotalRaised).unwrap_or(0);
        let target: i128 = env.storage().instance().get(&DataKey::Target).unwrap();
        let milestones_opt: Option<Address> = env.storage().instance().get(&DataKey::MilestonesContract);
        let is_from_milestones = match milestones_opt {
            Some(ref m) => admin == *m,
            None => false,
        };

        if total_raised < target && !is_from_milestones {
            panic!("Withdrawal not allowed: target not met");
        }

        if release_amount <= 0 {
            panic!("Release amount must be positive");
        }

        let dest_key = DataKey::ApprovedWithdrawalFor(to.clone());
        let approved_for_to: i128 = env.storage().persistent().get(&dest_key).unwrap_or(0);
        env.storage().persistent().set(&dest_key, &(approved_for_to + release_amount));
        Self::bump_persistent(&env, &dest_key);
        Self::bump_instance(&env);

        let approved: i128 = env.storage().instance().get(&DataKey::ApprovedWithdrawal).unwrap_or(0);
        env.storage().instance().set(&DataKey::ApprovedWithdrawal, &(approved + release_amount));

        env.events().publish(
            (Symbol::new(&env, "approve_withdrawal"), to),
            release_amount,
        );
    }

    pub fn approve_milestone_withdrawal(env: Env, to: Address, release_amount: i128) {
        let milestones: Address = env.storage().instance().get(&DataKey::MilestonesContract)
            .expect("Milestones contract not configured");
        milestones.require_auth();

        if Self::is_campaign_failed(env.clone()) || Self::is_refunding(env.clone()) {
            panic!("Campaign has failed or is refunding; withdrawals blocked");
        }

        if release_amount <= 0 {
            panic!("Release amount must be positive");
        }

        let dest_key = DataKey::ApprovedWithdrawalFor(to.clone());
        let approved_for_to: i128 = env.storage().persistent().get(&dest_key).unwrap_or(0);
        env.storage().persistent().set(&dest_key, &(approved_for_to + release_amount));
        Self::bump_persistent(&env, &dest_key);
        Self::bump_instance(&env);

        let approved: i128 = env.storage().instance().get(&DataKey::ApprovedWithdrawal).unwrap_or(0);
        env.storage().instance().set(&DataKey::ApprovedWithdrawal, &(approved + release_amount));

        env.events().publish(
            (Symbol::new(&env, "approve_withdrawal"), to),
            release_amount,
        );
    }

    /// Step 1 of 2: the admin proposes a new platform fee.
    pub fn propose_fee_change(env: Env, new_fee_bps: u32) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        if new_fee_bps > MAX_FEE_BPS {
            panic!("Platform fee BPS must not exceed MAX_FEE_BPS");
        }

        env.storage().instance().set(&DataKey::PendingFeeBps, &new_fee_bps);

        env.events().publish(
            (Symbol::new(&env, "fee_proposed"), admin),
            new_fee_bps,
        );
    }

    /// Step 2 of 2: the admin confirms the pending fee, applying it.
    pub fn confirm_fee_change(env: Env) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        let new_fee_bps: u32 = match env.storage().instance().get(&DataKey::PendingFeeBps) {
            Some(bps) => bps,
            None => panic!("No pending fee change to confirm"),
        };

        if new_fee_bps > MAX_FEE_BPS {
            panic!("Platform fee BPS must not exceed MAX_FEE_BPS");
        }

        env.storage().instance().set(&DataKey::PlatformFeeBps, &new_fee_bps);
        env.storage().instance().remove(&DataKey::PendingFeeBps);

        env.events().publish(
            (Symbol::new(&env, "fee_changed"), admin),
            new_fee_bps,
        );
    }

    /// Cancels any pending fee proposal without applying it.
    pub fn cancel_fee_change(env: Env) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        if !env.storage().instance().has(&DataKey::PendingFeeBps) {
            panic!("No pending fee change to cancel");
        }

        env.storage().instance().remove(&DataKey::PendingFeeBps);

        env.events().publish(
            (Symbol::new(&env, "fee_cancelled"), admin),
            (),
        );
    }

    /// Returns the pending proposed fee in BPS, or `None` if no change is pending.
    pub fn get_pending_fee(env: Env) -> Option<u32> {
        env.storage().instance().get(&DataKey::PendingFeeBps)
    }

    pub fn execute_withdrawal(env: Env, to: Address, release_amount: i128) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        if Self::is_campaign_failed(env.clone()) || Self::is_refunding(env.clone()) {
            panic!("Campaign has failed or is refunding; withdrawals blocked");
        }

        if release_amount <= 0 {
            panic!("Release amount must be positive");
        }

        let dest_key = DataKey::ApprovedWithdrawalFor(to.clone());
        let mut approved_for_to: i128 = env.storage().persistent().get(&dest_key).unwrap_or(0);
        if approved_for_to < release_amount {
            panic!("Insufficient approved amount for destination");
        }

        let mut approved: i128 = env.storage().instance().get(&DataKey::ApprovedWithdrawal).unwrap_or(0);
        if approved < release_amount {
            panic!("Insufficient approved amount");
        }

        let asset: Address = env.storage().instance().get(&DataKey::Asset).unwrap();
        let client = token::Client::new(&env, &asset);

        let fee_bps: u32 = env.storage().instance().get(&DataKey::PlatformFeeBps).unwrap_or(0);
        let fee_amount = (release_amount * (fee_bps as i128)) / 10000;
        let net_amount = release_amount - fee_amount;

        if net_amount > 0 {
            client.transfer(&env.current_contract_address(), &to, &net_amount);
        }

        if fee_amount > 0 {
            let fee_recipient: Address = env.storage().instance().get(&DataKey::PlatformFeeRecipient).unwrap();
            client.transfer(&env.current_contract_address(), &fee_recipient, &fee_amount);
        }

        approved_for_to -= release_amount;
        env.storage().persistent().set(&dest_key, &approved_for_to);
        Self::bump_persistent(&env, &dest_key);
        Self::bump_instance(&env);

        approved -= release_amount;
        env.storage().instance().set(&DataKey::ApprovedWithdrawal, &approved);

        env.events().publish(
            (Symbol::new(&env, "withdrawal"), to),
            (release_amount, net_amount, fee_amount),
        );
    }

    /// Admin override withdrawal requiring a second signer. Emits an event.
    pub fn admin_override_withdrawal(
        env: Env,
        second_signer: Address,
        to: Address,
        release_amount: i128,
    ) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        second_signer.require_auth();

        if admin == second_signer {
            panic!("Second signer must be distinct from admin");
        }

        if let Some(configured) = env.storage().instance().get::<_, Address>(&DataKey::SecondSigner) {
            if second_signer != configured {
                panic!("Invalid second signer");
            }
        }

        if release_amount <= 0 {
            panic!("Release amount must be positive");
        }

        let asset: Address = env.storage().instance().get(&DataKey::Asset).unwrap();
        let client = token::Client::new(&env, &asset);
        let contract_balance = client.balance(&env.current_contract_address());
        if contract_balance < release_amount {
            panic!("Insufficient contract balance for override withdrawal");
        }

        let fee_bps: u32 = env.storage().instance().get(&DataKey::PlatformFeeBps).unwrap_or(0);
        let fee_amount = (release_amount * (fee_bps as i128)) / 10000;
        let net_amount = release_amount - fee_amount;

        if net_amount > 0 {
            client.transfer(&env.current_contract_address(), &to, &net_amount);
        }

        if fee_amount > 0 {
            let fee_recipient: Address = env.storage().instance().get(&DataKey::PlatformFeeRecipient).unwrap();
            client.transfer(&env.current_contract_address(), &fee_recipient, &fee_amount);
        }

        env.events().publish(
            (Symbol::new(&env, "admin_override_withdrawal"), to),
            (release_amount, second_signer),
        );
    }

    /// Refunds a contributor once the campaign has failed.
    ///
    /// Withdrawals (milestone releases, admin overrides) may already have
    /// moved money out before the campaign failed, so the contract can hold
    /// less than the sum of recorded balances. On the first refund we snapshot
    /// the funds still held (`RefundPool`) and the total contributed
    /// (`RefundBase`); every contributor then receives
    /// `balance * RefundPool / RefundBase`, so refund order no longer matters.
    pub fn refund(env: Env, contributor: Address) {
        let explicitly_failed: bool = env.storage().instance().get(&DataKey::CampaignFailed).unwrap_or(false);
        if !explicitly_failed {
            let deadline: u64 = env.storage().instance().get(&DataKey::Deadline).unwrap();
            if env.ledger().timestamp() < deadline {
                panic!("Deadline has not passed");
            }

            let total_raised: i128 = env.storage().instance().get(&DataKey::TotalRaised).unwrap_or(0);
            let target: i128 = env.storage().instance().get(&DataKey::Target).unwrap();

            if total_raised >= target {
                panic!("Campaign succeeded, refunds unavailable");
            }
        }

        let balance_key = DataKey::Balances(contributor.clone());
        let amount: i128 = env.storage().persistent().get(&balance_key).unwrap_or(0);
        if amount <= 0 {
            panic!("No contribution to refund");
        }

        let asset: Address = env.storage().instance().get(&DataKey::Asset).unwrap();
        let client = token::Client::new(&env, &asset);

        if !env.storage().instance().has(&DataKey::RefundBase) {
            let total_raised: i128 = env.storage().instance().get(&DataKey::TotalRaised).unwrap_or(0);
            let held = client.balance(&env.current_contract_address());
            let pool = if held < total_raised { held } else { total_raised };
            env.storage().instance().set(&DataKey::RefundPool, &pool);
            env.storage().instance().set(&DataKey::RefundBase, &total_raised);
        }
        let pool: i128 = env.storage().instance().get(&DataKey::RefundPool).unwrap();
        let base: i128 = env.storage().instance().get(&DataKey::RefundBase).unwrap();
        let payout = amount * pool / base;

        // Mark campaign as refunding so any withdrawals are permanently blocked
        env.storage().instance().set(&DataKey::IsRefunding, &true);

        env.storage().persistent().set(&balance_key, &0i128);
        Self::bump_persistent(&env, &balance_key);

        let total_raised_current: i128 = env.storage().instance().get(&DataKey::TotalRaised).unwrap_or(0);
        let new_total = total_raised_current - amount;
        env.storage().instance().set(&DataKey::TotalRaised, &new_total);
        Self::bump_instance(&env);

        if payout > 0 {
            client.transfer(&env.current_contract_address(), &contributor, &payout);
        }

        env.events().publish(
            (Symbol::new(&env, "refund"), contributor),
            payout,
        );
    }

    pub fn get_total_raised(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalRaised).unwrap_or(0)
    }

    pub fn get_asset(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Asset).unwrap()
    }

    pub fn get_platform_fee_config(env: Env) -> (u32, Address) {
        let bps: u32 = env.storage().instance().get(&DataKey::PlatformFeeBps).unwrap_or(0);
        let recipient: Address = env.storage().instance().get(&DataKey::PlatformFeeRecipient).unwrap();
        (bps, recipient)
    }

    pub fn get_approved_withdrawal(env: Env, to: Address) -> i128 {
        let dest_key = DataKey::ApprovedWithdrawalFor(to);
        env.storage().persistent().get(&dest_key).unwrap_or(0)
    }

    pub fn get_balance(env: Env, contributor: Address) -> i128 {
        env.storage().persistent().get(&DataKey::Balances(contributor)).unwrap_or(0)
    }

    /// TTL (in ledgers) that keeps an entry live until the deadline plus the
    /// refund window, capped at the network's maximum entry TTL.
    fn ttl_target(env: &Env) -> u32 {
        let deadline: u64 = env.storage().instance().get(&DataKey::Deadline).unwrap_or(0);
        let now = env.ledger().timestamp();
        let to_deadline = deadline.saturating_sub(now) / LEDGER_SECONDS;
        let to_deadline = if to_deadline > u32::MAX as u64 { u32::MAX } else { to_deadline as u32 };
        to_deadline
            .saturating_add(REFUND_WINDOW_LEDGERS)
            .min(env.storage().max_ttl())
    }

    fn bump_instance(env: &Env) {
        let extend_to = Self::ttl_target(env);
        env.storage()
            .instance()
            .extend_ttl(extend_to.saturating_sub(TTL_BUMP_SLACK), extend_to);
    }

    fn bump_persistent(env: &Env, key: &DataKey) {
        let extend_to = Self::ttl_target(env);
        env.storage()
            .persistent()
            .extend_ttl(key, extend_to.saturating_sub(TTL_BUMP_SLACK), extend_to);
    }
}
