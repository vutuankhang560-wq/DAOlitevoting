import { Networks } from '@stellar/stellar-sdk';

/** Deployed Voting contract address (testnet). Empty string disables
 *  contract-mode features in the UI; the L1 vote-fee XLM payment still works. */
export const CONTRACT_ID =
  (import.meta.env.VITE_CONTRACT_ID as string | undefined) ?? '';

/** DAO treasury address — receives the L1 "vote fee" XLM payment. The vote
 *  fee is purely an L1 demonstration: it's a native XLM payment, not gated by
 *  the contract. The contract's `cast_vote` is what actually counts a vote. */
export const TREASURY_ADDRESS =
  (import.meta.env.VITE_TREASURY_ADDRESS as string | undefined) ?? '';

/** Default vote fee in XLM. Cosmetic — user can override in the form. */
export const DEFAULT_VOTE_FEE_XLM = '0.5';

export const NETWORK_PASSPHRASE = Networks.TESTNET;
export const RPC_URL = 'https://soroban-testnet.stellar.org';
export const HORIZON_URL = 'https://horizon-testnet.stellar.org';

// XLM = 7 decimals; on-chain amounts are stroops (i128).
export const STROOPS_PER_XLM = 10_000_000n;
