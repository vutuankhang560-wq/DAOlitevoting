import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  CONTRACT_ID,
  DEFAULT_VOTE_FEE_XLM,
  GOV_TOKEN_DECIMALS,
  GOV_TOKEN_ID,
  GOV_TOKEN_SYMBOL,
  TREASURY_ADDRESS,
} from './config';
import {
  ContractError,
  castVote,
  createProposal,
  deriveOutcome,
  fetchVotedEvents,
  fetchXlmBalance,
  formatTokenAmount,
  getGovBalance,
  getGovTotalSupply,
  getProposal,
  getProposalCount,
  hasVoted,
  hoursToSeconds,
  isLikelyStellarAddress,
  mintGovTokens,
  payVoteFee,
  relativeTime,
  xlmToStroops,
  yesPercent,
  type Proposal,
  type ProposalOutcome,
  type TxStatus,
  type VotedEvent,
} from './contract';
import { disconnectWallet, pickWallet } from './wallet';

type Status =
  | { kind: 'idle' }
  | { kind: 'progress'; phase: TxStatus; label: string }
  | { kind: 'success'; hash: string; message: string }
  | { kind: 'error'; message: string };

const PHASE_LABELS: Record<TxStatus, string> = {
  preparing: 'Preparing transaction…',
  signing: 'Awaiting signature in wallet…',
  submitting: 'Submitting to the network…',
  confirming: 'Waiting for confirmation…',
};

function shortAddr(addr: string): string {
  if (!addr) return '';
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function explorerTxUrl(hash: string): string {
  return `https://stellar.expert/explorer/testnet/tx/${hash}`;
}

function explorerContractUrl(id: string): string {
  return `https://stellar.expert/explorer/testnet/contract/${id}`;
}

function explorerAccountUrl(addr: string): string {
  return `https://stellar.expert/explorer/testnet/account/${addr}`;
}

const OUTCOME_LABEL: Record<ProposalOutcome, string> = {
  open: 'Open',
  passed: 'Passed',
  failed: 'Failed',
  pending: 'Closed (no votes)',
};

export default function App() {
  // ── wallet ───────────────────────────────────────────────────────────
  const [address, setAddress] = useState<string | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [govBalance, setGovBalance] = useState<bigint | null>(null);
  const [govSupply, setGovSupply] = useState<bigint | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);

  // ── L1 vote-fee form ─────────────────────────────────────────────────
  const [feeAmount, setFeeAmount] = useState(DEFAULT_VOTE_FEE_XLM);
  const [treasury, setTreasury] = useState(TREASURY_ADDRESS);
  const [feeMemo, setFeeMemo] = useState('DAO vote fee');
  const [feeStatus, setFeeStatus] = useState<Status>({ kind: 'idle' });

  // ── L2 create-proposal form ──────────────────────────────────────────
  const [propTitle, setPropTitle] = useState('');
  const [propDescription, setPropDescription] = useState('');
  const [propWindowHours, setPropWindowHours] = useState('24');
  const [propStatus, setPropStatus] = useState<Status>({ kind: 'idle' });

  // ── L4 mint-gov form (for the gov-token admin) ──────────────────────
  const [mintRecipient, setMintRecipient] = useState('');
  const [mintAmount, setMintAmount] = useState('100');
  const [mintStatus, setMintStatus] = useState<Status>({ kind: 'idle' });

  // ── L2/L3 dashboard state ────────────────────────────────────────────
  const [proposalCount, setProposalCount] = useState<number | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [proposalsLoading, setProposalsLoading] = useState(false);
  const [votedMap, setVotedMap] = useState<Record<number, boolean>>({});
  const [voteStatus, setVoteStatus] = useState<Status>({ kind: 'idle' });
  const [events, setEvents] = useState<VotedEvent[]>([]);
  const [eventsUpdatedAt, setEventsUpdatedAt] = useState<number | null>(null);
  const [onlyMyVotes, setOnlyMyVotes] = useState(false);

  // Re-render every 15s so the "closes in 3h 12m" / "updated 23s ago" labels
  // stay live without the user having to refresh.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const i = window.setInterval(() => setNowTick((n) => n + 1), 15_000);
    return () => window.clearInterval(i);
  }, []);

  // ── connect / disconnect ─────────────────────────────────────────────
  const onConnect = useCallback(async () => {
    setWalletError(null);
    try {
      const a = await pickWallet();
      setAddress(a);
    } catch (err) {
      const msg = (err as Error)?.message?.toLowerCase() ?? '';
      if (
        msg.includes('not installed') ||
        msg.includes('no wallet') ||
        msg.includes('not detected') ||
        msg.includes('not found')
      ) {
        setWalletError(
          'No supported wallet detected. Install Freighter (or another supported wallet) and try again.',
        );
      } else if (msg.includes('cancel') || msg.includes('reject')) {
        setWalletError('Wallet selection was cancelled.');
      } else {
        setWalletError((err as Error).message || 'Connect failed.');
      }
    }
  }, []);

  const onDisconnect = useCallback(async () => {
    await disconnectWallet();
    setAddress(null);
    setBalance(null);
    setGovBalance(null);
    setBalanceError(null);
    setWalletError(null);
  }, []);

  // ── balance fetching ────────────────────────────────────────────────
  const refreshBalance = useCallback(async (a: string) => {
    setBalanceLoading(true);
    setBalanceError(null);
    try {
      const [{ balance: b, funded }, gov, supply] = await Promise.all([
        fetchXlmBalance(a),
        GOV_TOKEN_ID ? getGovBalance(a).catch(() => 0n) : Promise.resolve(0n),
        GOV_TOKEN_ID ? getGovTotalSupply().catch(() => 0n) : Promise.resolve(0n),
      ]);
      if (!funded) {
        setBalance('0');
        setBalanceError(
          'Account not funded on testnet. Use friendbot to fund it.',
        );
      } else {
        setBalance(b);
      }
      setGovBalance(gov);
      setGovSupply(supply);
    } catch (err) {
      setBalanceError((err as Error).message);
    } finally {
      setBalanceLoading(false);
    }
  }, []);

  useEffect(() => {
    if (address) refreshBalance(address);
  }, [address, refreshBalance]);

  // ── L1 vote-fee handler ─────────────────────────────────────────────
  const feeValidation = useMemo(() => {
    if (!feeAmount.trim()) return null;
    try {
      xlmToStroops(feeAmount);
    } catch (err) {
      return (err as Error).message;
    }
    if (!treasury.trim()) return 'Treasury address is required.';
    if (!isLikelyStellarAddress(treasury))
      return `Treasury "${shortAddr(treasury)}" doesn't look like a Stellar G… key.`;
    return null;
  }, [feeAmount, treasury]);

  const handlePayFee = useCallback(async () => {
    if (!address) return;
    if (feeValidation) return;
    setFeeStatus({
      kind: 'progress',
      phase: 'preparing',
      label: PHASE_LABELS.preparing,
    });
    try {
      const amountStroops = xlmToStroops(feeAmount);
      const hash = await payVoteFee({
        sender: address,
        treasury,
        amountStroops,
        memo: feeMemo,
        onStatus: (phase) =>
          setFeeStatus({
            kind: 'progress',
            phase,
            label: PHASE_LABELS[phase],
          }),
      });
      setFeeStatus({
        kind: 'success',
        hash,
        message: `Vote fee of ${feeAmount} XLM sent to ${shortAddr(treasury)}.`,
      });
      refreshBalance(address);
    } catch (err) {
      const msg =
        err instanceof ContractError
          ? err.message
          : (err as Error).message || 'Unknown error';
      setFeeStatus({ kind: 'error', message: msg });
    }
  }, [address, feeAmount, treasury, feeMemo, feeValidation, refreshBalance]);

  // ── L2 create proposal ──────────────────────────────────────────────
  const propValidation = useMemo(() => {
    if (!propTitle.trim()) return null;
    if (propTitle.length > 80) return 'Title must be 80 characters or fewer.';
    if (propDescription.length > 280)
      return 'Description must be 280 characters or fewer.';
    try {
      hoursToSeconds(propWindowHours);
    } catch (err) {
      return (err as Error).message;
    }
    return null;
  }, [propTitle, propDescription, propWindowHours]);

  const handleCreate = useCallback(async () => {
    if (!address) return;
    if (!propTitle.trim() || propValidation) return;
    setPropStatus({
      kind: 'progress',
      phase: 'preparing',
      label: PHASE_LABELS.preparing,
    });
    try {
      const secs = hoursToSeconds(propWindowHours);
      const { hash, proposalId } = await createProposal({
        sender: address,
        title: propTitle.trim(),
        description: propDescription.trim(),
        votingWindowSecs: secs,
        onStatus: (phase) =>
          setPropStatus({
            kind: 'progress',
            phase,
            label: PHASE_LABELS[phase],
          }),
      });
      setPropStatus({
        kind: 'success',
        hash,
        message: `Proposal #${proposalId} created.`,
      });
      setPropTitle('');
      setPropDescription('');
      loadProposals();
    } catch (err) {
      const msg =
        err instanceof ContractError
          ? err.message
          : (err as Error).message || 'Unknown error';
      setPropStatus({ kind: 'error', message: msg });
    }
  }, [address, propTitle, propDescription, propWindowHours, propValidation]);

  // ── L4 mint gov-tokens (admin-only on-chain) ────────────────────────
  const mintValidation = useMemo(() => {
    if (!mintRecipient.trim() && !mintAmount.trim()) return null;
    if (!mintRecipient.trim()) return 'Recipient address is required.';
    if (!isLikelyStellarAddress(mintRecipient))
      return `Recipient "${shortAddr(mintRecipient)}" doesn't look like a Stellar G… key.`;
    if (!/^\d+(\.\d+)?$/.test(mintAmount.trim()))
      return 'Mint amount must be a positive number.';
    if (Number(mintAmount) <= 0) return 'Mint amount must be greater than 0.';
    return null;
  }, [mintRecipient, mintAmount]);

  const handleMint = useCallback(async () => {
    if (!address || !GOV_TOKEN_ID) return;
    if (mintValidation) return;
    setMintStatus({
      kind: 'progress',
      phase: 'preparing',
      label: PHASE_LABELS.preparing,
    });
    try {
      // Convert "100" → base units using the configured decimals so admins
      // can think in whole-token amounts in the form.
      const [whole = '0', frac = ''] = mintAmount.split('.');
      const padded = (frac + '0'.repeat(GOV_TOKEN_DECIMALS)).slice(
        0,
        GOV_TOKEN_DECIMALS,
      );
      const amountBase =
        BigInt(whole) * 10n ** BigInt(GOV_TOKEN_DECIMALS) +
        BigInt(padded || '0');
      const hash = await mintGovTokens({
        sender: address,
        to: mintRecipient.trim(),
        amount: amountBase,
        onStatus: (phase) =>
          setMintStatus({
            kind: 'progress',
            phase,
            label: PHASE_LABELS[phase],
          }),
      });
      setMintStatus({
        kind: 'success',
        hash,
        message: `Minted ${mintAmount} ${GOV_TOKEN_SYMBOL} to ${shortAddr(mintRecipient.trim())}.`,
      });
      refreshBalance(address);
      loadProposals();
    } catch (err) {
      const msg =
        err instanceof ContractError
          ? err.message
          : (err as Error).message || 'Unknown error';
      setMintStatus({ kind: 'error', message: msg });
    }
  }, [address, mintRecipient, mintAmount, mintValidation, refreshBalance]);

  // ── load all proposals (small dApp; scan from id=1) ─────────────────
  const loadProposals = useCallback(async () => {
    if (!CONTRACT_ID) return;
    setProposalsLoading(true);
    try {
      const count = await getProposalCount();
      setProposalCount(count);

      const out: Proposal[] = [];
      for (let id = 1; id <= count; id++) {
        try {
          const p = await getProposal(id);
          out.push(p);
        } catch (err) {
          console.warn(`getProposal(${id}) failed`, err);
        }
      }
      out.reverse();
      setProposals(out);

      if (address) {
        const voted: Record<number, boolean> = {};
        await Promise.all(
          out.map(async (p) => {
            try {
              voted[p.id] = await hasVoted(p.id, address);
            } catch {
              /* ignore */
            }
          }),
        );
        setVotedMap(voted);
      }
    } catch (err) {
      console.error('loadProposals failed', err);
    } finally {
      setProposalsLoading(false);
    }
  }, [address]);

  useEffect(() => {
    if (CONTRACT_ID) loadProposals();
  }, [loadProposals]);

  // ── event feed (poll every 5s, track last-update timestamp) ─────────
  const eventTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!CONTRACT_ID) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const evs = await fetchVotedEvents({ ledgersBack: 5_000, limit: 50 });
        if (!cancelled) {
          setEvents(evs);
          setEventsUpdatedAt(Date.now());
        }
      } catch (err) {
        console.warn('event fetch failed', err);
      }
    };
    tick();
    eventTimer.current = window.setInterval(tick, 5_000);
    return () => {
      cancelled = true;
      if (eventTimer.current !== null) window.clearInterval(eventTimer.current);
    };
  }, []);

  // ── vote handler ────────────────────────────────────────────────────
  const handleVote = useCallback(
    async (proposalId: number, support: boolean) => {
      if (!address) return;
      setVoteStatus({
        kind: 'progress',
        phase: 'preparing',
        label: PHASE_LABELS.preparing,
      });
      try {
        const hash = await castVote({
          sender: address,
          proposalId,
          support,
          onStatus: (phase) =>
            setVoteStatus({
              kind: 'progress',
              phase,
              label: PHASE_LABELS[phase],
            }),
        });
        setVoteStatus({
          kind: 'success',
          hash,
          message: `Voted ${support ? 'yes' : 'no'} on proposal #${proposalId}${
            govBalance && govBalance > 0n
              ? ` with ${formatTokenAmount(govBalance, GOV_TOKEN_DECIMALS)} ${GOV_TOKEN_SYMBOL} weight`
              : ''
          }.`,
        });
        loadProposals();
      } catch (err) {
        const msg =
          err instanceof ContractError
            ? err.message
            : (err as Error).message || 'Unknown error';
        setVoteStatus({ kind: 'error', message: msg });
      }
    },
    [address, govBalance, loadProposals],
  );

  // ── derived dashboard groups ────────────────────────────────────────
  const { open, closed } = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    const o: Proposal[] = [];
    const c: Proposal[] = [];
    for (const p of proposals) {
      if (Number(p.endTime) > now) o.push(p);
      else c.push(p);
    }
    return { open: o, closed: c };
  }, [proposals]);

  // ── filtered event feed (advanced streaming: per-user filter) ───────
  const filteredEvents = useMemo(() => {
    if (!onlyMyVotes || !address) return events;
    return events.filter((e) => e.voter === address);
  }, [events, address, onlyMyVotes]);

  const lastUpdatedLabel = useMemo(() => {
    if (eventsUpdatedAt === null) return null;
    const ago = Math.max(0, Math.floor((Date.now() - eventsUpdatedAt) / 1000));
    return ago < 5 ? 'just now' : `${ago}s ago`;
  }, [eventsUpdatedAt]);

  // ── render ──────────────────────────────────────────────────────────
  return (
    <div className="app">
      <div className="header">
        <div className="title">
          <h1>DAO-Lite Voting</h1>
          <p>
            On-chain proposals + token-weighted yes/no votes on Stellar
            testnet. Pay an L1 "vote fee" in XLM, then create proposals and
            cast votes — each vote is weighted by the voter's
            {' '}
            <strong>{GOV_TOKEN_SYMBOL}</strong>
            {' '}
            governance-token balance, fetched via an inter-contract call.
          </p>
        </div>

        <div className="wallet-card">
          {address ? (
            <>
              <div>
                <div className="addr">
                  <a
                    href={explorerAccountUrl(address)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {shortAddr(address)}
                  </a>
                </div>
                <div className="muted">
                  {balanceLoading ? (
                    <span
                      className="skeleton"
                      style={{ width: 60, display: 'inline-block' }}
                    />
                  ) : (
                    <>
                      <span className="balance">{balance ?? '—'} XLM</span>
                      {GOV_TOKEN_ID && govBalance !== null && (
                        <>
                          {' · '}
                          <span className="balance gov">
                            {formatTokenAmount(govBalance, GOV_TOKEN_DECIMALS)}{' '}
                            {GOV_TOKEN_SYMBOL}
                          </span>
                        </>
                      )}
                    </>
                  )}
                </div>
                {balanceError && (
                  <div className="muted" style={{ color: 'var(--warn)' }}>
                    {balanceError}
                  </div>
                )}
              </div>
              <button
                className="ghost"
                onClick={() => address && refreshBalance(address)}
                title="Refresh balance"
              >
                ↻
              </button>
              <button className="danger" onClick={onDisconnect}>
                Disconnect
              </button>
            </>
          ) : (
            <button onClick={onConnect}>Connect wallet</button>
          )}
        </div>
      </div>

      {walletError && (
        <div className="panel" style={{ borderColor: 'var(--error)' }}>
          <div className="status error">{walletError}</div>
        </div>
      )}

      {!CONTRACT_ID && (
        <div className="panel" style={{ borderColor: 'var(--warn)' }}>
          <div className="hint">
            <strong>Heads up:</strong> <code>VITE_CONTRACT_ID</code> isn't set,
            so on-chain proposals + voting are disabled. The L1 vote-fee XLM
            payment still works. Deploy the Voting contract and put its{' '}
            <code>C…</code> address in <code>frontend/.env</code> to unlock the
            rest.
          </div>
        </div>
      )}

      {CONTRACT_ID && !GOV_TOKEN_ID && (
        <div className="panel" style={{ borderColor: 'var(--warn)' }}>
          <div className="hint">
            <strong>Half-configured:</strong>{' '}
            <code>VITE_GOV_TOKEN_ID</code> is empty. Voting will fail at
            simulation because the Voting contract was deployed pointing at a
            gov-token but the frontend doesn't know its address. Set it in{' '}
            <code>frontend/.env</code> to enable balance display + minting.
          </div>
        </div>
      )}

      {/* ─── L1: vote-fee XLM payment ─── */}
      <div className="panel">
        <h2>1 · Pay vote fee (L1 — native XLM)</h2>
        <p className="sub">
          Send a small XLM payment to your DAO treasury. Demonstrates the L1
          flow: wallet connect → balance → testnet payment → tx hash.
        </p>

        <div className="row">
          <div>
            <label>Vote fee (XLM)</label>
            <input
              type="text"
              inputMode="decimal"
              value={feeAmount}
              onChange={(e) => setFeeAmount(e.target.value)}
              placeholder="0.5"
            />
          </div>
          <div>
            <label>Memo (optional, ≤28 chars)</label>
            <input
              type="text"
              value={feeMemo}
              onChange={(e) => setFeeMemo(e.target.value)}
              placeholder="DAO vote fee"
              maxLength={28}
            />
          </div>
        </div>

        <label>Treasury address</label>
        <input
          type="text"
          value={treasury}
          onChange={(e) => setTreasury(e.target.value)}
          placeholder="G…"
          style={{
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          }}
        />

        {feeValidation && <div className="status error">{feeValidation}</div>}

        <div className="actions">
          <button
            onClick={handlePayFee}
            disabled={
              !address ||
              !!feeValidation ||
              feeStatus.kind === 'progress' ||
              !feeAmount.trim() ||
              !treasury.trim()
            }
          >
            {feeStatus.kind === 'progress' ? 'Working…' : 'Pay vote fee'}
          </button>
        </div>

        {feeStatus.kind === 'progress' && (
          <div className={`status ${feeStatus.phase}`}>{feeStatus.label}</div>
        )}
        {feeStatus.kind === 'success' && (
          <div className="status success">
            ✓ {feeStatus.message}{' '}
            <a
              href={explorerTxUrl(feeStatus.hash)}
              target="_blank"
              rel="noreferrer"
            >
              tx <code>{feeStatus.hash.slice(0, 10)}…</code>
            </a>
          </div>
        )}
        {feeStatus.kind === 'error' && (
          <div className="status error">✕ {feeStatus.message}</div>
        )}
      </div>

      {/* ─── L4 admin-mint panel (only when gov-token configured) ─── */}
      {GOV_TOKEN_ID && (
        <div className="panel">
          <h2>
            Mint {GOV_TOKEN_SYMBOL} (L4 — gov-token admin)
          </h2>
          <p className="sub">
            Distributes voting power. Admin-only — your wallet must be the
            constructor-set admin of the gov-token at{' '}
            <a
              href={explorerContractUrl(GOV_TOKEN_ID)}
              target="_blank"
              rel="noreferrer"
            >
              {shortAddr(GOV_TOKEN_ID)}
            </a>
            {govSupply !== null && (
              <>
                . Current supply:{' '}
                <strong>
                  {formatTokenAmount(govSupply, GOV_TOKEN_DECIMALS)}{' '}
                  {GOV_TOKEN_SYMBOL}
                </strong>
              </>
            )}
            .
          </p>

          <div className="row">
            <div>
              <label>Recipient address</label>
              <input
                type="text"
                value={mintRecipient}
                onChange={(e) => setMintRecipient(e.target.value)}
                placeholder="G…"
                style={{
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, monospace',
                }}
              />
            </div>
            <div>
              <label>Amount (whole {GOV_TOKEN_SYMBOL})</label>
              <input
                type="text"
                inputMode="decimal"
                value={mintAmount}
                onChange={(e) => setMintAmount(e.target.value)}
                placeholder="100"
              />
            </div>
          </div>

          {mintValidation && (
            <div className="status error">{mintValidation}</div>
          )}

          <div className="actions">
            <button
              onClick={handleMint}
              disabled={
                !address ||
                !!mintValidation ||
                mintStatus.kind === 'progress' ||
                !mintRecipient.trim() ||
                !mintAmount.trim()
              }
            >
              {mintStatus.kind === 'progress'
                ? 'Working…'
                : `Mint ${GOV_TOKEN_SYMBOL}`}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => address && setMintRecipient(address)}
              disabled={!address}
              title="Mint to my own wallet"
            >
              Use my address
            </button>
          </div>

          {mintStatus.kind === 'progress' && (
            <div className={`status ${mintStatus.phase}`}>
              {mintStatus.label}
            </div>
          )}
          {mintStatus.kind === 'success' && (
            <div className="status success">
              ✓ {mintStatus.message}{' '}
              <a
                href={explorerTxUrl(mintStatus.hash)}
                target="_blank"
                rel="noreferrer"
              >
                tx <code>{mintStatus.hash.slice(0, 10)}…</code>
              </a>
            </div>
          )}
          {mintStatus.kind === 'error' && (
            <div className="status error">✕ {mintStatus.message}</div>
          )}
        </div>
      )}

      {/* ─── L2: create proposal ─── */}
      {CONTRACT_ID && (
        <div className="panel">
          <h2>2 · Create proposal (L2 — contract call)</h2>
          <p className="sub">
            Calls{' '}
            <code>create_proposal(creator, title, description, window)</code>{' '}
            on the deployed{' '}
            <a
              href={explorerContractUrl(CONTRACT_ID)}
              target="_blank"
              rel="noreferrer"
            >
              Voting contract
            </a>
            . Watch the status pipeline:{' '}
            <code>preparing → signing → submitting → confirming</code>.
          </p>

          <div className="row">
            <div>
              <label>Title (≤80 chars)</label>
              <input
                type="text"
                value={propTitle}
                onChange={(e) => setPropTitle(e.target.value)}
                placeholder="Adopt the bylaws v2"
                maxLength={80}
              />
            </div>
            <div>
              <label>Voting window (hours)</label>
              <input
                type="text"
                inputMode="decimal"
                value={propWindowHours}
                onChange={(e) => setPropWindowHours(e.target.value)}
                placeholder="24"
              />
            </div>
          </div>

          <label>Description (≤280 chars, optional)</label>
          <textarea
            value={propDescription}
            onChange={(e) => setPropDescription(e.target.value)}
            placeholder="What's the proposal about?"
            maxLength={280}
            rows={3}
          />

          {propValidation && (
            <div className="status error">{propValidation}</div>
          )}

          <div className="actions">
            <button
              onClick={handleCreate}
              disabled={
                !address ||
                !propTitle.trim() ||
                !!propValidation ||
                propStatus.kind === 'progress'
              }
            >
              {propStatus.kind === 'progress' ? 'Working…' : 'Create proposal'}
            </button>
          </div>

          {propStatus.kind === 'progress' && (
            <div className={`status ${propStatus.phase}`}>
              {propStatus.label}
            </div>
          )}
          {propStatus.kind === 'success' && (
            <div className="status success">
              ✓ {propStatus.message}{' '}
              <a
                href={explorerTxUrl(propStatus.hash)}
                target="_blank"
                rel="noreferrer"
              >
                tx <code>{propStatus.hash.slice(0, 10)}…</code>
              </a>
            </div>
          )}
          {propStatus.kind === 'error' && (
            <div className="status error">✕ {propStatus.message}</div>
          )}
        </div>
      )}

      {/* ─── L3 dashboard ─── */}
      {CONTRACT_ID && (
        <div className="panel">
          <h2>3 · Proposals dashboard (L3)</h2>
          <p className="sub">
            All on-chain proposals — {open.length} open, {closed.length} closed
            {proposalCount !== null && (
              <>
                {' '}
                · {proposalCount} total ·{' '}
                <a
                  href={explorerContractUrl(CONTRACT_ID)}
                  target="_blank"
                  rel="noreferrer"
                >
                  contract
                </a>
              </>
            )}
            .
            <button
              className="ghost"
              style={{ marginLeft: '0.5rem', padding: '0.2rem 0.6rem' }}
              onClick={loadProposals}
              disabled={proposalsLoading}
            >
              {proposalsLoading ? '…' : '↻'}
            </button>
          </p>

          {proposalsLoading && proposals.length === 0 ? (
            <>
              <div
                className="skeleton"
                style={{ height: 90, marginBottom: 8 }}
              />
              <div className="skeleton" style={{ height: 90 }} />
            </>
          ) : proposals.length === 0 ? (
            <div className="hint">
              No proposals yet — create the first one above.
            </div>
          ) : (
            <>
              {open.length > 0 && (
                <>
                  <div className="section-label">Open</div>
                  <div className="bill-list">
                    {open.map((p) => (
                      <ProposalCard
                        key={p.id}
                        p={p}
                        connected={address}
                        voted={!!votedMap[p.id]}
                        onVote={handleVote}
                        disabled={voteStatus.kind === 'progress'}
                        govBalance={govBalance}
                      />
                    ))}
                  </div>
                </>
              )}
              {closed.length > 0 && (
                <>
                  <div className="section-label" style={{ marginTop: '1rem' }}>
                    Closed
                  </div>
                  <div className="bill-list">
                    {closed.map((p) => (
                      <ProposalCard
                        key={p.id}
                        p={p}
                        connected={address}
                        voted={!!votedMap[p.id]}
                        onVote={handleVote}
                        disabled={voteStatus.kind === 'progress'}
                        govBalance={govBalance}
                      />
                    ))}
                  </div>
                </>
              )}
            </>
          )}

          {voteStatus.kind === 'progress' && (
            <div className={`status ${voteStatus.phase}`}>
              {voteStatus.label}
            </div>
          )}
          {voteStatus.kind === 'success' && (
            <div className="status success">
              ✓ {voteStatus.message}{' '}
              <a
                href={explorerTxUrl(voteStatus.hash)}
                target="_blank"
                rel="noreferrer"
              >
                tx <code>{voteStatus.hash.slice(0, 10)}…</code>
              </a>
            </div>
          )}
          {voteStatus.kind === 'error' && (
            <div className="status error">✕ {voteStatus.message}</div>
          )}
        </div>
      )}

      {/* ─── live event feed (L4 advanced streaming) ─── */}
      {CONTRACT_ID && (
        <div className="panel">
          <div className="feed-header">
            <h2>Live vote feed</h2>
            <div className="feed-meta">
              <span className="live-dot" aria-hidden="true" />
              <span className="muted">
                live · updated{' '}
                {lastUpdatedLabel ?? 'just now'}
              </span>
              {address && (
                <label className="filter-toggle">
                  <input
                    type="checkbox"
                    checked={onlyMyVotes}
                    onChange={(e) => setOnlyMyVotes(e.target.checked)}
                  />
                  Only my votes
                </label>
              )}
            </div>
          </div>
          <p className="sub">
            Real-time stream of <code>voted</code> events from the contract.
            Each event payload now includes the voter's gov-token weight at
            cast-time.
          </p>
          {filteredEvents.length === 0 ? (
            <div className="hint">
              {onlyMyVotes
                ? 'No votes from this wallet in the last ~5,000 ledgers.'
                : 'No votes yet.'}
            </div>
          ) : (
            <div className="event-feed">
              {filteredEvents.map((e) => (
                <div className="event-item" key={e.id}>
                  <span>
                    <span className="who">{shortAddr(e.voter)}</span> voted{' '}
                    <strong className={e.support ? 'yes' : 'no'}>
                      {e.support ? 'yes' : 'no'}
                    </strong>{' '}
                    on <strong>proposal #{e.proposalId}</strong>
                    {e.weight > 0n && (
                      <>
                        {' '}
                        with{' '}
                        <strong>
                          {formatTokenAmount(e.weight, GOV_TOKEN_DECIMALS)}{' '}
                          {GOV_TOKEN_SYMBOL}
                        </strong>
                      </>
                    )}
                  </span>
                  <span className="ts">
                    {new Date(e.ledgerClosedAt).toLocaleTimeString()}{' '}
                    {e.txHash && (
                      <a
                        href={explorerTxUrl(e.txHash)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        ↗
                      </a>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProposalCard(props: {
  p: Proposal;
  connected: string | null;
  voted: boolean;
  onVote: (id: number, support: boolean) => void;
  disabled: boolean;
  govBalance: bigint | null;
}) {
  const { p, connected, voted, onVote, disabled, govBalance } = props;
  const outcome = deriveOutcome({
    yes: p.yesWeight,
    no: p.noWeight,
    endSecs: p.endTime,
  });
  const total = p.yesWeight + p.noWeight;
  const pct = yesPercent(p.yesWeight, p.noWeight);
  const isOpen = outcome === 'open';
  const canVote = connected && isOpen && !voted && (govBalance ?? 0n) > 0n;
  const noVotingPower =
    connected && isOpen && !voted && (govBalance ?? 0n) === 0n;
  return (
    <div className="bill-item">
      <header>
        <div>
          <strong>#{p.id}</strong> · {p.title}
        </div>
        <div className="meta">
          <span className={`pill outcome-${outcome}`}>
            {OUTCOME_LABEL[outcome]}
          </span>{' '}
          · {relativeTime(p.endTime)}
        </div>
      </header>
      {p.description && (
        <p
          className="hint"
          style={{ margin: '0.4rem 0 0.5rem', whiteSpace: 'pre-wrap' }}
        >
          {p.description}
        </p>
      )}
      <div className="tally">
        <div className="tally-bar">
          <div
            className="tally-bar-yes"
            style={{ width: `${pct}%` }}
            title={`${formatTokenAmount(p.yesWeight, GOV_TOKEN_DECIMALS)} yes`}
          />
        </div>
        <div className="tally-numbers">
          <span className="yes">
            <strong>
              {formatTokenAmount(p.yesWeight, GOV_TOKEN_DECIMALS)}
            </strong>{' '}
            yes
          </span>
          <span className="no">
            <strong>{formatTokenAmount(p.noWeight, GOV_TOKEN_DECIMALS)}</strong>{' '}
            no
          </span>
          <span className="muted">
            {formatTokenAmount(total, GOV_TOKEN_DECIMALS)} {GOV_TOKEN_SYMBOL}{' '}
            · {p.voterCount} voter{p.voterCount === 1 ? '' : 's'}
          </span>
        </div>
      </div>
      {canVote && (
        <div className="actions">
          <button onClick={() => onVote(p.id, true)} disabled={disabled}>
            Vote yes
          </button>
          <button
            className="ghost"
            onClick={() => onVote(p.id, false)}
            disabled={disabled}
          >
            Vote no
          </button>
        </div>
      )}
      {connected && voted && (
        <div className="hint" style={{ marginTop: '0.5rem' }}>
          ✓ You've already voted on this proposal.
        </div>
      )}
      {noVotingPower && (
        <div className="hint" style={{ marginTop: '0.5rem' }}>
          You need at least 1 {GOV_TOKEN_SYMBOL} to vote — ask the gov-token
          admin to mint you some above.
        </div>
      )}
    </div>
  );
}
