import { getAccount } from '../core/wdk-setup.js';
import { resolveTokenOrAddress, parseAmount, fromBaseUnits, resolveToken } from '../core/tokens.js';
import { logReasoning } from '../reasoning/logger.js';
import { pricing } from '../core/pricing.js';
import { config } from '../core/config.js';
import type { Agent, AgentRequest, AgentResponse } from './types.js';

export const swapAgent: Agent = {
  name: 'swap',
  description: 'Token swaps via Velora DEX aggregator.',

  permissions: {
    allowedIntents: ['quote_swap', 'execute_swap'],
    allowedTokens: ['USDT', 'ETH', 'WETH', 'USDC', 'DAI', 'XAUT'],
  },

  async execute(request: AgentRequest): Promise<AgentResponse> {
    const { intent, params, userId } = request;

    switch (intent) {
      case 'quote_swap':
        return quoteSwap(params.chain, params.tokenIn, params.tokenOut, params.amount, userId);
      case 'execute_swap':
        return executeSwap(params.chain, params.tokenIn, params.tokenOut, params.amount, userId);
      default:
        return { success: false, message: `Unknown swap intent: ${intent}` };
    }
  },
};

async function quoteSwap(
  chain: string = 'ethereum',
  tokenIn: string,
  tokenOut: string,
  amount: string,
  userId?: string,
): Promise<AgentResponse> {
  if (!tokenIn || !tokenOut || !amount) {
    return { success: false, message: 'Swap requires tokenIn, tokenOut, and amount.' };
  }

  const tokenInAddress = resolveTokenOrAddress(tokenIn, chain);
  const tokenOutAddress = resolveTokenOrAddress(tokenOut, chain);

  if (!tokenInAddress) return { success: false, message: `Unknown token: ${tokenIn}` };
  if (!tokenOutAddress) return { success: false, message: `Unknown token: ${tokenOut}` };

  const baseAmount = parseAmount(amount, tokenIn, chain);
  if (baseAmount === null) return { success: false, message: `Invalid amount: ${amount}` };

  logReasoning({
    agent: 'Swap',
    action: 'quoteSwap',
    reasoning: `Quoting ${amount} ${tokenIn} -> ${tokenOut} on ${chain} via Velora`,
  });

  try {
    const account = await getAccount(chain, { userId });
    const swap = account.getSwapProtocol('velora');

    const quote = await swap.quoteSwap({
      tokenIn: tokenInAddress,
      tokenOut: tokenOutAddress,
      tokenInAmount: baseAmount,
    });

    const inToken = resolveToken(tokenIn, chain);
    const outToken = resolveToken(tokenOut, chain);
    const readableIn = fromBaseUnits(quote.tokenInAmount, inToken?.decimals ?? 18);
    const readableOut = fromBaseUnits(quote.tokenOutAmount, outToken?.decimals ?? 18);

    const result = [
      `Swap Quote: ${tokenIn} -> ${tokenOut}`,
      `Input: ${readableIn} ${tokenIn}`,
      `Output: ${readableOut} ${tokenOut}`,
      `Fee: ${fromBaseUnits(quote.fee, 18)} ETH`,
    ].join('\n');

    logReasoning({
      agent: 'Swap',
      action: 'quoteSwap',
      reasoning: 'Quote received',
      result,
    });

    return {
      success: true,
      message: result,
      data: {
        tokenIn,
        tokenOut,
        tokenInAmount: String(quote.tokenInAmount),
        tokenOutAmount: String(quote.tokenOutAmount),
        fee: String(quote.fee),
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Swap quote failed: ${msg}` };
  }
}

async function executeSwap(
  chain: string = 'ethereum',
  tokenIn: string,
  tokenOut: string,
  amount: string,
  userId?: string,
): Promise<AgentResponse> {
  if (!tokenIn || !tokenOut || !amount) {
    return { success: false, message: 'Swap requires tokenIn, tokenOut, and amount.' };
  }

  const tokenInAddress = resolveTokenOrAddress(tokenIn, chain);
  const tokenOutAddress = resolveTokenOrAddress(tokenOut, chain);

  if (!tokenInAddress) return { success: false, message: `Unknown token: ${tokenIn}` };
  if (!tokenOutAddress) return { success: false, message: `Unknown token: ${tokenOut}` };

  const baseAmount = parseAmount(amount, tokenIn, chain);
  if (baseAmount === null) return { success: false, message: `Invalid amount: ${amount}` };

  const account = await getAccount(chain, { userId });
  const swap = account.getSwapProtocol('velora');

  // Quote first — surface expected output and check price impact before committing.
  const inToken = resolveToken(tokenIn, chain);
  const outToken = resolveToken(tokenOut, chain);

  let quotedOut = '';
  let priceImpactPct: number | null = null;

  try {
    const quote = await swap.quoteSwap({
      tokenIn: tokenInAddress,
      tokenOut: tokenOutAddress,
      tokenInAmount: baseAmount,
    });

    quotedOut = fromBaseUnits(quote.tokenOutAmount, outToken?.decimals ?? 18);

    // Compare quoted rate against Bitfinex market price to detect price impact.
    try {
      const priceIn = await pricing.getCurrentPrice(tokenIn.toUpperCase(), 'USD');
      const priceOut = await pricing.getCurrentPrice(tokenOut.toUpperCase(), 'USD');

      if (priceIn > 0 && priceOut > 0) {
        const fairOut = (Number(amount) * priceIn) / priceOut;
        priceImpactPct = ((fairOut - Number(quotedOut)) / fairOut) * 100;

        if (priceImpactPct > config.risk.maxSlippagePercent) {
          logReasoning({
            agent: 'Swap',
            action: 'slippageAbort',
            reasoning: `Swap aborted — price impact ${priceImpactPct.toFixed(2)}% exceeds limit of ${config.risk.maxSlippagePercent}%`,
            result: `Would receive ${quotedOut} ${tokenOut} for ${amount} ${tokenIn}`,
            status: 'fail',
          });

          return {
            success: false,
            message: `Swap aborted: price impact is ${priceImpactPct.toFixed(2)}%, which exceeds the ${config.risk.maxSlippagePercent}% limit.\nQuoted output: ${quotedOut} ${tokenOut} for ${amount} ${tokenIn}.\nTry a smaller amount or wait for better liquidity.`,
          };
        }
      }
    } catch {
      // Pricing oracle unavailable — log warning, proceed with the swap.
      logReasoning({
        agent: 'Swap',
        action: 'priceCheckSkipped',
        reasoning: 'Bitfinex price unavailable — proceeding without market impact check',
        status: 'warn',
      });
    }

    logReasoning({
      agent: 'Swap',
      action: 'quoteVerified',
      reasoning: `Quote verified: ${amount} ${tokenIn} → ${quotedOut} ${tokenOut}${priceImpactPct !== null ? ` (impact: ${priceImpactPct.toFixed(2)}%)` : ''}`,
      status: 'pass',
    });
  } catch (err) {
    return { success: false, message: `Pre-swap quote failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  logReasoning({
    agent: 'Swap',
    action: 'executeSwap',
    reasoning: `Executing swap: ${amount} ${tokenIn} → ${tokenOut}`,
  });

  try {
    const result = await swap.swap({
      tokenIn: tokenInAddress,
      tokenOut: tokenOutAddress,
      tokenInAmount: baseAmount,
      // Pass slippage tolerance so the tx reverts rather than executing at a worse price.
      ...({ slippageTolerance: config.risk.maxSlippagePercent / 100 } as object),
    } as Parameters<typeof swap.swap>[0]);

    const readableOut = fromBaseUnits(result.tokenOutAmount, outToken?.decimals ?? 18);
    const impactNote = priceImpactPct !== null ? ` (${priceImpactPct.toFixed(2)}% price impact)` : '';

    logReasoning({
      agent: 'Swap',
      action: 'executeSwap',
      reasoning: 'Swap executed',
      result: `tx: ${result.hash}, received ${readableOut} ${tokenOut}${impactNote}`,
      status: 'pass',
    });

    return {
      success: true,
      message: `Swapped ${amount} ${tokenIn} for ${readableOut} ${tokenOut}${impactNote}\nTx: \`${result.hash}\``,
      data: {
        hash: result.hash,
        tokenIn,
        tokenOut,
        tokenInAmount: String(result.tokenInAmount),
        tokenOutAmount: String(result.tokenOutAmount),
        priceImpactPct: priceImpactPct ?? undefined,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Swap failed: ${msg}` };
  }
}
