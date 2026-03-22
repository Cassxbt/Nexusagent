import 'dotenv/config';

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const config = {
  openai: {
    apiKey: required('OPENAI_API_KEY'),
    routingModel: optional('OPENAI_MODEL_ROUTING', 'gpt-4o-mini'),
    reasoningModel: optional('OPENAI_MODEL_REASONING', 'gpt-4o'),
  },
  telegram: {
    botToken: optional('TELEGRAM_BOT_TOKEN', ''),
  },
  wdk: {
    indexerApiKey: optional('WDK_INDEXER_API_KEY', ''),
    // ERC-4337: set WDK_BUNDLER_URL to enable account abstraction (e.g. Pimlico)
    // e.g. https://api.pimlico.io/v2/arbitrum/rpc?apikey=YOUR_KEY
    bundlerUrl: optional('WDK_BUNDLER_URL', ''),
    useErc4337: optional('WDK_USE_ERC4337', 'false') === 'true',
  },
  // WDK registers chains under the 'ethereum' key (EVM-compatible).
  // This points to Arbitrum One — the WDK key is 'ethereum' by convention.
  chains: {
    ethereum: {
      provider: optional('ETH_RPC_URL', 'https://arb1.arbitrum.io/rpc'),
      label: 'Arbitrum One',
      chainId: 42161,
    },
  },
  risk: {
    maxTransactionUsdt: 500,
    dailyLimitUsdt: 2000,
    maxExposurePercent: 50,
    maxSlippagePercent: 1,
    minHealthFactor: 1.5,
  },
} as const;
