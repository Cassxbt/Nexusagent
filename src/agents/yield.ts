import type AaveProtocolEvm from '@tetherto/wdk-protocol-lending-aave-evm';
import { getRuntimeAccount, getAccount } from '../core/wdk-setup.js';
import { resolveTokenOrAddress, parseAmount, fromBaseUnits, resolveToken, getAavePoolAddress } from '../core/tokens.js';
import { llmComplete } from '../reasoning/llm.js';
import { logReasoning } from '../reasoning/logger.js';
import type { Agent, AgentRequest, AgentResponse } from './types.js';

// Aave V3 Arbitrum does not list XAUT as a reserve asset.
// Attempting supply/borrow with XAUT will revert on-chain.
// XAUT can be bridged via wdk-protocol-bridge-usdt0-evm (XAUt0) or used for price queries.
const AAVE_V3_UNSUPPORTED_TOKENS = new Set(['XAUT']);

export const yieldAgent: Agent = {
  name: 'yield',
  description: 'Aave V3 lending: supply, withdraw, borrow, repay, account data, APY monitoring.',

  permissions: {
    allowedIntents: ['quote_supply', 'supply', 'quote_withdraw', 'withdraw', 'account_data', 'quote_borrow', 'borrow', 'quote_repay', 'repay'],
    allowedTokens: ['USDT', 'USDC', 'DAI', 'WETH'],
    allowedContracts: ['0x794a61358D6845594F94dc1DB02A252b5b4814aD'],
  },

  async execute(request: AgentRequest): Promise<AgentResponse> {
    const { intent, params, userId } = request;

    switch (intent) {
      case 'quote_supply':  return quoteSupply(params.chain, params.token, params.amount, userId);
      case 'supply':        return supply(params.chain, params.token, params.amount, userId);
      case 'quote_withdraw':return quoteWithdraw(params.chain, params.token, params.amount, userId);
      case 'withdraw':      return withdraw(params.chain, params.token, params.amount, userId);
      case 'account_data':  return accountData(params.chain, userId);
      case 'quote_borrow':  return quoteBorrow(params.chain, params.token, params.amount, userId);
      case 'borrow':        return borrow(params.chain, params.token, params.amount, params.rateMode, userId);
      case 'quote_repay':   return quoteRepay(params.chain, params.token, params.amount, userId);
      case 'repay':         return repay(params.chain, params.token, params.amount, params.rateMode, userId);
      default:
        return { success: false, message: `Unknown yield intent: ${intent}` };
    }
  },
};

type ResolveResult =
  | { ok: true; tokenAddress: string; baseAmount: bigint }
  | { ok: false; error: string };

function resolveAndValidate(tokenSymbol: string, amount: string, chain: string): ResolveResult {
  const tokenAddress = resolveTokenOrAddress(tokenSymbol, chain);
  if (!tokenAddress) return { ok: false, error: `Unknown token: ${tokenSymbol}. Supported: USDT, USDC, DAI, WETH, XAUT` };

  const baseAmount = parseAmount(amount, tokenSymbol, chain);
  if (baseAmount === null) return { ok: false, error: `Invalid amount: ${amount}` };

  return { ok: true, tokenAddress, baseAmount };
}

function getLending(account: Awaited<ReturnType<typeof getAccount>>) {
  return account.getLendingProtocol('aave') as unknown as InstanceType<typeof AaveProtocolEvm>;
}

async function quoteSupply(chain = 'ethereum', token: string, amount: string, userId?: string): Promise<AgentResponse> {
  if (!token || !amount) return { success: false, message: 'Supply requires token and amount.' };
  if (AAVE_V3_UNSUPPORTED_TOKENS.has(token.toUpperCase())) {
    return { success: false, message: `${token} is not supported as an Aave V3 collateral asset on Arbitrum. Use "bridge XAUT" to move XAUt0 cross-chain, or "get price XAUT" for price data.` };
  }

  const resolved = resolveAndValidate(token, amount, chain);
  if (!resolved.ok) return { success: false, message: resolved.error };

  logReasoning({ agent: 'Yield', action: 'quoteSupply', reasoning: `Quoting supply of ${amount} ${token} to Aave V3`, status: 'pass' });

  try {
    const account = await getRuntimeAccount(chain, userId);
    const lending = account.getLendingProtocol('aave');
    const quote = await lending.quoteSupply({ token: resolved.tokenAddress, amount: resolved.baseAmount });

    logReasoning({ agent: 'Yield', action: 'quoteSupply', reasoning: 'Quote received', result: `Fee: ${fromBaseUnits(quote.fee, 18)} ETH`, status: 'pass' });

    return {
      success: true,
      message: `Supply quote: ${amount} ${token} to Aave V3\nEstimated fee: ${fromBaseUnits(quote.fee, 18)} ETH`,
      data: { token, amount, fee: String(quote.fee) },
    };
  } catch (err) {
    return { success: false, message: `Supply quote failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function supply(chain = 'ethereum', token: string, amount: string, userId?: string): Promise<AgentResponse> {
  if (!token || !amount) return { success: false, message: 'Supply requires token and amount.' };
  if (AAVE_V3_UNSUPPORTED_TOKENS.has(token.toUpperCase())) {
    return { success: false, message: `${token} is not supported as an Aave V3 collateral asset on Arbitrum. Use "bridge XAUT" to move XAUt0 cross-chain, or "get price XAUT" for price data.` };
  }

  const resolved = resolveAndValidate(token, amount, chain);
  if (!resolved.ok) return { success: false, message: resolved.error };

  const poolAddress = getAavePoolAddress(chain);
  if (!poolAddress) return { success: false, message: `Aave V3 not supported on ${chain}` };

  logReasoning({ agent: 'Yield', action: 'supply', reasoning: `Supplying ${amount} ${token} to Aave V3 on ${chain}`, status: 'pass' });

  try {
    const account = await getRuntimeAccount(chain, userId);

    logReasoning({ agent: 'Yield', action: 'approve', reasoning: `Approving Aave Pool to spend ${amount} ${token}`, status: 'pass' });
    await account.approve({ token: resolved.tokenAddress, spender: poolAddress, amount: resolved.baseAmount });
    logReasoning({ agent: 'Yield', action: 'approve', reasoning: 'Approval confirmed', status: 'pass' });

    const lending = account.getLendingProtocol('aave');
    const result = await lending.supply({ token: resolved.tokenAddress, amount: resolved.baseAmount });

    logReasoning({ agent: 'Yield', action: 'supply', reasoning: 'Supply executed', result: `tx: ${result.hash}`, status: 'pass' });

    return {
      success: true,
      message: `Supplied ${amount} ${token} to Aave V3\nTx: \`${result.hash}\``,
      data: { hash: result.hash, token, amount },
    };
  } catch (err) {
    return { success: false, message: `Supply failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function quoteWithdraw(chain = 'ethereum', token: string, amount: string, userId?: string): Promise<AgentResponse> {
  if (!token || !amount) return { success: false, message: 'Withdraw requires token and amount.' };

  const resolved = resolveAndValidate(token, amount, chain);
  if (!resolved.ok) return { success: false, message: resolved.error };

  try {
    const account = await getRuntimeAccount(chain, userId);
    const lending = account.getLendingProtocol('aave');
    const quote = await lending.quoteWithdraw({ token: resolved.tokenAddress, amount: resolved.baseAmount });

    return {
      success: true,
      message: `Withdraw quote: ${amount} ${token} from Aave V3\nEstimated fee: ${fromBaseUnits(quote.fee, 18)} ETH`,
      data: { token, amount, fee: String(quote.fee) },
    };
  } catch (err) {
    return { success: false, message: `Withdraw quote failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function withdraw(chain = 'ethereum', token: string, amount: string, userId?: string): Promise<AgentResponse> {
  if (!token || !amount) return { success: false, message: 'Withdraw requires token and amount.' };

  const resolved = resolveAndValidate(token, amount, chain);
  if (!resolved.ok) return { success: false, message: resolved.error };

  logReasoning({ agent: 'Yield', action: 'withdraw', reasoning: `Withdrawing ${amount} ${token} from Aave V3`, status: 'pass' });

  try {
    const account = await getRuntimeAccount(chain, userId);
    const lending = account.getLendingProtocol('aave');
    const result = await lending.withdraw({ token: resolved.tokenAddress, amount: resolved.baseAmount });

    logReasoning({ agent: 'Yield', action: 'withdraw', reasoning: 'Withdrawal executed', result: `tx: ${result.hash}`, status: 'pass' });

    return {
      success: true,
      message: `Withdrew ${amount} ${token} from Aave V3\nTx: \`${result.hash}\``,
      data: { hash: result.hash, token, amount },
    };
  } catch (err) {
    return { success: false, message: `Withdrawal failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function quoteBorrow(chain = 'ethereum', token: string, amount: string, userId?: string): Promise<AgentResponse> {
  if (!token || !amount) return { success: false, message: 'Borrow requires token and amount.' };
  if (AAVE_V3_UNSUPPORTED_TOKENS.has(token.toUpperCase())) {
    return { success: false, message: `${token} is not available for borrowing on Aave V3 Arbitrum.` };
  }

  const resolved = resolveAndValidate(token, amount, chain);
  if (!resolved.ok) return { success: false, message: resolved.error };

  logReasoning({ agent: 'Yield', action: 'quoteBorrow', reasoning: `Quoting borrow of ${amount} ${token} from Aave V3`, status: 'pass' });

  try {
    const account = await getRuntimeAccount(chain, userId);
    const lending = getLending(account);
    const quote = await lending.quoteBorrow({ token: resolved.tokenAddress, amount: resolved.baseAmount });

    const fee = quote?.fee ? fromBaseUnits(BigInt(quote.fee), 18) : '0';

    return {
      success: true,
      message: `Borrow quote: ${amount} ${token} from Aave V3\nEstimated fee: ${fee} ETH`,
      data: { token, amount, fee: String(quote?.fee ?? 0) },
    };
  } catch (err) {
    return { success: false, message: `Borrow quote failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function borrow(chain = 'ethereum', token: string, amount: string, rateMode = '2', userId?: string): Promise<AgentResponse> {
  if (!token || !amount) return { success: false, message: 'Borrow requires token and amount.' };
  if (AAVE_V3_UNSUPPORTED_TOKENS.has(token.toUpperCase())) {
    return { success: false, message: `${token} is not available for borrowing on Aave V3 Arbitrum.` };
  }

  const resolved = resolveAndValidate(token, amount, chain);
  if (!resolved.ok) return { success: false, message: resolved.error };

  logReasoning({ agent: 'Yield', action: 'borrow', reasoning: `Borrowing ${amount} ${token} from Aave V3 (rate mode: ${rateMode === '1' ? 'stable' : 'variable'})`, status: 'pass' });

  try {
    const account = await getRuntimeAccount(chain, userId);
    const lending = getLending(account);
    const result = await lending.borrow({
      token: resolved.tokenAddress,
      amount: resolved.baseAmount,
      ...({ interestRateMode: parseInt(rateMode, 10) } as Record<string, unknown>),
    });

    logReasoning({ agent: 'Yield', action: 'borrow', reasoning: 'Borrow executed', result: `tx: ${result.hash}`, status: 'pass' });

    return {
      success: true,
      message: `Borrowed ${amount} ${token} from Aave V3\nRate mode: ${rateMode === '1' ? 'Stable' : 'Variable'}\nTx: \`${result.hash}\``,
      data: { hash: result.hash, token, amount, rateMode },
    };
  } catch (err) {
    return { success: false, message: `Borrow failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function quoteRepay(chain = 'ethereum', token: string, amount: string, userId?: string): Promise<AgentResponse> {
  if (!token || !amount) return { success: false, message: 'Repay requires token and amount.' };

  const resolved = resolveAndValidate(token, amount, chain);
  if (!resolved.ok) return { success: false, message: resolved.error };

  try {
    const account = await getRuntimeAccount(chain, userId);
    const lending = getLending(account);
    const quote = await lending.quoteRepay({ token: resolved.tokenAddress, amount: resolved.baseAmount });

    const fee = quote?.fee ? fromBaseUnits(BigInt(quote.fee), 18) : '0';

    return {
      success: true,
      message: `Repay quote: ${amount} ${token} to Aave V3\nEstimated fee: ${fee} ETH`,
      data: { token, amount, fee: String(quote?.fee ?? 0) },
    };
  } catch (err) {
    return { success: false, message: `Repay quote failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function repay(chain = 'ethereum', token: string, amount: string, rateMode = '2', userId?: string): Promise<AgentResponse> {
  if (!token || !amount) return { success: false, message: 'Repay requires token and amount.' };

  const resolved = resolveAndValidate(token, amount, chain);
  if (!resolved.ok) return { success: false, message: resolved.error };

  const poolAddress = getAavePoolAddress(chain);
  if (!poolAddress) return { success: false, message: `Aave V3 not supported on ${chain}` };

  logReasoning({ agent: 'Yield', action: 'repay', reasoning: `Repaying ${amount} ${token} to Aave V3`, status: 'pass' });

  try {
    const account = await getRuntimeAccount(chain, userId);

    await account.approve({ token: resolved.tokenAddress, spender: poolAddress, amount: resolved.baseAmount });
    logReasoning({ agent: 'Yield', action: 'approve', reasoning: 'Approval for repay confirmed', status: 'pass' });

    const lending = getLending(account);
    const result = await lending.repay({
      token: resolved.tokenAddress,
      amount: resolved.baseAmount,
      ...({ interestRateMode: parseInt(rateMode, 10) } as Record<string, unknown>),
    });

    logReasoning({ agent: 'Yield', action: 'repay', reasoning: 'Repay executed', result: `tx: ${result.hash}`, status: 'pass' });

    return {
      success: true,
      message: `Repaid ${amount} ${token} to Aave V3\nTx: \`${result.hash}\``,
      data: { hash: result.hash, token, amount },
    };
  } catch (err) {
    return { success: false, message: `Repay failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function accountData(chain = 'ethereum', userId?: string): Promise<AgentResponse> {
  logReasoning({ agent: 'Yield', action: 'accountData', reasoning: `Fetching Aave V3 account data on ${chain}`, status: 'pass' });

  try {
    const account = await getRuntimeAccount(chain, userId);
    const lending = getLending(account);
    const data = await lending.getAccountData();

    const commentary = await llmComplete(
      [
        {
          role: 'system',
          content: 'You are a DeFi yield analyst. Interpret this Aave V3 account data in 2-3 sentences. Mention health factor, available borrows, and any risks. All values are in base units (bigint). Be specific about numbers.',
        },
        {
          role: 'user',
          content: `Aave V3 account data: ${JSON.stringify(data, (_k, v) => typeof v === 'bigint' ? v.toString() : v)}`,
        },
      ],
      { model: 'routing' },
    );

    return {
      success: true,
      message: `*Aave V3 Position:*\n${commentary}`,
      data: { accountData: data },
      reasoning: commentary,
    };
  } catch (err) {
    return { success: false, message: `Account data fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
