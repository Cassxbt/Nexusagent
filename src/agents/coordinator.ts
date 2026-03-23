import { llmJson, llmComplete } from '../reasoning/llm.js';
import { logReasoning, setActiveUser } from '../reasoning/logger.js';
import { getContextSummary } from '../reasoning/memory.js';
import { getDb } from '../core/db.js';
import { marketAgent } from './market.js';
import { riskAgent } from './risk.js';
import { swapAgent } from './swap.js';
import { treasuryAgent } from './treasury.js';
import { yieldAgent } from './yield.js';
import { bridgeAgent } from './bridge.js';
import type { Agent, AgentRequest, AgentResponse, RouteDecision, AgentName } from './types.js';
import { pricing } from '../core/pricing.js';

const agents: Record<string, Agent> = {
  treasury: treasuryAgent,
  market: marketAgent,
  swap: swapAgent,
  yield: yieldAgent,
  risk: riskAgent,
  bridge: bridgeAgent,
};

export function registerAgent(agent: Agent): void {
  agents[agent.name] = agent;
}

const RISK_GATED_INTENTS: Record<string, string[]> = {
  treasury: ['transfer'],
  swap: ['execute_swap'],
  yield: ['supply', 'withdraw', 'borrow', 'repay'],
  bridge: ['execute_bridge'],
};

const ROUTING_PROMPT = `You are Nexus, an autonomous treasury coordinator on Arbitrum. Analyze the user message and decide which specialist agent should handle it.

Available agents:
- treasury: wallet operations (balance, address, transfers, fees)
- market: price data, portfolio analysis, portfolio risk review, market conditions
- swap: token swaps via Velora DEX
- yield: Aave V3 lending (supply, withdraw, borrow, repay)
- risk: transaction validation, spending limits, exposure checks
- bridge: cross-chain USDT bridging via USDT0 protocol

Respond with JSON:
{
  "agent": "<agent_name>",
  "intent": "<specific_action>",
  "params": { "<key>": "<value>" },
  "plan": ["step1", "step2"]
}

Intent values per agent:
- treasury: get_balance, get_address, get_token_balance, transfer, estimate_fee
- market: get_price, get_history, portfolio_summary, assess_portfolio, market_conditions, get_premium_intel
- swap: quote_swap, execute_swap
- yield: quote_supply, supply, quote_withdraw, withdraw, account_data, quote_borrow, borrow, quote_repay, repay
- risk: check_transaction, get_limits, set_limits, assess_risk, get_guard_params
- bridge: quote_bridge, execute_bridge

Extract parameters from the message. For chain, default to "ethereum".
For tokens, use symbols like "USDT", "ETH", "XAUT".

For multi-step operations, use the "plan" field to describe the sequence. Examples:
- "swap ETH for USDT then supply to Aave" -> plan: ["swap ETH to USDT", "supply USDT to Aave"]
- "check my balance and show prices" -> plan: ["get balance", "get ETH price"]

If the request needs multiple agents, set agent to the FIRST one needed and include a plan.

If you cannot understand the request or it is not related to DeFi/wallet operations, respond with:
{"agent": "coordinator", "intent": "unknown", "params": {"message": "original message"}}`;

function extractChain(message: string): string | undefined {
  const lower = message.toLowerCase();
  if (lower.includes('arbitrum')) return 'ethereum';
  if (lower.includes('ethereum') || lower.includes('mainnet')) return 'ethereum';
  return undefined;
}

function extractSwapParams(message: string): Record<string, string> {
  const match = message.match(/\b(?:swap|trade|exchange)\s+(\d+(?:\.\d+)?)\s+([a-z0-9]+)\s+(?:to|for|into)\s+([a-z0-9]+)/i);
  if (!match) return {};
  return {
    amount: match[1],
    tokenIn: match[2].toUpperCase(),
    tokenOut: match[3].toUpperCase(),
  };
}

function extractYieldParams(message: string): Record<string, string> {
  const match = message.match(/\b(?:supply|lend|deposit|withdraw|borrow|repay)\s+(\d+(?:\.\d+)?)\s+([a-z0-9]+)/i);
  if (!match) return {};
  return {
    amount: match[1],
    token: match[2].toUpperCase(),
  };
}

function extractTransferParams(message: string): Record<string, string> {
  const match = message.match(/\b(?:send|transfer)\s+(\d+(?:\.\d+)?)\s+([a-z0-9]+)?\s*(?:to)\s+(0x[a-fA-F0-9]{40})/i);
  if (!match) return {};
  const params: Record<string, string> = {
    amount: match[1],
    to: match[3],
  };
  if (match[2]) params.token = match[2].toUpperCase();
  return params;
}

function extractBridgeParams(message: string): Record<string, string> {
  const match = message.match(/\bbridge\s+(\d+(?:\.\d+)?)\s+([a-z0-9]+)/i);
  if (!match) return {};
  return {
    amount: match[1],
    token: match[2].toUpperCase(),
  };
}

function fillMissingParams(
  existing: Record<string, string>,
  extracted: Record<string, string>,
): Record<string, string> {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(extracted)) {
    if (!merged[key] && value) merged[key] = value;
  }
  return merged;
}

function shouldKeepPlan(message: string, decision: RouteDecision): boolean {
  if (!decision.plan?.length) return false;
  return /\b(then|after that|afterwards|and then)\b/i.test(message)
    || /\band\s+(?:supply|deposit|lend|withdraw|borrow|repay|bridge|send|transfer|swap|trade|exchange|check|show|get)\b/i.test(message);
}

export function normalizeDecisionFromMessage(
  message: string,
  decision: RouteDecision,
): RouteDecision {
  const normalized: RouteDecision = {
    ...decision,
    params: { ...(decision.params || {}) },
  };

  if (!normalized.params.chain) {
    const chain = extractChain(message);
    if (chain) normalized.params.chain = chain;
  }

  switch (normalized.agent) {
    case 'swap':
      normalized.params = fillMissingParams(normalized.params, extractSwapParams(message));
      break;
    case 'yield':
      normalized.params = fillMissingParams(normalized.params, extractYieldParams(message));
      break;
    case 'treasury':
      if (normalized.intent === 'transfer') {
        normalized.params = fillMissingParams(normalized.params, extractTransferParams(message));
      }
      break;
    case 'bridge':
      normalized.params = fillMissingParams(normalized.params, extractBridgeParams(message));
      break;
    default:
      break;
  }

  if (!shouldKeepPlan(message, normalized)) {
    normalized.plan = undefined;
  }

  return normalized;
}

/** Route only — returns the decision without executing */
export async function analyzeMessage(
  userMessage: string,
  userId: string,
): Promise<RouteDecision> {
  setActiveUser(userId);

  logReasoning({
    agent: 'Coordinator',
    action: 'routing',
    reasoning: `Analyzing: "${userMessage}"`,
    status: 'pass',
  });

  const context = getContextSummary(userId);
  const userContent = context
    ? `Previous conversation:\n${context}\n\nNew message: ${userMessage}`
    : userMessage;

  let decision: RouteDecision;
  try {
    decision = await llmJson<RouteDecision>([
      { role: 'system', content: ROUTING_PROMPT },
      { role: 'user', content: userContent },
    ]);
  } catch {
    decision = fallbackRouting(userMessage);
  }
  decision = normalizeDecisionFromMessage(userMessage, decision);

  // Handle unknown intent
  if (decision.agent === ('coordinator' as AgentName) && decision.intent === 'unknown') {
    logReasoning({
      agent: 'Coordinator',
      action: 'unrecognized',
      reasoning: `Could not route: "${userMessage}"`,
      status: 'warn',
    });
    return decision;
  }

  logReasoning({
    agent: 'Coordinator',
    action: 'routed',
    reasoning: `→ ${decision.agent}.${decision.intent}`,
    result: decision.plan?.length ? `Plan: ${decision.plan.join(' → ')}` : undefined,
    status: 'pass',
  });

  return decision;
}

/** Check if a decision requires user confirmation (risk-gated operations) */
export function needsConfirmation(decision: RouteDecision): boolean {
  const gatedIntents = RISK_GATED_INTENTS[decision.agent];
  return gatedIntents?.includes(decision.intent) ?? false;
}

/** Format a decision into a human-readable confirmation prompt with risk score */
export function formatConfirmation(decision: RouteDecision, riskScore?: number, riskTier?: string, factors?: string[], estimatedFee?: string): string {
  const agent = decision.agent.charAt(0).toUpperCase() + decision.agent.slice(1);
  const lines = [`*${agent} Agent* wants to execute: \`${decision.intent}\``];

  if (riskScore != null && riskTier) {
    const icon = riskTier === 'APPROVE' ? '✅' : riskTier === 'REVIEW' ? '⚠️' : '🚫';
    lines.push(`${icon} Risk Score: *${riskScore}/10* (${riskTier})`);
    if (factors && factors.length > 0) {
      lines.push(...factors.map(f => `  › ${f}`));
    }
  }

  if (decision.params.amount) lines.push(`Amount: ${decision.params.amount}`);
  if (decision.params.token || decision.params.tokenIn) {
    const token = decision.params.token || decision.params.tokenIn;
    lines.push(`Token: ${token}`);
  }
  if (decision.params.tokenOut) lines.push(`To: ${decision.params.tokenOut}`);
  if (decision.params.to) lines.push(`Recipient: \`${decision.params.to}\``);
  if (estimatedFee) lines.push(`💰 Est. fee: ${estimatedFee}`);

  if (decision.plan && decision.plan.length > 1) {
    lines.push(`\nPlan: ${decision.plan.join(' → ')}`);
  }

  lines.push('\nReply *YES* to confirm or anything else to cancel.');
  return lines.join('\n');
}

/** Execute a decision (with risk gate + permission check) */
export async function executeDecision(
  decision: RouteDecision,
  userId: string,
): Promise<AgentResponse> {
  setActiveUser(userId);

  // Handle unknown intent — use LLM for conversational response
  if (decision.agent === ('coordinator' as AgentName) && decision.intent === 'unknown') {
    const originalMessage = decision.params.message as string | undefined;
    const context = getContextSummary(userId);
    const systemPrompt = `You are Nexus, an autonomous DeFi treasury agent on Arbitrum. You help users manage crypto portfolios, execute trades, interact with Aave lending, bridge USDT cross-chain, and monitor risk.

Capabilities:
- Wallet: check balances, get wallet address, send ETH/tokens, estimate fees
- Market: token prices (ETH, USDT, XAUT, etc.), portfolio summary, market conditions
- Swaps: token swaps via Velora DEX (e.g. "swap 10 USDT for ETH")
- Lending: Aave V3 supply, withdraw, borrow, repay, check health factor
- Risk: transaction risk scoring, spending limits, NexusGuard parameters
- Bridge: cross-chain USDT bridging via USDT0

Answer the user's question helpfully and concisely. If they ask what you can do, explain your capabilities naturally. Keep responses under 200 words.`;

    const userContent = context
      ? `Previous conversation:\n${context}\n\nUser: ${originalMessage ?? ''}`
      : (originalMessage ?? '');

    try {
      const reply = await llmComplete([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ]);
      return { success: true, message: reply };
    } catch {
      return {
        success: true,
        message: "I can help with wallet balances, token prices, swaps via Velora DEX, Aave lending, and cross-chain USDT bridging. Try: \"What's my ETH balance?\" or \"Swap 10 USDT for ETH\"",
      };
    }
  }

  // Permission manifest check
  const agent = agents[decision.agent];
  if (agent?.permissions?.allowedIntents) {
    if (!agent.permissions.allowedIntents.includes(decision.intent)) {
      logReasoning({
        agent: 'Coordinator',
        action: 'permission-denied',
        reasoning: `${decision.agent} does not permit intent "${decision.intent}"`,
        status: 'fail',
      });
      return {
        success: false,
        message: `Agent "${decision.agent}" does not support "${decision.intent}"`,
      };
    }
  }

  // Token allowlist check
  if (agent?.permissions?.allowedTokens) {
    const requestedToken = (decision.params.token || decision.params.tokenIn || '').toUpperCase();
    if (requestedToken && !agent.permissions.allowedTokens.includes(requestedToken)) {
      logReasoning({
        agent: 'Coordinator',
        action: 'permission-denied',
        reasoning: `${decision.agent} does not permit token "${requestedToken}"`,
        status: 'fail',
      });
      return {
        success: false,
        message: `Token "${requestedToken}" is not permitted for agent "${decision.agent}". Allowed: ${agent.permissions.allowedTokens.join(', ')}`,
      };
    }
  }

  // Contract allowlist check
  if (agent?.permissions?.allowedContracts && decision.params.contractAddress) {
    const addr = decision.params.contractAddress.toLowerCase();
    const allowed = agent.permissions.allowedContracts.map(a => a.toLowerCase());
    if (!allowed.includes(addr)) {
      logReasoning({
        agent: 'Coordinator',
        action: 'permission-denied',
        reasoning: `${decision.agent} does not permit contract "${decision.params.contractAddress.slice(0, 10)}..."`,
        status: 'fail',
      });
      return {
        success: false,
        message: `Contract "${decision.params.contractAddress.slice(0, 10)}..." is not whitelisted for agent "${decision.agent}"`,
      };
    }
  }

  if (decision.plan && decision.plan.length > 1) {
    return executePlan(decision, userId);
  }
  return executeWithRiskGate(decision, userId);
}

export async function executeSystemDecision(
  decision: RouteDecision,
  userId: string,
  systemActor: string = 'system',
): Promise<AgentResponse> {
  logReasoning({
    agent: 'Coordinator',
    action: 'system-execution',
    reasoning: `System actor "${systemActor}" submitted ${decision.agent}.${decision.intent} for ${userId}`,
    status: 'pass',
  });
  return executeDecision({ ...decision, systemActor }, userId);
}

/** Convenience: route + execute in one call (for non-interactive contexts) */
export async function routeMessage(
  userMessage: string,
  userId: string,
): Promise<AgentResponse> {
  const decision = await analyzeMessage(userMessage, userId);
  return executeDecision(decision, userId);
}

async function executeWithRiskGate(
  decision: RouteDecision,
  userId: string,
): Promise<AgentResponse> {
  const agent = agents[decision.agent];
  if (!agent) {
    return {
      success: false,
      message: `Agent "${decision.agent}" is not available. Available: ${Object.keys(agents).join(', ')}`,
    };
  }

  const gatedIntents = RISK_GATED_INTENTS[decision.agent];
  const isRiskGated = gatedIntents?.includes(decision.intent);

  let riskCheckAmount = '0';
  let riskScore: number | undefined;
  let riskTier: string | undefined;
  let riskFactors: string[] | undefined;

  if (isRiskGated) {
    riskCheckAmount = await resolveRiskCheckAmount(decision);

    logReasoning({
      agent: 'Coordinator',
      action: 'risk-gate',
      reasoning: `${decision.agent}.${decision.intent} requires risk approval`,
      status: 'pass',
    });

    const riskResult = await riskAgent.execute({
      intent: 'check_transaction',
      params: {
        amountUsdt: riskCheckAmount,
        type: decision.intent,
        slippage: decision.params.slippage || '0',
        token: decision.params.token || decision.params.tokenIn || '',
        tokenIn: decision.params.tokenIn || '',
        tokenOut: decision.params.tokenOut || '',
        contractAddress: decision.params.contractAddress || '',
        systemActor: decision.systemActor || '',
      },
      userId,
    });

    const riskData = riskResult.data as Record<string, unknown>;
    riskScore = riskResult.riskScore;
    riskTier = riskResult.riskTier;
    riskFactors = riskData?.factors as string[] | undefined;

    if (!riskResult.success || !riskData?.approved) {
      logReasoning({
        agent: 'Coordinator',
        action: 'risk-gate',
        reasoning: `BLOCKED — Risk ${riskResult.riskScore}/10 (${riskResult.riskTier})`,
        result: riskResult.message,
        status: 'fail',
        riskScore: riskResult.riskScore,
        riskTier: riskResult.riskTier,
      });
      return riskResult;
    }

    logReasoning({
      agent: 'Coordinator',
      action: 'risk-gate',
      reasoning: `PASSED — Risk ${riskResult.riskScore}/10 (${riskResult.riskTier})`,
      status: 'pass',
      riskScore: riskResult.riskScore,
      riskTier: riskResult.riskTier,
    });
  }

  const request: AgentRequest = {
    intent: decision.intent,
    params: decision.params || {},
    userId,
  };

  const result = await agent.execute(request);

  // Post-execution spending recording (bug fix: was pre-execution before)
  if (isRiskGated && result.success && parseFloat(riskCheckAmount) > 0) {
    await riskAgent.execute({
      intent: 'record_spending',
      params: { amountUsdt: riskCheckAmount },
      userId,
    });
  }

  // Log transaction to SQLite audit trail
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO tx_log (user_id, intent, agent, amount_usdt, tx_hash, status, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      decision.intent,
      decision.agent,
      parseFloat(riskCheckAmount) || null,
      ((result.data as Record<string, unknown>)?.txHash as string)
        ?? ((result.data as Record<string, unknown>)?.hash as string)
        ?? null,
      result.success ? 'success' : 'failed',
      JSON.stringify({
        params: decision.params,
        receiptContext: decision.receiptContext ?? null,
        risk: isRiskGated ? { score: riskScore, tier: riskTier, factors: riskFactors ?? [] } : null,
      }),
    );
  } catch {
    // Non-fatal — audit logging failure shouldn't block execution
  }

  return result;
}

async function resolveRiskCheckAmount(decision: RouteDecision): Promise<string> {
  if (decision.params.amountUsdt) return decision.params.amountUsdt;

  const rawAmount = parseFloat(decision.params.amount || '0');
  if (!Number.isFinite(rawAmount) || rawAmount <= 0) return '0';

  const tokenHint = (decision.params.token || decision.params.tokenIn || '').toUpperCase();
  if (!tokenHint) return String(rawAmount);
  if (['USDT', 'USDC', 'DAI'].includes(tokenHint)) return String(rawAmount);

  try {
    const price = await pricing.getCurrentPrice(tokenHint, 'USD');
    if (!Number.isFinite(price) || price <= 0) return String(rawAmount);
    return String(rawAmount * price);
  } catch {
    return String(rawAmount);
  }
}

async function executePlan(
  initialDecision: RouteDecision,
  userId: string,
): Promise<AgentResponse> {
  logReasoning({
    agent: 'Coordinator',
    action: 'plan-start',
    reasoning: `Executing ${initialDecision.plan!.length}-step plan`,
    status: 'pass',
  });

  const results: AgentResponse[] = [];

  const firstResult = await executeWithRiskGate(initialDecision, userId);
  results.push(firstResult);

  if (!firstResult.success) {
    return {
      success: false,
      message: `Plan failed at step 1: ${firstResult.message}`,
      data: { step: 1, results },
    };
  }

  for (let i = 1; i < initialDecision.plan!.length; i++) {
    const stepDescription = initialDecision.plan![i];
    const previousResult = results[results.length - 1];

    logReasoning({
      agent: 'Coordinator',
      action: `plan-step-${i + 1}`,
      reasoning: `Routing: "${stepDescription}"`,
      status: 'pass',
    });

    let stepDecision: RouteDecision;
    try {
      stepDecision = await llmJson<RouteDecision>([
        { role: 'system', content: ROUTING_PROMPT },
        {
          role: 'user',
          content: `${stepDescription}\n\nContext from previous step: ${previousResult.message}`,
        },
      ]);
    } catch {
      stepDecision = fallbackRouting(stepDescription);
    }

    stepDecision = normalizeDecisionFromMessage(stepDescription, stepDecision);
    stepDecision.plan = undefined;

    const stepResult = await executeWithRiskGate(stepDecision, userId);
    results.push(stepResult);

    if (!stepResult.success) {
      return {
        success: false,
        message: `Plan failed at step ${i + 1}: ${stepResult.message}`,
        data: { step: i + 1, results },
      };
    }
  }

  logReasoning({
    agent: 'Coordinator',
    action: 'plan-complete',
    reasoning: `All ${results.length} steps completed`,
    status: 'pass',
  });

  const summary = results
    .map((r, i) => `*Step ${i + 1}:* ${r.message}`)
    .join('\n\n');

  return {
    success: true,
    message: summary,
    data: { steps: results.length, results },
  };
}

export function fallbackRouting(message: string): RouteDecision {
  const lower = message.toLowerCase();

  if (lower.includes('balance') || lower.includes('how much')) {
    const tokenMatch = lower.match(/\b(usdt|eth|xaut|usdc|dai|weth)\b/i);
    if (tokenMatch) {
      return {
        agent: 'treasury',
        intent: 'get_token_balance',
        params: { token: tokenMatch[1].toUpperCase() },
      };
    }
    return { agent: 'treasury', intent: 'get_balance', params: {} };
  }

  if (lower.includes('address') || lower.includes('wallet')) {
    return { agent: 'treasury', intent: 'get_address', params: {} };
  }

  if (lower.includes('send') || lower.includes('transfer')) {
    return { agent: 'treasury', intent: 'transfer', params: {} };
  }

  if (lower.includes('price') || lower.includes('worth')) {
    return { agent: 'market' as AgentName, intent: 'get_price', params: {} };
  }

  if (
    (lower.includes('portfolio') && (lower.includes('worry') || lower.includes('worried') || lower.includes('safe') || lower.includes('analy') || lower.includes('assess') || lower.includes('review')))
    || lower.includes('should i be worried')
    || lower.includes('is my treasury safe')
  ) {
    return { agent: 'market' as AgentName, intent: 'assess_portfolio', params: {} };
  }

  if (lower.includes('portfolio')) {
    return { agent: 'market' as AgentName, intent: 'portfolio_summary', params: {} };
  }

  if (lower.includes('swap') || lower.includes('trade') || lower.includes('exchange')) {
    return { agent: 'swap' as AgentName, intent: 'quote_swap', params: {} };
  }

  if (lower.includes('supply') || lower.includes('lend') || lower.includes('yield') || lower.includes('apy')) {
    return { agent: 'yield' as AgentName, intent: 'quote_supply', params: {} };
  }

  if (lower.includes('bridge') || lower.includes('cross-chain') || lower.includes('cross chain')) {
    return { agent: 'bridge' as AgentName, intent: 'quote_bridge', params: {} };
  }

  if (lower.includes('guard') || lower.includes('on-chain') || lower.includes('contract')) {
    return { agent: 'risk' as AgentName, intent: 'get_guard_params', params: {} };
  }

  if (lower.includes('assess') || lower.includes('evaluate')) {
    return { agent: 'risk' as AgentName, intent: 'assess_risk', params: { context: lower } };
  }

  if (lower.includes('risk') || lower.includes('limit')) {
    return { agent: 'risk' as AgentName, intent: 'get_limits', params: {} };
  }

  if (lower.includes('health') || lower.includes('status') || lower.includes('system')) {
    return { agent: 'coordinator' as AgentName, intent: 'unknown', params: { message: 'health check' } };
  }

  // Don't default to balance for unrecognized input
  return { agent: 'coordinator' as AgentName, intent: 'unknown', params: { message: lower } };
}
