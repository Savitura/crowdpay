#![no_std]
#[cfg(test)]
extern crate std;

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Symbol, token};

#[cfg(test)]
mod test;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Active,
    Passed,
    Failed,
    Executed,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeProposal {
    pub id: u32,
    pub proposed_fee_bps: u32,
    pub proposed_creator_share_bps: u32,
    pub votes_for: i128,
    pub votes_against: i128,
    pub deadline: u64,
    pub status: ProposalStatus,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    PlatformFeeBps,
    CreatorShareBps,
    GovernanceToken,
    Admin,
    PendingProposal,
    ProposalCounter,
    ProposalVotes(u32, Address), // proposal_id, voter_address
    LockedDeposit(u32, Address), // proposal_id, voter_address
    Proposal(u32), // proposal_id
}

const DAY_IN_LEDGERS: u32 = 17_280;
/// Campaigns run for weeks and milestones can take months to deliver, so
/// keep this contract's entries live well beyond the 4096-ledger default.
pub const STORAGE_TTL_LEDGERS: u32 = 180 * DAY_IN_LEDGERS;
/// Entries are only re-extended once their remaining TTL drops this far
/// below the target, so back-to-back calls don't pay for redundant bumps.
const TTL_BUMP_SLACK: u32 = DAY_IN_LEDGERS;
const PROPOSAL_VOTING_PERIOD: u64 = 7 * 24 * 60 * 60; // 7 days in seconds
const MIN_TOKEN_BALANCE: i128 = 1000; // Minimum 1000 tokens to propose
const QUORUM_THRESHOLD: i128 = 1000; // 10% of total supply (assuming 10,000 total supply)

/// Maximum platform fee the registry will store, in basis points (10% = 1000 BPS).
///
/// Mirrors `MAX_FEE_BPS` in the escrow contract, which rejects any fee above this cap,
/// so a higher value here could never take effect.
pub const MAX_FEE_BPS: u32 = 1000;

/// The creator share is a percentage of collected platform fees, so 10000 BPS is the ceiling.
pub const MAX_CREATOR_SHARE_BPS: u32 = 10000;

/// Applied by every path that stores a fee: initialization, governance proposals, admin override.
fn validate_fees(new_fee_bps: u32, new_creator_share_bps: u32) {
    if new_fee_bps > MAX_FEE_BPS {
        panic!("Platform fee BPS must not exceed MAX_FEE_BPS");
    }
    if new_creator_share_bps > MAX_CREATOR_SHARE_BPS {
        panic!("Creator share BPS must not exceed MAX_CREATOR_SHARE_BPS");
    }
}

#[contract]
pub struct FeeRegistry;

#[contractimpl]
impl FeeRegistry {
    pub fn initialize(
        env: Env,
        admin: Address,
        governance_token: Address,
        initial_platform_fee_bps: u32,
        initial_creator_share_bps: u32,
    ) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Already initialized");
        }
        admin.require_auth();

        validate_fees(initial_platform_fee_bps, initial_creator_share_bps);

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::GovernanceToken, &governance_token);
        env.storage().instance().set(&DataKey::PlatformFeeBps, &initial_platform_fee_bps);
        env.storage().instance().set(&DataKey::CreatorShareBps, &initial_creator_share_bps);
        env.storage().instance().set(&DataKey::ProposalCounter, &0u32);
        Self::bump_instance(&env);
    }

    pub fn get_fee(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::PlatformFeeBps).unwrap_or(0)
    }

    pub fn get_creator_share(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::CreatorShareBps).unwrap_or(0)
    }

    pub fn get_governance_token(env: Env) -> Address {
        env.storage().instance().get(&DataKey::GovernanceToken).unwrap()
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).unwrap()
    }

    pub fn get_pending_proposal(env: Env) -> Option<FeeProposal> {
        env.storage().instance().get(&DataKey::PendingProposal)
    }

    pub fn get_proposal(env: Env, proposal_id: u32) -> Option<FeeProposal> {
        env.storage().persistent().get(&DataKey::Proposal(proposal_id))
    }

    pub fn propose_change(
        env: Env,
        proposer: Address,
        new_fee_bps: u32,
        new_creator_share_bps: u32,
    ) -> u32 {
        proposer.require_auth();

        validate_fees(new_fee_bps, new_creator_share_bps);

        // Check if proposer has minimum token balance
        let governance_token: Address = env.storage().instance().get(&DataKey::GovernanceToken).unwrap();
        let token_client = token::Client::new(&env, &governance_token);
        let proposer_balance = token_client.balance(&proposer);

        if proposer_balance < MIN_TOKEN_BALANCE {
            panic!("Proposer must hold at least 1000 governance tokens");
        }

        // Check if there's already an active proposal
        if let Some(existing_proposal) = env.storage().instance().get::<_, FeeProposal>(&DataKey::PendingProposal) {
            if existing_proposal.status == ProposalStatus::Active {
                panic!("There is already an active proposal");
            }
        }

        // Create new proposal
        let proposal_counter: u32 = env.storage().instance().get(&DataKey::ProposalCounter).unwrap_or(0);
        let new_proposal_id = proposal_counter + 1;
        let current_ledger_time = env.ledger().timestamp();
        let deadline = current_ledger_time + PROPOSAL_VOTING_PERIOD;

        let proposal = FeeProposal {
            id: new_proposal_id,
            proposed_fee_bps: new_fee_bps,
            proposed_creator_share_bps: new_creator_share_bps,
            votes_for: 0,
            votes_against: 0,
            deadline,
            status: ProposalStatus::Active,
        };

        env.storage().instance().set(&DataKey::PendingProposal, &proposal);
        env.storage().instance().set(&DataKey::ProposalCounter, &new_proposal_id);
        env.storage().persistent().set(&DataKey::Proposal(new_proposal_id), &proposal);
        Self::bump_persistent(&env, &DataKey::Proposal(new_proposal_id));
        Self::bump_instance(&env);

        new_proposal_id
    }

    pub fn vote(env: Env, voter: Address, proposal_id: u32, in_favor: bool) {
        voter.require_auth();

        let mut proposal: FeeProposal = env.storage().instance()
            .get::<_, FeeProposal>(&DataKey::PendingProposal)
            .expect("No active proposal");

        if proposal.id != proposal_id {
            panic!("Proposal ID does not match active proposal");
        }

        if proposal.status != ProposalStatus::Active {
            panic!("Proposal is not active for voting");
        }

        if env.ledger().timestamp() >= proposal.deadline {
            panic!("Voting period has ended");
        }

        // Check if voter has already voted
        let vote_key = DataKey::ProposalVotes(proposal_id, voter.clone());
        if env.storage().persistent().has(&vote_key) {
            panic!("Already voted on this proposal");
        }

        // Get voter's token balance at time of vote
        let governance_token: Address = env.storage().instance().get(&DataKey::GovernanceToken).unwrap();
        let token_client = token::Client::new(&env, &governance_token);
        let vote_weight = token_client.balance(&voter);

        if vote_weight <= 0 {
            panic!("Voter must hold governance tokens");
        }

        // Lock voter's tokens into the contract during the vote so tokens cannot vote twice
        token_client.transfer(&voter, &env.current_contract_address(), &vote_weight);
        let deposit_key = DataKey::LockedDeposit(proposal_id, voter.clone());
        env.storage().persistent().set(&deposit_key, &vote_weight);
        Self::bump_persistent(&env, &deposit_key);

        // Record vote
        env.storage().persistent().set(&vote_key, &in_favor);
        Self::bump_persistent(&env, &vote_key);

        // Update proposal vote counts
        if in_favor {
            proposal.votes_for += vote_weight;
        } else {
            proposal.votes_against += vote_weight;
        }

        env.storage().instance().set(&DataKey::PendingProposal, &proposal);
        env.storage().persistent().set(&DataKey::Proposal(proposal_id), &proposal);
        Self::bump_persistent(&env, &DataKey::Proposal(proposal_id));
        Self::bump_instance(&env);
    }

    pub fn reclaim_vote_deposit(env: Env, voter: Address, proposal_id: u32) {
        voter.require_auth();

        let proposal_opt: Option<FeeProposal> = env.storage().persistent().get(&DataKey::Proposal(proposal_id))
            .or_else(|| {
                let pending: Option<FeeProposal> = env.storage().instance().get(&DataKey::PendingProposal);
                if let Some(ref p) = pending {
                    if p.id == proposal_id {
                        return pending;
                    }
                }
                None
            });

        let proposal = proposal_opt.expect("Proposal not found");

        if proposal.status == ProposalStatus::Active && env.ledger().timestamp() < proposal.deadline {
            panic!("Voting period has not ended");
        }

        let deposit_key = DataKey::LockedDeposit(proposal_id, voter.clone());
        let locked_amount: i128 = env.storage().persistent().get(&deposit_key).unwrap_or(0);

        if locked_amount <= 0 {
            panic!("No deposit to reclaim");
        }

        let governance_token: Address = env.storage().instance().get(&DataKey::GovernanceToken).unwrap();
        let token_client = token::Client::new(&env, &governance_token);

        token_client.transfer(&env.current_contract_address(), &voter, &locked_amount);
        env.storage().persistent().remove(&deposit_key);
        Self::bump_instance(&env);

        env.events().publish(
            (Symbol::new(&env, "deposit_reclaimed"), voter),
            (proposal_id, locked_amount),
        );
    }

    pub fn get_locked_deposit(env: Env, proposal_id: u32, voter: Address) -> i128 {
        let deposit_key = DataKey::LockedDeposit(proposal_id, voter);
        env.storage().persistent().get(&deposit_key).unwrap_or(0)
    }

    pub fn execute_proposal(env: Env, proposal_id: u32) {
        let mut proposal: FeeProposal = env.storage().instance()
            .get::<_, FeeProposal>(&DataKey::PendingProposal)
            .expect("No active proposal");

        if proposal.id != proposal_id {
            panic!("Proposal ID does not match active proposal");
        }

        if proposal.status != ProposalStatus::Active {
            panic!("Proposal is not active");
        }

        if env.ledger().timestamp() < proposal.deadline {
            panic!("Voting period has not ended");
        }

        if proposal.votes_for > proposal.votes_against && proposal.votes_for >= QUORUM_THRESHOLD {
            // Proposal passed - update fees
            env.storage().instance().set(&DataKey::PlatformFeeBps, &proposal.proposed_fee_bps);
            env.storage().instance().set(&DataKey::CreatorShareBps, &proposal.proposed_creator_share_bps);
            proposal.status = ProposalStatus::Executed;
        } else {
            // Proposal failed
            proposal.status = ProposalStatus::Failed;
        }

        env.storage().instance().set(&DataKey::PendingProposal, &proposal);
        env.storage().persistent().set(&DataKey::Proposal(proposal_id), &proposal);
        Self::bump_persistent(&env, &DataKey::Proposal(proposal_id));
        Self::bump_instance(&env);
    }

    pub fn admin_set_fee(env: Env, admin: Address, new_fee_bps: u32, new_creator_share_bps: u32) {
        let stored_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if admin != stored_admin {
            panic!("Only the admin can set the fee");
        }
        stored_admin.require_auth();

        validate_fees(new_fee_bps, new_creator_share_bps);

        env.storage().instance().set(&DataKey::PlatformFeeBps, &new_fee_bps);
        env.storage().instance().set(&DataKey::CreatorShareBps, &new_creator_share_bps);
        Self::bump_instance(&env);
    }

    pub fn get_vote_status(env: Env, proposal_id: u32, voter: Address) -> Option<bool> {
        let vote_key = DataKey::ProposalVotes(proposal_id, voter);
        env.storage().persistent().get(&vote_key)
    }

    fn bump_instance(env: &Env) {
        let extend_to = STORAGE_TTL_LEDGERS.min(env.storage().max_ttl());
        env.storage()
            .instance()
            .extend_ttl(extend_to.saturating_sub(TTL_BUMP_SLACK), extend_to);
    }

    fn bump_persistent(env: &Env, key: &DataKey) {
        let extend_to = STORAGE_TTL_LEDGERS.min(env.storage().max_ttl());
        env.storage()
            .persistent()
            .extend_ttl(key, extend_to.saturating_sub(TTL_BUMP_SLACK), extend_to);
    }
}
