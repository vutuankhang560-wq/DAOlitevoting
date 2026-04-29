#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, testutils::Ledger, Address, Env, String};

struct Fixture<'a> {
    env: Env,
    client: VotingClient<'a>,
    admin: Address,
    alice: Address,
    bob: Address,
    carol: Address,
}

fn setup<'a>() -> Fixture<'a> {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register(Voting, (admin.clone(),));
    let client = VotingClient::new(&env, &contract_id);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let carol = Address::generate(&env);

    Fixture {
        env,
        client,
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
    assert_eq!(p1.yes_count, 0);
    assert_eq!(p1.no_count, 0);
    assert_eq!(p1.title, title(&f.env, "Adopt the bylaws v2"));

    let mine = f.client.proposals_by_creator(&f.alice);
    assert_eq!(mine.len(), 2);
}

#[test]
fn cast_vote_tallies_yes_and_no_and_marks_voter() {
    let f = setup();
    let id = f.client.create_proposal(
        &f.alice,
        &title(&f.env, "Topic"),
        &title(&f.env, ""),
        &86_400,
    );

    f.client.cast_vote(&id, &f.bob, &true);
    f.client.cast_vote(&id, &f.carol, &false);
    f.client.cast_vote(&id, &f.admin, &true);

    let p = f.client.get_proposal(&id);
    assert_eq!(p.yes_count, 2);
    assert_eq!(p.no_count, 1);

    assert!(f.client.has_voted(&id, &f.bob));
    assert!(f.client.has_voted(&id, &f.carol));
    assert_eq!(f.client.get_vote(&id, &f.bob), Some(true));
    assert_eq!(f.client.get_vote(&id, &f.carol), Some(false));
    // Address that never voted reports None.
    let stranger = Address::generate(&f.env);
    assert_eq!(f.client.get_vote(&id, &stranger), None);
    assert!(!f.client.has_voted(&id, &stranger));
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
    // Jump past the 120-second window.
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
    // Unknown id is treated as not-active rather than panicking.
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
fn admin_view_returns_constructor_arg() {
    let f = setup();
    assert_eq!(f.client.admin(), f.admin);
}
