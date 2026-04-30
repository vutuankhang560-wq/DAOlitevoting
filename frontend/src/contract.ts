import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Horizon,
  Memo,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from '@stellar/stellar-sdk';
import type { xdr } from '@stellar/stellar-sdk';

import {
  CONTRACT_ID,
  GOV_TOKEN_DECIMALS,
  GOV_TOKEN_ID,
  HORIZON_URL,
  NETWORK_PASSPHRASE,
  RPC_URL,
} from './config';
import { ContractError, decodeSimError } from './lib';
import { signXdr } from './wallet';

export {
  ContractError,
  type ContractErrorCategory,
  decodeSimError,
  deriveOutcome,
  formatTokenAmount,
  hoursToSeconds,
  isLikelyStellarAddress,
  type ProposalOutcome,
  relativeTime,
  stroopsToXlm,
  xlmToStroops,
  yesPercent,
} from './lib';

export const sorobanServer = new rpc.Server(RPC_URL);
export const horizonServer = new Horizon.Server(HORIZON_URL);

const votingContract = () => new Contract(CONTRACT_ID);
const govTokenContract = () => new Contract(GOV_TOKEN_ID);

// Read-only sims don't commit, so any structurally valid Stellar address works.
const READ_ONLY_SOURCE =
  'GCVNQZPI76QNMDKFC5DVDXHUXFVM3ABHARWJ4DOFFACQ4F2E6KYYH63A';

export type TxStatus = 'preparing' | 'signing' | 'submitting' | 'confirming';

// ──────────────────────────────────────────────────────────────────────────
// Proposal record types (mirror the contract structs)
// ──────────────────────────────────────────────────────────────────────────

export type Proposal = {
  id: number;
  creator: string;
  title: string;
  description: string;
  createdAt: bigint;
  endTime: bigint;
  /** Total weighted yes votes — sum of `gov_token.balance(voter)` snapshots. */
  yesWeight: bigint;
  /** Total weighted no votes — sum of `gov_token.balance(voter)` snapshots. */
  noWeight: bigint;
  /** Number of distinct voters across both sides. */
  voterCount: number;
};

export type VotedEvent = {
  id: string;
  ledger: number;
  ledgerClosedAt: string;
  proposalId: number;
  voter: string;
  support: boolean;
  /** Weight that was tallied — pulled from event payload `topic[2]`. */
  weight: bigint;
  txHash?: string;
};

// ──────────────────────────────────────────────────────────────────────────
// Read cache (TTL'd in-memory map). Invalidated after writes.
// ──────────────────────────────────────────────────────────────────────────

type CacheEntry = { value: unknown; expiresAt: number };
const readCache = new Map<string, CacheEntry>();

async function cached<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const entry = readCache.get(key);
  if (entry && entry.expiresAt > Date.now()) {
    return entry.value as T;
  }
  const value = await fn();
  readCache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

export function invalidateReads(prefix?: string): void {
  if (!prefix) {
    readCache.clear();
    return;
  }
  for (const key of readCache.keys()) {
    if (key.startsWith(prefix)) readCache.delete(key);
  }
}

const PROPOSAL_TTL_MS = 8_000;
const COUNT_TTL_MS = 4_000;
const EVENTS_TTL_MS = 4_000;

// ──────────────────────────────────────────────────────────────────────────
// Simulation helpers
// ──────────────────────────────────────────────────────────────────────────

async function simulate(
  contract: Contract,
  fnName: string,
  args: xdr.ScVal[],
  source = READ_ONLY_SOURCE,
): Promise<rpc.Api.SimulateTransactionResponse> {
  const dummy = new Account(source, '0');
  const tx = new TransactionBuilder(dummy, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(fnName, ...args))
    .setTimeout(0)
    .build();
  return sorobanServer.simulateTransaction(tx);
}

async function readView<T>(
  contract: Contract,
  fnName: string,
  args: xdr.ScVal[] = [],
): Promise<T> {
  const sim = await simulate(contract, fnName, args);
  if (rpc.Api.isSimulationError(sim)) {
    throw new ContractError(`Read failed: ${sim.error}`, 'simulation');
  }
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) {
    throw new ContractError('Read returned no result.', 'simulation');
  }
  return scValToNative(sim.result.retval) as T;
}

function ensureContractConfigured(): void {
  if (!CONTRACT_ID) {
    throw new ContractError(
      'No voting contract configured. Set VITE_CONTRACT_ID in frontend/.env after deploying.',
      'validation',
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────
// L1 — Native XLM "vote fee" payment (no contract involvement)
// ──────────────────────────────────────────────────────────────────────────

/** Send a single native-XLM payment to a treasury address as a "membership /
 *  vote fee" — purely L1; the voting contract doesn't gate on this. Returns
 *  the tx hash on success. Surfaces the three named L2 error categories
 *  (wallet not found, rejected, insufficient balance). */
export async function payVoteFee(opts: {
  sender: string;
  treasury: string;
  amountStroops: bigint;
  memo?: string;
  onStatus?: (status: TxStatus) => void;
}): Promise<string> {
  const { sender, treasury, amountStroops, memo, onStatus } = opts;

  onStatus?.('preparing');

  let source: Horizon.AccountResponse;
  try {
    source = await horizonServer.loadAccount(sender);
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response
      ?.status;
    if (status === 404) {
      throw new ContractError(
        'Sender account does not exist on testnet — fund it from friendbot first.',
        'rpc',
      );
    }
    throw new ContractError(
      `Could not load sender account: ${(err as Error).message}`,
      'rpc',
    );
  }

  // Pre-flight balance check so we can surface the named "insufficient
  // balance" category cleanly instead of letting Horizon reject with a
  // raw tx_insufficient_balance code.
  const native = source.balances.find((b) => b.asset_type === 'native');
  const havStroops = native ? xlmStringToStroops(native.balance) : 0n;
  // Reserve roughly 1 XLM for base reserve + fee headroom; testnet will
  // happily accept lower in practice but the warning is clearer this way.
  if (havStroops < amountStroops + 1_000_000n) {
    throw new ContractError(
      'Insufficient balance — your wallet needs at least the fee plus ~0.1 XLM headroom.',
      'insufficient-balance',
    );
  }

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: treasury,
        asset: Asset.native(),
        amount: stroopsAsXlmString(amountStroops),
      }),
    );

  if (memo && memo.trim()) {
    tx.addMemo(Memo.text(memo.slice(0, 28)));
  }

  const built = tx.setTimeout(60).build();

  onStatus?.('signing');
  let signedXdr: string;
  try {
    signedXdr = await signXdr(built.toXDR(), sender);
  } catch (err) {
    throw mapWalletError(err);
  }

  onStatus?.('submitting');
  const signed = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  try {
    const res = await horizonServer.submitTransaction(signed);
    onStatus?.('confirming');
    return res.hash;
  } catch (err: unknown) {
    const data = (err as { response?: { data?: unknown } })?.response?.data;
    const codes = (data as { extras?: { result_codes?: { transaction?: string } } })
      ?.extras?.result_codes;
    const txCode = codes?.transaction;
    if (txCode === 'tx_insufficient_balance') {
      throw new ContractError(
        'Insufficient balance — Horizon rejected the payment.',
        'insufficient-balance',
      );
    }
    const detail = codes ? JSON.stringify(codes) : (err as Error).message;
    throw new ContractError(`Submission rejected: ${detail}`, 'submission');
  }
}

function stroopsAsXlmString(stroops: bigint): string {
  const negative = stroops < 0n;
  const m = negative ? -stroops : stroops;
  const whole = m / 10_000_000n;
  const frac = (m % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '');
  const out = frac ? `${whole}.${frac}` : whole.toString();
  return negative ? `-${out}` : out;
}

function xlmStringToStroops(s: string): bigint {
  const [whole = '0', frac = ''] = s.split('.');
  const padded = (frac + '0000000').slice(0, 7);
  return BigInt(whole) * 10_000_000n + BigInt(padded || '0');
}

/** Translate a wallet-kit / Freighter signing failure into a typed
 *  ContractError. The kit throws different shapes depending on which wallet
 *  is selected, so we sniff the message rather than rely on instanceof. */
function mapWalletError(err: unknown): ContractError {
  const raw = ((err as Error)?.message || String(err)).toLowerCase();
  if (
    raw.includes('not installed') ||
    raw.includes('no wallet') ||
    raw.includes('not found') ||
    raw.includes('not detected')
  ) {
    return new ContractError(
      'No supported wallet detected. Install Freighter (or another supported wallet) and try again.',
      'wallet-not-found',
    );
  }
  if (
    raw.includes('reject') ||
    raw.includes('declin') ||
    raw.includes('user denied') ||
    raw.includes('cancel')
  ) {
    return new ContractError(
      'Signing was rejected in the wallet.',
      'rejected',
    );
  }
  return new ContractError(
    (err as Error)?.message || 'Signing failed.',
    'rejected',
  );
}

// ──────────────────────────────────────────────────────────────────────────
// L2 — Contract calls (create_proposal, cast_vote, view fns)
// ──────────────────────────────────────────────────────────────────────────

async function invokeContract(opts: {
  sender: string;
  fnName: string;
  args: xdr.ScVal[];
  onStatus?: (status: TxStatus) => void;
}): Promise<{ hash: string; returnValue: unknown }> {
  ensureContractConfigured();
  const { sender, fnName, args, onStatus } = opts;

  onStatus?.('preparing');

  let sourceAccount: Account;
  try {
    sourceAccount = await sorobanServer.getAccount(sender);
  } catch (err) {
    const msg = (err as Error).message || '';
    if (msg.toLowerCase().includes('not found')) {
      throw new ContractError(
        'Account does not exist on testnet — fund it from friendbot first.',
        'rpc',
      );
    }
    throw new ContractError(`Could not load account: ${msg}`, 'rpc');
  }

  const baseTx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(votingContract().call(fnName, ...args))
    .setTimeout(60)
    .build();

  const sim = await sorobanServer.simulateTransaction(baseTx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new ContractError(decodeSimError(sim.error), 'simulation');
  }

  const prepared = rpc.assembleTransaction(baseTx, sim).build();

  onStatus?.('signing');
  let signedXdr: string;
  try {
    signedXdr = await signXdr(prepared.toXDR(), sender);
  } catch (err) {
    throw mapWalletError(err);
  }

  onStatus?.('submitting');
  const signedTx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  const sendRes = await sorobanServer.sendTransaction(signedTx);
  if (sendRes.status === 'ERROR') {
    const name = sendRes.errorResult?.result().switch().name ?? 'unknown';
    if (name.toLowerCase().includes('insufficient')) {
      throw new ContractError(
        'Insufficient balance — your wallet does not have enough XLM to cover the fee.',
        'insufficient-balance',
      );
    }
    throw new ContractError(`Submission rejected: ${name}`, 'submission');
  }

  onStatus?.('confirming');
  let getRes = await sorobanServer.getTransaction(sendRes.hash);
  const start = Date.now();
  while (getRes.status === 'NOT_FOUND') {
    if (Date.now() - start > 30_000) {
      throw new ContractError('Timed out waiting for confirmation.', 'rpc');
    }
    await new Promise((r) => setTimeout(r, 1500));
    getRes = await sorobanServer.getTransaction(sendRes.hash);
  }

  if (getRes.status !== 'SUCCESS') {
    throw new ContractError(
      `Transaction failed on-chain: ${getRes.status}`,
      'submission',
    );
  }

  const returnValue =
    getRes.returnValue !== undefined
      ? scValToNative(getRes.returnValue)
      : undefined;

  return { hash: sendRes.hash, returnValue };
}

export async function createProposal(opts: {
  sender: string;
  title: string;
  description: string;
  votingWindowSecs: number;
  onStatus?: (status: TxStatus) => void;
}): Promise<{ hash: string; proposalId: number }> {
  const { sender, title, description, votingWindowSecs, onStatus } = opts;
  const args: xdr.ScVal[] = [
    Address.fromString(sender).toScVal(),
    nativeToScVal(title, { type: 'string' }),
    nativeToScVal(description, { type: 'string' }),
    nativeToScVal(votingWindowSecs, { type: 'u64' }),
  ];
  const { hash, returnValue } = await invokeContract({
    sender,
    fnName: 'create_proposal',
    args,
    onStatus,
  });
  invalidateReads('proposal:');
  invalidateReads('count');
  invalidateReads('events:');
  return { hash, proposalId: Number(returnValue) };
}

export async function castVote(opts: {
  sender: string;
  proposalId: number;
  support: boolean;
  onStatus?: (status: TxStatus) => void;
}): Promise<string> {
  const { sender, proposalId, support, onStatus } = opts;
  const args: xdr.ScVal[] = [
    nativeToScVal(proposalId, { type: 'u32' }),
    Address.fromString(sender).toScVal(),
    nativeToScVal(support, { type: 'bool' }),
  ];
  const { hash } = await invokeContract({
    sender,
    fnName: 'cast_vote',
    args,
    onStatus,
  });
  invalidateReads(`proposal:${proposalId}`);
  invalidateReads(`hasVoted:${proposalId}:`);
  invalidateReads('events:');
  return hash;
}

export async function getProposal(id: number): Promise<Proposal> {
  ensureContractConfigured();
  return cached(`proposal:${id}`, PROPOSAL_TTL_MS, async () => {
    const raw = await readView<{
      id: number | bigint;
      creator: string;
      title: string;
      description: string;
      created_at: number | bigint;
      end_time: number | bigint;
      yes_weight: number | bigint;
      no_weight: number | bigint;
      voter_count: number | bigint;
    }>(votingContract(), 'get_proposal', [
      nativeToScVal(id, { type: 'u32' }),
    ]);
    return {
      id: Number(raw.id),
      creator: String(raw.creator),
      title: String(raw.title ?? ''),
      description: String(raw.description ?? ''),
      createdAt:
        typeof raw.created_at === 'bigint'
          ? raw.created_at
          : BigInt(raw.created_at),
      endTime:
        typeof raw.end_time === 'bigint'
          ? raw.end_time
          : BigInt(raw.end_time),
      yesWeight:
        typeof raw.yes_weight === 'bigint'
          ? raw.yes_weight
          : BigInt(raw.yes_weight),
      noWeight:
        typeof raw.no_weight === 'bigint'
          ? raw.no_weight
          : BigInt(raw.no_weight),
      voterCount: Number(raw.voter_count),
    };
  });
}

export async function getProposalCount(): Promise<number> {
  ensureContractConfigured();
  return cached('count', COUNT_TTL_MS, async () => {
    const v = await readView<number | bigint>(
      votingContract(),
      'proposal_count',
    );
    return Number(v);
  });
}

export async function hasVoted(id: number, voter: string): Promise<boolean> {
  ensureContractConfigured();
  return cached(`hasVoted:${id}:${voter}`, PROPOSAL_TTL_MS, async () => {
    return readView<boolean>(votingContract(), 'has_voted', [
      nativeToScVal(id, { type: 'u32' }),
      Address.fromString(voter).toScVal(),
    ]);
  });
}

export async function getProposalsByCreator(
  creator: string,
): Promise<number[]> {
  ensureContractConfigured();
  return cached(
    `proposal:by-creator:${creator}`,
    PROPOSAL_TTL_MS,
    async () => {
      const v = await readView<(number | bigint)[]>(
        votingContract(),
        'proposals_by_creator',
        [Address.fromString(creator).toScVal()],
      );
      return v.map((n) => Number(n));
    },
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Voted-event feed
// ──────────────────────────────────────────────────────────────────────────

export async function fetchVotedEvents(
  opts: { ledgersBack?: number; limit?: number } = {},
): Promise<VotedEvent[]> {
  ensureContractConfigured();
  const { ledgersBack = 5_000, limit = 100 } = opts;
  return cached(`events:${ledgersBack}:${limit}`, EVENTS_TTL_MS, () =>
    fetchVotedFresh(ledgersBack, limit),
  );
}

async function fetchVotedFresh(
  ledgersBack: number,
  limit: number,
): Promise<VotedEvent[]> {
  const latest = await sorobanServer.getLatestLedger();
  const startLedger = Math.max(latest.sequence - ledgersBack, 1);

  const result = await sorobanServer.getEvents({
    startLedger,
    filters: [{ type: 'contract', contractIds: [CONTRACT_ID] }],
    limit,
  });

  const out: VotedEvent[] = [];
  for (const ev of result.events) {
    try {
      const topics = ev.topic.map((t) => scValToNative(t));
      const topicName = String(topics[0] ?? '');
      if (topicName !== 'voted') continue;
      const voter = String(topics[1] ?? '');
      // L4: event payload is now `(id, support, weight)`. Older events from
      // the L3-only contract emitted `(id, support)`; treat the missing
      // weight as 0 rather than dropping the event.
      const value = scValToNative(ev.value) as
        | [number | bigint, boolean]
        | [number | bigint, boolean, number | bigint]
        | undefined;
      if (!value) continue;
      const [proposalId, support, weight] = value as [
        number | bigint,
        boolean,
        number | bigint | undefined,
      ];
      out.push({
        id: ev.id,
        ledger: ev.ledger,
        ledgerClosedAt: ev.ledgerClosedAt,
        proposalId: Number(proposalId),
        voter,
        support: Boolean(support),
        weight:
          weight === undefined
            ? 0n
            : typeof weight === 'bigint'
              ? weight
              : BigInt(weight),
        txHash: ev.txHash,
      });
    } catch (err) {
      console.warn('[voting] failed to decode event', ev, err);
    }
  }
  return out.reverse();
}

// ──────────────────────────────────────────────────────────────────────────
// L4 — Gov-token reads (the inter-contract callee, exposed for the UI)
// ──────────────────────────────────────────────────────────────────────────

const GOV_TTL_MS = 6_000;

/** Read the connected wallet's governance-token balance (raw base units —
 *  caller formats with `formatTokenAmount` + GOV_TOKEN_DECIMALS). Returns 0
 *  when the gov-token isn't configured rather than throwing. */
export async function getGovBalance(address: string): Promise<bigint> {
  if (!GOV_TOKEN_ID) return 0n;
  return cached(`gov:bal:${address}`, GOV_TTL_MS, async () => {
    const v = await readView<bigint | number>(govTokenContract(), 'balance', [
      Address.fromString(address).toScVal(),
    ]);
    return typeof v === 'bigint' ? v : BigInt(v);
  });
}

export async function getGovSymbol(): Promise<string> {
  if (!GOV_TOKEN_ID) return '';
  return cached('gov:symbol', 60_000, async () => {
    return readView<string>(govTokenContract(), 'symbol');
  });
}

export async function getGovDecimals(): Promise<number> {
  if (!GOV_TOKEN_ID) return GOV_TOKEN_DECIMALS;
  return cached('gov:decimals', 60_000, async () => {
    const v = await readView<number | bigint>(govTokenContract(), 'decimals');
    return Number(v);
  });
}

export async function getGovTotalSupply(): Promise<bigint> {
  if (!GOV_TOKEN_ID) return 0n;
  return cached('gov:supply', GOV_TTL_MS, async () => {
    const v = await readView<bigint | number>(
      govTokenContract(),
      'total_supply',
    );
    return typeof v === 'bigint' ? v : BigInt(v);
  });
}

/** Admin-only: mint `amount` (in base units) of the gov-token to `to`. The
 *  caller MUST be the gov-token's admin or the simulation rejects with the
 *  SEP-41 "AuthError". Surfaces typed errors so the UI can render a clean
 *  banner. */
export async function mintGovTokens(opts: {
  sender: string;
  to: string;
  amount: bigint;
  onStatus?: (status: TxStatus) => void;
}): Promise<string> {
  if (!GOV_TOKEN_ID) {
    throw new ContractError(
      'No gov-token configured. Set VITE_GOV_TOKEN_ID in frontend/.env.',
      'validation',
    );
  }
  const { sender, to, amount, onStatus } = opts;
  if (amount <= 0n) {
    throw new ContractError('Mint amount must be greater than 0.', 'validation');
  }
  const args: xdr.ScVal[] = [
    Address.fromString(to).toScVal(),
    nativeToScVal(amount, { type: 'i128' }),
  ];
  const { hash } = await invokeArbitrary({
    sender,
    contract: govTokenContract(),
    fnName: 'mint',
    args,
    onStatus,
  });
  invalidateReads('gov:');
  return hash;
}

/** Same Soroban write pipeline as `invokeContract`, but parameterised on the
 *  target contract so it can drive the gov-token's `mint` op too. */
async function invokeArbitrary(opts: {
  sender: string;
  contract: Contract;
  fnName: string;
  args: xdr.ScVal[];
  onStatus?: (status: TxStatus) => void;
}): Promise<{ hash: string; returnValue: unknown }> {
  const { sender, contract, fnName, args, onStatus } = opts;

  onStatus?.('preparing');

  let sourceAccount: Account;
  try {
    sourceAccount = await sorobanServer.getAccount(sender);
  } catch (err) {
    const msg = (err as Error).message || '';
    if (msg.toLowerCase().includes('not found')) {
      throw new ContractError(
        'Account does not exist on testnet — fund it from friendbot first.',
        'rpc',
      );
    }
    throw new ContractError(`Could not load account: ${msg}`, 'rpc');
  }

  const baseTx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(fnName, ...args))
    .setTimeout(60)
    .build();

  const sim = await sorobanServer.simulateTransaction(baseTx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new ContractError(decodeSimError(sim.error), 'simulation');
  }

  const prepared = rpc.assembleTransaction(baseTx, sim).build();

  onStatus?.('signing');
  let signedXdr: string;
  try {
    signedXdr = await signXdr(prepared.toXDR(), sender);
  } catch (err) {
    throw mapWalletError(err);
  }

  onStatus?.('submitting');
  const signedTx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  const sendRes = await sorobanServer.sendTransaction(signedTx);
  if (sendRes.status === 'ERROR') {
    const name = sendRes.errorResult?.result().switch().name ?? 'unknown';
    if (name.toLowerCase().includes('insufficient')) {
      throw new ContractError(
        'Insufficient balance — your wallet does not have enough XLM to cover the fee.',
        'insufficient-balance',
      );
    }
    throw new ContractError(`Submission rejected: ${name}`, 'submission');
  }

  onStatus?.('confirming');
  let getRes = await sorobanServer.getTransaction(sendRes.hash);
  const start = Date.now();
  while (getRes.status === 'NOT_FOUND') {
    if (Date.now() - start > 30_000) {
      throw new ContractError('Timed out waiting for confirmation.', 'rpc');
    }
    await new Promise((r) => setTimeout(r, 1500));
    getRes = await sorobanServer.getTransaction(sendRes.hash);
  }

  if (getRes.status !== 'SUCCESS') {
    throw new ContractError(
      `Transaction failed on-chain: ${getRes.status}`,
      'submission',
    );
  }

  const returnValue =
    getRes.returnValue !== undefined
      ? scValToNative(getRes.returnValue)
      : undefined;

  return { hash: sendRes.hash, returnValue };
}

// ──────────────────────────────────────────────────────────────────────────
// Wallet balance (Horizon → native XLM)
// ──────────────────────────────────────────────────────────────────────────

export async function fetchXlmBalance(publicKey: string): Promise<{
  balance: string;
  funded: boolean;
}> {
  try {
    const account = await horizonServer.loadAccount(publicKey);
    const native = account.balances.find((b) => b.asset_type === 'native');
    return { balance: native?.balance ?? '0', funded: true };
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response
      ?.status;
    if (status === 404) return { balance: '0', funded: false };
    throw err;
  }
}
