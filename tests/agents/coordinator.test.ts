import { describe, it, expect } from 'vitest';
import { needsConfirmation, formatConfirmation } from '../../src/agents/coordinator.js';
import type { RouteDecision } from '../../src/agents/types.js';

describe('needsConfirmation', () => {
  const cases: [RouteDecision, boolean][] = [
    [{ agent: 'treasury', intent: 'transfer', params: {} }, true],
    [{ agent: 'swap', intent: 'execute_swap', params: {} }, true],
    [{ agent: 'yield', intent: 'supply', params: {} }, true],
    [{ agent: 'yield', intent: 'withdraw', params: {} }, true],
    [{ agent: 'yield', intent: 'borrow', params: {} }, true],
    [{ agent: 'yield', intent: 'repay', params: {} }, true],
    [{ agent: 'bridge', intent: 'execute_bridge', params: {} }, true],
    [{ agent: 'treasury', intent: 'get_balance', params: {} }, false],
    [{ agent: 'swap', intent: 'quote_swap', params: {} }, false],
    [{ agent: 'market', intent: 'get_price', params: {} }, false],
    [{ agent: 'risk', intent: 'get_limits', params: {} }, false],
    [{ agent: 'bridge', intent: 'quote_bridge', params: {} }, false],
    [{ agent: 'market', intent: 'portfolio_summary', params: {} }, false],
    [{ agent: 'yield', intent: 'account_data', params: {} }, false],
  ];

  for (const [decision, expected] of cases) {
    it(`${decision.agent}.${decision.intent} → ${expected}`, () => {
      expect(needsConfirmation(decision)).toBe(expected);
    });
  }
});

describe('formatConfirmation', () => {
  it('includes agent name and intent', () => {
    const msg = formatConfirmation(
      { agent: 'swap', intent: 'execute_swap', params: { amount: '100', tokenIn: 'USDT', tokenOut: 'ETH' } },
    );
    expect(msg).toContain('Swap Agent');
    expect(msg).toContain('execute_swap');
    expect(msg).toContain('100');
  });

  it('shows risk score and factors when provided', () => {
    const msg = formatConfirmation(
      { agent: 'treasury', intent: 'transfer', params: { amount: '500', to: '0xabc' } },
      7,
      'BLOCK',
      ['Amount is 100% of per-tx limit', 'Daily usage at 85%'],
    );
    expect(msg).toContain('7/10');
    expect(msg).toContain('BLOCK');
    expect(msg).toContain('100% of per-tx limit');
  });

  it('shows estimated fee when provided', () => {
    const msg = formatConfirmation(
      { agent: 'treasury', intent: 'transfer', params: { amount: '50' } },
      2,
      'APPROVE',
      [],
      '~$0.12',
    );
    expect(msg).toContain('~$0.12');
  });

  it('shows plan for multi-step operations', () => {
    const msg = formatConfirmation(
      { agent: 'swap', intent: 'execute_swap', params: {}, plan: ['Swap USDT to ETH', 'Supply ETH to Aave'] },
    );
    expect(msg).toContain('Swap USDT to ETH');
    expect(msg).toContain('Supply ETH to Aave');
  });

  it('prompts user for YES confirmation', () => {
    const msg = formatConfirmation(
      { agent: 'yield', intent: 'supply', params: { amount: '100', token: 'USDT' } },
    );
    expect(msg).toContain('YES');
  });
});
