import { config } from './config.js';

/**
 * NexusGuard — on-chain risk parameter reader.
 *
 * Fetches risk limits from the NexusGuard smart contract on Arbitrum.
 * The AI agent reads these limits but cannot modify them — only the
 * wallet owner can update them via a signed on-chain transaction.
 *
 * Falls back to config.risk values if the contract is not deployed
 * or the RPC call fails. Manual flows may still use fallback limits,
 * but autonomous system actors should treat this source as untrusted.
 *
 * getParams() selector: keccak256("getParams()")[0:4] = 0x26ededb9
 */

export interface OnChainRiskParams {
  maxTransactionUsdt: number;   // human-readable, e.g. 500
  dailyLimitUsdt: number;       // human-readable, e.g. 2000
  maxSlippagePercent: number;   // e.g. 1.0 (converted from bps)
  cooldownSeconds: number;
  paused: boolean;
  source: 'on-chain' | 'config-fallback';
}

// Function selector for getParams() — keccak256("getParams()")[0:4]
const GET_PARAMS_SELECTOR = '0x26ededb9';

// Cache params for 60 seconds to avoid hammering the RPC
let _cache: { params: OnChainRiskParams; expiresAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

/**
 * Read risk parameters from the NexusGuard contract (or fall back to config).
 * Result is cached for 60 seconds.
 */
export async function getGuardParams(): Promise<OnChainRiskParams> {
  const contractAddress = process.env.NEXUS_GUARD_ADDRESS;

  if (!contractAddress) {
    return fallback('config-fallback');
  }

  if (_cache && Date.now() < _cache.expiresAt) {
    return _cache.params;
  }

  try {
    const rpcUrl = config.chains.ethereum.provider;

    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [{ to: contractAddress, data: GET_PARAMS_SELECTOR }, 'latest'],
        id: 1,
      }),
      signal: AbortSignal.timeout(5000),
    });

    const json = await response.json() as { result?: string; error?: { message: string } };

    if (json.error || !json.result || json.result === '0x') {
      return fallback('config-fallback');
    }

    const params = decodeGetParams(json.result);
    _cache = { params, expiresAt: Date.now() + CACHE_TTL_MS };
    return params;
  } catch {
    return fallback('config-fallback');
  }
}

/** Invalidate the cache — call after owner updates contract params */
export function invalidateGuardCache(): void {
  _cache = null;
}

function fallback(source: 'config-fallback'): OnChainRiskParams {
  return {
    maxTransactionUsdt: config.risk.maxTransactionUsdt,
    dailyLimitUsdt: config.risk.dailyLimitUsdt,
    maxSlippagePercent: config.risk.maxSlippagePercent,
    cooldownSeconds: 0,
    paused: false,
    source,
  };
}

/**
 * Decode the ABI-encoded return value of getParams().
 * Returns: (uint64 maxTx, uint64 daily, uint32 slippageBps, uint32 cooldown, bool paused)
 * Each value is right-padded to 32 bytes in ABI encoding.
 */
function decodeGetParams(hex: string): OnChainRiskParams {
  const data = hex.startsWith('0x') ? hex.slice(2) : hex;

  // Each slot is 32 bytes = 64 hex chars
  const slot = (i: number) => BigInt('0x' + data.slice(i * 64, (i + 1) * 64));

  const maxTransactionUsdt6 = slot(0); // 6-decimal USDT
  const dailyLimitUsdt6     = slot(1);
  const maxSlippageBps      = slot(2);
  const cooldownSeconds     = slot(3);
  const paused              = slot(4) !== 0n;

  return {
    maxTransactionUsdt : Number(maxTransactionUsdt6) / 1e6,
    dailyLimitUsdt     : Number(dailyLimitUsdt6) / 1e6,
    maxSlippagePercent : Number(maxSlippageBps) / 100,
    cooldownSeconds    : Number(cooldownSeconds),
    paused,
    source             : 'on-chain',
  };
}
