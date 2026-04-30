#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::Address as _, testutils::Ledger, token::StellarAssetClient, Address, Env, String,
};

struct Fixture<'a> {
    env: Env,
    client: VotingClient<'a>,
    gov_token: Address,
    admin: Address,
    alice: Address,
    bob: Address,
    carol: Address,
}

fn setup<'a>() -> Fixture<'a> {
    let env = Env::default();
    // cast_vote sub-invokes the gov-token's `balance`, so the inner auth
    // probe needs to pass without being the root call.
    env.mock_all_auths_allowing_non_root_auth();

    // Use a Stellar Asset Contract as the gov-token stand-in — its
    // TokenInterface signature matches what Voting calls via inter-contract
    // call, so we don't have to deploy our own GovToken in the voting tests.
    let sac_admin = Address::generate(&env);
    let token_sac = env.register_stellar_asset_contract_v2(sac_admin);
    let gov_token = token_sac.address();

    let admin = Address::generate(&env);
    let contract_id = env.register(Voting, (admin.clone(), gov_token.clone()));
    let client = VotingClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let carol = Address::generate(&env);

    // Mint gov tokens — alice 100, bob 50, carol 25; admin holds none on
    // purpose so the "no voting power" test below is deterministic.
    let admin_client = StellarAssetClient::new(&env, &gov_token);
    admin_client.mint(&alice, &100);
    admin_client.mint(&bob, &50);
    admin_client.mint(&carol, &25);

    Fixture {
        env,
        client,
        gov_token,
        admin,
        alice,
        bob,
        carol,
    }
}

fn title(env: &Env, s: &str) -> String {
    String::from_str(env, s)
}

#[test]
fn create_proposal_assigns_incrementing_ids_and_indexes_by_creator() {
    let f = setup();

    let id1 = f.client.create_proposal(
        &f.alice,
        &title(&f.env, "Adopt the bylaws v2"),
        &title(&f.env, "Replaces the v1 bylaws drafted last year."),
        &86_400,
    );
    let id2 = f.client.create_proposal(
        &f.alice,
        &title(&f.env, "Treasury allocation Q3"),
        &title(&f.env, ""),
        &86_400,
    );

    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
    assert_eq!(f.client.proposal_count(), 2);

    let p1 = f.client.get_proposal(&id1);
    assert_eq!(p1.creator, f.alice);
    assert_eq!(p1.yes_weight, 0);
    assert_eq!(p1.no_weight, 0);
    assert_eq!(p1.voter_count, 0);
    assert_eq!(p1.title, title(&f.env, "Adopt the bylaws v2"));

    let mine = f.client.proposals_by_creator(&f.alice);
    assert_eq!(mine.len(), 2);
}

#[test]
fn cast_vote_uses_gov_token_balance_as_weight() {
    let f = setup();
    let id = f.client.create_proposal(
        &f.alice,
        &title(&f.env, "Topic"),
        &title(&f.env, ""),
        &86_400,
    );

    // alice (100) yes, bob (50) yes, carol (25) no.
    f.client.cast_vote(&id, &f.alice, &true);
    f.client.cast_vote(&id, &f.bob, &true);
    f.client.cast_vote(&id, &f.carol, &false);

    let p = f.client.get_proposal(&id);
    // L4 invariant: the inter-contract balance call set the per-vote weight.
    assert_eq!(p.yes_weight, 150); // 100 + 50
    assert_eq!(p.no_weight, 25);
    assert_eq!(p.voter_count, 3);

    // Per-voter weight snapshots are exactly the balance at vote time.
    assert_eq!(f.client.get_vote_weight(&id, &f.alice), 100);
    assert_eq!(f.client.get_vote_weight(&id, &f.bob), 50);
    assert_eq!(f.client.get_vote_weight(&id, &f.carol), 25);
    assert_eq!(f.client.get_vote(&id, &f.alice), Some(true));
    assert_eq!(f.client.get_vote(&id, &f.carol), Some(false));
}

#[test]
fn vote_weight_snapshot_is_immune_to_later_balance_changes() {
    let f = setup();
    let id = f.client.create_proposal(
        &f.alice,
        &title(&f.env, "Topic"),
        &title(&f.env, ""),
        &86_400,
    );

    f.client.cast_vote(&id, &f.alice, &true);
    let snapshot_before = f.client.get_vote_weight(&id, &f.alice);
    assert_eq!(snapshot_before, 100);

    // Alice transfers her tokens away after voting — the recorded weight
    // must not change retroactively.
    let token_client = soroban_sdk::token::Client::new(&f.env, &f.gov_token);
    token_client.transfer(&f.alice, &f.bob, &100);
    assert_eq!(token_client.balance(&f.alice), 0);

    let p = f.client.get_proposal(&id);
    assert_eq!(p.yes_weight, 100);
    assert_eq!(f.client.get_vote_weight(&id, &f.alice), 100);
}

#[test]
#[should_panic(expected = "no voting power")]
fn cast_vote_rejects_zero_balance_voter() {
    let f = setup();
    let id = f.client.create_proposal(
        &f.alice,
        &title(&f.env, "Topic"),
        &title(&f.env, ""),
        &86_400,
    );
    // f.admin was never minted gov tokens, so balance is 0.
    f.client.cast_vote(&id, &f.admin, &true);
}

#[test]
#[should_panic(expected = "already voted")]
fn cast_vote_rejects_double_vote() {
    let f = setup();
    let id = f.client.create_proposal(
        &f.alice,
        &title(&f.env, "Topic"),
        &title(&f.env, ""),
        &86_400,
    );
    f.client.cast_vote(&id, &f.bob, &true);
    f.client.cast_vote(&id, &f.bob, &false);
}

#[test]
#[should_panic(expected = "voting closed")]
fn cast_vote_rejects_after_window() {
    let f = setup();
    let id = f.client.create_proposal(
        &f.alice,
        &title(&f.env, "Topic"),
        &title(&f.env, ""),
        &120,
    );
    f.env.ledger().with_mut(|l| {
        l.timestamp += 121;
    });
    f.client.cast_vote(&id, &f.bob, &true);
}

#[test]
fn is_active_flips_when_window_expires() {
    let f = setup();
    let id = f.client.create_proposal(
        &f.alice,
        &title(&f.env, "Topic"),
        &title(&f.env, ""),
        &600,
    );
    assert!(f.client.is_active(&id));
    f.env.ledger().with_mut(|l| {
        l.timestamp += 601;
    });
    assert!(!f.client.is_active(&id));
    assert!(!f.client.is_active(&999));
}

#[test]
#[should_panic(expected = "title required")]
fn rejects_empty_title() {
    let f = setup();
    f.client.create_proposal(
        &f.alice,
        &title(&f.env, ""),
        &title(&f.env, "no title"),
        &86_400,
    );
}

#[test]
#[should_panic(expected = "window too short")]
fn rejects_too_short_window() {
    let f = setup();
    f.client.create_proposal(
        &f.alice,
        &title(&f.env, "Topic"),
        &title(&f.env, ""),
        &10,
    );
}

#[test]
#[should_panic(expected = "window too long")]
fn rejects_too_long_window() {
    let f = setup();
    f.client.create_proposal(
        &f.alice,
        &title(&f.env, "Topic"),
        &title(&f.env, ""),
        &(31 * 24 * 60 * 60),
    );
}

#[test]
#[should_panic(expected = "proposal not found")]
fn cast_vote_unknown_proposal() {
    let f = setup();
    f.client.cast_vote(&42, &f.bob, &true);
}

#[test]
fn admin_and_gov_token_views_return_constructor_args() {
    let f = setup();
    assert_eq!(f.client.admin(), f.admin);
    assert_eq!(f.client.gov_token(), f.gov_token);
}

#[test]
fn get_vote_returns_none_for_non_voter() {
    let f = setup();
    let id = f.client.create_proposal(
        &f.alice,
        &title(&f.env, "Topic"),
        &title(&f.env, ""),
        &86_400,
    );
    let stranger = Address::generate(&f.env);
    assert_eq!(f.client.get_vote(&id, &stranger), None);
    assert!(!f.client.has_voted(&id, &stranger));
    assert_eq!(f.client.get_vote_weight(&id, &stranger), 0);
}
