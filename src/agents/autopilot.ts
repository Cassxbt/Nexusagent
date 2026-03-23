import type AaveProtocolEvm from '@tetherto/wdk-protocol-lending-aave-evm';
import { getOperatorAccount } from '../core/wdk-setup.js';
import { resolveTokenAddress, fromBaseUnits } from '../core/tokens.js';
import { logReasoning, setActiveUser } from '../reasoning/logger.js';
import { pricing } from '../core/pricing.js';
import { emitEvent } from '../core/events.js';
import { evaluateRules } from '../core/rules.js';
import { getFearGreedSignal, getGoldSignal } from '../core/regime-signals.js';
import { listUserAccountContexts } from '../core/account-context.js';
import { evaluateTreasuryPolicy, getOrCreateTreasuryPolicy, type TreasurySignals, type TreasuryState } from '../core/treasury-policy.js';
import type { Bot } from 'grammy';
import { executeSystemDecision } from './coordinator.js';
import { getDb } from '../core/db.js';
import { markAutopilotCycleCompleted, markAutopilotCycleStarted } from '../core/heartbeat.js';

interface AutopilotConfig {
  intervalMs: number;
  healthFactorWarn: number;
  healthFactorCritical: number;
  apyDropThresholdPercent: number;
  balanceChangeThresholdPercent: number;
}

const DEFAULT_CONFIG: AutopilotConfig = {
  intervalMs: 5 * 60 * 1000, // 5 minutes
  healthFactorWarn: 1.5,
  healthFactorCritical: 1.2,
  apyDropThresholdPercent: 30,
  balanceChangeThresholdPercent: 10,
};

interface PortfolioSnapshot {
  ethBalance: bigint;
  usdtBalance: bigint;
  ethPrice: number;
  totalUsdValue: number;
  timestamp: number;
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let alertCallbacks: Array<(userId: string, message: string) => Promise<void>> = [];
let broadcastCallbacks: Array<(message: string) => void> = [];
let monitoredUsers: Set<string> = new Set();
let stateLoaded = false;
const baselineApyByUser = new Map<string, number | null>();
const lastSnapshotByUser = new Map<string, PortfolioSnapshot | null>();
const DEMO_USER_ID = process.env.NEXUS_DEMO_USER_ID || 'demo';

/** Register an additional alert channel (e.g. WebSocket broadcast) */
export function addAlertChannel(fn: (userId: string, message: string) => Promise<void>): void {
  alertCallbacks.push(fn);
}

/** Register a broadcast channel for web clients (no userId needed) */
export function addBroadcastChannel(fn: (message: string) => void): void {
  broadcastCallbacks.push(fn);
}

/** Start the autonomous monitoring loop. bot may be null when Telegram is not configured. */
export function startAutopilot(
  bot: Bot | null,
  userIds: string[],
  config: Partial<AutopilotConfig> = {},
): void {
  if (intervalHandle) return; // already running

  loadPersistedState();
  const cfg = { ...DEFAULT_CONFIG, ...config };
  monitoredUsers = new Set(userIds);

  if (bot) {
    const telegramAlert = async (userId: string, message: string) => {
      try {
        await bot.api.sendMessage(userId, message, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error(`Autopilot alert failed for ${userId}:`, err);
      }
    };
    alertCallbacks = [telegramAlert];
  } else {
    alertCallbacks = [];
  }

  console.log(`[Autopilot] Started — ${userIds.length} Telegram user(s), ${broadcastCallbacks.length} web channel(s), cycle: ${cfg.intervalMs / 1000}s`);

  // Run first check immediately
  runAutopilotCycle(cfg).catch(err => {
    console.error('[Autopilot] Initial cycle failed:', err);
  });

  intervalHandle = setInterval(() => {
    runAutopilotCycle(cfg).catch(err => {
      console.error('[Autopilot] Cycle failed:', err);
    });
  }, cfg.intervalMs);
}

export function stopAutopilot(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[Autopilot] Stopped');
  }
}

export function isAutopilotRunning(): boolean {
  return intervalHandle !== null;
}

function baselineKey(userId: string): string {
  return `autopilot:${userId}:baseline_apy`;
}

function snapshotKey(userId: string): string {
  return `autopilot:${userId}:last_snapshot`;
}

function loadPersistedState(): void {
  if (stateLoaded) return;

  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT key, value
      FROM autopilot_state
    `).all() as Array<{ key: string; value: string }>;

    for (const row of rows) {
      if (row.key.endsWith(':baseline_apy')) {
        const userId = row.key.slice('autopilot:'.length, -':baseline_apy'.length);
        const parsed = JSON.parse(row.value) as number | null;
        baselineApyByUser.set(userId, typeof parsed === 'number' ? parsed : null);
      }
      if (row.key.endsWith(':last_snapshot')) {
        const userId = row.key.slice('autopilot:'.length, -':last_snapshot'.length);
        lastSnapshotByUser.set(userId, JSON.parse(row.value) as PortfolioSnapshot);
      }
    }
  } catch {
    // Non-fatal — autopilot can rebuild state from fresh observations
  } finally {
    stateLoaded = true;
  }
}

function persistState(key: string, value: unknown): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO autopilot_state (key, value, updated_at)
      VALUES (?, ?, unixepoch())
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value));
  } catch {
    // Non-fatal — persistence should not block runtime decisions
  }
}

function getBaselineApy(userId: string): number | null {
  return baselineApyByUser.get(userId) ?? null;
}

function setBaselineApy(userId: string, value: number | null): void {
  baselineApyByUser.set(userId, value);
  persistState(baselineKey(userId), value);
}

function getLastSnapshot(userId: string): PortfolioSnapshot | null {
  return lastSnapshotByUser.get(userId) ?? null;
}

function setLastSnapshot(userId: string, snapshot: PortfolioSnapshot): void {
  lastSnapshotByUser.set(userId, snapshot);
  persistState(snapshotKey(userId), snapshot);
}

function getAutopilotUserIds(): string[] {
  const ids = new Set<string>([DEMO_USER_ID, ...monitoredUsers]);
  for (const ctx of listUserAccountContexts('ethereum')) {
    if (ctx.accountIndex === 0) continue;
    if (ctx.ownerAddress || monitoredUsers.has(ctx.userId) || ctx.userId === DEMO_USER_ID) {
      ids.add(ctx.userId);
    }
  }
  return Array.from(ids);
}

function isTreasuryActionOnCooldown(userId: string, cooldownSeconds: number): boolean {
  const db = getDb();
  const row = db.prepare(`
    SELECT created_at
    FROM tx_log
    WHERE user_id = ?
      AND agent IN ('swap', 'yield')
      AND status = 'success'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(userId) as { created_at: number } | undefined;

  if (!row) return false;
  return (Math.floor(Date.now() / 1000) - row.created_at) < cooldownSeconds;
}

async function runAutopilotCycle(cfg: AutopilotConfig): Promise<void> {
  loadPersistedState();
  setActiveUser('autopilot');

  const cycleStart = Date.now();
  const cycleId = `cycle-${cycleStart}`;
  markAutopilotCycleStarted(cycleStart);

  try {
    emitEvent({ type: 'cycle_start', cycleId });

    logReasoning({
      agent: 'Autopilot',
      action: 'cycle-start',
      reasoning: 'Running autonomous monitoring cycle',
      status: 'pass',
    });

    const alertsByUser = new Map<string, string[]>();
    const autopilotUsers = getAutopilotUserIds();

    for (const userId of autopilotUsers) {
      try {
        const alerts = await runUserAutopilotCycle(userId, cfg);
        if (alerts.length > 0) {
          alertsByUser.set(userId, alerts);
        }
      } catch (err) {
        console.error(`[Autopilot] User cycle failed for ${userId}:`, err);
      }
    }

    const totalAlerts = Array.from(alertsByUser.values()).reduce((sum, list) => sum + list.length, 0);
    const durationMs = Date.now() - cycleStart;
    emitEvent({ type: 'cycle_complete', alertCount: totalAlerts, durationMs });
    markAutopilotCycleCompleted({
      success: true,
      durationMs,
      alertCount: totalAlerts,
      completedAtMs: Date.now(),
    });

    // Send alerts to all monitored users and web clients
    if (alertsByUser.size > 0) {
      for (const [userId, alerts] of alertsByUser) {
        const message = `🤖 *Autopilot Alert*\n\n${alerts.join('\n\n')}`;

        logReasoning({
          agent: 'Autopilot',
          action: 'alert',
          reasoning: `Sending ${alerts.length} alert(s) for ${userId}`,
          result: alerts.join('; '),
          status: 'warn',
        });

        if (monitoredUsers.has(userId)) {
          for (const cb of alertCallbacks) {
            await cb(userId, message);
          }
        }

        for (const broadcast of broadcastCallbacks) {
          broadcast(userId === DEMO_USER_ID ? message : `${message}\n\n_User: ${userId}_`);
        }
      }
    } else {
      logReasoning({
        agent: 'Autopilot',
        action: 'cycle-complete',
        reasoning: 'No alerts — all systems normal',
        status: 'pass',
      });
    }
  } catch (err) {
    const durationMs = Date.now() - cycleStart;
    markAutopilotCycleCompleted({
      success: false,
      durationMs,
      alertCount: 0,
      completedAtMs: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function runUserAutopilotCycle(userId: string, cfg: AutopilotConfig): Promise<string[]> {
  setActiveUser(userId);
  const alerts: string[] = [];

  // Step 0: Perceive current state
  let cycleEthBal = 0;
  let cycleUsdtBal = 0;
  let cycleHealthFactor: number | undefined;
  try {
    const account = await getOperatorAccount();
    const ethRaw = await account.getBalance();
    const usdtAddr = resolveTokenAddress('USDT', 'ethereum');
    const usdtRaw = usdtAddr ? await account.getTokenBalance(usdtAddr) : 0n;
    cycleEthBal = parseFloat(fromBaseUnits(ethRaw, 18));
    cycleUsdtBal = parseFloat(fromBaseUnits(usdtRaw, 6));

    try {
      const lending = account.getLendingProtocol('aave') as unknown as InstanceType<typeof AaveProtocolEvm>;
      const aaveData = await lending.getAccountData();
      cycleHealthFactor = Number(aaveData.healthFactor) / 1e18;
    } catch {
      // No Aave position is acceptable
    }

    let ethPrice = getLastSnapshot(userId)?.ethPrice ?? 0;
    if (ethPrice === 0) {
      try {
        ethPrice = await pricing.getCurrentPrice('ETH', 'USD');
      } catch {
        // non-fatal
      }
    }
    const totalUsd = (cycleEthBal * ethPrice) + cycleUsdtBal;
    emitEvent({
      type: 'perceive',
      ethBalance: cycleEthBal.toFixed(6),
      usdtBalance: cycleUsdtBal.toFixed(2),
      ethPrice,
      totalUsd,
    });
  } catch {
    return alerts;
  }

  try {
    const healthAlert = await checkHealthFactor(userId, cfg, cycleUsdtBal);
    emitEvent({ type: 'evaluate', check: 'health-factor', result: healthAlert ? 'alert triggered' : 'healthy', status: healthAlert ? 'warn' : 'pass' });
    if (healthAlert) alerts.push(healthAlert);
  } catch (err) {
    emitEvent({ type: 'evaluate', check: 'health-factor', result: 'check failed', status: 'fail' });
    console.error(`[Autopilot] Health factor check failed for ${userId}:`, err);
  }

  try {
    const balanceAlert = await checkBalanceDrift(userId, cfg);
    emitEvent({ type: 'evaluate', check: 'balance-drift', result: balanceAlert ? 'drift detected' : 'stable', status: balanceAlert ? 'warn' : 'pass' });
    if (balanceAlert) alerts.push(balanceAlert);
  } catch (err) {
    emitEvent({ type: 'evaluate', check: 'balance-drift', result: 'check failed', status: 'fail' });
    console.error(`[Autopilot] Balance drift check failed for ${userId}:`, err);
  }

  try {
    const gasAlert = await checkGasConditions(userId);
    emitEvent({ type: 'evaluate', check: 'gas', result: gasAlert ? 'low gas' : 'sufficient', status: gasAlert ? 'warn' : 'pass' });
    if (gasAlert) alerts.push(gasAlert);
  } catch (err) {
    emitEvent({ type: 'evaluate', check: 'gas', result: 'check failed', status: 'fail' });
    console.error(`[Autopilot] Gas check failed for ${userId}:`, err);
  }

  try {
    const apyAlert = await checkApyDrop(userId, cfg);
    const baselineApy = getBaselineApy(userId);
    emitEvent({ type: 'evaluate', check: 'apy-drift', result: apyAlert ? 'APY drop detected' : (baselineApy !== null ? `${baselineApy.toFixed(2)}% — stable` : 'fetching baseline'), status: apyAlert ? 'warn' : 'pass' });
    if (apyAlert) alerts.push(apyAlert);
  } catch (err) {
    emitEvent({ type: 'evaluate', check: 'apy-drift', result: 'check failed', status: 'fail' });
    console.error(`[Autopilot] APY check failed for ${userId}:`, err);
  }

  try {
    const treasuryAlerts = await applyTreasuryPolicy(userId);
    alerts.push(...treasuryAlerts);
  } catch (err) {
    console.error(`[Autopilot] Treasury policy check failed for ${userId}:`, err);
  }

  try {
    const ruleAlerts = await evaluateRules(userId, {
      apy: getBaselineApy(userId) ?? undefined,
      healthFactor: cycleHealthFactor,
      ethBalance: cycleEthBal,
      usdtBalance: cycleUsdtBal,
      ethPrice: getLastSnapshot(userId)?.ethPrice,
    });
    alerts.push(...ruleAlerts);
  } catch (err) {
    console.error(`[Autopilot] Rules evaluation failed for ${userId}:`, err);
  }

  await takeSnapshot(userId);
  return alerts;
}

async function checkHealthFactor(userId: string, cfg: AutopilotConfig, walletUsdtBal: number): Promise<string | null> {
  try {
    const account = await getOperatorAccount();
    const lending = account.getLendingProtocol('aave') as unknown as InstanceType<typeof AaveProtocolEvm>;
    const data = await lending.getAccountData();

    const healthFactor = Number(data.healthFactor) / 1e18;

    logReasoning({
      agent: 'Autopilot',
      action: 'health-check',
      reasoning: `Aave health factor: ${healthFactor.toFixed(2)}`,
      status: healthFactor < cfg.healthFactorCritical ? 'fail' : healthFactor < cfg.healthFactorWarn ? 'warn' : 'pass',
    });

    if (healthFactor < cfg.healthFactorCritical && healthFactor > 0) {
      emitEvent({ type: 'health_alert', healthFactor, tier: 'critical' });

      // A health factor < 1.2 always implies debt exists.
      // Repaying debt directly improves HF; withdrawing collateral would worsen it.
      // Formula: repay = debt × (1 − currentHF / targetHF)
      const debtUsd = Number(data.totalDebtBase) / 1e8;
      const policy = getOrCreateTreasuryPolicy(userId);
      const repayAmount = Math.max(10, Math.min(
        debtUsd * (1 - healthFactor / cfg.healthFactorWarn),
        policy.maxActionUsdt,
        walletUsdtBal,  // never try to repay more than the wallet holds
      ));

      logReasoning({
        agent: 'Autopilot',
        action: 'health-protection',
        reasoning: `Health factor ${healthFactor.toFixed(2)} below critical ${cfg.healthFactorCritical} — repaying $${repayAmount.toFixed(2)} USDT debt to restore HF`,
        status: 'warn',
      });

      let txResult = '';
      try {
        const response = await executeSystemDecision({
          agent: 'yield',
          intent: 'repay',
          params: { amount: repayAmount.toFixed(2), token: 'USDT', chain: 'ethereum', rateMode: '2' },
          receiptContext: {
            source: 'autopilot',
            policy: 'health_factor_protection',
            reason: `Health factor ${healthFactor.toFixed(2)} fell below critical threshold ${cfg.healthFactorCritical}.`,
            summary: `Autonomous USDT debt repayment of $${repayAmount.toFixed(2)} to restore health factor.`,
          },
        }, userId, 'autopilot');
        txResult = response.success
          ? `Debt repayment executed: ${response.message}`
          : `Debt repayment failed: ${response.message}`;

        logReasoning({
          agent: 'Autopilot',
          action: 'health-protection',
          reasoning: txResult,
          status: response.success ? 'pass' : 'fail',
        });
      } catch (err) {
        txResult = `Health protection error: ${err instanceof Error ? err.message : String(err)}`;
        logReasoning({
          agent: 'Autopilot',
          action: 'health-protection',
          reasoning: txResult,
          status: 'fail',
        });
      }

      return `🚨 *CRITICAL: Aave health factor at ${healthFactor.toFixed(2)}*\nLiquidation risk detected — autonomous protective action taken.\n${txResult}`;
    }

    if (healthFactor < cfg.healthFactorWarn && healthFactor > 0) {
      emitEvent({ type: 'health_alert', healthFactor, tier: 'warn' });
      return `⚠️ *Aave health factor dropped to ${healthFactor.toFixed(2)}*\nApproaching danger zone (liquidation at 1.0).\n_Consider reducing your position or adding collateral._`;
    }

    return null;
  } catch (err) {
    console.warn('[Autopilot] Health factor check failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function checkBalanceDrift(userId: string, cfg: AutopilotConfig): Promise<string | null> {
  const lastSnapshot = getLastSnapshot(userId);
  if (!lastSnapshot) return null;

  try {
    const account = await getOperatorAccount();
    const ethBalance = await account.getBalance();

    const usdtAddr = resolveTokenAddress('USDT', 'ethereum');
    const usdtBalance = usdtAddr ? await account.getTokenBalance(usdtAddr) : 0n;

    const ethDelta = ethBalance - lastSnapshot.ethBalance;
    const usdtDelta = usdtBalance - lastSnapshot.usdtBalance;

    const ethReadable = fromBaseUnits(ethBalance, 18);
    const usdtReadable = fromBaseUnits(usdtBalance, 6);

    // Significant ETH change (for gas monitoring)
    if (lastSnapshot.ethBalance > 0n) {
      const ethChangePercent = Math.abs(Number(ethDelta) / Number(lastSnapshot.ethBalance)) * 100;
      if (ethChangePercent > cfg.balanceChangeThresholdPercent) {
        const direction = ethDelta > 0n ? 'increased' : 'decreased';
        return `📊 *ETH balance ${direction} by ${ethChangePercent.toFixed(1)}%*\nCurrent: ${ethReadable} ETH`;
      }
    }

    // Significant USDT change
    if (lastSnapshot.usdtBalance > 0n) {
      const usdtChangePercent = Math.abs(Number(usdtDelta) / Number(lastSnapshot.usdtBalance)) * 100;
      if (usdtChangePercent > cfg.balanceChangeThresholdPercent) {
        const direction = usdtDelta > 0n ? 'increased' : 'decreased';
        return `📊 *USDT balance ${direction} by ${usdtChangePercent.toFixed(1)}%*\nCurrent: ${usdtReadable} USDT`;
      }
    }

    // Low ETH warning (gas)
    if (ethBalance < BigInt(1e15)) { // < 0.001 ETH
      return `⛽ *Low ETH for gas: ${ethReadable} ETH*\nYou may not be able to execute transactions. Top up your wallet.`;
    }

    return null;
  } catch {
    return null;
  }
}

async function checkGasConditions(userId: string): Promise<string | null> {
  try {
    const account = await getOperatorAccount();
    const ethBalance = await account.getBalance();
    const ethReadable = fromBaseUnits(ethBalance, 18);
    const ethAmt = parseFloat(ethReadable);

    if (ethAmt < 0.001) {
      logReasoning({
        agent: 'Autopilot',
        action: 'gas-check',
        reasoning: `Critical: ${ethReadable} ETH — insufficient for gas`,
        status: 'fail',
      });
      return `⛽ *Low ETH for gas: ${ethReadable} ETH*\nTransactions will fail without gas. Top up your wallet on Arbitrum.`;
    }

    if (ethAmt < 0.005) {
      logReasoning({
        agent: 'Autopilot',
        action: 'gas-check',
        reasoning: `Low gas: ${ethReadable} ETH`,
        status: 'warn',
      });
      return `⛽ *Low ETH balance: ${ethReadable} ETH*\nConsider topping up to ensure uninterrupted operations.`;
    }

    logReasoning({
      agent: 'Autopilot',
      action: 'gas-check',
      reasoning: `ETH gas balance OK: ${ethReadable} ETH`,
      status: 'pass',
    });
    return null;
  } catch {
    return null;
  }
}

async function checkApyDrop(userId: string, cfg: AutopilotConfig): Promise<string | null> {
  try {
    const res = await fetch('https://api.llama.fi/pools', {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;

    const { data } = await res.json() as {
      data: Array<{ project: string; chain: string; symbol: string; apy: number }>;
    };

    const pool = data.find(
      p => (p.project === 'aave-v3' || p.project === 'aave') && p.chain === 'Arbitrum' && p.symbol.toUpperCase().includes('USDT'),
    );
    if (!pool || typeof pool.apy !== 'number') {
      console.warn('[Autopilot] Aave USDT pool not found on Llama.fi — APY monitoring skipped this cycle');
      return null;
    }

    const currentApy = pool.apy;

    logReasoning({
      agent: 'Autopilot',
      action: 'apy-check',
      reasoning: `Aave V3 USDT APY on Arbitrum: ${currentApy.toFixed(2)}%`,
      status: 'pass',
    });

    const baselineApy = getBaselineApy(userId);
    if (baselineApy === null) {
      setBaselineApy(userId, currentApy);
      return null;
    }

    if (baselineApy > 0) {
      const dropPercent = ((baselineApy - currentApy) / baselineApy) * 100;

      if (dropPercent > cfg.apyDropThresholdPercent) {
        emitEvent({ type: 'apy_alert', current: currentApy, baseline: baselineApy, dropPct: dropPercent });
        logReasoning({
          agent: 'Autopilot',
          action: 'apy-alert',
          reasoning: `APY dropped ${dropPercent.toFixed(1)}% — from ${baselineApy.toFixed(2)}% to ${currentApy.toFixed(2)}%`,
          status: 'warn',
        });

        const oldBaseline = baselineApy;
        setBaselineApy(userId, currentApy);
        return `📉 *Aave USDT yield dropped ${dropPercent.toFixed(1)}%*\nBaseline: ${oldBaseline.toFixed(2)}% → Now: ${currentApy.toFixed(2)}%\n_Consider reallocating to a higher-yield protocol._`;
      }
    }

    // Update baseline on normal cycles
    setBaselineApy(userId, currentApy);
    return null;
  } catch (err) {
    console.warn('[Autopilot] APY check failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function applyTreasuryPolicy(userId: string): Promise<string[]> {
  const usdtAddr = resolveTokenAddress('USDT', 'ethereum');
  const xautAddr = resolveTokenAddress('XAUT', 'ethereum');
  if (!usdtAddr || !xautAddr) return [];

  const account = await getOperatorAccount();
  const usdtBalance = await account.getTokenBalance(usdtAddr);
  const xautBalance = await account.getTokenBalance(xautAddr);
  const usdtAmount = parseFloat(fromBaseUnits(usdtBalance, 6));
  const xautAmount = parseFloat(fromBaseUnits(xautBalance, 6));
  const baselineApy = getBaselineApy(userId);

  const [fearGreed, goldSignal, aaveAccountData] = await Promise.all([
    getFearGreedSignal(),
    getGoldSignal(),
    (async () => {
      try {
        const lending = account.getLendingProtocol('aave') as unknown as InstanceType<typeof AaveProtocolEvm>;
        return await lending.getAccountData();
      } catch {
        return null;
      }
    })(),
  ]);

  const signals: TreasurySignals = {
    fearGreedValue: fearGreed.value,
    fearGreedClassification: fearGreed.classification,
    gold24hChangePct: goldSignal.change24hPct,
  };
  const state: TreasuryState = {
    walletUsdt: usdtAmount,
    walletXaut: xautAmount,
    xautUsdPrice: goldSignal.xautUsd ?? goldSignal.spotUsd ?? 0,
    aaveCollateralUsd: aaveAccountData ? Number(aaveAccountData.totalCollateralBase) / 1e8 : 0,
    aaveDebtUsd: aaveAccountData ? Number(aaveAccountData.totalDebtBase) / 1e8 : 0,
    healthFactor: aaveAccountData ? Number(aaveAccountData.healthFactor) / 1e18 : undefined,
  };
  const policy = getOrCreateTreasuryPolicy(userId);
  const plans = evaluateTreasuryPolicy(policy, state, signals);
  const alerts: string[] = [];

  if (isTreasuryActionOnCooldown(userId, policy.rebalanceCooldownSeconds)) {
    logReasoning({
      agent: 'Autopilot',
      action: 'treasury-policy',
      reasoning: `Treasury actions on cooldown for ${userId}`,
      result: `Cooldown: ${policy.rebalanceCooldownSeconds}s`,
      status: 'warn',
    });
    return alerts;
  }

  for (const plan of plans) {
    if (plan.type === 'hold') {
      logReasoning({
        agent: 'Autopilot',
        action: 'treasury-policy',
        reasoning: plan.reason,
        result: plan.summary,
        status: 'pass',
      });
      continue;
    }

    const receiptContext = {
      source: 'autopilot',
      policy: plan.policy,
      reason: plan.reason,
      summary: plan.summary,
      beforeState: state,
      signals,
    };

    let response;
    if (plan.type === 'deploy_to_aave') {
      if (baselineApy === null || baselineApy < 1) continue;
      response = await executeSystemDecision({
        agent: 'yield',
        intent: 'supply',
        params: { amount: plan.amountUsdt.toFixed(2), token: 'USDT', chain: 'ethereum' },
        receiptContext,
      }, userId, 'autopilot');
    } else if (plan.type === 'withdraw_to_reserve') {
      response = await executeSystemDecision({
        agent: 'yield',
        intent: 'withdraw',
        params: { amount: plan.amountUsdt.toFixed(2), token: 'USDT', chain: 'ethereum' },
        receiptContext,
      }, userId, 'autopilot');
    } else if (plan.type === 'rebalance_to_xaut') {
      response = await executeSystemDecision({
        agent: 'swap',
        intent: 'execute_swap',
        params: {
          amount: plan.amountUsdt.toFixed(2),
          amountUsdt: plan.amountUsdt.toFixed(2),
          tokenIn: 'USDT',
          tokenOut: 'XAUT',
          chain: 'ethereum',
        },
        receiptContext,
      }, userId, 'autopilot');
    } else {
      const xautUsd = state.walletXaut * state.xautUsdPrice;
      const xautSellAmount = state.xautUsdPrice > 0
        ? Math.min(state.walletXaut, plan.amountUsdt / state.xautUsdPrice)
        : 0;
      if (xautSellAmount <= 0 || xautUsd <= 0) continue;
      response = await executeSystemDecision({
        agent: 'swap',
        intent: 'execute_swap',
        params: {
          amount: xautSellAmount.toFixed(6),
          amountUsdt: plan.amountUsdt.toFixed(2),
          tokenIn: 'XAUT',
          tokenOut: 'USDT',
          chain: 'ethereum',
        },
        receiptContext,
      }, userId, 'autopilot');
    }

    if (response.success) {
      const txHash = (response.data as Record<string, unknown>)?.hash as string | undefined;
      emitEvent({
        type: 'act',
        action: plan.type,
        txHash,
        success: true,
        message: plan.summary,
      });
      alerts.push(`📌 *Treasury Policy Action*\n_${plan.reason}_\n\n${response.message}`);
    }
  }

  return alerts;
}

async function takeSnapshot(userId: string): Promise<void> {
  try {
    const account = await getOperatorAccount();
    const ethBalance = await account.getBalance();
    const usdtAddr = resolveTokenAddress('USDT', 'ethereum');
    const usdtBalance = usdtAddr ? await account.getTokenBalance(usdtAddr) : 0n;

    let ethPrice = 0;
    try {
      ethPrice = await pricing.getCurrentPrice('ETH', 'USD');
    } catch {
      // Price may fail
    }

    const ethUsd = parseFloat(fromBaseUnits(ethBalance, 18)) * ethPrice;
    const usdtUsd = parseFloat(fromBaseUnits(usdtBalance, 6));
    const totalUsdValue = ethUsd + usdtUsd;

    const snapshot = {
      ethBalance,
      usdtBalance,
      ethPrice,
      totalUsdValue,
      timestamp: Date.now(),
    };
    setLastSnapshot(userId, snapshot);
  } catch {
    // Snapshot may fail on first run before WDK is ready
  }
}

/**
 * Run a named demo scenario — forces specific conditions to demonstrate
 * agent capabilities without waiting for real market events.
 *
 * Available scenarios:
 * - guard_block: submit an oversized transaction to prove NexusGuard rejects it
 * - force_cycle: trigger an immediate autopilot cycle
 * - inject_apy_drop: simulate a 75% APY drop to show the alert path
 */
export async function runDemoScenario(scenario: string): Promise<{ success: boolean; message: string }> {
  loadPersistedState();
  switch (scenario) {
    case 'guard_block': {
      const { riskAgent } = await import('./risk.js');
      const result = await riskAgent.execute({
        intent: 'check_transaction',
        params: {
          amountUsdt: '99999',
          type: 'transfer',
          token: 'USDT',
          slippage: '0',
          tokenIn: '',
          tokenOut: '',
          contractAddress: '',
        },
        userId: DEMO_USER_ID,
      });
      emitEvent({
        type: 'guard_block',
        reason: result.message,
        riskScore: result.riskScore ?? 10,
        amount: '99999',
      });
      return { success: true, message: `NexusGuard Demo:\n${result.message}` };
    }

    case 'force_cycle': {
      await runAutopilotCycle(DEFAULT_CONFIG);
      return { success: true, message: 'Autopilot cycle triggered — watch /api/stream for live reasoning' };
    }

    case 'inject_apy_drop': {
      const savedBaseline = getBaselineApy(DEMO_USER_ID);
      // Set baseline 4× current so the check sees a 75% drop
      setBaselineApy(DEMO_USER_ID, (savedBaseline ?? 4) * 4);
      const alert = await checkApyDrop(DEMO_USER_ID, DEFAULT_CONFIG);
      // Restore — if the check overwrote baselineApy, restore saved value
      if (savedBaseline !== null) {
        setBaselineApy(DEMO_USER_ID, savedBaseline);
      }
      return {
        success: true,
        message: alert ?? 'APY drop scenario complete — no threshold crossed (APY may not be fetchable)',
      };
    }

    default:
      return {
        success: false,
        message: `Unknown scenario "${scenario}". Available: guard_block, force_cycle, inject_apy_drop`,
      };
  }
}

/** Returns portfolio delta string for use in responses — e.g. "+2.3% since last check" */
export function getPortfolioDelta(currentUsdValue: number, userId: string = DEMO_USER_ID): string | null {
  const lastSnapshot = getLastSnapshot(userId);
  if (!lastSnapshot || lastSnapshot.totalUsdValue === 0 || currentUsdValue === 0) return null;
  const delta = ((currentUsdValue - lastSnapshot.totalUsdValue) / lastSnapshot.totalUsdValue) * 100;
  const sign = delta >= 0 ? '+' : '';
  const ageMinutes = Math.round((Date.now() - lastSnapshot.timestamp) / 60000);
  const age = ageMinutes < 60 ? `${ageMinutes}m` : `${Math.round(ageMinutes / 60)}h`;
  return `${sign}${delta.toFixed(1)}% since last check (${age} ago)`;
}
