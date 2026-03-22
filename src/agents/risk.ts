import { config } from '../core/config.js';
import { getAccount } from '../core/wdk-setup.js';
import { resolveTokenOrAddress, fromBaseUnits, resolveToken, getAavePoolAddress } from '../core/tokens.js';
import { llmComplete } from '../reasoning/llm.js';
import { logReasoning } from '../reasoning/logger.js';
import { getDb } from '../core/db.js';
import { pricing } from '../core/pricing.js';
import { getGuardParams } from '../core/guard.js';
import type { Agent, AgentRequest, AgentResponse, RiskTier } from './types.js';

type UserLimits = {
  maxTransactionUsdt: number;
  dailyLimitUsdt: number;
  maxSlippagePercent: number;
};

// Whitelisted contract addresses
const CONTRACT_WHITELIST = new Set<string>([
  // Aave V3 Pools
  '0x794a61358D6845594F94dc1DB02A252b5b4814aD', // Aave V3 Arbitrum
  '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', // Aave V3 Mainnet
  '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', // Aave V3 Base
  // USDT0 Bridge
  '0xc026395860Db2d07ee33e05fE50ed7bD583189C7', // USDT0 Router Arbitrum
  // Token contracts (approve targets)
  '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', // USDT Arbitrum
  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // USDC Arbitrum
  '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // WETH Arbitrum
  '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', // DAI Arbitrum
  '0x68749665FF8D2d112Fa859AA293f07A622782F38', // XAUT Arbitrum
]);

export const riskAgent: Agent = {
  name: 'risk',
  description: 'Intelligent transaction guardian: risk scoring, CEX-DEX validation, spending limits, balance checks, contract whitelisting.',

  permissions: {
    allowedIntents: ['check_transaction', 'get_limits', 'set_limits', 'assess_risk', 'record_spending', 'get_guard_params'],
    allowedTokens: ['USDT', 'USDC', 'ETH', 'WETH', 'DAI', 'XAUT'],
  },

  async execute(request: AgentRequest): Promise<AgentResponse> {
    const { intent, params } = request;

    switch (intent) {
      case 'check_transaction':
        return checkTransaction(params, request.userId);
      case 'record_spending':
        return recordSpending(params, request.userId);
      case 'get_limits':
        return getLimits(request.userId);
      case 'set_limits':
        return setLimits(params, request.userId);
      case 'assess_risk':
        return assessRisk(params);
      case 'get_guard_params':
        return getOnChainGuardParams();
      default:
        return { success: false, message: `Unknown risk intent: ${intent}` };
    }
  },
};

const SYSTEM_ACTORS = new Set(['autopilot', 'rules', 'x402']);

export function getRemainingCooldownSeconds(
  lastSuccessfulTxAt: number | null,
  cooldownSeconds: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): number {
  if (!lastSuccessfulTxAt || cooldownSeconds <= 0) return 0;
  return Math.max(0, (lastSuccessfulTxAt + cooldownSeconds) - nowSeconds);
}

function getLatestSuccessfulRiskGatedTransactionAt(userId: string): number | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT created_at
    FROM tx_log
    WHERE user_id = ?
      AND status = 'success'
      AND amount_usdt IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 1
  `).get(userId) as { created_at: number } | undefined;

  return row?.created_at ?? null;
}

async function getUserLimits(userId: string): Promise<UserLimits> {
  // Per-user overrides in SQLite take highest priority
  const db = getDb();
  const row = db.prepare(
    'SELECT max_transaction_usdt, daily_limit_usdt, max_slippage_percent FROM risk_limits WHERE user_id = ?',
  ).get(userId) as { max_transaction_usdt: number; daily_limit_usdt: number; max_slippage_percent: number } | undefined;

  if (row) {
    return { maxTransactionUsdt: row.max_transaction_usdt, dailyLimitUsdt: row.daily_limit_usdt, maxSlippagePercent: row.max_slippage_percent };
  }

  // Fall back to on-chain NexusGuard params (or config if not deployed)
  const guard = await getGuardParams();
  logReasoning({
    agent: 'Risk',
    action: 'guardParams',
    reasoning: `Risk limits source: ${guard.source} — maxTx: $${guard.maxTransactionUsdt}, daily: $${guard.dailyLimitUsdt}`,
    status: 'pass',
  });

  return {
    maxTransactionUsdt: guard.maxTransactionUsdt,
    dailyLimitUsdt: guard.dailyLimitUsdt,
    maxSlippagePercent: guard.maxSlippagePercent,
  };
}

export function getTodayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function getDailyTotal(userId: string): number {
  const db = getDb();
  const row = db.prepare(
    'SELECT total FROM risk_spending WHERE user_id = ? AND date = ?',
  ).get(userId, getTodayKey()) as { total: number } | undefined;
  return row?.total ?? 0;
}

export function addSpending(userId: string, amountUsdt: number): void {
  const db = getDb();
  const today = getTodayKey();
  db.prepare(`
    INSERT INTO risk_spending (user_id, date, total) VALUES (?, ?, ?)
    ON CONFLICT (user_id, date) DO UPDATE SET total = total + excluded.total
  `).run(userId, today, amountUsdt);
}

/** Calculate numerical risk score (1-10) and tier */
export function calculateRiskScore(
  amountUsdt: number,
  limits: UserLimits,
  dailyTotal: number,
  slippage: number,
  violations: string[],
): { score: number; tier: RiskTier; factors: string[] } {
  const factors: string[] = [];
  let score = 1; // Base score: minimal risk

  // Amount relative to per-tx limit
  const txRatio = amountUsdt / limits.maxTransactionUsdt;
  if (txRatio > 1) {
    score += 4;
    factors.push(`Amount is ${(txRatio * 100).toFixed(0)}% of per-tx limit`);
  } else if (txRatio > 0.7) {
    score += 2;
    factors.push(`Amount is ${(txRatio * 100).toFixed(0)}% of per-tx limit`);
  } else if (txRatio > 0.3) {
    score += 1;
    factors.push(`Amount is ${(txRatio * 100).toFixed(0)}% of per-tx limit`);
  }

  // Daily cap usage
  const dailyRatio = (dailyTotal + amountUsdt) / limits.dailyLimitUsdt;
  if (dailyRatio > 1) {
    score += 3;
    factors.push(`Would exceed daily cap (${(dailyRatio * 100).toFixed(0)}%)`);
  } else if (dailyRatio > 0.8) {
    score += 2;
    factors.push(`Daily usage at ${(dailyRatio * 100).toFixed(0)}%`);
  } else if (dailyRatio > 0.5) {
    score += 1;
    factors.push(`Daily usage at ${(dailyRatio * 100).toFixed(0)}%`);
  }

  // Slippage
  if (slippage > limits.maxSlippagePercent) {
    score += 2;
    factors.push(`Slippage ${slippage}% exceeds ${limits.maxSlippagePercent}% max`);
  } else if (slippage > limits.maxSlippagePercent * 0.7) {
    score += 1;
    factors.push(`Slippage ${slippage}% approaching limit`);
  }

  // Hard violations
  score += violations.length;

  // Clamp to 1-10
  score = Math.min(10, Math.max(1, score));

  // Determine tier
  let tier: RiskTier;
  if (violations.length > 0 || score >= 7) {
    tier = 'BLOCK';
  } else if (score >= 4) {
    tier = 'REVIEW';
  } else {
    tier = 'APPROVE';
  }

  return { score, tier, factors };
}

/** CEX-DEX price validation */
async function validateSwapPrice(
  tokenIn: string,
  tokenOut: string,
  swapQuotePrice?: string,
): Promise<{ valid: boolean; deviation?: number; cexPrice?: number; message?: string }> {
  try {
    // Map common symbols for Bitfinex
    const base = tokenIn.toUpperCase() === 'USDT' ? tokenOut : tokenIn;
    const quote = tokenIn.toUpperCase() === 'USDT' ? 'USD' : 'USD';

    if (base === 'USDT' || base === 'USDC' || base === 'DAI') {
      return { valid: true }; // Stablecoins don't need price validation
    }

    const cexPrice = await pricing.getCurrentPrice(base, quote);

    if (swapQuotePrice) {
      const dexPrice = parseFloat(swapQuotePrice);
      const deviation = Math.abs(dexPrice - cexPrice) / cexPrice * 100;

      logReasoning({
        agent: 'Risk',
        action: 'cex-dex-validation',
        reasoning: `CEX price: $${cexPrice} | DEX price: $${dexPrice} | Deviation: ${deviation.toFixed(2)}%`,
        status: deviation > 2 ? 'warn' : 'pass',
      });

      if (deviation > 3) {
        return {
          valid: false,
          deviation,
          cexPrice,
          message: `DEX price deviates ${deviation.toFixed(1)}% from CEX — possible manipulation or low liquidity`,
        };
      }

      if (deviation > 2) {
        return {
          valid: true,
          deviation,
          cexPrice,
          message: `DEX-CEX price deviation of ${deviation.toFixed(1)}% — proceed with caution`,
        };
      }
    }

    return { valid: true, cexPrice };
  } catch {
    logReasoning({
      agent: 'Risk',
      action: 'cex-dex-validation',
      reasoning: 'Price validation unavailable — CEX price feed unreachable',
      status: 'warn',
    });
    // Fail-open: don't block swaps on price feed outage, but flag it
    return { valid: true, message: 'Price validation skipped — CEX feed unavailable' };
  }
}

async function checkTransaction(
  params: Record<string, string>,
  userId: string,
): Promise<AgentResponse> {
  const amountUsdt = parseFloat(params.amountUsdt || '0');
  const type = params.type || 'transfer';
  const slippage = parseFloat(params.slippage || '0');
  const token = params.token || '';

  logReasoning({
    agent: 'Risk',
    action: 'checkTransaction',
    reasoning: `Validating ${type} of ~$${amountUsdt} USDT equivalent`,
    status: 'pass',
  });

  const limits = await getUserLimits(userId);
  const violations: string[] = [];

  // Emergency pause check — on-chain kill switch
  const guard = await getGuardParams();
  if (guard.paused) {
    return {
      success: false,
      message: '🚫 *BLOCKED* — NexusGuard emergency pause is active. All transactions halted by owner.',
      data: { approved: false, violations: ['Emergency pause active'], riskScore: 10, riskTier: 'BLOCK' as RiskTier, factors: ['Emergency pause active'] },
      riskScore: 10,
      riskTier: 'BLOCK' as RiskTier,
    };
  }

  // Fail closed for autonomous system actors if on-chain guard data is unavailable.
  // User-initiated flows may still use config-backed limits, but unattended execution
  // should not proceed on an untrusted fallback safety source.
  const systemActor = params.systemActor || userId;
  if (guard.source !== 'on-chain' && SYSTEM_ACTORS.has(systemActor)) {
    return {
      success: false,
      message: '🚫 *BLOCKED* — Autonomous execution disabled because NexusGuard is not available on-chain. Manual actions may continue under config-backed limits.',
      data: {
        approved: false,
        violations: ['On-chain NexusGuard unavailable for autonomous execution'],
        riskScore: 10,
        riskTier: 'BLOCK' as RiskTier,
        factors: ['Autonomous writes require trusted on-chain guard data'],
      },
      riskScore: 10,
      riskTier: 'BLOCK' as RiskTier,
    };
  }

  const cooldownRemaining = getRemainingCooldownSeconds(
    getLatestSuccessfulRiskGatedTransactionAt(userId),
    guard.cooldownSeconds,
  );
  if (cooldownRemaining > 0) {
    violations.push(
      `Guard cooldown active for ${cooldownRemaining}s`,
    );
  }

  // Per-transaction limit
  if (amountUsdt > limits.maxTransactionUsdt) {
    violations.push(
      `Amount $${amountUsdt} exceeds per-tx limit of $${limits.maxTransactionUsdt}`,
    );
  }

  // Daily cap
  const dailyTotal = getDailyTotal(userId);
  if (dailyTotal + amountUsdt > limits.dailyLimitUsdt) {
    violations.push(
      `Would push daily total to $${dailyTotal + amountUsdt} (limit: $${limits.dailyLimitUsdt})`,
    );
  }

  // Slippage guard
  if (slippage > limits.maxSlippagePercent) {
    violations.push(
      `Slippage ${slippage}% exceeds max ${limits.maxSlippagePercent}%`,
    );
  }

  // Contract whitelist check
  if (params.contractAddress && !CONTRACT_WHITELIST.has(params.contractAddress)) {
    violations.push(
      `Contract ${params.contractAddress.slice(0, 10)}... is not whitelisted`,
    );
  }

  // CEX-DEX price validation for swaps
  if (type === 'execute_swap' && params.tokenIn && params.tokenOut) {
    const priceCheck = await validateSwapPrice(
      params.tokenIn,
      params.tokenOut,
      params.swapQuotePrice,
    );
    if (!priceCheck.valid && priceCheck.message) {
      violations.push(priceCheck.message);
    }
  }

  // On-chain balance check
  if (token && amountUsdt > 0) {
    try {
      const balanceCheck = await checkBalance(token, amountUsdt, userId);
      if (balanceCheck) {
        violations.push(balanceCheck);
      }
    } catch (err) {
      logReasoning({
        agent: 'Risk',
        action: 'checkTransaction',
        reasoning: 'Balance check failed (non-blocking)',
        result: err instanceof Error ? err.message : String(err),
        status: 'warn',
      });
    }
  }

  // Calculate risk score
  const { score, tier, factors } = calculateRiskScore(amountUsdt, limits, dailyTotal, slippage, violations);

  logReasoning({
    agent: 'Risk',
    action: 'riskScore',
    reasoning: `Risk Score: ${score}/10 — ${tier}`,
    result: factors.join('; '),
    status: tier === 'BLOCK' ? 'fail' : tier === 'REVIEW' ? 'warn' : 'pass',
    riskScore: score,
    riskTier: tier,
  });

  if (tier === 'BLOCK') {
    return {
      success: false,
      message: `🚫 *BLOCKED* — Risk Score: ${score}/10\n${violations.map((v) => `• ${v}`).join('\n')}`,
      data: { approved: false, violations, riskScore: score, riskTier: tier, factors },
      riskScore: score,
      riskTier: tier,
    };
  }

  // NOTE: Spending is NOT recorded here anymore (bug fix).
  // Coordinator calls record_spending AFTER successful execution.

  const message = tier === 'REVIEW'
    ? `⚠️ *REVIEW* — Risk Score: ${score}/10\n${factors.map(f => `• ${f}`).join('\n')}\nDaily spending: $${dailyTotal} / $${limits.dailyLimitUsdt}`
    : `✅ *APPROVED* — Risk Score: ${score}/10\nDaily spending: $${dailyTotal} / $${limits.dailyLimitUsdt}`;

  return {
    success: true,
    message,
    data: { approved: true, riskScore: score, riskTier: tier, factors, dailyTotal: getDailyTotal(userId) },
    riskScore: score,
    riskTier: tier,
  };
}

/** Post-execution spending recording (called by coordinator after success) */
async function recordSpending(
  params: Record<string, string>,
  userId: string,
): Promise<AgentResponse> {
  const amountUsdt = parseFloat(params.amountUsdt || '0');
  addSpending(userId, amountUsdt);

  logReasoning({
    agent: 'Risk',
    action: 'recordSpending',
    reasoning: `Recorded $${amountUsdt} spending after successful execution`,
    result: `Daily total: $${getDailyTotal(userId)}`,
    status: 'pass',
  });

  return {
    success: true,
    message: `Spending recorded. Daily total: $${getDailyTotal(userId)}`,
    data: { dailyTotal: getDailyTotal(userId) },
  };
}

/** Check if wallet has sufficient balance for the operation */
async function checkBalance(token: string, amountUsdt: number, userId?: string): Promise<string | null> {
  try {
    const account = await getAccount('ethereum', { userId });

    // Always check ETH for gas
    const ethBalance = await account.getBalance();
    const ethReadable = fromBaseUnits(ethBalance, 18);
    if (ethBalance === 0n) {
      return `Wallet has 0 ETH — insufficient for gas fees`;
    }
    if (ethBalance < BigInt(5e14)) { // < 0.0005 ETH
      return `Low ETH for gas: ${ethReadable} ETH — transactions may fail`;
    }

    if (token && token.toUpperCase() !== 'ETH') {
      const tokenAddress = resolveTokenOrAddress(token, 'ethereum');
      if (tokenAddress) {
        const tokenBalance = await account.getTokenBalance(tokenAddress);
        const tokenInfo = resolveToken(token, 'ethereum');
        const decimals = tokenInfo?.decimals ?? 18;
        const readable = fromBaseUnits(tokenBalance, decimals);

        // Convert required amount to base units for comparison
        // amountUsdt is in USD; for USDT/USDC 1:1, for ETH-priced tokens skip precise check
        const isStablecoin = ['USDT', 'USDC', 'DAI'].includes(token.toUpperCase());
        if (isStablecoin) {
          const requiredBase = BigInt(Math.floor(amountUsdt * 10 ** decimals));
          logReasoning({
            agent: 'Risk',
            action: 'balanceCheck',
            reasoning: `On-chain: ${readable} ${token} (need ~${amountUsdt}), ${ethReadable} ETH (gas)`,
            status: tokenBalance < requiredBase ? 'fail' : 'pass',
          });
          if (tokenBalance === 0n) return `Wallet has 0 ${token} — insufficient balance`;
          if (tokenBalance < requiredBase) {
            return `Insufficient ${token}: have ${readable}, need ~${amountUsdt}`;
          }
        } else {
          logReasoning({
            agent: 'Risk',
            action: 'balanceCheck',
            reasoning: `On-chain: ${readable} ${token}, ${ethReadable} ETH (gas)`,
            status: tokenBalance === 0n ? 'fail' : 'pass',
          });
          if (tokenBalance === 0n) return `Wallet has 0 ${token} — insufficient balance`;
        }
      }
    }

    return null;
  } catch {
    return null; // Non-blocking — don't fail on RPC errors
  }
}

async function getLimits(userId: string): Promise<AgentResponse> {
  const limits = await getUserLimits(userId);
  const dailyTotal = getDailyTotal(userId);

  logReasoning({
    agent: 'Risk',
    action: 'getLimits',
    reasoning: `Fetching risk limits for user ${userId}`,
    status: 'pass',
  });

  return {
    success: true,
    message: [
      '*Risk Limits:*',
      `Per-transaction: $${limits.maxTransactionUsdt}`,
      `Daily cap: $${limits.dailyLimitUsdt}`,
      `Daily used: $${dailyTotal}`,
      `Daily remaining: $${limits.dailyLimitUsdt - dailyTotal}`,
      `Max slippage: ${limits.maxSlippagePercent}%`,
      `Min health factor: ${config.risk.minHealthFactor}`,
      `Whitelisted contracts: ${CONTRACT_WHITELIST.size}`,
    ].join('\n'),
    data: {
      ...limits,
      dailyTotal,
      dailyRemaining: limits.dailyLimitUsdt - dailyTotal,
      minHealthFactor: config.risk.minHealthFactor,
      whitelistedContracts: CONTRACT_WHITELIST.size,
    },
  };
}

async function setLimits(
  params: Record<string, string>,
  userId: string,
): Promise<AgentResponse> {
  const current = await getUserLimits(userId);
  const updated = { ...current };

  if (params.maxTransactionUsdt) {
    updated.maxTransactionUsdt = parseFloat(params.maxTransactionUsdt);
  }
  if (params.dailyLimitUsdt) {
    updated.dailyLimitUsdt = parseFloat(params.dailyLimitUsdt);
  }
  if (params.maxSlippagePercent) {
    updated.maxSlippagePercent = parseFloat(params.maxSlippagePercent);
  }

  const db = getDb();
  db.prepare(`
    INSERT INTO risk_limits (user_id, max_transaction_usdt, daily_limit_usdt, max_slippage_percent)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET
      max_transaction_usdt = excluded.max_transaction_usdt,
      daily_limit_usdt = excluded.daily_limit_usdt,
      max_slippage_percent = excluded.max_slippage_percent
  `).run(userId, updated.maxTransactionUsdt, updated.dailyLimitUsdt, updated.maxSlippagePercent);

  logReasoning({
    agent: 'Risk',
    action: 'setLimits',
    reasoning: `Updated risk limits for user ${userId}`,
    result: JSON.stringify(updated),
    status: 'pass',
  });

  return {
    success: true,
    message: [
      '*Limits updated:*',
      `Per-transaction: $${updated.maxTransactionUsdt}`,
      `Daily cap: $${updated.dailyLimitUsdt}`,
      `Max slippage: ${updated.maxSlippagePercent}%`,
    ].join('\n'),
    data: updated,
  };
}

/** Expose on-chain NexusGuard parameters to the user */
async function getOnChainGuardParams(): Promise<AgentResponse> {
  const guard = await getGuardParams();
  const source = guard.source === 'on-chain'
    ? `🔗 *On-chain* (NexusGuard contract: \`${process.env.NEXUS_GUARD_ADDRESS?.slice(0, 10)}...\`)`
    : '⚙️ *Config fallback* (contract not deployed — set NEXUS_GUARD_ADDRESS to enable)';

  return {
    success: true,
    message: [
      '*NexusGuard Risk Parameters:*',
      source,
      `Per-transaction limit: $${guard.maxTransactionUsdt}`,
      `Daily spending cap: $${guard.dailyLimitUsdt}`,
      `Max slippage: ${guard.maxSlippagePercent}%`,
      `Cooldown: ${guard.cooldownSeconds}s`,
      guard.paused ? '🚨 *PAUSED — all transactions blocked*' : '✅ Operational',
    ].join('\n'),
    data: { ...guard },
  };
}

async function assessRisk(params: Record<string, string>): Promise<AgentResponse> {
  const context = params.context || 'general DeFi operation';

  logReasoning({
    agent: 'Risk',
    action: 'assessRisk',
    reasoning: `LLM risk assessment for: ${context}`,
    status: 'pass',
  });

  const commentary = await llmComplete(
    [
      {
        role: 'system',
        content:
          'You are a DeFi risk analyst. Assess the risk of the described operation in 2-3 sentences. Consider smart contract risk, market risk, slippage, and liquidity. Be specific and practical.',
      },
      {
        role: 'user',
        content: `Assess risk: ${context}`,
      },
    ],
    { model: 'routing' },
  );

  return {
    success: true,
    message: `*Risk Assessment:*\n${commentary}`,
    data: { context },
    reasoning: commentary,
  };
}
