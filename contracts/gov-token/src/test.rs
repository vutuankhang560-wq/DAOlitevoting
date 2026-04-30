#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, token, Address, Env, String};

fn deploy<'a>(env: &Env) -> (Address, Address, token::Client<'a>) {
    let admin = Address::generate(env);
    let id = env.register(
        GovToken,
        (
            admin.clone(),
            7u32,
            String::from_str(env, "DAO Vote"),
            String::from_str(env, "DAO"),
        ),
    );
    let token_client = token::Client::new(env, &id);
    (admin, id, token_client)
}

#[test]
fn metadata_and_admin_set_correctly() {
    let env = Env::default();
    let (admin, id, token_client) = deploy(&env);
    let gov = GovTokenClient::new(&env, &id);
    assert_eq!(gov.admin(), admin);
    assert_eq!(token_client.decimals(), 7);
    assert_eq!(token_client.name(), String::from_str(&env, "DAO Vote"));
    assert_eq!(token_client.symbol(), String::from_str(&env, "DAO"));
    assert_eq!(gov.total_supply(), 0);
}

#[test]
fn mint_increases_balance_and_supply() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, id, token_client) = deploy(&env);
    let gov = GovTokenClient::new(&env, &id);
    let alice = Address::generate(&env);

    gov.mint(&alice, &1_000_000_000);

    assert_eq!(token_client.balance(&alice), 1_000_000_000);
    assert_eq!(gov.total_supply(), 1_000_000_000);
}

#[test]
fn transfer_moves_balance_between_accounts() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, id, token_client) = deploy(&env);
    let gov = GovTokenClient::new(&env, &id);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    gov.mint(&alice, &500_000_000);
    token_client.transfer(&alice, &bob, &200_000_000);

    assert_eq!(token_client.balance(&alice), 300_000_000);
    assert_eq!(token_client.balance(&bob), 200_000_000);
    assert_eq!(gov.total_supply(), 500_000_000);
}

#[test]
fn burn_reduces_balance_and_supply() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, id, token_client) = deploy(&env);
    let gov = GovTokenClient::new(&env, &id);
    let alice = Address::generate(&env);

    gov.mint(&alice, &500_000_000);
    token_client.burn(&alice, &200_000_000);

    assert_eq!(token_client.balance(&alice), 300_000_000);
    assert_eq!(gov.total_supply(), 300_000_000);
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")] // InsufficientBalance
fn transfer_fails_when_balance_too_low() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, _id, token_client) = deploy(&env);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    token_client.transfer(&alice, &bob, &1);
}

#[test]
fn set_admin_transfers_authority() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, id, _) = deploy(&env);
    let gov = GovTokenClient::new(&env, &id);
    let new_admin = Address::generate(&env);

    gov.set_admin(&new_admin);
    assert_eq!(gov.admin(), new_admin);
}
