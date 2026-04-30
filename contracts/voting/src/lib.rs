#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, Address, Env, String, Vec,
};

const MAX_TITLE_LEN: u32 = 80;
const MAX_DESCRIPTION_LEN: u32 = 280;
const MIN_WINDOW_SECS: u64 = 60;
const MAX_WINDOW_SECS: u64 = 30 * 24 * 60 * 60; // 30 days

#[contracttype]
#[derive(Clone)]
pub struct Proposal {
    pub id: u32,
    pub creator: Address,
    pub title: String,
    pub description: String,
    pub created_at: u64,
    pub end_time: u64,
    /// Weighted yes votes — sum of `gov_token.balance(voter)` across all yes
    /// voters at the moment they cast their vote.
    pub yes_weight: i128,
    /// Weighted no votes — same as `yes_weight` but for "no" voters.
    pub no_weight: i128,
    /// Number of distinct voters (any side). Useful to differentiate "no votes
    /// yet" from "lots of zero-weight attempts" client-side.
    pub voter_count: u32,
}

#[contracttype]
pub enum DataKey {
    Admin,
    GovToken,
    ProposalCount,
    Proposal(u32),
    HasVoted(u32, Address),
    Vote(u32, Address),
    /// Snapshot of the voter's gov-token balance at the moment they cast — so
    /// later balance changes don't retroactively rewrite tallies.
    VoteWeight(u32, Address),
    ProposalsByCreator(Address),
}

#[contract]
pub struct Voting;

#[contractimpl]
impl Voting {
    /// Constructor — wires the admin and the SEP-41 governance token whose
    /// `balance(voter)` will be the voter's weight in `cast_vote`.
    pub fn __constructor(env: Env, admin: Address, gov_token: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::GovToken, &gov_token);
        env.storage().instance().set(&DataKey::ProposalCount, &0u32);
    }

    /// Create a new proposal that closes `voting_window_secs` from now.
    /// `creator` must sign the tx. Returns the new proposal id.
    pub fn create_proposal(
        env: Env,
        creator: Address,
        title: String,
        description: String,
        voting_window_secs: u64,
    ) -> u32 {
        creator.require_auth();

        if title.len() == 0 {
            panic!("title required");
        }
        if title.len() > MAX_TITLE_LEN {
            panic!("title too long");
        }
        if description.len() > MAX_DESCRIPTION_LEN {
            panic!("description too long");
        }
        if voting_window_secs < MIN_WINDOW_SECS {
            panic!("window too short");
        }
        if voting_window_secs > MAX_WINDOW_SECS {
            panic!("window too long");
        }

        let id: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0);
        let next_id = id + 1;
        env.storage()
            .instance()
            .set(&DataKey::ProposalCount, &next_id);

        let now = env.ledger().timestamp();
        let proposal = Proposal {
            id: next_id,
            creator: creator.clone(),
            title: title.clone(),
            description: description.clone(),
            created_at: now,
            end_time: now + voting_window_secs,
            yes_weight: 0,
            no_weight: 0,
            voter_count: 0,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(next_id), &proposal);

        let creator_key = DataKey::ProposalsByCreator(creator.clone());
        let mut by_creator: Vec<u32> = env
            .storage()
            .persistent()
            .get(&creator_key)
            .unwrap_or_else(|| Vec::new(&env));
        by_creator.push_back(next_id);
        env.storage().persistent().set(&creator_key, &by_creator);

        env.events().publish(
            (symbol_short!("created"), creator),
            (next_id, title, proposal.end_time),
        );

        next_id
    }

    /// Cast a yes/no vote on `id`. Vote weight is the voter's current
    /// balance on the configured governance token, fetched via an
    /// inter-contract `balance` call. Voters with zero balance are
    /// rejected — the DAO doesn't count "phantom" votes.
    pub fn cast_vote(env: Env, id: u32, voter: Address, support: bool) {
        voter.require_auth();

        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(id))
            .expect("proposal not found");

        let now = env.ledger().timestamp();
        if now >= proposal.end_time {
            panic!("voting closed");
        }

        let voted_key = DataKey::HasVoted(id, voter.clone());
        if env.storage().persistent().get(&voted_key).unwrap_or(false) {
            panic!("already voted");
        }

        // ── L4 inter-contract call ────────────────────────────────────────
        // Read the voter's gov-token balance from the deployed SEP-41
        // contract. `voter.require_auth()` above plus the SDK's sub-invocation
        // auth-chain rules mean the wallet's signature on `cast_vote` also
        // covers this read. (It's a pure view, so even a fully open auth
        // configuration would be safe — no value moves.)
        let gov_token: Address = env
            .storage()
            .instance()
            .get(&DataKey::GovToken)
            .expect("contract not initialized");
        let weight = token::Client::new(&env, &gov_token).balance(&voter);
        if weight <= 0 {
            panic!("no voting power");
        }

        if support {
            proposal.yes_weight += weight;
        } else {
            proposal.no_weight += weight;
        }
        proposal.voter_count += 1;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(id), &proposal);
        env.storage().persistent().set(&voted_key, &true);
        env.storage()
            .persistent()
            .set(&DataKey::Vote(id, voter.clone()), &support);
        env.storage()
            .persistent()
            .set(&DataKey::VoteWeight(id, voter.clone()), &weight);

        env.events()
            .publish((symbol_short!("voted"), voter), (id, support, weight));
    }

    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("contract not initialized")
    }

    pub fn gov_token(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::GovToken)
            .expect("contract not initialized")
    }

    pub fn proposal_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0)
    }

    pub fn get_proposal(env: Env, id: u32) -> Proposal {
        env.storage()
            .persistent()
            .get(&DataKey::Proposal(id))
            .expect("proposal not found")
    }

    pub fn has_voted(env: Env, id: u32, voter: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::HasVoted(id, voter))
            .unwrap_or(false)
    }

    /// Returns Some(true) if `voter` voted yes, Some(false) for no, None if
    /// they haven't voted yet.
    pub fn get_vote(env: Env, id: u32, voter: Address) -> Option<bool> {
        env.storage().persistent().get(&DataKey::Vote(id, voter))
    }

    /// Returns the voter's recorded weight at the moment they cast their
    /// vote, or 0 if they haven't voted.
    pub fn get_vote_weight(env: Env, id: u32, voter: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::VoteWeight(id, voter))
            .unwrap_or(0)
    }

    pub fn is_active(env: Env, id: u32) -> bool {
        let proposal: Proposal = match env.storage().persistent().get(&DataKey::Proposal(id)) {
            Some(p) => p,
            None => return false,
        };
        env.ledger().timestamp() < proposal.end_time
    }

    pub fn proposals_by_creator(env: Env, creator: Address) -> Vec<u32> {
        env.storage()
            .persistent()
            .get(&DataKey::ProposalsByCreator(creator))
            .unwrap_or_else(|| Vec::new(&env))
    }
}

mod test;
