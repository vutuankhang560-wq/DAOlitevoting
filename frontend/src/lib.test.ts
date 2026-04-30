import { describe, expect, it } from 'vitest';
import {
  ContractError,
  decodeSimError,
  deriveOutcome,
  formatTokenAmount,
  hoursToSeconds,
  isLikelyStellarAddress,
  relativeTime,
  stroopsToXlm,
  xlmToStroops,
  yesPercent,
} from './lib';

describe('xlmToStroops', () => {
  it('converts whole XLM amounts to stroops', () => {
    expect(xlmToStroops('1')).toBe(10_000_000n);
    expect(xlmToStroops('100')).toBe(1_000_000_000n);
  });

  it('converts fractional XLM up to 7 decimals', () => {
    expect(xlmToStroops('0.5')).toBe(5_000_000n);
    expect(xlmToStroops('1.2345678')).toBe(12_345_678n);
  });

  it('throws ContractError(validation) for non-numeric input', () => {
    expect(() => xlmToStroops('abc')).toThrow(ContractError);
    try {
      xlmToStroops('abc');
    } catch (err) {
      expect((err as ContractError).category).toBe('validation');
    }
  });

  it('throws for zero or negative amount', () => {
    expect(() => xlmToStroops('0')).toThrow(/greater than 0/);
    expect(() => xlmToStroops('-1')).toThrow(ContractError);
  });
});

describe('stroopsToXlm', () => {
  it('formats whole-stroop amounts without trailing decimals', () => {
    expect(stroopsToXlm(10_000_000n)).toBe('1');
  });

  it('preserves fractional XLM and strips trailing zeros', () => {
    expect(stroopsToXlm(5_000_000n)).toBe('0.5');
    expect(stroopsToXlm(1n)).toBe('0.0000001');
  });

  it('round-trips with xlmToStroops', () => {
    for (const xlm of ['0.5', '1', '7.25', '0.0000001', '12345']) {
      expect(stroopsToXlm(xlmToStroops(xlm))).toBe(xlm);
    }
  });
});

describe('isLikelyStellarAddress', () => {
  it('accepts a well-formed G address', () => {
    expect(
      isLikelyStellarAddress(
        'GCVNQZPI76QNMDKFC5DVDXHUXFVM3ABHARWJ4DOFFACQ4F2E6KYYH63A',
      ),
    ).toBe(true);
  });

  it('rejects malformed addresses', () => {
    expect(isLikelyStellarAddress('GABC')).toBe(false);
    expect(isLikelyStellarAddress('not an address')).toBe(false);
    // C-prefixed (contract) is not a wallet address.
    expect(
      isLikelyStellarAddress(
        'CCJ62UKISYB5I5UIPIRHVO7YZ4BZVB7F2UY4NZDC6ILNEHRWIMFT4PCS',
      ),
    ).toBe(false);
  });

  it('trims whitespace before validating', () => {
    expect(
      isLikelyStellarAddress(
        '   GCVNQZPI76QNMDKFC5DVDXHUXFVM3ABHARWJ4DOFFACQ4F2E6KYYH63A  ',
      ),
    ).toBe(true);
  });
});

describe('hoursToSeconds', () => {
  it('converts whole hours to seconds', () => {
    expect(hoursToSeconds('1')).toBe(3600);
    expect(hoursToSeconds('24')).toBe(86_400);
  });

  it('rounds fractional hours to whole seconds', () => {
    expect(hoursToSeconds('0.5')).toBe(1800);
  });

  it('clamps to a minimum of 60s to match the contract floor', () => {
    // 0.01h = 36s, but the contract requires at least 60s.
    expect(hoursToSeconds('0.01')).toBe(60);
  });

  it('throws on zero, negative, or non-numeric input', () => {
    expect(() => hoursToSeconds('0')).toThrow(ContractError);
    expect(() => hoursToSeconds('-2')).toThrow(ContractError);
    expect(() => hoursToSeconds('abc')).toThrow(ContractError);
  });

  it('rejects windows beyond the contract maximum (30 days)', () => {
    expect(() => hoursToSeconds('721')).toThrow(/30 days/);
  });
});

describe('relativeTime', () => {
  it('renders a future end as "closes in …"', () => {
    expect(relativeTime(1_000_000 + 3 * 3600 + 12 * 60, 1_000_000)).toBe(
      'closes in 3h 12m',
    );
  });

  it('renders a past end as "closed … ago"', () => {
    expect(relativeTime(1_000_000 - 5 * 60, 1_000_000)).toBe(
      'closed 5m ago',
    );
  });

  it('uses days for windows beyond 24h', () => {
    expect(relativeTime(1_000_000 + 2 * 86_400 + 4 * 3600, 1_000_000)).toBe(
      'closes in 2d 4h',
    );
  });

  it('accepts bigint timestamps', () => {
    expect(relativeTime(BigInt(1_000_000 + 60), 1_000_000)).toBe(
      'closes in 1m',
    );
  });
});

describe('deriveOutcome', () => {
  const now = 1_000_000;
  it('returns "open" while the window is live', () => {
    expect(
      deriveOutcome({ yes: 5, no: 2, endSecs: now + 60, nowSecs: now }),
    ).toBe('open');
  });

  it('returns "passed" when closed and yes > no', () => {
    expect(
      deriveOutcome({ yes: 5, no: 2, endSecs: now - 1, nowSecs: now }),
    ).toBe('passed');
  });

  it('returns "failed" when closed and no >= yes (ties fail)', () => {
    expect(
      deriveOutcome({ yes: 2, no: 5, endSecs: now - 1, nowSecs: now }),
    ).toBe('failed');
    expect(
      deriveOutcome({ yes: 3, no: 3, endSecs: now - 1, nowSecs: now }),
    ).toBe('failed');
  });

  it('returns "pending" when closed with no votes at all', () => {
    expect(
      deriveOutcome({ yes: 0, no: 0, endSecs: now - 1, nowSecs: now }),
    ).toBe('pending');
  });

  it('accepts bigint endSecs from the contract', () => {
    expect(
      deriveOutcome({
        yes: 1,
        no: 0,
        endSecs: BigInt(now - 1),
        nowSecs: now,
      }),
    ).toBe('passed');
  });

  it('handles bigint weighted tallies past safe integer range', () => {
    // ~10^24 — way past Number.MAX_SAFE_INTEGER (~9 * 10^15).
    const huge = 1_000_000_000_000_000_000_000_000n;
    expect(
      deriveOutcome({
        yes: huge,
        no: huge - 1n,
        endSecs: now - 1,
        nowSecs: now,
      }),
    ).toBe('passed');
    expect(
      deriveOutcome({
        yes: huge,
        no: huge,
        endSecs: now - 1,
        nowSecs: now,
      }),
    ).toBe('failed'); // ties fail
  });
});

describe('formatTokenAmount', () => {
  it('formats whole-token amounts with 7 decimals (gov-token default)', () => {
    expect(formatTokenAmount(10_000_000n, 7)).toBe('1');
    expect(formatTokenAmount(0n, 7)).toBe('0');
  });

  it('strips trailing zeros and groups thousands', () => {
    expect(formatTokenAmount(1_500_000_000n, 7)).toBe('150');
    expect(formatTokenAmount(123_456_789_000_000n, 7)).toBe('12,345,678.9');
  });

  it('handles a zero-decimal token (e.g. plain integer counter)', () => {
    expect(formatTokenAmount(1_500n, 0)).toBe('1,500');
  });

  it('handles negative values', () => {
    expect(formatTokenAmount(-10_000_000n, 7)).toBe('-1');
  });
});

describe('yesPercent', () => {
  it('returns 0 when no votes', () => {
    expect(yesPercent(0n, 0n)).toBe(0);
  });

  it('returns 100 when only yes votes', () => {
    expect(yesPercent(50n, 0n)).toBe(100);
  });

  it('returns 0 when only no votes', () => {
    expect(yesPercent(0n, 50n)).toBe(0);
  });

  it('rounds to a clean integer', () => {
    expect(yesPercent(1n, 2n)).toBe(33); // 33.33...
    expect(yesPercent(2n, 1n)).toBe(67); // 66.66...
  });

  it('handles huge weights without precision loss', () => {
    const huge = 1_000_000_000_000_000_000n;
    expect(yesPercent(huge, huge)).toBe(50);
  });
});

describe('decodeSimError', () => {
  it('translates contract panics into user-readable messages', () => {
    expect(decodeSimError('panic: title required')).toMatch(/cannot be empty/);
    expect(decodeSimError('panic: title too long')).toMatch(/80 characters/);
    expect(decodeSimError('panic: voting closed')).toMatch(/closed/);
    expect(decodeSimError('panic: already voted')).toMatch(/already voted/);
    expect(decodeSimError('panic: window too short')).toMatch(/60 seconds/);
    expect(decodeSimError('panic: proposal not found')).toMatch(/not found/i);
  });

  it('translates insufficient-balance hints', () => {
    expect(decodeSimError('account has insufficient funds')).toMatch(
      /Insufficient/,
    );
  });

  it('falls back to a truncated raw message when nothing matches', () => {
    const long = 'X'.repeat(500);
    const decoded = decodeSimError(long);
    expect(decoded.startsWith('Simulation failed: ')).toBe(true);
    expect(decoded.length).toBeLessThan(280);
  });
});

describe('ContractError', () => {
  it('captures message and category', () => {
    const err = new ContractError('boom', 'rejected');
    expect(err.message).toBe('boom');
    expect(err.category).toBe('rejected');
    expect(err.name).toBe('ContractError');
    expect(err).toBeInstanceOf(Error);
  });

  it('supports the L2-required named error categories', () => {
    const wallet = new ContractError('no wallet', 'wallet-not-found');
    const rejected = new ContractError('user rejected', 'rejected');
    const insufficient = new ContractError('low', 'insufficient-balance');
    expect(wallet.category).toBe('wallet-not-found');
    expect(rejected.category).toBe('rejected');
    expect(insufficient.category).toBe('insufficient-balance');
  });
});
