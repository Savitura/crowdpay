#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, Symbol, Vec, token
};

#[cfg(test)]
mod test;

/// Ledgers close roughly every 5 seconds on Stellar.
const LEDGER_SECONDS: u64 = 5;
const DAY_IN_LEDGERS: u32 = 17_280;
/// How long contributor balances must stay live after the deadline so that
/// late refunds and milestone releases still work without a manual restore.
pub const REFUND_WINDOW_LEDGERS: u32 = 60 * DAY_IN_LEDGERS;
/// Entries are only re-extended once their remaining TTL drops this far
/// below the target, so back-to-back calls don't pay for redundant bumps.
const TTL_BUMP_SLACK: u32 = DAY_IN_LEDGERS;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Milestone {
    pub target: i128,
    pub amount: i128,
    pub released: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    CampaignId,
    Goal,
    Deadline,
    Creator,
    Token,
    TotalRaised,
    TotalReleased,
    Contributions(Address),
    Milestones,
    Status,
    Platform,
    MilestoneApproved(u32),
    RefundPool,
    RefundBase,
}

#[contract]
pub struct CrowdPayContract;

#[contractimpl]
impl CrowdPayContract {
    pub fn initialize(
        env: Env,
        campaign_id: Symbol,
        creator: Address,
        platform: Address,
        token: Address,
        goal: i128,
        deadline: u64,
        milestones: Vec<Milestone>,
    ) {
        if env.storage().instance().has(&DataKey::CampaignId) {
            panic!("Already initialized");
        }
        creator.require_auth();

        if creator == platform {
            panic!("Creator and platform must be distinct");
        }
        if goal <= 0 {
            panic!("Goal must be positive");
        }
        if milestones.is_empty() {
            panic!("Milestones cannot be empty");
        }

        let mut total_milestone_amount: i128 = 0;
        for m in milestones.iter() {
            if m.released {
                panic!("Milestones must start unreleased");
            }
            if m.target <= 0 {
                panic!("Milestone target must be positive");
            }
            if m.amount <= 0 {
                panic!("Milestone amount must be positive");
            }
            total_milestone_amount += m.amount;
        }

        if total_milestone_amount > goal {
            panic!("Total milestone allocations cannot exceed goal");
        }

        env.storage().instance().set(&DataKey::CampaignId, &campaign_id);
        env.storage().instance().set(&DataKey::Creator, &creator);
        env.storage().instance().set(&DataKey::Platform, &platform);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::Goal, &goal);
        env.storage().instance().set(&DataKey::Deadline, &deadline);
        env.storage().instance().set(&DataKey::Milestones, &milestones);
        env.storage().instance().set(&DataKey::TotalRaised, &0i128);
        env.storage().instance().set(&DataKey::TotalReleased, &0i128);
        env.storage().instance().set(&DataKey::Status, &symbol_short!("Active"));
        Self::bump_instance(&env);
    }

    pub fn contribute(env: Env, contributor: Address, amount: i128) {
        if amount <= 0 {
            panic!("Contribution amount must be positive");
        }

        contributor.require_auth();
        
        let status: Symbol = env.storage().instance().get(&DataKey::Status).unwrap();
        if status != symbol_short!("Active") && status != symbol_short!("Funded") {
            panic!("Campaign is not accepting contributions");
        }

        let deadline: u64 = env.storage().instance().get(&DataKey::Deadline).unwrap();
        if env.ledger().timestamp() >= deadline {
            panic!("Deadline passed");
        }

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let client = token::Client::new(&env, &token_addr);
        client.transfer(&contributor, &env.current_contract_address(), &amount);

        let balance_key = DataKey::Contributions(contributor.clone());
        let current_balance: i128 = env.storage().persistent().get(&balance_key).unwrap_or(0);
        env.storage().persistent().set(&balance_key, &(current_balance + amount));
        Self::bump_persistent(&env, &balance_key);

        let total_raised: i128 = env.storage().instance().get(&DataKey::TotalRaised).unwrap_or(0);
        let new_total = total_raised + amount;
        env.storage().instance().set(&DataKey::TotalRaised, &new_total);

        // Check if goal reached
        let goal: i128 = env.storage().instance().get(&DataKey::Goal).unwrap();
        if new_total >= goal && status == symbol_short!("Active") {
            env.storage().instance().set(&DataKey::Status, &symbol_short!("Funded"));
        }
        Self::bump_instance(&env);
    }

    /// Platform sign-off that the creator delivered a milestone. Release is
    /// impossible until this has been called for the milestone's index.
    pub fn approve_milestone(env: Env, milestone_index: u32) {
        let platform: Address = env.storage().instance().get(&DataKey::Platform).unwrap();
        platform.require_auth();

        let status: Symbol = env.storage().instance().get(&DataKey::Status).unwrap();
        if status == symbol_short!("Failed") {
            panic!("Campaign has failed");
        }

        let milestones: Vec<Milestone> = env.storage().instance().get(&DataKey::Milestones).unwrap();
        let milestone = milestones.get(milestone_index).expect("Invalid milestone index");
        if milestone.released {
            panic!("Milestone already released");
        }

        env.storage().instance().set(&DataKey::MilestoneApproved(milestone_index), &true);
        Self::bump_instance(&env);

        env.events().publish((symbol_short!("approve"), milestone_index), platform);
    }

    pub fn is_milestone_approved(env: Env, milestone_index: u32) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::MilestoneApproved(milestone_index))
            .unwrap_or(false)
    }

    pub fn release_milestone(env: Env, milestone_index: u32) {
        let creator: Address = env.storage().instance().get(&DataKey::Creator).unwrap();
        creator.require_auth();

        let mut milestones: Vec<Milestone> = env.storage().instance().get(&DataKey::Milestones).unwrap();
        let mut milestone = milestones.get(milestone_index).expect("Invalid milestone index");

        if milestone.released {
            panic!("Milestone already released");
        }

        let status: Symbol = env.storage().instance().get(&DataKey::Status).unwrap();
        if status == symbol_short!("Failed") {
            panic!("Campaign has failed");
        }

        if !Self::is_milestone_approved(env.clone(), milestone_index) {
            panic!("Milestone not approved");
        }

        let total_raised: i128 = env.storage().instance().get(&DataKey::TotalRaised).unwrap_or(0);
        if total_raised < milestone.target {
            panic!("Milestone target not met");
        }

        let total_released: i128 = env.storage().instance().get(&DataKey::TotalReleased).unwrap_or(0);
        let milestone_amount = milestone.amount;

        if total_released + milestone_amount > total_raised {
            panic!("Release amount exceeds available funds");
        }

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let client = token::Client::new(&env, &token_addr);
        let balance = client.balance(&env.current_contract_address());
        
        if balance < milestone_amount {
            panic!("Insufficient contract balance");
        }

        milestone.released = true;
        milestones.set(milestone_index, milestone);
        env.storage().instance().set(&DataKey::Milestones, &milestones);
        env.storage().instance().set(&DataKey::TotalReleased, &(total_released + milestone_amount));
        Self::bump_instance(&env);

        if milestone_amount > 0 {
            client.transfer(&env.current_contract_address(), &creator, &milestone_amount);
        }

        env.events().publish(
            (symbol_short!("release"), milestone_index),
            (creator, milestone_amount),
        );
    }

    /// Pays the contributor their pro-rata share of whatever is still held.
    ///
    /// Milestones may already have been released before the campaign failed,
    /// so the contract can hold less than `total_raised`. On the first refund
    /// we snapshot the remaining funds (`RefundPool`) and the total they have
    /// to be split across (`RefundBase`), and every contributor receives
    /// `balance * RefundPool / RefundBase`. Refund order no longer matters.
    pub fn refund(env: Env, contributor: Address) {
        contributor.require_auth();
        let status: Symbol = env.storage().instance().get(&DataKey::Status).unwrap();
        if status != symbol_short!("Failed") {
            panic!("Campaign has not failed");
        }

        let balance_key = DataKey::Contributions(contributor.clone());
        let amount: i128 = env.storage().persistent().get(&balance_key).unwrap_or(0);
        
        if amount <= 0 {
            panic!("No contribution to refund");
        }

        if !env.storage().instance().has(&DataKey::RefundBase) {
            let total_raised: i128 = env.storage().instance().get(&DataKey::TotalRaised).unwrap_or(0);
            let total_released: i128 = env.storage().instance().get(&DataKey::TotalReleased).unwrap_or(0);
            env.storage().instance().set(&DataKey::RefundPool, &(total_raised - total_released));
            env.storage().instance().set(&DataKey::RefundBase, &total_raised);
        }
        let pool: i128 = env.storage().instance().get(&DataKey::RefundPool).unwrap();
        let base: i128 = env.storage().instance().get(&DataKey::RefundBase).unwrap();
        let payout = amount * pool / base;

        env.storage().persistent().set(&balance_key, &0i128);
        Self::bump_persistent(&env, &balance_key);
        Self::bump_instance(&env);

        if payout > 0 {
            let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
            let client = token::Client::new(&env, &token_addr);
            client.transfer(&env.current_contract_address(), &contributor, &payout);
        }

        env.events().publish((symbol_short!("refund"), contributor), (amount, payout));
    }

    pub fn set_failed(env: Env) {
        let deadline: u64 = env.storage().instance().get(&DataKey::Deadline).unwrap();
        let total_raised: i128 = env.storage().instance().get(&DataKey::TotalRaised).unwrap_or(0);
        let goal: i128 = env.storage().instance().get(&DataKey::Goal).unwrap();

        if env.ledger().timestamp() >= deadline && total_raised < goal {
            env.storage().instance().set(&DataKey::Status, &symbol_short!("Failed"));
        } else {
            let creator: Address = env.storage().instance().get(&DataKey::Creator).unwrap();
            creator.require_auth();
            env.storage().instance().set(&DataKey::Status, &symbol_short!("Failed"));
        }
        Self::bump_instance(&env);
    }

    pub fn get_status(env: Env) -> Symbol {
        env.storage().instance().get(&DataKey::Status).unwrap_or(symbol_short!("Active"))
    }

    pub fn get_total_raised(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalRaised).unwrap_or(0)
    }

    pub fn get_total_released(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalReleased).unwrap_or(0)
    }

    pub fn get_contribution(env: Env, contributor: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Contributions(contributor))
            .unwrap_or(0)
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
