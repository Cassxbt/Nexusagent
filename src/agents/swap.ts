import { getAccount } from '../core/wdk-setup.js';
import { resolveTokenOrAddress, parseAmount, fromBaseUnits, resolveToken } from '../core/tokens.js';
import { logReasoning } from '../reasoning/logger.js';
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

  logReasoning({
    agent: 'Swap',
    action: 'executeSwap',
    reasoning: `Executing swap: ${amount} ${tokenIn} -> ${tokenOut} on ${chain}`,
  });

  try {
    const account = await getAccount(chain, { userId });
    const swap = account.getSwapProtocol('velora');

    const result = await swap.swap({
      tokenIn: tokenInAddress,
      tokenOut: tokenOutAddress,
      tokenInAmount: baseAmount,
    });

    const outToken = resolveToken(tokenOut, chain);
    const readableOut = fromBaseUnits(result.tokenOutAmount, outToken?.decimals ?? 18);

    logReasoning({
      agent: 'Swap',
      action: 'executeSwap',
      reasoning: 'Swap executed',
      result: `tx: ${result.hash}, received ${readableOut} ${tokenOut}`,
    });

    return {
      success: true,
      message: `Swapped ${amount} ${tokenIn} for ${readableOut} ${tokenOut}\nTx: ${result.hash}`,
      data: {
        hash: result.hash,
        tokenIn,
        tokenOut,
        tokenInAmount: String(result.tokenInAmount),
        tokenOutAmount: String(result.tokenOutAmount),
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Swap failed: ${msg}` };
  }
}
