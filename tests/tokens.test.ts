import { describe, it, expect } from 'vitest';
import {
  toBaseUnits,
  fromBaseUnits,
  parseAmount,
  resolveToken,
  resolveTokenOrAddress,
  isAddress,
  getAavePoolAddress,
} from '../src/core/tokens.js';

describe('toBaseUnits', () => {
  it('converts whole numbers', () => {
    expect(toBaseUnits('100', 6)).toBe(100_000_000n);
  });

  it('converts decimals', () => {
    expect(toBaseUnits('1.5', 6)).toBe(1_500_000n);
  });

  it('truncates excess decimals', () => {
    expect(toBaseUnits('1.123456789', 6)).toBe(1_123_456n);
  });

  it('handles zero', () => {
    expect(toBaseUnits('0', 18)).toBe(0n);
  });
});

describe('fromBaseUnits', () => {
  it('converts back to human-readable', () => {
    expect(fromBaseUnits(1_000_000n, 6)).toBe('1');
  });

  it('preserves decimals', () => {
    expect(fromBaseUnits(1_500_000n, 6)).toBe('1.5');
  });

  it('strips trailing zeros', () => {
    expect(fromBaseUnits(1_100_000n, 6)).toBe('1.1');
  });
});

describe('parseAmount', () => {
  it('parses USDT with 6 decimals', () => {
    expect(parseAmount('10', 'USDT', 'ethereum')).toBe(10_000_000n);
  });

  it('parses ETH with 18 decimals', () => {
    expect(parseAmount('1', 'ETH', 'ethereum')).toBe(10n ** 18n);
  });

  it('returns null for invalid input', () => {
    expect(parseAmount('abc', 'USDT', 'ethereum')).toBeNull();
  });
});

describe('resolveToken', () => {
  it('resolves USDT on ethereum chain', () => {
    const token = resolveToken('USDT', 'ethereum');
    expect(token).not.toBeNull();
    expect(token!.decimals).toBe(6);
    expect(token!.address).toMatch(/^0x/);
  });

  it('is case-insensitive', () => {
    expect(resolveToken('usdt', 'ethereum')).toEqual(resolveToken('USDT', 'ethereum'));
  });

  it('returns null for unknown token', () => {
    expect(resolveToken('FAKE', 'ethereum')).toBeNull();
  });
});

describe('isAddress', () => {
  it('validates a proper 0x address', () => {
    expect(isAddress('0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9')).toBe(true);
  });

  it('rejects short address', () => {
    expect(isAddress('0x1234')).toBe(false);
  });

  it('rejects non-hex string', () => {
    expect(isAddress('USDT')).toBe(false);
  });
});

describe('resolveTokenOrAddress', () => {
  it('passes through a valid address unchanged', () => {
    const addr = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';
    expect(resolveTokenOrAddress(addr, 'ethereum')).toBe(addr);
  });

  it('resolves a symbol to an address', () => {
    const result = resolveTokenOrAddress('USDT', 'ethereum');
    expect(result).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

describe('getAavePoolAddress', () => {
  it('returns Arbitrum pool for ethereum chain key', () => {
    const addr = getAavePoolAddress('ethereum');
    expect(addr).toBe('0x794a61358D6845594F94dc1DB02A252b5b4814aD');
  });

  it('returns null for unsupported chain', () => {
    expect(getAavePoolAddress('solana')).toBeNull();
  });
});
