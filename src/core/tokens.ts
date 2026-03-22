export interface TokenInfo {
  address: string;
  decimals: number;
  symbol: string;
}

const NATIVE_ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

// Arbitrum One token addresses (primary demo chain)
const ARBITRUM_TOKENS: Record<string, TokenInfo> = {
  ETH: { address: NATIVE_ETH, decimals: 18, symbol: 'ETH' },
  WETH: { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18, symbol: 'WETH' },
  USDT: { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6, symbol: 'USDT' },
  USDC: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6, symbol: 'USDC' },
  DAI: { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18, symbol: 'DAI' },
  XAUT: { address: '0x68749665FF8D2d112Fa859AA293f07A622782F38', decimals: 6, symbol: 'XAUT' },
};

// Ethereum Mainnet (secondary)
const ETHEREUM_TOKENS: Record<string, TokenInfo> = {
  ETH: { address: NATIVE_ETH, decimals: 18, symbol: 'ETH' },
  WETH: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18, symbol: 'WETH' },
  USDT: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, symbol: 'USDT' },
  USDC: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, symbol: 'USDC' },
  DAI: { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18, symbol: 'DAI' },
  XAUT: { address: '0x68749665FF8D2d112Fa859AA293f07A622782F38', decimals: 6, symbol: 'XAUT' },
};

const CHAIN_TOKENS: Record<string, Record<string, TokenInfo>> = {
  ethereum: ARBITRUM_TOKENS, // "ethereum" is the WDK chain key; maps to Arbitrum in our config
  arbitrum: ARBITRUM_TOKENS,
  mainnet: ETHEREUM_TOKENS,
};

// Aave V3 Pool addresses (spender for approve() before supply/repay)
const AAVE_V3_POOLS: Record<string, string> = {
  ethereum: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', // Arbitrum pool (our default "ethereum" key)
  arbitrum: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  mainnet: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  base: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  optimism: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
};

// Ordered list of all supported token symbols for portfolio scanning
export const ARBITRUM_TOKEN_LIST = ['ETH', 'WETH', 'USDT', 'USDC', 'DAI', 'XAUT'] as const;

export function getAavePoolAddress(chain: string = 'ethereum'): string | null {
  return AAVE_V3_POOLS[chain] ?? null;
}

export function resolveToken(symbol: string, chain: string = 'ethereum'): TokenInfo | null {
  const chainTokens = CHAIN_TOKENS[chain];
  if (!chainTokens) return null;
  return chainTokens[symbol.toUpperCase()] ?? null;
}

export function resolveTokenAddress(symbol: string, chain: string = 'ethereum'): string | null {
  const token = resolveToken(symbol, chain);
  return token?.address ?? null;
}

export function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function resolveTokenOrAddress(symbolOrAddress: string, chain: string = 'ethereum'): string | null {
  if (isAddress(symbolOrAddress)) return symbolOrAddress;
  return resolveTokenAddress(symbolOrAddress, chain);
}

export function toBaseUnits(amount: string, decimals: number): bigint {
  const parts = amount.split('.');
  const whole = parts[0] || '0';
  let fraction = parts[1] || '';

  if (fraction.length > decimals) {
    fraction = fraction.slice(0, decimals);
  }
  fraction = fraction.padEnd(decimals, '0');

  return BigInt(whole + fraction);
}

export function fromBaseUnits(amount: bigint, decimals: number): string {
  const str = amount.toString().padStart(decimals + 1, '0');
  const whole = str.slice(0, str.length - decimals);
  const fraction = str.slice(str.length - decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

export function parseAmount(amountStr: string, symbolOrAddress: string, chain: string = 'ethereum'): bigint | null {
  const token = isAddress(symbolOrAddress)
    ? null
    : resolveToken(symbolOrAddress, chain);

  const decimals = token?.decimals ?? 18;

  try {
    // Always treat input as human-readable amount and convert to base units.
    // "10" means 10 tokens, "0.5" means half a token.
    return toBaseUnits(amountStr, decimals);
  } catch {
    return null;
  }
}
