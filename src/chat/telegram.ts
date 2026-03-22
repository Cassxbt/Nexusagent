import { Bot } from 'grammy';
import { config } from '../core/config.js';
import {
  analyzeMessage,
  executeDecision,
  needsConfirmation,
  formatConfirmation,
  routeMessage,
} from '../agents/coordinator.js';
import { isErc4337Mode } from '../core/wdk-setup.js';
import type { RouteDecision } from '../agents/types.js';
import {
  getReasoningLog,
  clearReasoningLog,
  formatReasoningForUser,
  setActiveUser,
} from '../reasoning/logger.js';
import { addMessage, clearHistory } from '../reasoning/memory.js';
import { getUserAccountContext } from '../core/account-context.js';

const allowedUsers: Set<string> | null = (() => {
  const raw = process.env.TELEGRAM_ALLOWED_USERS;
  if (!raw) return null;
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
})();

function isAuthorized(userId: string): boolean {
  return allowedUsers === null || allowedUsers.has(userId);
}

const pendingActions = new Map<string, RouteDecision>();

function sanitizeError(msg: string): string {
  return msg
    .replace(/https?:\/\/[^\s]+/g, '[RPC]')
    .replace(/0x[a-fA-F0-9]{64}/g, '0x...')
    .replace(/at\s+\S+\s+\(.*\)/g, '')
    .slice(0, 300);
}

export function createBot(): Bot {
  const bot = new Bot(config.telegram.botToken);

  bot.use(async (ctx, next) => {
    const userId = String(ctx.from?.id ?? '');
    if (!isAuthorized(userId)) {
      await ctx.reply('Unauthorized.');
      return;
    }
    return next();
  });

  bot.command('start', async (ctx) => {
    const userId = String(ctx.from?.id ?? 'unknown');
    setActiveUser(userId);

    let portfolioSection = '';
    try {
      const response = await routeMessage('show portfolio summary', userId);
      if (response.success) portfolioSection = `\n\n${response.message}`;
    } catch {
      // non-blocking
    }

    await sendReply(ctx,
      '*Nexus* — Autonomous treasury agent on Arbitrum\n\n' +
      '*Systems:* Coordinator · Treasury · Market · Swap · Yield · Risk · Bridge\n' +
      portfolioSection +
      '\n\n_Try: "What\'s my balance?" or "Put 100 USDT to work"_',
    );
  });

  bot.command('health', async (ctx) => {
    const userId = String(ctx.from?.id ?? 'unknown');
    setActiveUser(userId);

    const { getWdk } = await import('../core/wdk-setup.js');
    let wdkStatus = 'online';
    let chainStatus = 'unknown';
    let walletAddress = 'unknown';

    try {
      const { getAccount } = await import('../core/wdk-setup.js');
      const account = await getAccount('ethereum', { userId });
      walletAddress = await account.getAddress();
      const balance = await account.getBalance();
      chainStatus = `Arbitrum One — ${balance > 0n ? 'funded' : 'unfunded'}`;
    } catch (err) {
      wdkStatus = 'error';
      chainStatus = err instanceof Error ? err.message.slice(0, 60) : 'unavailable';
    }

    const { isAutopilotRunning } = await import('../agents/autopilot.js').catch(() => ({ isAutopilotRunning: () => false }));

    const ctxAccount = getUserAccountContext(userId, 'ethereum');
    const walletMode = ctxAccount?.walletMode === 'erc4337'
      ? 'ERC-4337 (Account Abstraction)'
      : ctxAccount?.walletMode === 'eoa'
        ? 'Standard EOA'
        : isErc4337Mode() ? 'ERC-4337 (Account Abstraction)' : 'Standard EOA';

    const lines = [
      '*System Health*',
      `WDK: ${wdkStatus}`,
      `Chain: ${chainStatus}`,
      `Wallet: \`${walletAddress.slice(0, 10)}...${walletAddress.slice(-8)}\``,
      `Mode: ${walletMode}`,
      `Agents: coordinator · treasury · market · swap · yield · risk · bridge`,
      `Autopilot: ${isAutopilotRunning() ? 'active (5-min cycle)' : 'inactive'}`,
    ];

    await sendReply(ctx, lines.join('\n'));
  });

  bot.command('reasoning', async (ctx) => {
    const userId = String(ctx.from?.id ?? 'unknown');
    const log = getReasoningLog(userId);
    if (log.length === 0) {
      await ctx.reply('No reasoning recorded for this session.');
      return;
    }
    await sendReply(ctx, `*Agent Reasoning:*\n\n${formatReasoningForUser(log)}`);
  });

  bot.command('limits', async (ctx) => {
    const userId = String(ctx.from?.id ?? 'unknown');
    setActiveUser(userId);
    clearReasoningLog(userId);
    const response = await routeMessage('show my risk limits', userId);
    await sendReply(ctx, response.message);
  });

  bot.command('portfolio', async (ctx) => {
    const userId = String(ctx.from?.id ?? 'unknown');
    setActiveUser(userId);
    clearReasoningLog(userId);
    const response = await routeMessage('show portfolio summary', userId);
    await sendReply(ctx, response.message);
  });

  bot.command('guard', async (ctx) => {
    const userId = String(ctx.from?.id ?? 'unknown');
    setActiveUser(userId);

    try {
      const { getGuardParams } = await import('../core/guard.js');
      const p = await getGuardParams();
      const sourceLabel = p.source === 'on-chain'
        ? `✅ on-chain (${process.env.NEXUS_GUARD_ADDRESS?.slice(0, 10)}...)`
        : '⚠️ config fallback (contract not deployed)';

      const lines = [
        '*NexusGuard Risk Parameters*',
        `Source: ${sourceLabel}`,
        `Status: ${p.paused ? '🚫 PAUSED — all agent txs blocked' : '🟢 active'}`,
        `Max transaction: $${p.maxTransactionUsdt.toLocaleString()} USDT`,
        `Daily limit: $${p.dailyLimitUsdt.toLocaleString()} USDT`,
        `Max slippage: ${p.maxSlippagePercent}%`,
        `Cooldown: ${p.cooldownSeconds}s`,
      ];

      await sendReply(ctx, lines.join('\n'));
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 100) : String(err);
      await ctx.reply(`Failed to read guard params: ${msg}`);
    }
  });

  bot.command('clear', async (ctx) => {
    const userId = String(ctx.from?.id ?? 'unknown');
    clearHistory(userId);
    clearReasoningLog(userId);
    pendingActions.delete(userId);
    await ctx.reply('Session cleared.');
  });

  bot.on('message:text', async (ctx) => {
    const userMessage = ctx.message.text;
    const userId = String(ctx.from.id);
    setActiveUser(userId);

    const pending = pendingActions.get(userId);
    if (pending) {
      pendingActions.delete(userId);

      if (/^(yes|confirm|y)$/i.test(userMessage.trim())) {
        addMessage(userId, 'user', userMessage);
        clearReasoningLog(userId);

        try {
          const response = await executeDecision(pending, userId);
          addMessage(userId, 'assistant', response.message);
          await sendReplyWithReasoning(ctx, response.message, userId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('Execution error:', msg);
          await ctx.reply(`Error: ${sanitizeError(msg)}`);
        }
        return;
      }

      await ctx.reply('Cancelled.');
    }

    addMessage(userId, 'user', userMessage);
    clearReasoningLog(userId);

    try {
      const decision = await analyzeMessage(userMessage, userId);

      if (needsConfirmation(decision)) {
        // Pre-check risk so the confirmation message shows score + factors
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
          // Non-blocking — confirmation still shows without risk info
        }

        pendingActions.set(userId, decision);
        const prompt = formatConfirmation(decision, preRiskScore, preRiskTier, preFactors, undefined);
        await sendReply(ctx, prompt);
        return;
      }

      const response = await executeDecision(decision, userId);
      addMessage(userId, 'assistant', response.message);
      await sendReplyWithReasoning(ctx, response.message, userId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Message handler error:', msg);
      await ctx.reply(`Error: ${sanitizeError(msg)}`);
    }
  });

  return bot;
}

async function sendReplyWithReasoning(
  ctx: { reply: (text: string, options?: Record<string, unknown>) => Promise<unknown> },
  message: string,
  userId: string,
): Promise<void> {
  const log = getReasoningLog(userId);
  const reply = log.length > 0
    ? `${message}\n\n*Agent Reasoning:*\n${formatReasoningForUser(log)}`
    : message;

  await sendReply(ctx, reply);
}

async function sendReply(
  ctx: { reply: (text: string, options?: Record<string, unknown>) => Promise<unknown> },
  text: string,
): Promise<void> {
  const truncated = text.length > 4000
    ? text.slice(0, 3950) + '\n_[truncated — use /reasoning for full log]_'
    : text;

  try {
    await ctx.reply(truncated, { parse_mode: 'Markdown' });
  } catch {
    await ctx.reply(truncated);
  }
}
