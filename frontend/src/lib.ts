// Pure, dependency-free helpers. Tests can import these without dragging in
// the wallet kit / Stellar SDK (both have CJS interop quirks under Vitest).

import { STROOPS_PER_XLM } from './config';

export type ContractErrorCategory =
  | 'validation'
  | 'rejected'
  | 'submission'
  | 'rpc'
  | 'simulation'
  | 'wallet-not-found'
  | 'insufficient-balance';

export class ContractError extends Error {
  category: ContractErrorCategory;

  constructor(message: string, category: ContractErrorCategory) {
    super(message);
    this.name = 'ContractError';
    this.category = category;
  }
}

/** Convert a user-entered XLM string ("12.5") to stroops as a bigint. */
export function xlmToStroops(xlm: string): bigint {
  const trimmed = xlm.trim();
  if (!/^-?\d+(\.\d{1,7})?$/.test(trimmed)) {
    throw new ContractError(
      'Amount must be a number with up to 7 decimals.',
      'validation',
    );
  }
  const negative = trimmed.startsWith('-');
  const body = negative ? trimmed.slice(1) : trimmed;
  const [whole, frac = ''] = body.split('.');
  const padded = (frac + '0000000').slice(0, 7);
  const magnitude = BigInt(whole) * STROOPS_PER_XLM + BigInt(padded || '0');
  const stroops = negative ? -magnitude : magnitude;
  if (stroops <= 0n) {
    throw new ContractError('Amount must be greater than 0.', 'validation');
  }
  return stroops;
}

export function stroopsToXlm(stroops: bigint | number | string): string {
  const value = typeof stroops === 'bigint' ? stroops : BigInt(stroops);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / STROOPS_PER_XLM;
  const frac = (magnitude % STROOPS_PER_XLM)
    .toString()
    .padStart(7, '0')
    .replace(/0+$/, '');
  const formatted = frac ? `${whole}.${frac}` : whole.toString();
  return negative ? `-${formatted}` : formatted;
}

/** Lightweight Stellar G... address sanity check — strkey checksum still
 *  validated by the SDK at tx-build time, but this catches typos in the form
 *  before we hit the RPC. */
export function isLikelyStellarAddress(s: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(s.trim());
}

/** Window in human-friendly hours → seconds for the contract call. */
export function hoursToSeconds(hours: string): number {
  const trimmed = hours.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new ContractError(
      'Voting window must be a positive number of hours.',
      'validation',
    );
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ContractError(
      'Voting window must be greater than 0 hours.',
      'validation',
    );
  }
  if (n > 24 * 30) {
    throw new ContractError(
      'Voting window cannot exceed 30 days.',
      'validation',
    );
  }
  // Round to whole seconds; minimum 60 (matches the contract's MIN_WINDOW_SECS).
  const secs = Math.max(60, Math.round(n * 3600));
  return secs;
}

/** Format a Unix timestamp (seconds) as a relative "in 3h 12m" / "ended 2h ago"
 *  string. `nowSecs` defaults to current wall clock; passable for tests. */
export function relativeTime(
  endSecs: number | bigint,
  nowSecs: number = Math.floor(Date.now() / 1000),
): string {
  const end = typeof endSecs === 'bigint' ? Number(endSecs) : endSecs;
  const delta = end - nowSecs;
  const abs = Math.abs(delta);
  const d = Math.floor(abs / 86_400);
  const h = Math.floor((abs % 86_400) / 3600);
  const m = Math.floor((abs % 3600) / 60);
  let parts: string;
  if (d > 0) parts = `${d}d ${h}h`;
  else if (h > 0) parts = `${h}h ${m}m`;
  else parts = `${m}m`;
  return delta >= 0 ? `closes in ${parts}` : `closed ${parts} ago`;
}

/** Derive the "result" of a proposal given its tallies and end_time.
 *  - 'passed': closed and yes > no
 *  - 'failed': closed and no >= yes (ties fail by default)
 *  - 'open': still in voting window
 *  - 'pending': closed with zero votes — neither passed nor failed clearly */
export type ProposalOutcome = 'open' | 'passed' | 'failed' | 'pending';

export function deriveOutcome(opts: {
  yes: number;
  no: number;
  endSecs: number | bigint;
  nowSecs?: number;
}): ProposalOutcome {
  const now = opts.nowSecs ?? Math.floor(Date.now() / 1000);
  const end = typeof opts.endSecs === 'bigint' ? Number(opts.endSecs) : opts.endSecs;
  if (now < end) return 'open';
  if (opts.yes === 0 && opts.no === 0) return 'pending';
  if (opts.yes > opts.no) return 'passed';
  return 'failed';
}

/** Translate a raw Soroban simulation error into something a user can act on.
 *  Falls back to a truncated raw string for unknown errors so the UI never
 *  silently swallows information. */
export function decodeSimError(raw: string): string {
  if (raw.includes('title required'))
    return 'Proposal title cannot be empty.';
  if (raw.includes('title too long'))
    return 'Proposal title must be 80 characters or fewer.';
  if (raw.includes('description too long'))
    return 'Proposal description must be 280 characters or fewer.';
  if (raw.includes('window too short'))
    return 'Voting window must be at least 60 seconds.';
  if (raw.includes('window too long'))
    return 'Voting window cannot exceed 30 days.';
  if (raw.includes('proposal not found'))
    return 'Proposal not found.';
  if (raw.includes('voting closed'))
    return 'This proposal is closed — voting window has ended.';
  if (raw.includes('already voted'))
    return 'You have already voted on this proposal.';
  if (raw.toLowerCase().includes('insufficient'))
    return 'Insufficient balance for this transaction.';
  if (raw.includes('Account_does_not_exist'))
    return 'Account does not exist on testnet (fund it from friendbot first).';
  return `Simulation failed: ${raw.slice(0, 240)}`;
}
