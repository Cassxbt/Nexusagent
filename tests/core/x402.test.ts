import { describe, it, expect } from 'vitest';
import { validateX402AutonomousPayment } from '../../src/core/x402-client.js';

const TRUSTED = new Set(['0xabc123']);

describe('x402 payment validation', () => {
  it('rejects payments above autonomous cap', () => {
    expect(() => validateX402AutonomousPayment({
      token: 'USDT',
      amount: '5.00',
      recipient: '0xabc123',
      chain: 'ethereum',
    }, {
      trustedRecipients: TRUSTED,
      maxAutonomousPaymentUsd: 2,
      maxDailyOpsBudgetUsd: 10,
      spentTodayUsd: 0,
    })).toThrow(/exceeds autonomous cap/i);
  });

  it('accepts payments at or below cap', () => {
    const valid = validateX402AutonomousPayment({
      token: 'USDT',
      amount: '2.00',
      recipient: '0xabc123',
      chain: 'ethereum',
    }, {
      trustedRecipients: TRUSTED,
      maxAutonomousPaymentUsd: 2,
      maxDailyOpsBudgetUsd: 10,
      spentTodayUsd: 0,
    });
    expect(valid.requestedAmount).toBe(2);
  });

  it('rejects negative amounts', () => {
    expect(() => validateX402AutonomousPayment({
      token: 'USDT',
      amount: '-1',
      recipient: '0xabc123',
      chain: 'ethereum',
    }, {
      trustedRecipients: TRUSTED,
      maxAutonomousPaymentUsd: 2,
      maxDailyOpsBudgetUsd: 10,
      spentTodayUsd: 0,
    })).toThrow(/invalid payment amount/i);
  });

  it('rejects NaN amounts', () => {
    expect(() => validateX402AutonomousPayment({
      token: 'USDT',
      amount: 'not-a-number',
      recipient: '0xabc123',
      chain: 'ethereum',
    }, {
      trustedRecipients: TRUSTED,
      maxAutonomousPaymentUsd: 2,
      maxDailyOpsBudgetUsd: 10,
      spentTodayUsd: 0,
    })).toThrow(/invalid payment amount/i);
  });

  it('fails closed when no trusted recipients are configured', () => {
    expect(() => validateX402AutonomousPayment({
      token: 'USDT',
      amount: '0.10',
      recipient: '0xabc123',
      chain: 'ethereum',
    }, {
      trustedRecipients: new Set(),
      maxAutonomousPaymentUsd: 2,
      maxDailyOpsBudgetUsd: 10,
      spentTodayUsd: 0,
    })).toThrow(/trusted recipient list is empty/i);
  });

  it('validates recipient is in trusted set', () => {
    expect(() => validateX402AutonomousPayment({
      token: 'USDT',
      amount: '0.10',
      recipient: '0xevil',
      chain: 'ethereum',
    }, {
      trustedRecipients: TRUSTED,
      maxAutonomousPaymentUsd: 2,
      maxDailyOpsBudgetUsd: 10,
      spentTodayUsd: 0,
    })).toThrow(/untrusted payment recipient/i);
  });

  it('rejects unsupported autonomous payment tokens', () => {
    expect(() => validateX402AutonomousPayment({
      token: 'ETH',
      amount: '0.10',
      recipient: '0xabc123',
      chain: 'ethereum',
    }, {
      trustedRecipients: TRUSTED,
      maxAutonomousPaymentUsd: 2,
      maxDailyOpsBudgetUsd: 10,
      spentTodayUsd: 0,
    })).toThrow(/only support usdt/i);
  });

  it('enforces the daily ops budget', () => {
    expect(() => validateX402AutonomousPayment({
      token: 'USDT',
      amount: '2.00',
      recipient: '0xabc123',
      chain: 'ethereum',
    }, {
      trustedRecipients: TRUSTED,
      maxAutonomousPaymentUsd: 2,
      maxDailyOpsBudgetUsd: 10,
      spentTodayUsd: 9,
    })).toThrow(/daily ops budget exceeded/i);
  });

  it('builds correct payment proof header', () => {
    const proof = JSON.stringify({
      txHash: '0xabc',
      token: 'USDT',
      amount: '0.10',
      chain: 'ethereum',
    });
    const parsed = JSON.parse(proof);
    expect(parsed.txHash).toBe('0xabc');
    expect(parsed.token).toBe('USDT');
  });
});
