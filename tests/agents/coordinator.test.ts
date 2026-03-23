import { describe, it, expect } from 'vitest';
import { needsConfirmation, formatConfirmation, fallbackRouting, normalizeDecisionFromMessage } from '../../src/agents/coordinator.js';
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

describe('fallbackRouting', () => {
  it('routes portfolio worry prompts to a portfolio assessment', () => {
    const decision = fallbackRouting('should I be worried about my portfolio?');
    expect(decision.agent).toBe('market');
    expect(decision.intent).toBe('assess_portfolio');
  });

  it('keeps plain portfolio requests on the summary intent', () => {
    const decision = fallbackRouting('show portfolio summary');
    expect(decision.agent).toBe('market');
    expect(decision.intent).toBe('portfolio_summary');
  });
});

describe('normalizeDecisionFromMessage', () => {
  it('fills missing swap params from a simple natural-language swap', () => {
    const decision = normalizeDecisionFromMessage(
      'swap 1 usdt to eth on arbitrum',
      {
        agent: 'swap',
        intent: 'execute_swap',
        params: { amount: '1' },
        plan: ['quote swap USDT to ETH', 'execute swap'],
      },
    );

    expect(decision.params.amount).toBe('1');
    expect(decision.params.tokenIn).toBe('USDT');
    expect(decision.params.tokenOut).toBe('ETH');
    expect(decision.params.chain).toBe('ethereum');
    expect(decision.plan).toBeUndefined();
  });

  it('keeps a real multi-step plan when the prompt explicitly chains actions', () => {
    const decision = normalizeDecisionFromMessage(
      'swap 10 usdt to eth then supply it to aave',
      {
        agent: 'swap',
        intent: 'execute_swap',
        params: { amount: '10' },
        plan: ['swap 10 USDT to ETH', 'supply ETH to Aave'],
      },
    );

    expect(decision.plan).toEqual(['swap 10 USDT to ETH', 'supply ETH to Aave']);
    expect(decision.params.tokenIn).toBe('USDT');
    expect(decision.params.tokenOut).toBe('ETH');
  });

  it('fills missing yield params from a supply request', () => {
    const decision = normalizeDecisionFromMessage(
      'supply 25 usdt to aave',
      {
        agent: 'yield',
        intent: 'supply',
        params: {},
      },
    );

    expect(decision.params.amount).toBe('25');
    expect(decision.params.token).toBe('USDT');
  });

  it('fills missing transfer params from a send request', () => {
    const decision = normalizeDecisionFromMessage(
      'send 5 usdt to 0x1111111111111111111111111111111111111111',
      {
        agent: 'treasury',
        intent: 'transfer',
        params: {},
      },
    );

    expect(decision.params.amount).toBe('5');
    expect(decision.params.token).toBe('USDT');
    expect(decision.params.to).toBe('0x1111111111111111111111111111111111111111');
  });
});
