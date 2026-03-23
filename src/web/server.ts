import express from 'express';
import { createServer } from 'http';
import { randomBytes } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from '../core/db.js';
import {
  analyzeMessage,
  executeDecision,
  needsConfirmation,
  formatConfirmation,
} from '../agents/coordinator.js';
import { routeMessage } from '../agents/coordinator.js';
import {
  getReasoningLog,
  clearReasoningLog,
  setActiveUser,
  type ReasoningStep,
} from '../reasoning/logger.js';
import { addMessage, clearHistory } from '../reasoning/memory.js';
import { addEventSubscriber, getEventBuffer, type StampedEvent } from '../core/events.js';
import type { ExecutionReceiptContext, RouteDecision } from '../agents/types.js';
import { getUserAccountContext } from '../core/account-context.js';
import {
  createAuthChallenge,
  verifyAuthChallenge,
  getWebSession,
  deleteWebSession,
  type WebSession,
} from './auth.js';
import { readServiceHeartbeat } from '../core/heartbeat.js';
import {
  canAccessSensitiveRoute,
  resolveRestUserId,
  resolveSocketUserId,
} from './access.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface WsMessage {
  type: 'message' | 'confirm' | 'cancel' | 'ping' | 'wallet_refresh';
  content?: string;
  userId?: string;
}

interface WsOutbound {
  type: 'response' | 'confirm_prompt' | 'reasoning' | 'error' | 'pong' | 'typing' | 'wallet' | 'event' | 'event_replay';
  content?: string;
  success?: boolean;
  steps?: ReasoningStep[];
  riskScore?: number;
  riskTier?: string;
  wallet?: WalletData;
  event?: StampedEvent;
  events?: StampedEvent[];
}

interface WalletData {
  address: string;
  chainName: string;
  mode: string;
}

const pendingActions = new Map<string, RouteDecision>();
const pendingConfirmTokens = new Map<string, { userId: string; expiresAt: number }>();
const confirmTokenByUser = new Map<string, string>();
const connectedClients = new Set<WebSocket>();
const sseClients = new Set<import('express').Response>();
const CONFIRM_TOKEN_TTL_MS = 10 * 60 * 1000;
const READ_ONLY_INTENTS = new Set([
  'get_balance',
  'get_address',
  'get_token_balance',
  'estimate_fee',
  'get_price',
  'get_history',
  'portfolio_summary',
  'market_conditions',
  'quote_swap',
  'quote_supply',
  'quote_withdraw',
  'quote_borrow',
  'quote_repay',
  'account_data',
  'check_transaction',
  'get_limits',
  'assess_risk',
  'get_guard_params',
  'quote_bridge',
  'unknown',
]);

function send(ws: WebSocket, data: WsOutbound): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcastToAll(message: string): void {
  for (const ws of connectedClients) {
    send(ws, { type: 'response', content: message, success: true });
  }
}

function sanitize(msg: string): string {
  return msg
    .replace(/https?:\/\/[^\s]+/g, '[RPC]')
    .replace(/0x[a-fA-F0-9]{64}/g, '0x...')
    .slice(0, 500);
}

function getSessionToken(req: import('express').Request): string | null {
  const bearer = req.headers.authorization?.replace('Bearer ', '').trim();
  const headerToken = typeof req.headers['x-session-token'] === 'string' ? req.headers['x-session-token'] : '';
  const queryToken = typeof req.query.session === 'string' ? req.query.session : '';
  return bearer || headerToken || queryToken || null;
}

function hasValidApiToken(req: import('express').Request, expectedToken: string): boolean {
  if (!expectedToken) return false;
  const bearer = req.headers.authorization?.replace('Bearer ', '').trim();
  const query = typeof req.query.token === 'string' ? req.query.token : '';
  return bearer === expectedToken || query === expectedToken;
}

function requireWebSession(
  req: import('express').Request,
  res: import('express').Response,
): WebSession | null {
  const sessionToken = getSessionToken(req);
  if (!sessionToken) {
    res.status(401).json({ success: false, error: 'session required' });
    return null;
  }

  const session = getWebSession(sessionToken);
  if (!session) {
    res.status(401).json({ success: false, error: 'invalid session' });
    return null;
  }

  return session;
}

function clearPendingAction(userId: string): void {
  pendingActions.delete(userId);
  clearConfirmToken(userId);
}

function clearConfirmToken(userId: string): void {
  const existingToken = confirmTokenByUser.get(userId);
  if (existingToken) {
    confirmTokenByUser.delete(userId);
    pendingConfirmTokens.delete(existingToken);
  }
}

function issueConfirmToken(userId: string): string {
  clearConfirmToken(userId);
  const token = `tok_${randomBytes(16).toString('hex')}`;
  pendingConfirmTokens.set(token, {
    userId,
    expiresAt: Date.now() + CONFIRM_TOKEN_TTL_MS,
  });
  confirmTokenByUser.set(userId, token);
  return token;
}

function resolveConfirmToken(token: string): { userId: string } | null {
  const pending = pendingConfirmTokens.get(token);
  if (!pending) return null;
  if (pending.expiresAt < Date.now()) {
    pendingConfirmTokens.delete(token);
    if (confirmTokenByUser.get(pending.userId) === token) {
      confirmTokenByUser.delete(pending.userId);
    }
    return null;
  }
  return { userId: pending.userId };
}

async function getWalletData(userId: string): Promise<WalletData> {
  try {
    const { getAccount } = await import('../core/wdk-setup.js');
    const { isErc4337Mode } = await import('../core/wdk-setup.js');
    const account = await getAccount('ethereum', { userId });
    const address = await account.getAddress();
    const ctx = getUserAccountContext(userId, 'ethereum');
    const mode = ctx?.walletMode === 'erc4337'
      ? 'ERC-4337'
      : ctx?.walletMode === 'eoa'
        ? 'EOA'
        : isErc4337Mode() ? 'ERC-4337' : 'EOA';
    return {
      address,
      chainName: 'Arbitrum One',
      mode,
    };
  } catch {
    return { address: 'unavailable', chainName: 'Arbitrum One', mode: 'unknown' };
  }
}

async function getOperatorWalletData(): Promise<WalletData> {
  try {
    const { getOperatorAccount, isErc4337Mode } = await import('../core/wdk-setup.js');
    const account = await getOperatorAccount('ethereum');
    const address = await account.getAddress();
    return {
      address,
      chainName: 'Arbitrum One',
      mode: isErc4337Mode() ? 'ERC-4337' : 'EOA',
    };
  } catch {
    return { address: 'unavailable', chainName: 'Arbitrum One', mode: 'unknown' };
  }
}

async function buildDashboardState(userId: string, view: 'current' | 'demo') {
  const [{ getAccount, getOperatorAccount }, { fromBaseUnits, resolveTokenAddress }, { pricing }, { getFearGreedSignal, getGoldSignal }, { getOrCreateTreasuryPolicy }, { isAutopilotRunning }] = await Promise.all([
    import('../core/wdk-setup.js'),
    import('../core/tokens.js'),
    import('../core/pricing.js'),
    import('../core/regime-signals.js'),
    import('../core/treasury-policy.js'),
    import('../agents/autopilot.js'),
  ]);

  const account = view === 'demo'
    ? await getOperatorAccount('ethereum')
    : await getAccount('ethereum', { userId });
  const wallet = view === 'demo'
    ? await getOperatorWalletData()
    : await getWalletData(userId);
  const accountContext = getUserAccountContext(userId, 'ethereum');
  const ethRaw = await account.getBalance();
  const wethAddr = resolveTokenAddress('WETH', 'ethereum');
  const usdtAddr = resolveTokenAddress('USDT', 'ethereum');
  const xautAddr = resolveTokenAddress('XAUT', 'ethereum');
  const [wethRaw, usdtRaw, xautRaw, ethPrice, fearGreed, goldSignal] = await Promise.all([
    wethAddr ? account.getTokenBalance(wethAddr).catch(() => 0n) : Promise.resolve(0n),
    usdtAddr ? account.getTokenBalance(usdtAddr).catch(() => 0n) : Promise.resolve(0n),
    xautAddr ? account.getTokenBalance(xautAddr).catch(() => 0n) : Promise.resolve(0n),
    pricing.getCurrentPrice('ETH', 'USD').catch(() => 0),
    getFearGreedSignal(),
    getGoldSignal(),
  ]);

  const eth = parseFloat(fromBaseUnits(ethRaw, 18));
  const weth = parseFloat(fromBaseUnits(wethRaw, 18));
  const usdt = parseFloat(fromBaseUnits(usdtRaw, 6));
  const xaut = parseFloat(fromBaseUnits(xautRaw, 6));
  const xautUsdPrice = goldSignal.xautUsd ?? goldSignal.spotUsd ?? 0;

  let aaveCollateralUsd = 0;
  let aaveDebtUsd = 0;
  let healthFactor: number | null = null;
  try {
    const lending = account.getLendingProtocol('aave');
    const aaveData = await lending.getAccountData();
    aaveCollateralUsd = Number(aaveData.totalCollateralBase) / 1e8;
    aaveDebtUsd = Number(aaveData.totalDebtBase) / 1e8;
    healthFactor = Number(aaveData.healthFactor) / 1e18;
  } catch {
    // no Aave position yet
  }

  const totalUsdValue = (eth * ethPrice) + (weth * ethPrice) + usdt + (xaut * xautUsdPrice) + aaveCollateralUsd - aaveDebtUsd;
  const xautUsdValue = xaut * xautUsdPrice;
  const reservePct = totalUsdValue > 0 ? (usdt / totalUsdValue) * 100 : 0;
  const xautPct = totalUsdValue > 0 ? (xautUsdValue / totalUsdValue) * 100 : 0;
  const yieldPct = totalUsdValue > 0 ? (aaveCollateralUsd / totalUsdValue) * 100 : 0;

  const policy = getOrCreateTreasuryPolicy(userId);
  const autopilotRunning = isAutopilotRunning();
  const heartbeat = readServiceHeartbeat({
    autopilotRunning,
    expectedCycleMs: 5 * 60 * 1000,
  });
  const db = getDb();
  const txRows = (view === 'demo'
    ? db.prepare(`
        SELECT user_id, intent, agent, amount_usdt, tx_hash, status, created_at, metadata
        FROM tx_log
        ORDER BY created_at DESC
        LIMIT 8
      `).all()
    : db.prepare(`
        SELECT user_id, intent, agent, amount_usdt, tx_hash, status, created_at, metadata
        FROM tx_log
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 8
      `).all(userId)) as Array<Record<string, unknown>>;

  const receipts = txRows.map((tx) => {
    let parsedMetadata: Record<string, unknown> | null = null;
    try {
      parsedMetadata = tx.metadata ? JSON.parse(String(tx.metadata)) as Record<string, unknown> : null;
    } catch {
      parsedMetadata = null;
    }
    const receiptContext = (parsedMetadata?.receiptContext ?? null) as ExecutionReceiptContext | null;
    return {
      intent: tx.intent,
      agent: tx.agent,
      amountUsdt: tx.amount_usdt,
      txHash: tx.tx_hash,
      status: tx.status,
      createdAt: tx.created_at,
      receiptContext,
      risk: parsedMetadata?.risk ?? null,
      summary: receiptContext?.summary ?? null,
      policyReason: receiptContext?.reason ?? null,
      policyName: receiptContext?.policy ?? null,
      signalSnapshot: receiptContext?.signals ?? null,
    };
  });

  const x402Rows = (view === 'demo'
    ? db.prepare(`
        SELECT amount_usdt, tx_hash, status, created_at
        FROM tx_log
        WHERE intent = 'x402_payment'
        ORDER BY created_at DESC
        LIMIT 5
      `).all()
    : db.prepare(`
        SELECT amount_usdt, tx_hash, status, created_at
        FROM tx_log
        WHERE user_id = ? AND intent = 'x402_payment'
        ORDER BY created_at DESC
        LIMIT 5
      `).all(userId)) as Array<Record<string, unknown>>;

  const regime = {
    fearGreedValue: fearGreed.value,
    fearGreedClassification: fearGreed.classification,
    gold24hChangePct: goldSignal.change24hPct,
    xautUsdPrice,
    posture:
      (fearGreed.value ?? 50) <= 40 || (goldSignal.change24hPct ?? 0) > 1.5
        ? 'risk-off'
        : (fearGreed.value ?? 50) >= 65 && (goldSignal.change24hPct ?? 0) <= 0.5
          ? 'risk-on'
          : 'neutral',
  };

  return {
    view,
    userId,
    wallet,
    autopilot: {
      running: autopilotRunning,
      status: heartbeat.status,
      ...heartbeat.autopilot,
    },
    execution: {
      ownerAddress: accountContext?.ownerAddress ?? null,
      strategyAddress: wallet.address,
      model: view === 'demo'
        ? 'Read-only mirror of the live server treasury'
        : accountContext?.ownerAddress
          ? 'Wallet-authenticated identity + Nexus-managed WDK strategy account'
          : 'Live server treasury',
      limitation: view === 'demo'
        ? 'Judge Demo is inspect-only. It mirrors the funded server treasury without exposing write access.'
        : accountContext?.ownerAddress
          ? 'The connected wallet authenticates the user. Execution currently runs from the mapped WDK strategy account.'
          : 'Autopilot and execution currently run from the funded server treasury.',
    },
    heartbeat,
    balances: {
      eth,
      weth,
      usdt,
      xaut,
      xautUsdValue,
      aaveCollateralUsd,
      aaveDebtUsd,
      healthFactor,
      totalUsdValue,
      reservePct,
      xautPct,
      yieldPct,
    },
    regime,
    policy,
    receipts,
    x402Payments: x402Rows,
    sourceHealth: heartbeat.sources,
    reasoning: getReasoningLog(view === 'demo' ? 'autopilot' : userId),
  };
}

function isReadOnlyDecision(decision: RouteDecision): boolean {
  return READ_ONLY_INTENTS.has(decision.intent);
}

async function handleMessage(
  ws: WebSocket,
  userId: string,
  content: string,
  isAuthenticated: boolean,
): Promise<void> {
  setActiveUser(userId);
  addMessage(userId, 'user', content);
  clearReasoningLog(userId);

  send(ws, { type: 'typing' });

  try {
    const decision = await analyzeMessage(content, userId);

    if (!isAuthenticated && !isReadOnlyDecision(decision)) {
      send(ws, {
        type: 'response',
        content: 'Sign in with a wallet before running state-changing actions. Guest mode is read-only and demo-safe.',
        success: false,
      });
      send(ws, { type: 'reasoning', steps: getReasoningLog(userId) });
      return;
    }

    if (needsConfirmation(decision)) {
      // Pre-check risk so confirmation shows score + factors
      let preRiskScore: number | undefined;
      let preRiskTier: string | undefined;
      let preFactors: string[] | undefined;
      try {
        const { riskAgent } = await import('../agents/risk.js');
        const preCheck = await riskAgent.execute({
          intent: 'check_transaction',
          params: {
            amountUsdt: decision.params.amountUsdt || decision.params.amount || '0',
            type: decision.intent,
            slippage: decision.params.slippage || '0',
            token: decision.params.token || decision.params.tokenIn || '',
            tokenIn: decision.params.tokenIn || '',
            tokenOut: decision.params.tokenOut || '',
            contractAddress: decision.params.contractAddress || '',
          },
          userId,
        });
        preRiskScore = preCheck.riskScore;
        preRiskTier = preCheck.riskTier as string | undefined;
        preFactors = (preCheck.data as Record<string, unknown>)?.factors as string[] | undefined;
      } catch {
        // Non-blocking
      }

      // Fetch fee estimate for the confirmation prompt
      let estimatedFee: string | undefined;
      try {
        const { treasuryAgent } = await import('../agents/treasury.js');
        if (decision.params.to && decision.params.amount) {
          const feeResult = await treasuryAgent.execute({
            intent: 'estimate_fee',
            params: { chain: decision.params.chain || 'ethereum', to: decision.params.to, amount: decision.params.amount },
            userId,
          });
          if (feeResult.success && feeResult.data?.fee) {
            const { fromBaseUnits } = await import('../core/tokens.js');
            estimatedFee = `${fromBaseUnits(BigInt(feeResult.data.fee as string), 18)} ETH`;
          }
        }
      } catch {
        // Non-blocking
      }

      pendingActions.set(userId, decision);
      const prompt = formatConfirmation(decision, preRiskScore, preRiskTier, preFactors, estimatedFee);
      send(ws, {
        type: 'confirm_prompt',
        content: prompt,
        riskScore: preRiskScore,
        riskTier: preRiskTier,
      });
      send(ws, { type: 'reasoning', steps: getReasoningLog(userId) });
      return;
    }

    const response = await executeDecision(decision, userId);
    addMessage(userId, 'assistant', response.message);

    send(ws, {
      type: 'response',
      content: response.message,
      success: response.success,
    });
    send(ws, { type: 'reasoning', steps: getReasoningLog(userId) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send(ws, { type: 'error', content: sanitize(msg) });
  }
}

export function createWebServer(port = 3000): void {
  const app = express();
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer });
  const webToken = process.env.WEB_ACCESS_TOKEN || '';

  app.use(express.static(path.join(__dirname, 'public')));

  app.post('/api/auth/challenge', express.json(), async (req, res) => {
    const { address } = req.body as { address?: string };
    if (!address?.trim()) {
      res.status(400).json({ success: false, error: 'address required' });
      return;
    }

    try {
      const challenge = createAuthChallenge(address.trim());
      res.json({ success: true, challenge });
    } catch (err) {
      res.status(400).json({ success: false, error: sanitize(String(err)) });
    }
  });

  app.post('/api/auth/verify', express.json(), async (req, res) => {
    const { address, signature } = req.body as { address?: string; signature?: string };
    if (!address?.trim() || !signature?.trim()) {
      res.status(400).json({ success: false, error: 'address and signature required' });
      return;
    }

    try {
      const session = verifyAuthChallenge(address.trim(), signature.trim());
      const ctx = getUserAccountContext(session.userId, 'ethereum');
      res.json({ success: true, session, account: ctx });
    } catch (err) {
      res.status(400).json({ success: false, error: sanitize(String(err)) });
    }
  });

  app.get('/api/auth/me', async (req, res) => {
    const sessionToken = getSessionToken(req);
    if (!sessionToken) {
      res.status(401).json({ success: false, error: 'session required' });
      return;
    }

    const session = getWebSession(sessionToken);
    if (!session) {
      res.status(401).json({ success: false, error: 'invalid session' });
      return;
    }

    const ctx = getUserAccountContext(session.userId, 'ethereum');
    res.json({
      success: true,
      session,
      account: ctx,
      wallet: await getWalletData(session.userId),
    });
  });

  app.post('/api/auth/logout', express.json(), async (req, res) => {
    const sessionToken = getSessionToken(req);
    if (sessionToken) {
      deleteWebSession(sessionToken);
    }
    res.json({ success: true });
  });

  app.get('/health', async (_req, res) => {
    let walletAddress = 'unknown';
    let walletFunded = false;
    try {
      const { getOperatorAccount } = await import('../core/wdk-setup.js');
      const account = await getOperatorAccount('ethereum');
      walletAddress = await account.getAddress();
      const balance = await account.getBalance();
      walletFunded = balance > 0n;
    } catch { /* non-blocking */ }

    const autopilotModule = await import('../agents/autopilot.js').catch(() => ({ isAutopilotRunning: () => false }));
    const autopilotRunning = autopilotModule.isAutopilotRunning();
    const heartbeat = readServiceHeartbeat({
      autopilotRunning,
      expectedCycleMs: 5 * 60 * 1000,
    });

    const status = (
      heartbeat.status === 'ok'
      && autopilotRunning
      && walletFunded
    ) ? 'ok' : 'degraded';

    res.json({
      status,
      agents: ['coordinator', 'treasury', 'market', 'swap', 'yield', 'risk', 'bridge'],
      autopilot: {
        running: autopilotRunning,
        ...heartbeat.autopilot,
      },
      heartbeat,
      wallet: walletAddress !== 'unknown' ? `${walletAddress.slice(0, 10)}...${walletAddress.slice(-8)}` : 'unavailable',
      walletFunded,
      chain: 'Arbitrum One',
      guardContract: process.env.NEXUS_GUARD_ADDRESS || null,
      uptime: Math.round(process.uptime()),
    });
  });

  app.get('/api/dashboard/state', async (req, res) => {
    try {
      const sessionToken = getSessionToken(req);
      const session = sessionToken ? getWebSession(sessionToken) : null;
      const requestedView = typeof req.query.view === 'string' ? req.query.view : '';
      const useDemo = requestedView === 'demo' || !session;
      const userId = useDemo ? (process.env.NEXUS_DEMO_USER_ID || 'demo') : session.userId;
      const dashboard = await buildDashboardState(userId, useDemo ? 'demo' : 'current');
      res.json({ success: true, dashboard });
    } catch (err) {
      res.status(500).json({ success: false, error: sanitize(String(err)) });
    }
  });

  // REST chat endpoint — enables HTTP clients (MCP, scripts, curl) to call Nexus
  // POST /api/chat  { "message": "swap 5 USDT for ETH", "userId": "optional" }
  // Auth: if WEB_ACCESS_TOKEN is set, require it as Bearer token or ?token= query param
  //
  // Confirmation flow for write operations:
  //   1. POST /api/chat { message }  → 202 { requires_confirmation: true, confirm_token: "tok_..." }
  //   2. POST /api/chat/confirm { confirm_token }  → 200 { success, message }
  //   OR: POST /api/chat { message: "yes", userId }  → executes pending for that userId
  app.post('/api/chat', express.json(), async (req, res) => {
    const sessionToken = getSessionToken(req);
    const session = sessionToken ? getWebSession(sessionToken) : null;
    const hasApiToken = hasValidApiToken(req, webToken);
    if (webToken) {
      if (!hasApiToken) {
        res.status(401).json({ success: false, error: 'Unauthorized — provide token via Authorization: Bearer <token> or ?token=<token>' });
        return;
      }
    }
    const { message, userId: reqUserId } = req.body as { message?: string; userId?: string };
    if (!message?.trim()) {
      res.status(400).json({ success: false, error: 'message required' });
      return;
    }
    const uid = resolveRestUserId({
      sessionUserId: session?.userId,
      requestedUserId: reqUserId,
      hasApiToken,
    });
    setActiveUser(uid);
    clearReasoningLog(uid);
    addMessage(uid, 'user', message.trim());

    // If this looks like a confirmation reply for a pending REST action
    if (/^(yes|confirm|y)$/i.test(message.trim())) {
      const pending = pendingActions.get(uid);
      if (pending) {
        clearPendingAction(uid);
        try {
          const response = await executeDecision(pending, uid);
          addMessage(uid, 'assistant', response.message);
          res.json({ success: response.success, message: response.message, reasoning: getReasoningLog(uid) });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          res.status(500).json({ success: false, error: sanitize(msg) });
        }
        return;
      }
    }

    try {
      const decision = await analyzeMessage(message.trim(), uid);

      if (!session && !hasApiToken && !isReadOnlyDecision(decision)) {
        res.status(401).json({
          success: false,
          error: 'Sign in with a wallet before running state-changing actions. Anonymous REST access is read-only.',
        });
        return;
      }

      if (needsConfirmation(decision)) {
        // Store pending under the userId so a follow-up "yes" or /confirm call can execute it
        pendingActions.set(uid, decision);
        const confirmToken = issueConfirmToken(uid);
        const prompt = formatConfirmation(decision);
        res.status(202).json({
          success: true,
          requires_confirmation: true,
          confirmation_prompt: prompt,
          confirm_token: confirmToken,
          confirm_hint: `POST /api/chat with { "message": "yes", "userId": "${uid}" } to confirm, or POST /api/chat/confirm with { "confirm_token": "${confirmToken}" }`,
          userId: uid,
        });
        return;
      }

      const response = await executeDecision(decision, uid);
      addMessage(uid, 'assistant', response.message);
      res.json({ success: response.success, message: response.message, reasoning: getReasoningLog(uid) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: sanitize(msg) });
    }
  });

  // Explicit confirmation endpoint for REST clients
  // POST /api/chat/confirm { "confirm_token": "<random token from requires_confirmation response>" }
  app.post('/api/chat/confirm', express.json(), async (req, res) => {
    const session = getSessionToken(req) ? getWebSession(getSessionToken(req)!) : null;
    const hasApiToken = hasValidApiToken(req, webToken);
    if (webToken) {
      if (!hasApiToken && !session) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }
    }
    const { confirm_token } = req.body as { confirm_token?: string };
    if (!confirm_token?.trim()) {
      res.status(400).json({ success: false, error: 'confirm_token required' });
      return;
    }
    const resolved = resolveConfirmToken(confirm_token.trim());
    if (!resolved) {
      res.status(404).json({ success: false, error: 'No pending action for this token — it may have expired or already been executed' });
      return;
    }
    const pending = pendingActions.get(resolved.userId);
    if (!pending) {
      res.status(404).json({ success: false, error: 'No pending action for this token — it may have expired or already been executed' });
      return;
    }
    if (session && session.userId !== resolved.userId) {
      res.status(403).json({ success: false, error: 'confirm_token does not belong to this session' });
      return;
    }
    clearPendingAction(resolved.userId);
    setActiveUser(resolved.userId);
    clearReasoningLog(resolved.userId);
    try {
      const response = await executeDecision(pending, resolved.userId);
      addMessage(resolved.userId, 'assistant', response.message);
      res.json({ success: response.success, message: response.message });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: sanitize(msg) });
    }
  });

  // Natural-language conditional rules
  // GET  /api/rules         — list all rules
  // POST /api/rules         — add rule: { "rule": "if APY drops below 3% withdraw all USDT" }
  // DELETE /api/rules/:id   — remove a rule
  // PATCH /api/rules/:id    — toggle: { "enabled": true|false }

  app.get('/api/rules', async (req, res) => {
    try {
      const { listRules } = await import('../core/rules.js');
      const session = requireWebSession(req, res);
      if (!session) return;
      res.json({ success: true, rules: listRules(session.userId) });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  app.post('/api/rules', express.json(), async (req, res) => {
    const { rule } = req.body as { rule?: string };
    if (!rule?.trim()) {
      res.status(400).json({ success: false, error: 'rule text required', example: 'if APY drops below 3% alert me' });
      return;
    }
    try {
      const { parseRule, addRule } = await import('../core/rules.js');
      const session = requireWebSession(req, res);
      if (!session) return;
      const parsed = await parseRule(rule.trim());
      if (!parsed) {
        res.status(422).json({ success: false, error: 'Could not parse rule — try: "if APY drops below 3% alert me" or "if health factor below 1.5 withdraw USDT"' });
        return;
      }
      const id = `rule-${Date.now()}`;
      const stored = addRule(session.userId, id, rule.trim(), parsed.condition, parsed.action);
      res.json({ success: true, rule: stored, parsed });
    } catch (err) {
      res.status(500).json({ success: false, error: sanitize(String(err)) });
    }
  });

  app.delete('/api/rules/:id', async (req, res) => {
    try {
      const { deleteRule } = await import('../core/rules.js');
      const session = requireWebSession(req, res);
      if (!session) return;
      const deleted = deleteRule(session.userId, req.params.id);
      res.json({ success: deleted, message: deleted ? 'Rule deleted' : 'Rule not found' });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  app.patch('/api/rules/:id', express.json(), async (req, res) => {
    const { enabled } = req.body as { enabled?: boolean };
    if (enabled === undefined) {
      res.status(400).json({ success: false, error: 'enabled (boolean) required' });
      return;
    }
    try {
      const { setRuleEnabled } = await import('../core/rules.js');
      const session = requireWebSession(req, res);
      if (!session) return;
      const updated = setRuleEnabled(session.userId, req.params.id, enabled);
      res.json({ success: updated });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  app.get('/api/policy', async (req, res) => {
    try {
      const session = requireWebSession(req, res);
      if (!session) return;
      const { getOrCreateTreasuryPolicy } = await import('../core/treasury-policy.js');
      res.json({ success: true, policy: getOrCreateTreasuryPolicy(session.userId) });
    } catch (err) {
      res.status(500).json({ success: false, error: sanitize(String(err)) });
    }
  });

  app.put('/api/policy', express.json(), async (req, res) => {
    try {
      const session = requireWebSession(req, res);
      if (!session) return;
      const { updateTreasuryPolicy } = await import('../core/treasury-policy.js');
      const body = req.body as Record<string, unknown>;
      const toNumber = (value: unknown): number | undefined => {
        if (value === undefined || value === null || value === '') return undefined;
        const num = Number(value);
        if (!Number.isFinite(num)) throw new Error('Policy fields must be numeric');
        return num;
      };

      const updated = updateTreasuryPolicy(session.userId, {
        reserveFloorUsdt: toNumber(body.reserveFloorUsdt),
        targetXautPercent: toNumber(body.targetXautPercent),
        maxXautPercent: toNumber(body.maxXautPercent),
        maxYieldPercent: toNumber(body.maxYieldPercent),
        minRebalanceUsdt: toNumber(body.minRebalanceUsdt),
        minYieldDeployUsdt: toNumber(body.minYieldDeployUsdt),
        maxActionUsdt: toNumber(body.maxActionUsdt),
        rebalanceCooldownSeconds: toNumber(body.rebalanceCooldownSeconds),
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      });
      res.json({ success: true, policy: updated });
    } catch (err) {
      res.status(400).json({ success: false, error: sanitize(String(err)) });
    }
  });

  app.get('/api/demo/state', async (_req, res) => {
    const demoUserId = process.env.NEXUS_DEMO_USER_ID || 'demo';

    try {
      const { riskAgent } = await import('../agents/risk.js');
      const { listRules } = await import('../core/rules.js');
      const { getOrCreateTreasuryPolicy } = await import('../core/treasury-policy.js');
      const wallet = await getOperatorWalletData();
      const portfolio = await routeMessage('show portfolio summary', demoUserId);
      const market = await routeMessage('show market conditions', demoUserId);
      const limits = await riskAgent.execute({ intent: 'get_limits', params: {}, userId: demoUserId });
      const policy = getOrCreateTreasuryPolicy(demoUserId);
      const rules = listRules(demoUserId);
      const reasoning = getReasoningLog(demoUserId);

      const db = getDb();
      const transactions = db.prepare(`
        SELECT user_id, intent, agent, amount_usdt, tx_hash, status, created_at, metadata
        FROM tx_log
        ORDER BY created_at DESC
        LIMIT 20
      `).all();

      const x402Payments = db.prepare(`
        SELECT user_id, intent, agent, amount_usdt, tx_hash, status, created_at, metadata
        FROM tx_log
        WHERE intent = 'x402_payment'
        ORDER BY created_at DESC
        LIMIT 10
      `).all();

      const receipts = (transactions as Array<Record<string, unknown>>).slice(0, 5).map((tx) => {
        let parsedMetadata: Record<string, unknown> | null = null;
        try {
          parsedMetadata = tx.metadata ? JSON.parse(String(tx.metadata)) as Record<string, unknown> : null;
        } catch {
          parsedMetadata = null;
        }
        return {
          intent: tx.intent,
          agent: tx.agent,
          amountUsdt: tx.amount_usdt,
          txHash: tx.tx_hash,
          status: tx.status,
          createdAt: tx.created_at,
          receiptContext: parsedMetadata?.receiptContext ?? null,
          risk: parsedMetadata?.risk ?? null,
        };
      });

      res.json({
        success: true,
        demo: {
          userId: demoUserId,
          wallet,
          portfolio: portfolio.message,
          market: market.message,
          limits: limits.message,
          policy,
          rules,
          reasoning,
          transactions,
          x402Payments,
          receipts,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: sanitize(String(err)) });
    }
  });

  // Transaction audit log — shows autonomous agent activity
  app.get('/api/tx-log', (req, res) => {
    try {
      const session = getSessionToken(req) ? getWebSession(getSessionToken(req)!) : null;
      const hasApiToken = hasValidApiToken(req, webToken);
      if (!canAccessSensitiveRoute({ hasSession: Boolean(session), hasApiToken })) {
        res.status(401).json({ success: false, error: 'session or api token required' });
        return;
      }

      const db = getDb();
      const rows = session
        ? db.prepare(`
            SELECT user_id, intent, agent, amount_usdt, tx_hash, status, created_at, metadata
            FROM tx_log
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT 50
          `).all(session.userId)
        : db.prepare(`
            SELECT user_id, intent, agent, amount_usdt, tx_hash, status, created_at, metadata
            FROM tx_log
            ORDER BY created_at DESC
            LIMIT 50
          `).all();
      res.json({ success: true, count: rows.length, transactions: rows });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // x402-gated premium market intelligence endpoint
  // Demonstrates the HTTP 402 Payment Required protocol for autonomous agent payments
  app.get('/api/premium/market-intel', async (req, res) => {
    const paymentHeader = req.headers['x-payment'];

    // If no payment proof, return 402 with payment requirements
    if (!paymentHeader) {
      // Use configured address; fall back to wallet address; never use zero address
      let serviceAddress = process.env.PREMIUM_SERVICE_ADDRESS || '';
      if (!serviceAddress || serviceAddress === '0x0000000000000000000000000000000000000000') {
        try {
          const { getOperatorAccount } = await import('../core/wdk-setup.js');
          const account = await getOperatorAccount('ethereum');
          serviceAddress = await account.getAddress();
        } catch {
          serviceAddress = '0x000000000000000000000000000000000000dead'; // burn address — still better than zero
        }
      }
      res.status(402).json({
        x402Version: 1,
        message: 'Payment required for premium market intelligence',
        paymentRequirements: {
          token: 'USDT',
          amount: '0.10',
          recipient: serviceAddress,
          chain: 'ethereum',
          description: 'Premium market intel: APY comparison, risk metrics, yield optimization',
        },
      });
      return;
    }

    // Payment proof provided — serve premium content
    // In production: verify tx hash on-chain. For hackathon demo: trust the proof.
    try {
      const apyData = await fetchPremiumData();
      res.json({
        success: true,
        data: apyData,
        paymentVerified: true,
      });
    } catch {
      res.json({
        success: true,
        data: { message: 'Premium data temporarily unavailable — payment accepted' },
        paymentVerified: true,
      });
    }
  });

  async function fetchPremiumData() {
    try {
      const llamaRes = await fetch('https://api.llama.fi/pools', { signal: AbortSignal.timeout(8000) });
      if (!llamaRes.ok) return { pools: [] };

      const { data } = await llamaRes.json() as {
        data: Array<{ project: string; chain: string; symbol: string; apy: number; tvlUsd: number }>;
      };

      // Top Arbitrum lending pools by APY
      const arbPools = data
        .filter(p => p.chain === 'Arbitrum' && p.apy > 0 && p.tvlUsd > 100000)
        .sort((a, b) => b.apy - a.apy)
        .slice(0, 10)
        .map(p => ({
          protocol: p.project,
          asset: p.symbol,
          apy: `${p.apy.toFixed(2)}%`,
          tvl: `$${(p.tvlUsd / 1e6).toFixed(1)}M`,
        }));

      return {
        timestamp: new Date().toISOString(),
        topArbitrumYields: arbPools,
        recommendation: arbPools.length > 0
          ? `Highest yield: ${arbPools[0].protocol} ${arbPools[0].asset} at ${arbPools[0].apy} APY (TVL: ${arbPools[0].tvl})`
          : 'No yield data available',
      };
    } catch {
      return { pools: [], error: 'DeFiLlama temporarily unreachable' };
    }
  }

  // Autopilot typed events are relayed to WS/SSE clients via addEventSubscriber below.
  // broadcastToAll is intentionally NOT registered — it sends Telegram-formatted text.

  // Global event relay: autopilot typed events → WS clients and SSE clients
  addEventSubscriber((event) => {
    for (const ws of connectedClients) {
      send(ws, { type: 'event', event });
    }
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of sseClients) {
      try { res.write(data); } catch { /* client disconnected */ }
    }
  });

  // SSE stream — every autopilot cycle phase is streamed as typed events
  // curl http://localhost:3000/api/stream
  app.get('/api/stream', (req, res) => {
    if (webToken) {
      const bearer = req.headers.authorization?.replace('Bearer ', '');
      const query = (req.query as Record<string, string>).token;
      if (bearer !== webToken && query !== webToken) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    // Replay buffered events so late joiners see full history
    for (const event of getEventBuffer()) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  // Demo scenario endpoint — forces specific conditions for judge demos
  // POST /api/demo { "scenario": "guard_block" | "force_cycle" | "inject_apy_drop" }
  app.post('/api/demo', express.json(), async (req, res) => {
    const session = getSessionToken(req) ? getWebSession(getSessionToken(req)!) : null;
    const hasApiToken = hasValidApiToken(req, webToken);
    if (!canAccessSensitiveRoute({ hasSession: Boolean(session), hasApiToken })) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { scenario } = req.body as { scenario?: string };
    if (!scenario?.trim()) {
      res.status(400).json({
        success: false,
        error: 'scenario required',
        available: ['guard_block', 'force_cycle', 'inject_apy_drop'],
      });
      return;
    }

    try {
      const { runDemoScenario } = await import('../agents/autopilot.js');
      const result = await runDemoScenario(scenario.trim());
      res.json(result);
    } catch (err) {
      res.status(500).json({ success: false, error: sanitize(String(err)) });
    }
  });

  wss.on('connection', async (ws, req) => {
    // Token auth via query string: ws://localhost:3000?token=<WEB_ACCESS_TOKEN>
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (webToken) {
      const token = url.searchParams.get('token');
      if (token !== webToken) {
        ws.close(4001, 'Unauthorized');
        return;
      }
    }
    connectedClients.add(ws);
    ws.on('close', () => connectedClients.delete(ws));

    const sessionToken = url.searchParams.get('session');
    const session = sessionToken ? getWebSession(sessionToken) : null;
    const userId = resolveSocketUserId(session?.userId);

    const wallet = session
      ? await getWalletData(userId)
      : { ...(await getOperatorWalletData()), mode: 'READ-ONLY' };
    send(ws, { type: 'wallet', wallet });

    // Replay event history so judges see the full autopilot decision trail
    const buffered = getEventBuffer();
    if (buffered.length > 0) {
      send(ws, { type: 'event_replay', events: buffered });
    }

    ws.on('message', async (raw) => {
      let msg: WsMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: 'error', content: 'Invalid message format' });
        return;
      }

      if (msg.type === 'ping') {
        send(ws, { type: 'pong' });
        return;
      }

      if (msg.type === 'wallet_refresh') {
        const updated = session
          ? await getWalletData(userId)
          : { address: 'demo-read-only', chainName: 'Arbitrum One', mode: 'READ-ONLY' };
        send(ws, { type: 'wallet', wallet: updated });
        return;
      }

      const uid = session?.userId ?? userId;

      if (msg.type === 'confirm') {
        const pending = pendingActions.get(uid);
        if (!pending) {
          send(ws, { type: 'error', content: 'No pending action to confirm' });
          return;
        }
        clearPendingAction(uid);
        setActiveUser(uid);
        clearReasoningLog(uid);
        send(ws, { type: 'typing' });

        try {
          const response = await executeDecision(pending, uid);
          addMessage(uid, 'assistant', response.message);
          send(ws, { type: 'response', content: response.message, success: response.success });
          send(ws, { type: 'reasoning', steps: getReasoningLog(uid) });
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          send(ws, { type: 'error', content: sanitize(m) });
        }
        return;
      }

      if (msg.type === 'cancel') {
        clearPendingAction(uid);
        send(ws, { type: 'response', content: 'Cancelled.', success: true });
        return;
      }

      if (msg.type === 'message' && msg.content?.trim()) {
        // Check for pending — treat any non-yes as cancel
        const pending = pendingActions.get(uid);
        if (pending) {
          if (/^(yes|confirm|y)$/i.test(msg.content.trim())) {
            clearPendingAction(uid);
            setActiveUser(uid);
            clearReasoningLog(uid);
            send(ws, { type: 'typing' });
            try {
              const response = await executeDecision(pending, uid);
              addMessage(uid, 'assistant', response.message);
              send(ws, { type: 'response', content: response.message, success: response.success });
              send(ws, { type: 'reasoning', steps: getReasoningLog(uid) });
            } catch (err) {
              const m = err instanceof Error ? err.message : String(err);
              send(ws, { type: 'error', content: sanitize(m) });
            }
          } else {
            clearPendingAction(uid);
            send(ws, { type: 'response', content: 'Cancelled.', success: true });
          }
          return;
        }

        if (msg.content.trim() === '/clear') {
          clearHistory(uid);
          clearReasoningLog(uid);
          send(ws, { type: 'response', content: 'Session cleared.', success: true });
          return;
        }

        if (msg.content.trim() === '/portfolio') {
          const response = await routeMessage('show portfolio summary', uid);
          send(ws, { type: 'response', content: response.message, success: response.success });
          send(ws, { type: 'reasoning', steps: getReasoningLog(uid) });
          return;
        }

        await handleMessage(ws, uid, msg.content.trim(), Boolean(session));
      }
    });

    ws.on('error', (err) => {
      console.error('[WS] error:', err.message);
    });
  });

  httpServer.listen(port, () => {
    console.log(`Web terminal running at http://localhost:${port}`);
  });
}
