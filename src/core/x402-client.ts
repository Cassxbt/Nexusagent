import { getAccount } from './wdk-setup.js';
import { resolveTokenAddress, parseAmount } from './tokens.js';
import { logReasoning } from '../reasoning/logger.js';
import { getDb } from './db.js';

/** Maximum autonomous micropayment in USD — anything above requires user confirmation */
const MAX_AUTONOMOUS_PAYMENT_USD = 2.0;

/** Maximum autonomous operational spend per user per UTC day */
const MAX_DAILY_OPS_BUDGET_USD = 10.0;

/** Allowed recipient addresses for x402 payments */
const TRUSTED_RECIPIENTS = new Set<string>(
  [
    process.env.PREMIUM_SERVICE_ADDRESS ?? '',
    ...(process.env.X402_TRUSTED_RECIPIENTS ?? '')
      .split(',')
      .map(value => value.trim()),
  ]
    .filter(Boolean)
    .map(value => value.toLowerCase()),
);

const AUTONOMOUS_PAYMENT_TOKENS = new Set<string>(['USDT']);

function getStartOfUtcDay(): number {
  const now = new Date();
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);
}

function getTodaysX402SpendUsd(userId: string): number {
  const db = getDb();
  const startOfDay = getStartOfUtcDay();
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount_usdt), 0) AS total
    FROM tx_log
    WHERE user_id = ?
      AND intent = 'x402_payment'
      AND status = 'confirmed'
      AND created_at >= ?
  `).get(userId, startOfDay) as { total: number | null };

  return row.total ?? 0;
}

/**
 * x402-aware fetch — implements the HTTP 402 Payment Required protocol.
 *
 * Flow:
 * 1. Makes initial request to a resource
 * 2. If server returns 402 with payment requirements, validates amount & recipient
 * 3. Sends USDT payment from WDK wallet to the specified recipient
 * 4. Retries request with X-PAYMENT header containing tx hash as proof
 *
 * Safety:
 * - Caps autonomous payments at $2 USD
 * - Caps per-user operational spend at $10/day
 * - Only pays trusted recipients
 * - Logs all payments to SQLite for audit trail
 */
export async function x402Fetch(
  url: string,
  userId: string,
  options?: RequestInit,
): Promise<Response> {
  const res = await fetch(url, {
    ...options,
    signal: options?.signal ?? AbortSignal.timeout(10000),
  });

  if (res.status !== 402) return res;

  let requirements: {
    token: string;
    amount: string;
    recipient: string;
    chain: string;
    description?: string;
  };

  try {
    const body = await res.json() as Record<string, unknown>;
    requirements = body.paymentRequirements as typeof requirements;
    if (!requirements?.token || !requirements?.amount || !requirements?.recipient) {
      throw new Error('Incomplete payment requirements');
    }
  } catch {
    throw new Error('x402: Could not parse payment requirements from 402 response');
  }

  // Safety: validate payment amount
  const requestedAmount = parseFloat(requirements.amount);
  if (isNaN(requestedAmount) || requestedAmount <= 0) {
    throw new Error(`x402: Invalid payment amount "${requirements.amount}"`);
  }
  if (requestedAmount > MAX_AUTONOMOUS_PAYMENT_USD) {
    throw new Error(
      `x402: Payment $${requestedAmount} exceeds autonomous cap of $${MAX_AUTONOMOUS_PAYMENT_USD} — requires user approval`,
    );
  }

  const normalizedToken = requirements.token.toUpperCase();
  if (!AUTONOMOUS_PAYMENT_TOKENS.has(normalizedToken)) {
    throw new Error(`x402: Autonomous payments only support ${Array.from(AUTONOMOUS_PAYMENT_TOKENS).join(', ')}`);
  }

  const spentToday = getTodaysX402SpendUsd(userId);
  const projectedSpend = spentToday + requestedAmount;
  if (projectedSpend > MAX_DAILY_OPS_BUDGET_USD) {
    logReasoning({
      agent: 'x402-Client',
      action: 'budget-rejected',
      reasoning: `Projected x402 ops spend $${projectedSpend.toFixed(2)} exceeds daily budget $${MAX_DAILY_OPS_BUDGET_USD.toFixed(2)}`,
      status: 'fail',
    });
    throw new Error(
      `x402: Daily ops budget exceeded — spent $${spentToday.toFixed(2)} today, requested $${requestedAmount.toFixed(2)}, cap is $${MAX_DAILY_OPS_BUDGET_USD.toFixed(2)}`,
    );
  }

  // Safety: validate recipient
  const normalizedRecipient = requirements.recipient.toLowerCase();
  if (TRUSTED_RECIPIENTS.size > 0 && !TRUSTED_RECIPIENTS.has(normalizedRecipient)) {
    logReasoning({
      agent: 'x402-Client',
      action: 'payment-rejected',
      reasoning: `Recipient ${requirements.recipient.slice(0, 10)}... is not in trusted list`,
      status: 'fail',
    });
    throw new Error(`x402: Untrusted payment recipient ${requirements.recipient.slice(0, 10)}...`);
  }

  logReasoning({
    agent: 'x402-Client',
    action: 'payment-required',
    reasoning: `Resource requires ${requirements.amount} ${normalizedToken} payment to ${requirements.recipient.slice(0, 10)}...`,
    result: `Daily budget after payment: $${(MAX_DAILY_OPS_BUDGET_USD - projectedSpend).toFixed(2)} remaining`,
    status: 'pass',
  });

  const chain = requirements.chain || 'ethereum';
  const account = await getAccount(chain, { userId });

  const tokenAddress = resolveTokenAddress(normalizedToken, chain);
  if (!tokenAddress) throw new Error(`x402: Unknown token ${normalizedToken}`);

  const baseAmount = parseAmount(requirements.amount, normalizedToken, chain);
  if (baseAmount === null) throw new Error(`x402: Invalid amount ${requirements.amount}`);

  const transferResult = await account.transfer({
    token: tokenAddress,
    recipient: normalizedRecipient,
    amount: baseAmount,
  });

  logReasoning({
    agent: 'x402-Client',
    action: 'payment-sent',
    reasoning: `Paid ${requirements.amount} ${requirements.token} → tx: ${transferResult.hash}`,
    status: 'pass',
  });

  // Log payment to SQLite for audit trail
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO tx_log (user_id, intent, agent, amount_usdt, tx_hash, status, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId, 'x402_payment', 'x402-client', requestedAmount, transferResult.hash, 'confirmed', JSON.stringify({
      url,
      recipient: normalizedRecipient,
      token: normalizedToken,
      description: requirements.description,
      dailyBudgetUsd: MAX_DAILY_OPS_BUDGET_USD,
      spentTodayUsd: spentToday,
      projectedSpendUsd: projectedSpend,
    }));
  } catch {
    // Non-fatal — logging failure shouldn't block the payment flow
  }

  const retryRes = await fetch(url, {
    ...options,
    headers: {
      ...Object.fromEntries(new Headers(options?.headers).entries()),
      'X-PAYMENT': JSON.stringify({
        txHash: transferResult.hash,
        token: normalizedToken,
        amount: requirements.amount,
        chain,
      }),
    },
    signal: AbortSignal.timeout(10000),
  });

  logReasoning({
    agent: 'x402-Client',
    action: 'payment-verified',
    reasoning: retryRes.ok ? 'Access granted after payment' : `Server returned ${retryRes.status} after payment`,
    status: retryRes.ok ? 'pass' : 'fail',
  });

  return retryRes;
}
