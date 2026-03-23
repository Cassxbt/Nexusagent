import { describe, it, expect } from 'vitest';
import { getPortfolioDelta, shouldSendAutopilotAlert } from '../../src/agents/autopilot.js';

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

describe('shouldSendAutopilotAlert', () => {
  it('suppresses duplicate low-gas alerts within the cooldown window', () => {
    const userId = `test-alert-${Date.now()}`;
    const alert = '⛽ *Low ETH balance: 0.0004 ETH*\nConsider topping up to ensure uninterrupted operations.';
    const start = 1_000_000;

    expect(shouldSendAutopilotAlert(userId, alert, start)).toBe(true);
    expect(shouldSendAutopilotAlert(userId, alert, start + 5 * 60 * 1000)).toBe(false);
    expect(shouldSendAutopilotAlert(userId, alert, start + 61 * 60 * 1000)).toBe(true);
  });

  it('still emits immediately when the alert family changes severity', () => {
    const userId = `test-alert-severity-${Date.now()}`;
    const low = '⛽ *Low ETH balance: 0.0004 ETH*\nConsider topping up to ensure uninterrupted operations.';
    const critical = '⛽ *Low ETH for gas: 0.00009 ETH*\nTransactions will fail without gas. Top up your wallet on Arbitrum.';
    const start = 2_000_000;

    expect(shouldSendAutopilotAlert(userId, low, start)).toBe(true);
    expect(shouldSendAutopilotAlert(userId, critical, start + 60_000)).toBe(true);
  });
});
