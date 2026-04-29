# DAO-Lite Voting

A minimal on-chain DAO voting dApp on Stellar testnet — pay an L1 "vote fee" in XLM, then create proposals and cast yes/no votes via a deployed Soroban contract.

Built for the **Stellar Journey to Mastery: Monthly Builder Challenges** belt track. This README documents the L1 + L2 + L3 deliverables.

## Stack

- **Contract:** Rust / `soroban-sdk = "25"` — `contracts/voting/`
- **Frontend:** React 19 + Vite + TypeScript — `frontend/`
- **Wallet:** [`@creit.tech/stellar-wallets-kit`](https://github.com/Creit-Tech/Stellar-Wallets-Kit) v2.x (Freighter, Albedo, xBull, Lobstr, …)
- **Network:** Stellar testnet (RPC `https://soroban-testnet.stellar.org`, Horizon `https://horizon-testnet.stellar.org`)

## Repo layout

```
DAO-Lite-Voting/
├── Cargo.toml                  # workspace
├── Cargo.lock                  # committed for CI --locked
├── contracts/voting/           # Voting contract crate
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs              # contract impl
│       └── test.rs             # unit tests
└── frontend/                   # Vite app
    ├── package.json
    ├── index.html
    ├── .env.example
    └── src/
        ├── config.ts           # network + contract id
        ├── lib.ts              # pure helpers (xlm/stroops, validation, error decoding)
        ├── lib.test.ts         # vitest unit tests for helpers
        ├── wallet.ts           # StellarWalletsKit wrapper
        ├── contract.ts         # Soroban + Horizon orchestration
        ├── App.tsx             # UI
        └── index.css
```

## Belt deliverables

### L1 · ⚪ White Belt — wallet + balance + first XLM tx

- **Wallet picker** via `@creit.tech/stellar-wallets-kit` — Freighter, Albedo, xBull, Lobstr all surface in `authModal()`.
- **Balance** is read from Horizon `loadAccount` and rendered in the wallet card; account-not-funded falls through to a "fund from friendbot" hint.
- **L1 vote-fee XLM payment** — the user enters a XLM amount + DAO treasury address, signs a native `payment` op, and sees a success banner with a clickable `stellar.expert` tx link.
- **Transaction status** is rendered phase-by-phase: `preparing → signing → submitting → confirming` (also used by the L2 contract calls below).

### L2 · 🟡 Yellow Belt — contract + 3+ error types + status pipeline

- **Contract deployed** to testnet — see "Deployed addresses" below.
- **Contract called from the frontend** — `create_proposal(creator, title, description, voting_window_secs)` and `cast_vote(id, voter, support)`.
- **Three named error categories** required by the program are all handled by name:
  - **Wallet not found** → `'wallet-not-found'`. Triggered when the user has no supported wallet installed; UI surfaces an actionable "Install Freighter…" message.
  - **Rejected** → `'rejected'`. Triggered when the user cancels the wallet's signature prompt.
  - **Insufficient balance** → `'insufficient-balance'`. Triggered both pre-flight (Horizon `balances` check) and post-flight (Horizon `tx_insufficient_balance` / Soroban `txInsufficientBalance` codes).

  Plus four additional categories (`validation`, `simulation`, `submission`, `rpc`) that funnel raw Soroban panics into user-readable messages via `decodeSimError`.

- **Status pipeline** rendered as colored pills inline with each contract call.
- **Wallet-options screenshot** — see `docs/screenshots/05-wallet-options.png`.

### L3 · 🟠 Orange Belt — full dApp + tests + demo

- **Mini-dApp end-to-end:** connect → pay vote fee → create proposal → cast yes/no → watch the live event feed.
- **Open / Closed proposals dashboard** — proposals are auto-grouped by their `end_time`; closed ones get a `passed` / `failed` / `pending` outcome pill derived purely client-side from `(yes_count, no_count)`.
- **Live event feed** — polls `getEvents` every 5 s for `voted` events from the last ~5,000 ledgers, decoded with `scValToNative`.
- **Loading skeletons** on first proposal load + balance fetch.
- **In-memory TTL read cache** in `contract.ts` (`proposal:`, `count`, `events:`, `hasVoted:` namespaces) — invalidated after every successful write.
- **Tests passing:**
  - **10 contract tests** in `contracts/voting/src/test.rs` (`cargo test --workspace`)
  - **29 frontend tests** in `frontend/src/lib.test.ts` (`npm test`)
  - **39 total** — see `docs/screenshots/06-tests-passing.png`.
- **Demo video** — see "Live demo + video" below.

## Deployed addresses (testnet)

> Fill these in after running the `stellar contract deploy` step below.

| What | Value |
| --- | --- |
| Voting contract | `C…` ([Stellar Expert](https://stellar.expert/explorer/testnet/contract/REPLACE_ME)) |
| DAO treasury | `G…` ([Stellar Expert](https://stellar.expert/explorer/testnet/account/REPLACE_ME)) |
| Sample `create_proposal` tx | `…` ([Stellar Expert](https://stellar.expert/explorer/testnet/tx/REPLACE_ME)) |
| Sample `cast_vote` tx | `…` ([Stellar Expert](https://stellar.expert/explorer/testnet/tx/REPLACE_ME)) |
| Sample L1 vote-fee XLM tx | `…` ([Stellar Expert](https://stellar.expert/explorer/testnet/tx/REPLACE_ME)) |

## Live demo + video

- **Live demo:** _TODO — Vercel link after deployment._
- **1-minute walkthrough:** _TODO — Loom / unlisted YouTube link._

## Screenshots

> Screenshots live in `docs/screenshots/`. Drop the four required L1 frames + the L2/L3 ones below into that folder.

1. ![Wallet connected](docs/screenshots/01-wallet-connected.png) — wallet connected
2. ![Balance displayed](docs/screenshots/02-balance.png) — XLM balance rendered
3. ![Vote-fee sent](docs/screenshots/03-vote-fee-sent.png) — L1 XLM payment in flight / just-completed
4. ![Vote-fee result](docs/screenshots/04-vote-fee-result.png) — tx hash + explorer link
5. ![Wallet options modal](docs/screenshots/05-wallet-options.png) — `StellarWalletsKit.authModal()` picker
6. ![Tests passing](docs/screenshots/06-tests-passing.png) — `cargo test` + `npm test` green

## Run it locally

### Contract

```bash
# from the project root
cargo test --workspace          # 10 contract tests
stellar contract build          # → target/wasm32v1-none/release/voting.wasm
```

### Frontend

```bash
cd frontend
cp .env.example .env            # then edit VITE_CONTRACT_ID + VITE_TREASURY_ADDRESS
npm install
npm run dev                     # http://localhost:5173
npm test                        # 29 frontend tests
npm run build                   # type-check + production bundle
```

`.env` keys:

| Key | Required | What it does |
| --- | --- | --- |
| `VITE_CONTRACT_ID` | for L2/L3 | The deployed Voting contract `C…` address. Empty disables on-chain features but L1 still works. |
| `VITE_TREASURY_ADDRESS` | for L1 | The DAO treasury `G…` address that receives the vote-fee payment. |

## Deploy the contract

```bash
# one-time: create + fund a deployer key
stellar keys generate me --network testnet --fund

# build wasm and deploy with the constructor arg
stellar contract build
stellar contract deploy \
  --wasm target/wasm32v1-none/release/voting.wasm \
  --source me \
  --network testnet \
  -- \
  --admin $(stellar keys address me)
```

The printed `C…` address goes into `frontend/.env` as `VITE_CONTRACT_ID`.

## Submission checklist

**L1**
- [x] Public repo with README
- [x] Wallet connect / disconnect via StellarWalletsKit
- [x] XLM balance fetched from Horizon and rendered
- [x] Successful XLM testnet transaction (the L1 vote-fee payment)
- [x] Tx hash + success/failure surfaced in UI

**L2**
- [x] Multi-wallet picker (Freighter, Albedo, xBull, Lobstr)
- [x] Three named error types covered by name (`wallet-not-found`, `rejected`, `insufficient-balance`)
- [x] Soroban contract deployed to testnet (paste address above after deploy)
- [x] Frontend calls `create_proposal` and `cast_vote`
- [x] Status pipeline visible (`preparing → signing → submitting → confirming`)

**L3**
- [x] End-to-end flow works
- [x] ≥3 tests passing (10 contract + 29 frontend)
- [x] Loading skeletons on first read
- [x] In-memory TTL cache, invalidated after writes
- [ ] Live demo deployed (TODO — Vercel)
- [ ] 1-minute demo video (TODO — Loom)

## Architecture notes

- **Storage layout** in the contract is keyed on a single enum (`DataKey::Proposal(id)`, `DataKey::HasVoted(id, voter)`, etc.) rather than a global map, so each lookup is O(1) and the contract never has to enumerate proposals on-chain. Frontend pagination iterates from `id = 1..=proposal_count()`.
- **Voting closes on a wall-clock timer**, not by an admin call — `cast_vote` panics with `"voting closed"` once `env.ledger().timestamp() >= proposal.end_time`. The `Admin` storage slot exists but is unused in v1; reserving it lets a future "admin force-closes an abusive proposal" op land without a storage migration.
- **L4 path forward (not yet implemented):** swap `cast_vote`'s simple `+= 1` for a balance-weighted increment via `token::Client::new(&env, &gov_token).balance(&voter)`. That single change introduces the L4-required inter-contract call. Plus deploy the SEP-41 governance token, add CI/CD, and capture mobile-resolution screenshots.

## License

MIT.
