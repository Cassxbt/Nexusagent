import { getDb } from './db.js';

export interface TreasuryPolicy {
  userId: string;
  reserveFloorUsdt: number;
  targetXautPercent: number;
  maxXautPercent: number;
  maxYieldPercent: number;
  minRebalanceUsdt: number;
  minYieldDeployUsdt: number;
  maxActionUsdt: number;
  rebalanceCooldownSeconds: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface TreasuryState {
  walletUsdt: number;
  walletXaut: number;
  xautUsdPrice: number;
  aaveCollateralUsd: number;
  aaveDebtUsd: number;
  healthFactor?: number;
}

export interface TreasurySignals {
  fearGreedValue: number | null;
  fearGreedClassification: string | null;
  gold24hChangePct: number | null;
}

export interface TreasuryActionPlan {
  type: 'rebalance_to_xaut' | 'rebalance_to_usdt' | 'deploy_to_aave' | 'withdraw_to_reserve' | 'hold';
  amountUsdt: number;
  reason: string;
  policy: string;
  summary: string;
}

interface TreasuryPolicyRow {
  user_id: string;
  reserve_floor_usdt: number;
  target_xaut_percent: number;
  max_xaut_percent: number;
  max_yield_percent: number;
  min_rebalance_usdt: number;
  min_yield_deploy_usdt: number;
  max_action_usdt: number;
  rebalance_cooldown_seconds: number;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface TreasuryPolicyPatch {
  reserveFloorUsdt?: number;
  targetXautPercent?: number;
  maxXautPercent?: number;
  maxYieldPercent?: number;
  minRebalanceUsdt?: number;
  minYieldDeployUsdt?: number;
  maxActionUsdt?: number;
  rebalanceCooldownSeconds?: number;
  enabled?: boolean;
}

function mapRow(row: TreasuryPolicyRow): TreasuryPolicy {
  return {
    userId: row.user_id,
    reserveFloorUsdt: row.reserve_floor_usdt,
    targetXautPercent: row.target_xaut_percent,
    maxXautPercent: row.max_xaut_percent,
    maxYieldPercent: row.max_yield_percent,
    minRebalanceUsdt: row.min_rebalance_usdt,
    minYieldDeployUsdt: row.min_yield_deploy_usdt,
    maxActionUsdt: row.max_action_usdt,
    rebalanceCooldownSeconds: row.rebalance_cooldown_seconds,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getOrCreateTreasuryPolicy(userId: string): TreasuryPolicy {
  const db = getDb();
  const existing = db.prepare(`
    SELECT user_id, reserve_floor_usdt, target_xaut_percent, max_xaut_percent, max_yield_percent,
           min_rebalance_usdt, min_yield_deploy_usdt, max_action_usdt, rebalance_cooldown_seconds,
           enabled, created_at, updated_at
    FROM treasury_policies
    WHERE user_id = ?
  `).get(userId) as TreasuryPolicyRow | undefined;

  if (existing) return mapRow(existing);

  db.prepare(`
    INSERT INTO treasury_policies (user_id)
    VALUES (?)
  `).run(userId);

  const created = db.prepare(`
    SELECT user_id, reserve_floor_usdt, target_xaut_percent, max_xaut_percent, max_yield_percent,
           min_rebalance_usdt, min_yield_deploy_usdt, max_action_usdt, rebalance_cooldown_seconds,
           enabled, created_at, updated_at
    FROM treasury_policies
    WHERE user_id = ?
  `).get(userId) as TreasuryPolicyRow;

  return mapRow(created);
}

export function updateTreasuryPolicy(userId: string, patch: TreasuryPolicyPatch): TreasuryPolicy {
  const current = getOrCreateTreasuryPolicy(userId);
  const next: TreasuryPolicy = {
    ...current,
    ...patch,
    targetXautPercent: patch.targetXautPercent ?? current.targetXautPercent,
    maxXautPercent: patch.maxXautPercent ?? current.maxXautPercent,
    maxYieldPercent: patch.maxYieldPercent ?? current.maxYieldPercent,
    enabled: patch.enabled ?? current.enabled,
    updatedAt: Math.floor(Date.now() / 1000),
  };

  if (next.reserveFloorUsdt < 0) throw new Error('Reserve floor must be non-negative');
  if (next.minRebalanceUsdt < 0) throw new Error('Minimum rebalance must be non-negative');
  if (next.minYieldDeployUsdt < 0) throw new Error('Minimum yield deploy must be non-negative');
  if (next.maxActionUsdt <= 0) throw new Error('Max action size must be greater than zero');
  if (next.rebalanceCooldownSeconds < 0) throw new Error('Cooldown must be non-negative');
  if (next.targetXautPercent < 0 || next.targetXautPercent > 1) throw new Error('XAUT target must be between 0 and 1');
  if (next.maxXautPercent < 0 || next.maxXautPercent > 1) throw new Error('XAUT max must be between 0 and 1');
  if (next.maxYieldPercent < 0 || next.maxYieldPercent > 1) throw new Error('Yield max must be between 0 and 1');
  if (next.targetXautPercent > next.maxXautPercent) throw new Error('XAUT target cannot exceed XAUT max');

  const db = getDb();
  db.prepare(`
    UPDATE treasury_policies
    SET reserve_floor_usdt = ?,
        target_xaut_percent = ?,
        max_xaut_percent = ?,
        max_yield_percent = ?,
        min_rebalance_usdt = ?,
        min_yield_deploy_usdt = ?,
        max_action_usdt = ?,
        rebalance_cooldown_seconds = ?,
        enabled = ?,
        updated_at = ?
    WHERE user_id = ?
  `).run(
    next.reserveFloorUsdt,
    next.targetXautPercent,
    next.maxXautPercent,
    next.maxYieldPercent,
    next.minRebalanceUsdt,
    next.minYieldDeployUsdt,
    next.maxActionUsdt,
    next.rebalanceCooldownSeconds,
    next.enabled ? 1 : 0,
    next.updatedAt,
    userId,
  );

  return getOrCreateTreasuryPolicy(userId);
}

export function evaluateTreasuryPolicy(
  policy: TreasuryPolicy,
  state: TreasuryState,
  signals: TreasurySignals,
): TreasuryActionPlan[] {
  if (!policy.enabled) {
    return [{
      type: 'hold',
      amountUsdt: 0,
      reason: 'Treasury policy is disabled for this user.',
      policy: 'policy_disabled',
      summary: 'Hold all positions because automation is disabled.',
    }];
  }

  const xautUsdValue = state.walletXaut * state.xautUsdPrice;
  const totalUsd = state.walletUsdt + xautUsdValue + state.aaveCollateralUsd;
  const xautPercent = totalUsd > 0 ? xautUsdValue / totalUsd : 0;
  const yieldPercent = totalUsd > 0 ? state.aaveCollateralUsd / totalUsd : 0;

  const fearGreed = signals.fearGreedValue ?? 50;

  // Risk-off: Fear & Greed ≤ 40 (fear/extreme fear on 0-100 scale) signals broad risk aversion —
  // historically correlates with flight to safe-haven assets like gold.
  // Gold 24h > 1.5% is an independent macro stress signal (USD weakness or geopolitical shock).
  // Either condition alone is sufficient to trigger defensive repositioning into XAUT.
  const riskOff = fearGreed <= 40 || (signals.gold24hChangePct ?? 0) > 1.5;

  // Risk-on: Fear & Greed ≥ 65 (greed territory) combined with flat gold (≤ 0.5%)
  // indicates risk appetite is returning and the defensive XAUT position can be trimmed.
  // Both conditions required together to avoid premature rebalancing on noise.
  const riskOn = fearGreed >= 65 && (signals.gold24hChangePct ?? 0) <= 0.5;

  const plans: TreasuryActionPlan[] = [];

  const reserveGap = Math.max(0, policy.reserveFloorUsdt - state.walletUsdt);
  if (reserveGap >= policy.minYieldDeployUsdt && state.aaveCollateralUsd >= policy.minYieldDeployUsdt) {
    const withdrawAmount = Math.min(reserveGap, state.aaveCollateralUsd, policy.maxActionUsdt);
    if (withdrawAmount >= policy.minYieldDeployUsdt) {
      plans.push({
        type: 'withdraw_to_reserve',
        amountUsdt: roundUsd(withdrawAmount),
        reason: `Wallet USDT reserve fell below the policy floor of $${policy.reserveFloorUsdt.toFixed(2)}.`,
        policy: 'reserve_floor_restore',
        summary: `Withdraw ${roundUsd(withdrawAmount).toFixed(2)} USDT from Aave to restore treasury reserve.`,
      });
      return plans;
    }
  }

  if (riskOff && state.walletUsdt > policy.reserveFloorUsdt + policy.minRebalanceUsdt && xautPercent < policy.targetXautPercent) {
    const desiredXautUsd = totalUsd * policy.targetXautPercent;
    const neededXautUsd = Math.max(0, desiredXautUsd - xautUsdValue);
    const availableUsdt = Math.max(0, state.walletUsdt - policy.reserveFloorUsdt);
    const rebalanceAmount = Math.min(neededXautUsd, availableUsdt, policy.maxActionUsdt);
    if (rebalanceAmount >= policy.minRebalanceUsdt) {
      plans.push({
        type: 'rebalance_to_xaut',
        amountUsdt: roundUsd(rebalanceAmount),
        reason: `Risk-off conditions detected (${describeRegime(signals)}), and XAUT is below the ${Math.round(policy.targetXautPercent * 100)}% target band.`,
        policy: 'xaut_defense_band',
        summary: `Swap ${roundUsd(rebalanceAmount).toFixed(2)} USDT into XAUT to strengthen the defensive treasury band.`,
      });
      return plans;
    }
  }

  if (riskOn && xautPercent > policy.maxXautPercent && xautUsdValue >= policy.minRebalanceUsdt) {
    const excessXautUsd = Math.max(0, xautUsdValue - (totalUsd * policy.maxXautPercent));
    const rebalanceAmount = Math.min(excessXautUsd, policy.maxActionUsdt);
    if (rebalanceAmount >= policy.minRebalanceUsdt) {
      plans.push({
        type: 'rebalance_to_usdt',
        amountUsdt: roundUsd(rebalanceAmount),
        reason: `Risk-on conditions detected (${describeRegime(signals)}), and XAUT is above the ${Math.round(policy.maxXautPercent * 100)}% ceiling.`,
        policy: 'xaut_trim_band',
        summary: `Swap approximately ${roundUsd(rebalanceAmount).toFixed(2)} USD worth of XAUT back into USDT.`,
      });
      return plans;
    }
  }

  if (!riskOff && state.walletUsdt > policy.reserveFloorUsdt + policy.minYieldDeployUsdt && yieldPercent < policy.maxYieldPercent) {
    const desiredYieldUsd = totalUsd * policy.maxYieldPercent;
    const capacity = Math.max(0, desiredYieldUsd - state.aaveCollateralUsd);
    const availableUsdt = Math.max(0, state.walletUsdt - policy.reserveFloorUsdt);
    const deployAmount = Math.min(capacity, availableUsdt, policy.maxActionUsdt);
    if (deployAmount >= policy.minYieldDeployUsdt) {
      plans.push({
        type: 'deploy_to_aave',
        amountUsdt: roundUsd(deployAmount),
        reason: `Idle USDT is above the reserve floor and market conditions are not risk-off (${describeRegime(signals)}).`,
        policy: 'yield_band_deploy',
        summary: `Supply ${roundUsd(deployAmount).toFixed(2)} USDT to Aave while keeping the policy reserve intact.`,
      });
      return plans;
    }
  }

  plans.push({
    type: 'hold',
    amountUsdt: 0,
    reason: `No treasury action is required under the current reserve, XAUT, and yield bands (${describeRegime(signals)}).`,
    policy: 'hold',
    summary: 'Hold treasury allocations steady.',
  });

  return plans;
}

function describeRegime(signals: TreasurySignals): string {
  const fearGreed = signals.fearGreedValue !== null
    ? `fear/greed ${signals.fearGreedValue}${signals.fearGreedClassification ? ` (${signals.fearGreedClassification})` : ''}`
    : 'fear/greed unavailable';
  const goldMove = signals.gold24hChangePct !== null
    ? `gold 24h ${signals.gold24hChangePct.toFixed(2)}%`
    : 'gold move unavailable';
  return `${fearGreed}, ${goldMove}`;
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}
