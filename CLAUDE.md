# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

This directory is **not** itself a git repo — it is a workspace holding sibling Stellar / Soroban projects submitted to the **Stellar Journey to Mastery: Monthly Builder Challenges** belt track. Each sibling has its own `Cargo.toml` workspace, its own frontend, and its own deployed contracts — treat them as independent repos.

- `stellar-journey/` — completed L1+L2+L3+L4 **Stellar Tip Jar** (React 19 + Vite, Soroban tip-jar + SEP-41 supporter-token contracts, inter-contract `mint` on every tip, deployed to testnet). Has its own detailed `stellar-journey/CLAUDE.md` covering the architecture, deployed contract addresses, the `mock_all_auths_allowing_non_root_auth()` gotcha for testing inter-contract calls, and the frontend module breakdown. **Read that file first when working inside `stellar-journey/`.**
- `Split-Bill-Calculator/` — completed L1+L2+L3+L4 **Split Bill Calculator** (same stack as stellar-journey). Contracts: `bill-split` (records bills, emits `settled` events, performs an inter-contract `token::transfer` from payer → creator on settle) and `stable-token` (custom SEP-41 settlement currency). CI runs `cargo test --workspace` + `npm test && npm run build` on push. Project README documents deploy/mint commands.

When building a **new project idea** in this folder, scaffold it as a third sibling (`<idea-name>/`) with the same shape — don't intermix code with the existing two.

## Stellar Journey to Mastery — Belt Track requirements

The program is a structured **monthly** builder challenge with a public review period at month-end. Builds progress L1 → L4; each belt builds on the previous one. Submissions are GitHub repo URLs, judged against an explicit checklist — a missing screenshot or one fewer commit than required can cost you the prize even if the code is great.

**Submission discipline (applies to every belt):**

- **Submit by the monthly deadline.** Don't push the last commit at 23:59 — the live demo and CI badge need time to come up green.
- **"Meaningful" commits ≠ padding.** A reviewer scanning `git log` should see logical milestones (`feat: contract`, `feat: wallet wiring`, `test: ...`, `ci: ...`, `docs: ...`). Twenty `fix typo` commits do not satisfy "8+ meaningful commits" for L4. Reorganize history with soft-resets before the final push if you ended up with messy commits.
- **Every required screenshot must be in the README and visibly clickable** — not just in a `docs/` folder no one opens. Use relative paths: `![alt](docs/screenshots/01-wallet.png)`.
- **Commit `Cargo.lock`.** The CI snippet uses `cargo test --workspace --locked`, which fails on a missing lockfile. Run `cargo build` once before the first push so the lockfile exists.
- **Soroban testnet event retention is ~24 h.** A reviewer testing your demo a day after submission may see an empty event feed if no one's interacted recently. Either keep your live deploy warm with a recent test tx the day judging happens, or document the contract address + a Stellar Expert link to a historical `settled`/whatever-event tx in the README so the reviewer can see proof regardless.

Below is the full requirements set per belt, **plus the patterns the two existing projects use to satisfy them** — copy from those when building a new idea.

### L1 · ⚪ White Belt — first on-chain dApp

**Goal:** Ship a working dApp on Stellar testnet with the basics wired up.

**Required:**

1. **Wallet setup** — Freighter wallet, Stellar **testnet**.
2. **Wallet connection** — connect + disconnect working.
3. **Balance handling** — fetch the connected wallet's XLM balance and display it.
4. **Transaction flow** — send an XLM transaction on testnet, show success/failure state and the transaction hash.
5. **Public GitHub repo + README**.

**Required README screenshots (all four — checklist scored individually):**
1. Wallet **connected** state.
2. Balance **displayed** in the UI.
3. Successful **testnet transaction** in flight or just-completed.
4. The **transaction result** shown to the user (success banner with the tx hash).

**How prior projects do it:**
- Wallet kit lives in `frontend/src/wallet.ts` — `StellarWalletsKit.init(...)` once at module load with `defaultModules()` and `FREIGHTER_ID`. **Kit v2.x is all-static** — don't `new` it.
- Balance via `frontend/src/contract.ts` → `fetchXlmBalance(publicKey)` against Horizon (`https://horizon-testnet.stellar.org`); 404 means "not funded yet, send to friendbot".
- Tx hashes are clickable links to `https://stellar.expert/explorer/testnet/tx/<hash>` in the success banner.

**Project ideas suggested by the program:** Simple Payment dApp, Wallet Balance Checker, Transaction History Viewer, Testnet Faucet Interface, Tip Jar Page, Split Bill Calculator.

### L2 · 🟡 Yellow Belt — multi-wallet + first contract — $10 prize

**Goal:** Multi-wallet integration, deploy your own Soroban contract, real-time event handling.

**Required:**

1. **3+ error types handled.** The program literally names these three: **wallet not found**, **rejected** (user dismissed the signature prompt), **insufficient balance**. Cover those three by name in your code/README, even if you ship more categories on top.
2. **Contract deployed on testnet.**
3. **Contract called from the frontend.**
4. **Transaction status visible** — pending / success / fail (use phase labels: `preparing`, `signing`, `submitting`, `confirming`).
5. **Minimum 2+ meaningful commits.**

**Required in README:**
- **Screenshot: wallet options** — the StellarWalletsKit picker modal showing the multiple wallet choices.
- **Deployed contract address** — `C…`, ideally as a clickable Stellar Expert link.
- **Transaction hash of a contract call** — verifiable on Stellar Expert.
- (Optional) live demo link.

**How prior projects do it:**
- Multi-wallet via `@creit.tech/stellar-wallets-kit` — opening `StellarWalletsKit.authModal()` shows the picker (Freighter, Albedo, xBull, Lobstr, …). The kit's `Networks` enum collides with `stellar-sdk`'s `Networks` — alias one as `KitNetworks` on import.
- Contract calls go through `frontend/src/contract.ts`'s pipeline: `getAccount` → `TransactionBuilder.addOperation(contract.call(...))` → `simulateTransaction` → `rpc.assembleTransaction(baseTx, sim).build()` → `signXdr` → `sendTransaction` → poll `getTransaction` until `SUCCESS` (≤30 s timeout). Status callback emits `'preparing' | 'signing' | 'submitting' | 'confirming'` so the UI can render the phase.
- Errors are funneled through a `ContractError` class with a `category` field (`validation` / `rejected` / `rpc` / `simulation` / `submission`) so one banner component handles them all. `decodeSimError(raw)` maps known contract-panic strings to user-friendly messages.
- Real-time events via `sorobanServer.getEvents({ startLedger, filters: [{ type: 'contract', contractIds: [CONTRACT_ID] }] })` polled every 5 s. Decode topics + values with `scValToNative`. Use the **last ~5,000 ledgers** (~7 hours) — well within Soroban testnet's retention.

**Project ideas suggested by the program:** Token Swap, NFT Minter, Crowdfunding Page, Real-time Auction, Token Leaderboard, Activity Feed, Live Poll, Payment Tracker.

### L3 · 🟠 Orange Belt — complete mini-dApp — $30 prize

**Goal:** End-to-end mini-dApp with documentation, tests, and a demo video.

**Required:**

1. **Mini-dApp fully functional.**
2. **Minimum 3 tests passing.**
3. **README complete.**
4. **Demo video recorded** (1 minute).
5. **Minimum 3+ meaningful commits.**

**Required in README:**
- **Live demo link** — deployed on Vercel / Netlify / similar.
- **Screenshot: test output** showing ≥3 tests passing (`npm test` terminal output is fine — capture the green summary line).
- **Demo video link** — 1 minute, walking through the full flow end-to-end.

**Demo video — practical guidance:**
- **Tools:** Loom (free, hosts the video and gives you a shareable link in one step) is the lowest-friction option. Alternatives: OBS Studio (local recording → upload to YouTube/unlisted), Windows Game Bar (`Win+G`, records the foreground app), QuickTime on macOS.
- **What to film (in 60 s):**
  1. Show the deployed URL in the address bar, show the `C…` contract address in the README.
  2. Connect wallet → balance appears.
  3. Trigger the main flow (mint / tip / settle / split / etc.) — show the wallet sign prompt → success banner with tx hash → click through to Stellar Expert.
  4. Show the on-chain effect (event feed updating, history list updating, balance changing).
- **Where to host:** Loom direct link, or unlisted YouTube. Don't upload the raw `.mp4` to the GitHub repo — adds bloat and reviewers can't easily preview it.

**How prior projects do it:**
- **Loading states:** CSS `.skeleton` shimmer (linear-gradient + animation) for initial reads; per-phase pill colors for `'preparing' | 'signing' | 'submitting' | 'confirming'`.
- **Caching:** module-level `Map<string, { value, expiresAt }>` in `frontend/src/contract.ts` with TTLs around 4–15 s and an `invalidateReads(prefix)` flush that the write helpers call after `SUCCESS`. Keep cache keys prefixed (`bills:`, `events:`, `stable:`) so invalidation is precise.
- **Tests:**
  - Frontend pure helpers live in `frontend/src/lib.ts` (no kit/SDK imports) and are exercised by `frontend/src/lib.test.ts` under Vitest in **`environment: 'node'`** — required because the wallet kit has CJS/ESM interop quirks under Vitest.
  - Contract tests live in `contracts/<name>/src/test.rs` gated by `#![cfg(test)]`; build the env, register the contract, drive its generated client.
  - Aim for ≥3 tests per layer; both projects ship 12+ contract tests + 16 frontend tests.
- **Live demo:** deploy `frontend/dist` to Vercel with **Root Directory = `frontend`**, `npm run build` as build command, `dist` as output, and the `VITE_*` env vars set in the Vercel project settings.

### L4 · 🟢 Green Belt — production-ready — $60 prize

**Goal:** Advanced contract patterns, production readiness.

**Required:**

1. **Inter-contract call working** (if applicable to your design).
2. **Custom token created** — **or liquidity pool deployed**. You pick one or both; not both required.
3. **CI/CD running** on every push/PR.
4. **Mobile responsive design.**
5. **Minimum 8+ meaningful commits.**

**Required in README:**
- **Live demo link** (carries over from L3).
- **Screenshot: mobile responsive view** — take it from a real mobile resolution (iPhone 12 Pro = 390×844 in Chrome devtools). Don't just shrink the browser window.
- **Screenshot or badge: CI/CD pipeline running** — the GitHub Actions badge in the README counts as long as it's actually green. A screenshot of the green run page is the safest choice.
- **Contract addresses + transaction hash** for the inter-contract call you implemented (link both to Stellar Expert).
- **Token or pool address** if you deployed a custom token or pool.

**"Advanced event streaming" — what counts:** L2 already requires real-time event handling, so L4 "advanced" needs to do more than the L2 baseline. Acceptable upgrades over the basic 5 s polling pattern: paginated history beyond the recent window with a "Load more" button; event-driven optimistic UI updates (apply the local mutation before the on-chain confirmation, reconcile on event arrival); per-user filtering against `topic[1]` / `topic[2]` so each visitor sees only events that mention them; or a clear "live updating" indicator with last-update timestamp. Both prior projects shipped a 5 s poll with `getEvents` + `scValToNative` — that's the floor; layer one of the above on top for L4.

**How prior projects do it:**
- **Inter-contract call pattern:**

  ```rust
  use soroban_sdk::token;
  let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
  token::Client::new(&env, &token_addr).transfer(&from, &to, &amount);
  ```

  Or for a non-`TokenInterface` callee:

  ```rust
  let _: () = env.invoke_contract(&callee, &Symbol::new(&env, "method"), args);
  ```

- **CRITICAL: testing inter-contract calls.** A sub-invocation has its own auth check. `env.mock_all_auths()` only mocks the root call — the inner call fails with *"authorization not tied to the root contract invocation"*. Use **`env.mock_all_auths_allowing_non_root_auth()`** in `setup()` whenever your function does a sub-invocation. This burned both prior projects when first wired up.
- **Custom token:** SEP-41 minimal — implement `soroban_sdk::token::TokenInterface` (`balance`, `transfer`, `transfer_from`, `approve`, `allowance`, `burn`, `burn_from`, `decimals`, `name`, `symbol`) plus `__constructor(admin, decimals, name, symbol)`, admin-gated `mint` / `set_admin`, and `total_supply`. Both prior projects' token contracts (`stellar-journey/contracts/supporter-token/`, `Split-Bill-Calculator/contracts/stable-token/`) are reference implementations — copy from either.
- **Liquidity pool (alternative to a custom token):** **no prior project in this folder has built one** — you'd be the first reference, so allow extra design time. Minimal-viable shape: a single contract holding two SEP-41 token balances (e.g. tokenA + tokenB), with `deposit(provider, amount_a, amount_b) -> shares`, `withdraw(provider, shares) -> (amount_a, amount_b)`, `swap(from_token, amount_in) -> amount_out`, and `reserves() -> (i128, i128)`. Use the constant-product formula `x * y = k` for swap pricing, mint LP shares proportional to the deposit's contribution to reserves, and apply a fixed fee (typically 30 bps) on swaps. The `deposit` / `withdraw` / `swap` paths all call `token::Client::transfer` on the underlying token addresses — those sub-invocations satisfy the L4 inter-contract call requirement without needing a separate `mint` call. References worth reading: the Soroban examples repo's [liquidity_pool](https://github.com/stellar/soroban-examples/tree/main/liquidity_pool) and [single_offer](https://github.com/stellar/soroban-examples/tree/main/single_offer).
- **CI:** `.github/workflows/ci.yml` with two jobs:
  - `contracts`: `actions/checkout@v4`, `dtolnay/rust-toolchain@stable`, cache `~/.cargo` + `target`, run `cargo test --workspace --locked`. **Don't** run `stellar contract build` in CI — the wasm32v1-none target needs `stellar` CLI and adds minutes for no value; unit tests run on the host target.
  - `frontend`: `actions/setup-node@v4` with `cache: npm`, `cache-dependency-path: frontend/package-lock.json`, then `npm ci`, `npm test`, `npm run build`.
- **Mobile responsive:** target 360px–600px viewports. Stack the header (`flex-direction: column`) on `max-width: 600px`, reduce panel padding, collapse 2-column rows to 1. Always include `<meta name="viewport" content="width=device-width, initial-scale=1.0" />` in `index.html`.

## Submission checklist (paste this into the project README and tick as you go)

Before you submit the GitHub URL on the program portal, verify every row below. Reviewers grade against this list — missing any single line costs the points.

**L1**
- [ ] Public GitHub repo with `README.md`.
- [ ] Wallet **connect** works (Freighter visible in the picker).
- [ ] Wallet **disconnect** works (state actually clears, not just the kit's session).
- [ ] XLM balance fetched from Horizon and **rendered in the UI**.
- [ ] One successful XLM transaction sent on **testnet** (not mainnet — verify the network passphrase).
- [ ] Tx hash + success/failure state shown to the user.
- [ ] README screenshots (4): connected wallet, balance displayed, successful tx, tx result.
- [ ] README has setup instructions (`npm install`, `npm run dev`, env vars).

**L2** (everything in L1 plus:)
- [ ] StellarWalletsKit picker working with multiple wallet options visible.
- [ ] Three named error types covered: **wallet not found**, **rejected**, **insufficient balance** (in code + visible in README).
- [ ] One Soroban contract built and **deployed** to testnet — paste the `C…` address in the README.
- [ ] Frontend calls a contract function — paste a sample tx hash in the README.
- [ ] Tx status pipeline visible (`preparing` / `signing` / `submitting` / `confirming`).
- [ ] **2+ meaningful commits** in `git log`.
- [ ] Screenshot: wallet options modal.

**L3** (everything in L2 plus:)
- [ ] Mini-dApp covers the full intended user flow end-to-end.
- [ ] **3+ tests passing** (frontend Vitest + contract `cargo test` both count).
- [ ] Loading skeletons or progress indicators on initial reads.
- [ ] In-memory TTL cache on read paths, invalidated after writes.
- [ ] **Live demo deployed** (Vercel/Netlify) — URL in README.
- [ ] **3+ meaningful commits.**
- [ ] Screenshot: test output showing ≥3 passing.
- [ ] **1-minute demo video** — link in README (Loom or unlisted YouTube; not a raw `.mp4` in the repo).

**L4** (everything in L3 plus:)
- [ ] **Inter-contract call** in production — at least one contract calls another via `token::Client::*` or `env.invoke_contract`. Reviewers verify by reading the contract source.
- [ ] **Custom token deployed** OR **custom liquidity pool deployed** (one or both).
- [ ] Address(es) of the token / pool / inter-contract pair pasted in the README, linked to Stellar Expert.
- [ ] Sample tx hash that exercises the inter-contract call, linked to Stellar Expert.
- [ ] **CI/CD pipeline** running on push/PR — `.github/workflows/ci.yml` with both `cargo test --workspace --locked` and `npm test && npm run build`.
- [ ] CI badge in README, **green** (not yellow / not red / not "no status").
- [ ] **Mobile responsive** — verified at 360px–600px viewports, screenshot taken from a real mobile resolution (Chrome devtools device toolbar).
- [ ] **8+ meaningful commits.** A `git log --oneline` reviewer scan should see logical milestones (`feat:`, `fix:`, `test:`, `ci:`, `docs:`), not 8 typo fixes.
- [ ] One "advanced" event streaming feature beyond the L2 baseline (pagination / optimistic UI / per-user filter / live indicator — see L4 section above).

## Cross-cutting Soroban / frontend recipes

These patterns hold for any new project in this folder.

### Numbers

- XLM = 7 decimals; on-chain amounts are i128 stroops; `STROOPS_PER_XLM = 10_000_000n`.
- Always use `bigint`, never `Number`, for stroop arithmetic — losing 1 stroop is real money in some markets.
- The SDK's `nativeToScVal(amount, { type: 'i128' })` accepts `bigint` directly.

### Read sims

Read-only contract calls don't change state; build a tx with **any structurally valid Stellar address** as source (the deployer's address is a fine default), call `simulateTransaction`, and `scValToNative(sim.result.retval)` the return value. RPC won't charge or commit anything.

### Reads vs. writes from the frontend

| | Reads | Writes |
| --- | --- | --- |
| Source account | placeholder (e.g. deployer) | the connected wallet |
| Sign? | no | yes — via `signXdr` |
| Submit? | no — sim only | yes — `sendTransaction` + poll |
| Cost | free | testnet XLM (BASE_FEE) |

### TypeScript config gotchas

`frontend/tsconfig.app.json` has `verbatimModuleSyntax: true` and `erasableSyntaxOnly: true`, so:
- All type-only imports must use `import type { ... }`.
- No constructor parameter properties; assign in the body instead (`class C { x: T; constructor(x: T) { this.x = x; } }`).

### Stellar Wallets Kit

```ts
import { StellarWalletsKit, Networks as KitNetworks } from '@creit.tech/stellar-wallets-kit';
import { defaultModules } from '@creit.tech/stellar-wallets-kit/modules/utils';
import { FREIGHTER_ID } from '@creit.tech/stellar-wallets-kit/modules/freighter';

StellarWalletsKit.init({
  modules: defaultModules(),
  selectedWalletId: FREIGHTER_ID,
  network: KitNetworks.TESTNET,
});
```

`defaultModules` is exported from `…/modules/utils`, **not** the package root. The kit is all-static — don't instantiate. Its `Networks` enum collides with `@stellar/stellar-sdk`'s `Networks` — alias on import.

## Project-idea catalog (20 belt-scaling ideas)

The user's working list of 20 ideas, each designed to scale across all four belts so a single repo compounds work month-over-month. Build status, difficulty (after the reframings below), and the L4 inter-contract pattern are noted on each.

**Already shipped — do not rebuild:**

- **#1 Tip Jar for Creators** — `stellar-journey/`. L4 = inter-contract `mint` of a SEP-41 supporter token on every tip.
- **#2 Split-Bill Calculator** — `Split-Bill-Calculator/`. L4 = inter-contract `token::transfer(payer → creator)` on settle.

**Remaining 18 ideas, ordered easiest → hardest after reframing:**

| Order | # | Idea | L1 | L2 | L3 | L4 inter-contract pattern |
|---|---|---|---|---|---|---|
| 1 | 11 | **Pay-Per-View Paywall** | XLM payment unlocks content | Paywall contract gates per-content, emits `Unlocked` | content gallery + access list + tests | balance read on a creator-owned token gives discount |
| 2 | 5 | **DAO-Lite Voting** | wallet connect + "vote fee" XLM payment | Vote contract with proposals + `VoteCast` event | dashboard of open/closed polls + results + tests | weighted votes via balance read on a governance token |
| 3 | 19 | **Loyalty Punch-Card** | pay merchant in XLM | Loyalty contract issues stamps + `Earned` event | multi-merchant UI + redeem flow + tests | stamps redeem to a points token via inter-contract `mint` |
| 4 | 17 | **Bounty Board** | send XLM bounty to a worker | Bounty contract with post/claim/approve + events | board UI + my-bounties + tests | reputation token mint on completion |
| 5 | 4 | **Crowdfunding Page** | pledge button sending XLM | Campaign contract with goal/deadline + pledge/refund events | multi-campaign browser + progress bars + tests | backer-reward token auto-distributed |
| 6 | 3 | **Round-Robin Lottery** *(reframed from Raffle)* | send XLM to raffle wallet | Raffle contract with `buy_ticket` + `Drawn` event | ticket dashboard + past draws + tests | every Nth ticket auto-mints a Winner NFT *(drops VRF — Soroban has no honest randomness)* |
| 7 | 8 | **Subscription Service** | one-time XLM payment unlocks content | Subscription contract with periods + `Renewed` event | dashboard (active/expired) + cancel flow + tests | NFT subscription pass mint |
| 8 | 10 | **Token Launchpad** | send XLM to a sale wallet | Sale contract with cap + `Contributed` event | launch directory + contribute UI + tests | custom token deployed + claimed via inter-contract call |
| 9 | 20 | **Habit Tracker with Stake** | stake XLM to a wallet | Habit contract with daily check-in + `Checked` event | streak dashboard + history + tests | streak NFT mint + forfeited-stake redistribution |
| 10 | 18 | **Charity Tracker** | donate XLM directly | Charity contract with milestone unlocks + events | multi-charity dashboard + audit trail + tests | impact-receipt token mint per donation |
| 11 | 7 | **P2P Escrow** | send XLM to holding address | Escrow contract with release/refund + events | dispute UI + status timeline + tests | multi-token escrow via inter-contract transfer |
| 12 | 12 | **On-Chain Microblog** | wallet connect + balance | Posts contract with `Posted` event | live feed + profile pages + tests | tipping token + verified-badge NFT |
| 13 | 16 | **Booking / Rental dApp** | pay deposit in XLM | Booking contract with check-in events | calendar UI + cancellation flow + tests | holder-discount via balance read on a member token |
| 14 | 15 | **Auction House** | wallet/balance | Auction contract with bid/settle + `BidPlaced` event | listings + bid history + tests | NFT auctions via inter-contract NFT transfer on settle |
| 15 | 9 | **Yes/No Binary Pool** *(reframed from Prediction Market)* | send XLM to "yes" or "no" wallet | Market contract pooling bets + `BetPlaced` event | multi-market UI + admin-resolve flow + tests | bet mints a YesToken/NoToken; `claim()` redeems after admin resolution *(drops continuous odds + oracle resolution)* |
| 16 | 6 | **Single-Contract NFT Sale** *(reframed from NFT Marketplace)* | wallet/balance UI | one NFT contract with mint + built-in `list/buy` + `Minted`/`Sold` events | listing/buy/browse pages + tests | `buy()` does inter-contract `token::transfer` against a stablecoin; royalty as a `creator_pct` field paid in the same call *(drops separate marketplace + royalty splitter contracts)* |
| 17 | 13 | **Rotating Savings Circle (ROSCA)** *(reframed from Lending Pool)* | deposit XLM to pool wallet | ROSCA contract with N members × period deposits + rotation events | full deposit/payout UI + rotation order + tests | rotation enforced via inter-contract `transfer`; "your turn" NFT minted then burned on payout *(drops interest, health factor, oracle, liquidations)* |
| 18 | 14 | **Fixed-Rate Token Swap** *(reframed from AMM)* | balance display | Swap contract with admin-set fixed rate + `Swapped` event | swap UI + admin top-up flow + tests | **two** inter-contract calls per swap: `transfer_from` on the input token + `transfer` on the output token *(drops the `x*y=k` pool + LP shares)* |

**Reframing notes (the ones in italics above):**

- The reframings drop the genuinely-hard part (no-VRF randomness, oracle resolution, AMM math, DeFi liquidations) while preserving the *spirit* of the idea and the L4 inter-contract requirement. Each reframed contract is < 200 lines of Rust.
- If the user picks a reframed idea later and asks "can we add the hard part back?", flag the cost — VRF needs commit-reveal across two txs, oracles need a separate price-feed contract, AMMs need careful rounding to avoid drain attacks. Don't slip those in casually.

**Realistic time per project (after the Split-Bill template is in hand):**

- Orders 1–5 (easiest): ~4–6 hours focused work each.
- Orders 6–11: ~6–10 hours.
- Orders 12–15: ~8–12 hours.
- Orders 16–18 (reframed-hard): ~10–15 hours — they introduce one *new* pattern (NFT, rotation logic, two-token swap) you haven't built yet.

Plus a ~2–3 hour operational tail per project (deploy + mint test tokens + Vercel + README + screenshots + 1-min demo video + ≥8 commits + push). The tail doesn't shrink with practice.

**When the user picks one to build:**

1. Confirm the idea by `#` and the L1/L2/L3/L4 progression listed above — don't drift the scope.
2. Plan storage layout, event names, and frontend modules **before writing code**, in chat. Retrofitting the L4 inter-contract design (which contract calls which) is painful.
3. Follow the "Adding a new project idea to this workspace" playbook below.

## Adding a new project idea to this workspace

When the user wants to build a new idea in this folder:

1. **Create `<idea-name>/`** as a sibling of the existing two. Don't reuse their `Cargo.toml` workspaces or `node_modules`.
2. **Scaffold contracts** with `stellar contract init` or by copying the workspace `Cargo.toml` (`members = ["contracts/*"]`, `soroban-sdk = "25"`) plus the release profile from either prior project.
3. **Scaffold the frontend** by copying these files from a prior project, then trimming what isn't needed:
   - `package.json`, `tsconfig*.json`, `vite.config.ts`, `index.html`, `.gitignore`, `.env.example`
   - `src/config.ts`, `src/lib.ts` (with the pure helpers), `src/wallet.ts`, `src/contract.ts` (orchestration shell), `src/main.tsx`, `src/index.css`
   - `src/lib.test.ts` as the test scaffold
4. **Map the idea to the four belts before coding** — the L4 inter-contract design constraint (which contract calls which) determines storage layout, so retrofitting is painful. Decide upfront: which contract owns funds, which owns logic, what auth chain do sub-invocations need.
5. **Reuse `mock_all_auths_allowing_non_root_auth()`** in any test that exercises a sub-invocation — see the L4 note above.

## Per-sibling project commands

### Contracts (run from a project root or a contract subdir)

- Build all to wasm: `stellar contract build` → `target/wasm32v1-none/release/*.wasm`. Plain `cargo build` won't produce valid Soroban wasm.
- Run all tests: `cargo test` (or `cargo test --workspace` from the project root if you have multiple contracts).
- Run a single test: `cargo test -p <crate-name> <test_name>`.
- Format: `cargo fmt --all`.

### Frontend (run from `<project>/frontend/`)

- Install: `npm install`
- Dev: `npm run dev` (port 5173)
- Build: `npm run build` (`tsc -b` first, so type errors fail the build)
- Tests: `npm test` (Vitest, Node env) or `npm run test:watch`
- Preview: `npm run preview`

### Deploy a contract to testnet

```bash
stellar keys generate me --network testnet --fund     # one-time
stellar contract deploy \
  --wasm target/wasm32v1-none/release/<crate>.wasm \
  --source me \
  --network testnet \
  -- \
  --constructor-arg-1 ... --constructor-arg-2 ...     # if your contract has __constructor
```

The printed `C…` address goes into the frontend's `VITE_*` env var.
