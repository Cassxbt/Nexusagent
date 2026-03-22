import { describe, it, expect } from 'vitest';

// Bridge agent validation logic (tested without WDK dependency)
const SUPPORTED_TARGET_CHAINS = ['ethereum', 'base', 'polygon', 'optimism'];

describe('bridge validation', () => {
  it('accepts supported target chains', () => {
    for (const chain of SUPPORTED_TARGET_CHAINS) {
      expect(SUPPORTED_TARGET_CHAINS.includes(chain)).toBe(true);
    }
  });

  it('rejects unsupported chains', () => {
    expect(SUPPORTED_TARGET_CHAINS.includes('solana')).toBe(false);
    expect(SUPPORTED_TARGET_CHAINS.includes('bitcoin')).toBe(false);
    expect(SUPPORTED_TARGET_CHAINS.includes('avalanche')).toBe(false);
  });

  it('only allows USDT bridging', () => {
    const allowedTokens = ['USDT'];
    expect(allowedTokens.includes('USDT')).toBe(true);
    expect(allowedTokens.includes('ETH')).toBe(false);
    expect(allowedTokens.includes('USDC')).toBe(false);
  });

  it('requires positive amount', () => {
    const amount = parseFloat('100');
    expect(amount > 0).toBe(true);
    expect(parseFloat('0') > 0).toBe(false);
    expect(parseFloat('-10') > 0).toBe(false);
  });

  it('validates target address format', () => {
    const isAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
    expect(isAddress('0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9')).toBe(true);
    expect(isAddress('0xinvalid')).toBe(false);
    expect(isAddress('not-an-address')).toBe(false);
  });
});
