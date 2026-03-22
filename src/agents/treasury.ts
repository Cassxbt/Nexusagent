import { getAccount } from '../core/wdk-setup.js';
import { resolveTokenOrAddress, parseAmount, isAddress, fromBaseUnits, resolveToken } from '../core/tokens.js';
import { logReasoning } from '../reasoning/logger.js';
import type { Agent, AgentRequest, AgentResponse } from './types.js';

export const treasuryAgent: Agent = {
  name: 'treasury',
  description: 'Manages WDK wallets: balances, addresses, transfers, fee estimates.',

  permissions: {
    allowedIntents: ['get_balance', 'get_address', 'get_token_balance', 'transfer', 'estimate_fee'],
    allowedTokens: ['USDT', 'ETH', 'WETH', 'USDC', 'DAI', 'XAUT'],
  },

  async execute(request: AgentRequest): Promise<AgentResponse> {
    const { intent, params, userId } = request;

    switch (intent) {
      case 'get_balance':
        return getBalance(params.chain, userId);
      case 'get_address':
        return getAddress(params.chain, userId);
      case 'get_token_balance':
        return getTokenBalance(params.chain, params.token, userId);
      case 'transfer':
        return transfer(params.chain, params.to, params.amount, params.token, userId);
      case 'estimate_fee':
        return estimateFee(params.chain, params.to, params.amount, userId);
      default:
        return { success: false, message: `Unknown treasury intent: ${intent}` };
    }
  },
};

async function getBalance(chain: string = 'ethereum', userId?: string): Promise<AgentResponse> {
  logReasoning({
    agent: 'Treasury',
    action: 'getBalance',
    reasoning: `Fetching native balance on ${chain}`,
  });

  try {
    const account = await getAccount(chain, { userId });
    const balance = await account.getBalance();
    const readable = fromBaseUnits(balance, 18);

    logReasoning({
      agent: 'Treasury',
      action: 'getBalance',
      reasoning: 'Balance retrieved',
      result: `${readable} ETH`,
    });

    return {
      success: true,
      message: `Balance on ${chain}: ${readable} ETH`,
      data: { chain, balance: String(balance), readable },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Failed to get balance: ${msg}` };
  }
}

async function getAddress(chain: string = 'ethereum', userId?: string): Promise<AgentResponse> {
  logReasoning({
    agent: 'Treasury',
    action: 'getAddress',
    reasoning: `Fetching wallet address on ${chain}`,
  });

  try {
    const account = await getAccount(chain, { userId });
    const address = await account.getAddress();

    return {
      success: true,
      message: `Your ${chain} address: ${address}`,
      data: { chain, address },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Failed to get address: ${msg}` };
  }
}

async function getTokenBalance(
  chain: string = 'ethereum',
  tokenSymbol?: string,
  userId?: string,
): Promise<AgentResponse> {
  const symbol = tokenSymbol || 'USDT';
  const tokenAddress = resolveTokenOrAddress(symbol, chain);

  if (!tokenAddress) {
    return { success: false, message: `Unknown token: ${symbol}. Supported: ETH, USDT, USDC, DAI, WETH, XAUT` };
  }

  logReasoning({
    agent: 'Treasury',
    action: 'getTokenBalance',
    reasoning: `Fetching ${symbol} balance on ${chain}`,
  });

  try {
    const account = await getAccount(chain, { userId });
    const balance = await account.getTokenBalance(tokenAddress);
    const token = resolveToken(symbol, chain);
    const readable = fromBaseUnits(balance, token?.decimals ?? 18);

    return {
      success: true,
      message: `${symbol} balance on ${chain}: ${readable}`,
      data: { chain, token: symbol, balance: String(balance), readable },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Failed to get token balance: ${msg}` };
  }
}

async function transfer(
  chain: string = 'ethereum',
  to: string,
  amount: string,
  tokenSymbol?: string,
  userId?: string,
): Promise<AgentResponse> {
  if (!to || !amount) {
    return { success: false, message: 'Transfer requires `to` address and `amount`.' };
  }

  if (!isAddress(to)) {
    return { success: false, message: `Invalid recipient address: ${to}` };
  }

  logReasoning({
    agent: 'Treasury',
    action: 'transfer',
    reasoning: `Transferring ${amount} ${tokenSymbol || 'ETH'} to ${to} on ${chain}`,
  });

  try {
    const account = await getAccount(chain, { userId });

    if (tokenSymbol) {
      const tokenAddress = resolveTokenOrAddress(tokenSymbol, chain);
      if (!tokenAddress) {
        return { success: false, message: `Unknown token: ${tokenSymbol}` };
      }

      const baseAmount = parseAmount(amount, tokenSymbol, chain);
      if (baseAmount === null) {
        return { success: false, message: `Invalid amount: ${amount}` };
      }

      const result = await account.transfer({ token: tokenAddress, recipient: to, amount: baseAmount });
      logReasoning({
        agent: 'Treasury',
        action: 'transfer',
        reasoning: 'Token transfer executed',
        result: `tx: ${result.hash}`,
      });
      return {
        success: true,
        message: `Sent ${amount} ${tokenSymbol} to ${to}\nTx: ${result.hash}`,
        data: { hash: result.hash, chain, to, amount, token: tokenSymbol },
      };
    }

    const baseAmount = parseAmount(amount, 'ETH', chain);
    if (baseAmount === null) {
      return { success: false, message: `Invalid amount: ${amount}` };
    }

    const result = await account.sendTransaction({ to, value: baseAmount });
    logReasoning({
      agent: 'Treasury',
      action: 'sendTransaction',
      reasoning: 'Native transfer executed',
      result: `tx: ${result.hash}`,
    });
    return {
      success: true,
      message: `Sent ${amount} ETH to ${to}\nTx: ${result.hash}`,
      data: { hash: result.hash, chain, to, amount },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Transfer failed: ${msg}` };
  }
}

async function estimateFee(
  chain: string = 'ethereum',
  to: string,
  amount: string,
  userId?: string,
): Promise<AgentResponse> {
  if (!to || !isAddress(to)) {
    return { success: false, message: 'Fee estimate requires a valid `to` address.' };
  }

  logReasoning({
    agent: 'Treasury',
    action: 'estimateFee',
    reasoning: `Estimating fee for ${amount} to ${to} on ${chain}`,
  });

  try {
    const account = await getAccount(chain, { userId });
    const baseAmount = parseAmount(amount || '0', 'ETH', chain);
    const quote = await account.quoteSendTransaction({ to, value: baseAmount ?? 0n });

    return {
      success: true,
      message: `Estimated fee: ${fromBaseUnits(quote.fee, 18)} ETH`,
      data: { chain, fee: String(quote.fee) },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Fee estimation failed: ${msg}` };
  }
}
