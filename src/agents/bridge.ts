import type Usdt0ProtocolEvm from '@tetherto/wdk-protocol-bridge-usdt0-evm';
import { getAddress, isAddress } from 'ethers';
import { getAccount } from '../core/wdk-setup.js';
import { resolveTokenOrAddress, parseAmount, fromBaseUnits } from '../core/tokens.js';
import { logReasoning } from '../reasoning/logger.js';
import type { Agent, AgentRequest, AgentResponse } from './types.js';

// USDT0 supports bridging USDT across EVM chains
const SUPPORTED_TOKENS = ['USDT'];
const SUPPORTED_TARGET_CHAINS = ['ethereum', 'base', 'polygon', 'optimism'];
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const bridgeAgent: Agent = {
  name: 'bridge',
  description: 'Cross-chain USDT bridge via USDT0 protocol — move USDT between Arbitrum and other EVM chains.',

  permissions: {
    allowedIntents: ['quote_bridge', 'execute_bridge'],
    allowedTokens: ['USDT'],
  },

  async execute(request: AgentRequest): Promise<AgentResponse> {
    const { intent, params, userId } = request;

    switch (intent) {
      case 'quote_bridge':
        return quoteBridge(params.chain, params.targetChain, params.token, params.amount, params.recipient, userId);
      case 'execute_bridge':
        return executeBridge(params.chain, params.targetChain, params.token, params.amount, params.recipient, userId);
      default:
        return { success: false, message: `Unknown bridge intent: ${intent}` };
    }
  },
};

function getBridge(account: Awaited<ReturnType<typeof getAccount>>) {
  return account.getBridgeProtocol('usdt0') as unknown as InstanceType<typeof Usdt0ProtocolEvm>;
}

async function quoteBridge(
  chain = 'ethereum',
  targetChain: string,
  token: string,
  amount: string,
  recipient: string,
  userId?: string,
): Promise<AgentResponse> {
  const validation = validate(token, amount, targetChain, recipient, chain);
  if (!validation.ok) return { success: false, message: validation.error };

  logReasoning({
    agent: 'Bridge',
    action: 'quoteBridge',
    reasoning: `Quoting bridge of ${amount} ${token} from ${chain} → ${targetChain}`,
    status: 'pass',
  });

  try {
    const account = await getAccount(chain, { userId });
    const bridge = getBridge(account);

    const quote = await bridge.quoteBridge({
      targetChain,
      recipient: validation.recipient,
      token: validation.tokenAddress,
      amount: validation.baseAmount,
    });

    const fee = fromBaseUnits(quote.fee, 18);
    const bridgeFee = fromBaseUnits(quote.bridgeFee, 18);

    return {
      success: true,
      message: [
        `Bridge Quote: ${amount} ${token} → ${targetChain}`,
        `Recipient: \`${validation.recipient.slice(0, 10)}...${validation.recipient.slice(-8)}\``,
        `Gas fee: ${fee} ETH`,
        `Bridge fee: ${bridgeFee} ETH`,
      ].join('\n'),
      data: { token, amount, targetChain, recipient: validation.recipient, fee: String(quote.fee), bridgeFee: String(quote.bridgeFee) },
    };
  } catch (err) {
    return { success: false, message: `Bridge quote failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function executeBridge(
  chain = 'ethereum',
  targetChain: string,
  token: string,
  amount: string,
  recipient: string,
  userId?: string,
): Promise<AgentResponse> {
  const validation = validate(token, amount, targetChain, recipient, chain);
  if (!validation.ok) return { success: false, message: validation.error };

  const poolAddress = '0xc026395860Db2d07ee33e05fE50ed7bD583189C7'; // USDT0 Arbitrum router

  logReasoning({
    agent: 'Bridge',
    action: 'executeBridge',
    reasoning: `Bridging ${amount} ${token} from Arbitrum → ${targetChain} to ${recipient}`,
    status: 'pass',
  });

  try {
    const account = await getAccount(chain, { userId });

    logReasoning({ agent: 'Bridge', action: 'approve', reasoning: `Approving USDT0 router to spend ${amount} USDT`, status: 'pass' });
    await account.approve({ token: validation.tokenAddress, spender: poolAddress, amount: validation.baseAmount });

    const bridge = getBridge(account);
    const result = await bridge.bridge({
      targetChain,
      recipient: validation.recipient,
      token: validation.tokenAddress,
      amount: validation.baseAmount,
    });

    logReasoning({
      agent: 'Bridge',
      action: 'executeBridge',
      reasoning: 'Bridge executed',
      result: `tx: ${result.hash}`,
      status: 'pass',
    });

    return {
      success: true,
      message: [
        `Bridging ${amount} ${token} → ${targetChain}`,
        `Recipient: \`${validation.recipient}\``,
        `Tx: \`${result.hash}\``,
        result.approveHash ? `Approve Tx: \`${result.approveHash}\`` : '',
      ].filter(Boolean).join('\n'),
      data: { hash: result.hash, approveHash: result.approveHash, token, amount, targetChain, recipient: validation.recipient },
    };
  } catch (err) {
    return { success: false, message: `Bridge failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

type ValidationResult =
  | { ok: true; tokenAddress: string; baseAmount: bigint; recipient: string }
  | { ok: false; error: string };

export function normalizeBridgeRecipient(recipient: string): string {
  const trimmed = recipient.trim();
  if (!isAddress(trimmed)) {
    throw new Error('Invalid bridge recipient address');
  }

  const normalized = getAddress(trimmed);
  if (normalized.toLowerCase() === ZERO_ADDRESS) {
    throw new Error('Bridge recipient cannot be the zero address');
  }

  return normalized;
}

function validate(token: string, amount: string, targetChain: string, recipient: string, chain: string): ValidationResult {
  if (!token || !amount || !targetChain || !recipient) {
    return { ok: false, error: 'Bridge requires token, amount, targetChain, and recipient.' };
  }

  if (!SUPPORTED_TOKENS.includes(token.toUpperCase())) {
    return { ok: false, error: `USDT0 bridge only supports USDT. Got: ${token}` };
  }

  if (!SUPPORTED_TARGET_CHAINS.includes(targetChain.toLowerCase())) {
    return { ok: false, error: `Unsupported target chain: ${targetChain}. Supported: ${SUPPORTED_TARGET_CHAINS.join(', ')}` };
  }

  const tokenAddress = resolveTokenOrAddress(token, chain);
  if (!tokenAddress) return { ok: false, error: `Cannot resolve ${token} address on ${chain}` };

  const baseAmount = parseAmount(amount, token, chain);
  if (baseAmount === null) return { ok: false, error: `Invalid amount: ${amount}` };

  let normalizedRecipient: string;
  try {
    normalizedRecipient = normalizeBridgeRecipient(recipient);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Invalid bridge recipient address' };
  }

  return { ok: true, tokenAddress, baseAmount, recipient: normalizedRecipient };
}
