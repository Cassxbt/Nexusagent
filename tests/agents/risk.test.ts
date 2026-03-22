import { describe, it, expect } from 'vitest';
import { calculateRiskScore, getTodayKey } from '../../src/agents/risk.js';

const defaultLimits = { maxTransactionUsdt: 500, dailyLimitUsdt: 2000, maxSlippagePercent: 1 };

describe('calculateRiskScore', () => {
  it('small safe transaction is APPROVE', () => {
    const { tier, score } = calculateRiskScore(10, defaultLimits, 0, 0, []);
    expect(tier).toBe('APPROVE');
    expect(score).toBeLessThan(4);
  });

  it('transaction over per-tx limit is BLOCK', () => {
    const { tier } = calculateRiskScore(600, defaultLimits, 0, 0, ['Exceeds per-tx limit']);
    expect(tier).toBe('BLOCK');
  });

  it('high slippage escalates score', () => {
    const low = calculateRiskScore(50, defaultLimits, 0, 0.5, []);
    const high = calculateRiskScore(50, defaultLimits, 0, 1.5, []);
    expect(high.score).toBeGreaterThan(low.score);
  });

  it('near daily cap triggers REVIEW', () => {
    const { tier } = calculateRiskScore(200, defaultLimits, 1700, 0, []);
    expect(tier).toBe('REVIEW');
  });

  it('score is clamped between 1 and 10', () => {
    const { score } = calculateRiskScore(9999, defaultLimits, 9999, 99, ['v1', 'v2', 'v3', 'v4', 'v5']);
    expect(score).toBeGreaterThanOrEqual(1);
    expect(score).toBeLessThanOrEqual(10);
  });

  it('zero amount is minimal risk', () => {
    const { score, tier } = calculateRiskScore(0, defaultLimits, 0, 0, []);
    expect(score).toBe(1);
    expect(tier).toBe('APPROVE');
  });

  it('any violation forces BLOCK regardless of score', () => {
    const { tier } = calculateRiskScore(1, defaultLimits, 0, 0, ['contract not whitelisted']);
    expect(tier).toBe('BLOCK');
  });

  it('returns factors explaining each scoring component', () => {
    const { factors } = calculateRiskScore(400, defaultLimits, 1500, 0.8, []);
    expect(factors.length).toBeGreaterThan(0);
    expect(factors.some(f => f.includes('per-tx limit'))).toBe(true);
  });

  it('multiple violations stack scores additively', () => {
    const one = calculateRiskScore(100, defaultLimits, 0, 0, ['v1']);
    const three = calculateRiskScore(100, defaultLimits, 0, 0, ['v1', 'v2', 'v3']);
    expect(three.score).toBeGreaterThan(one.score);
  });

  it('slippage at threshold boundary triggers warning', () => {
    const { score: atThreshold } = calculateRiskScore(50, defaultLimits, 0, 0.75, []);
    const { score: belowThreshold } = calculateRiskScore(50, defaultLimits, 0, 0.5, []);
    expect(atThreshold).toBeGreaterThan(belowThreshold);
  });

  it('exactly at daily cap is REVIEW not BLOCK', () => {
    // $1600 daily + $400 = $2000 exactly (100% of limit)
    const { tier } = calculateRiskScore(400, defaultLimits, 1600, 0, []);
    // 100% daily usage = +2 (>0.8), 80% tx ratio = +2 (>0.7), base 1 = score 5 → REVIEW
    expect(tier).toBe('REVIEW');
  });

  it('custom limits are respected', () => {
    const strictLimits = { maxTransactionUsdt: 50, dailyLimitUsdt: 100, maxSlippagePercent: 0.5 };
    const { tier } = calculateRiskScore(40, strictLimits, 0, 0, []);
    // 80% of $50 tx limit → +2, score = 3 → APPROVE
    expect(tier).toBe('APPROVE');
    const { tier: tier2 } = calculateRiskScore(60, strictLimits, 0, 0, ['Exceeds per-tx limit']);
    expect(tier2).toBe('BLOCK');
  });
});

describe('getTodayKey', () => {
  it('returns YYYY-MM-DD format', () => {
    const key = getTodayKey();
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
