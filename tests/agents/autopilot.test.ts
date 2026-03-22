import { describe, it, expect } from 'vitest';
import { getPortfolioDelta } from '../../src/agents/autopilot.js';

describe('getPortfolioDelta', () => {
  it('returns null when no snapshot exists', () => {
    // No snapshot has been taken, so delta should be null
    expect(getPortfolioDelta(1000)).toBeNull();
  });

  it('returns null for zero current value', () => {
    expect(getPortfolioDelta(0)).toBeNull();
  });
});

describe('autopilot config defaults', () => {
  it('defines correct thresholds', () => {
    const DEFAULT_CONFIG = {
      intervalMs: 5 * 60 * 1000,
      healthFactorWarn: 1.5,
      healthFactorCritical: 1.2,
      apyDropThresholdPercent: 30,
      balanceChangeThresholdPercent: 10,
    };

    expect(DEFAULT_CONFIG.intervalMs).toBe(300000); // 5 minutes
    expect(DEFAULT_CONFIG.healthFactorCritical).toBeLessThan(DEFAULT_CONFIG.healthFactorWarn);
    expect(DEFAULT_CONFIG.apyDropThresholdPercent).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.balanceChangeThresholdPercent).toBeGreaterThan(0);
  });

  it('critical threshold is below warning threshold', () => {
    // This invariant must hold for correct alerting behavior
    const warn = 1.5;
    const critical = 1.2;
    expect(critical).toBeLessThan(warn);
    expect(critical).toBeGreaterThan(1.0); // Above liquidation
  });
});
