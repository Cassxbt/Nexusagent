import { getOperatorAccount } from '../core/wdk-setup.js';
import { fromBaseUnits, resolveTokenAddress, resolveToken, ARBITRUM_TOKEN_LIST } from '../core/tokens.js';
import { llmComplete } from '../reasoning/llm.js';
import { logReasoning } from '../reasoning/logger.js';
import { pricing } from '../core/pricing.js';
import { getFearGreedSignal, getGoldSignal } from '../core/regime-signals.js';
import type { Agent, AgentRequest, AgentResponse } from './types.js';
import { getPortfolioDelta } from './autopilot.js';
import { x402Fetch } from '../core/x402-client.js';

// CoinGecko symbol -> id mapping (free API, no key needed)
const COINGECKO_IDS: Record<string, string> = {
  ETH: 'ethereum',
  BTC: 'bitcoin',
  USDT: 'tether',
  USDC: 'usd-coin',
  DAI: 'dai',
  WETH: 'weth',
  XAUT: 'tether-gold',
};

/** Fetch price from CoinGecko free API (second source) */
async function getCoinGeckoPrice(symbol: string): Promise<number | null> {
  const id = COINGECKO_IDS[symbol.toUpperCase()];
  if (!id) return null;

  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json() as Record<string, { usd: number }>;
    return data[id]?.usd ?? null;
  } catch {
    return null;
  }
}

export const marketAgent: Agent = {
  name: 'market',
  description: 'Price data (dual-source: Bitfinex + CoinGecko), portfolio analysis, market conditions.',

  permissions: {
    allowedIntents: ['get_price', 'get_history', 'portfolio_summary', 'market_conditions', 'get_premium_intel'],
  },

  async execute(request: AgentRequest): Promise<AgentResponse> {
    const { intent, params, userId } = request;

    switch (intent) {
      case 'get_price':
        return getPrice(params.base, params.quote);
      case 'get_history':
        return getHistory(params.base, params.quote, params.period);
      case 'portfolio_summary':
        return portfolioSummary(params.chain, userId);
      case 'market_conditions':
        return marketConditions();
      case 'get_premium_intel':
        return getPremiumIntel(userId);
      default:
        return { success: false, message: `Unknown market intent: ${intent}` };
    }
  },
};

async function getPrice(
  base: string = 'ETH',
  quote: string = 'USD',
): Promise<AgentResponse> {
  logReasoning({
    agent: 'Market',
    action: 'getPrice',
    reasoning: `Fetching ${base}/${quote} from Bitfinex + CoinGecko`,
    status: 'pass',
  });

  const results: { source: string; price: number | null }[] = [];

  // Primary: Bitfinex
  try {
    const price = await pricing.getCurrentPrice(base, quote);
    results.push({ source: 'Bitfinex', price });
  } catch {
    results.push({ source: 'Bitfinex', price: null });
  }

  // Secondary: CoinGecko (Rogue multi-source pattern)
  if (quote.toUpperCase() === 'USD') {
    const cgPrice = await getCoinGeckoPrice(base);
    results.push({ source: 'CoinGecko', price: cgPrice });
  }

  const validPrices = results.filter(r => r.price !== null);
  if (validPrices.length === 0) {
    return { success: false, message: `Could not fetch ${base}/${quote} from any source` };
  }

  const primaryPrice = validPrices[0].price!;
  const lines = [`*${base}/${quote}*`];

  validPrices.forEach(r => {
    lines.push(`• ${r.source}: $${r.price!.toLocaleString()}`);
  });

  // Cross-source validation — flag discrepancies >1%
  if (validPrices.length === 2) {
    const p1 = validPrices[0].price!;
    const p2 = validPrices[1].price!;
    const deviation = Math.abs(p1 - p2) / p1 * 100;

    if (deviation > 2) {
      lines.push(`⚠️ Price deviation: ${deviation.toFixed(1)}% between sources`);
      logReasoning({
        agent: 'Market',
        action: 'priceDeviation',
        reasoning: `${deviation.toFixed(1)}% deviation between Bitfinex and CoinGecko`,
        status: 'warn',
      });
    } else {
      lines.push(`✅ Sources aligned (${deviation.toFixed(2)}% deviation)`);
      logReasoning({
        agent: 'Market',
        action: 'priceValidation',
        reasoning: `Sources aligned — ${deviation.toFixed(2)}% deviation`,
        status: 'pass',
      });
    }
  }

  return {
    success: true,
    message: lines.join('\n'),
    data: { base, quote, price: String(primaryPrice), sources: validPrices },
  };
}

async function getHistory(
  base: string = 'ETH',
  quote: string = 'USD',
  period: string = '1D',
): Promise<AgentResponse> {
  logReasoning({
    agent: 'Market',
    action: 'getHistory',
    reasoning: `Fetching ${base}/${quote} historical data (${period})`,
    status: 'pass',
  });

  try {
    const history = await pricing.getHistoricalPrice({ from: base, to: quote });

    const commentary = await llmComplete(
      [
        {
          role: 'system',
          content: 'You are a DeFi market analyst. Provide a brief 2-3 sentence analysis of the price data. Include specific trend direction, percentage change, and whether conditions favor holding, buying, or selling.',
        },
        {
          role: 'user',
          content: `Analyze this ${base}/${quote} price data (${period}): ${JSON.stringify(history)}`,
        },
      ],
      { model: 'routing' },
    );

    return {
      success: true,
      message: `*${base}/${quote} Analysis (${period}):*\n${commentary}`,
      data: { base, quote, period, history },
      reasoning: commentary,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `History fetch failed: ${msg}` };
  }
}

async function portfolioSummary(chain: string = 'ethereum', userId?: string): Promise<AgentResponse> {
  logReasoning({
    agent: 'Market',
    action: 'portfolioSummary',
    reasoning: `Building full portfolio summary for ${chain}`,
    status: 'pass',
  });

  try {
    const account = await getOperatorAccount(chain);
    const address = await account.getAddress();
    const nativeBalance = await account.getBalance();
    const readableEth = fromBaseUnits(nativeBalance, 18);

    // Scan ALL registered tokens (not just USDT)
    const tokenBalances: { symbol: string; balance: string; usdValue?: string }[] = [];

    for (const symbol of ARBITRUM_TOKEN_LIST) {
      if (symbol === 'ETH') continue;
      try {
        const addr = resolveTokenAddress(symbol, chain);
        if (!addr) continue;
        const bal = await account.getTokenBalance(addr);
        if (bal > 0n) {
          const tokenInfo = resolveToken(symbol, chain);
          tokenBalances.push({ symbol, balance: fromBaseUnits(bal, tokenInfo?.decimals ?? 18) });
        }
      } catch {
        // Token may not exist on this chain
      }
    }

    let ethPrice = 0;
    let ethUsdValue = 'N/A';
    let totalUsdValue = 0;
    try {
      const priceResult = await getPrice('ETH', 'USD');
      if (priceResult.success && priceResult.data?.price) {
        ethPrice = parseFloat(priceResult.data.price as string);
        const ethAmt = parseFloat(readableEth);
        const ethUsd = ethAmt * ethPrice;
        ethUsdValue = `$${ethUsd.toFixed(2)}`;
        totalUsdValue += ethUsd;
      }
    } catch {
      // Price may fail
    }

    for (const tok of tokenBalances) {
      if (tok.symbol === 'USDT' || tok.symbol === 'USDC' || tok.symbol === 'DAI') {
        const usdAmt = parseFloat(tok.balance);
        totalUsdValue += usdAmt;
        tok.usdValue = `$${usdAmt.toFixed(2)}`;
      } else if (tok.symbol === 'XAUT') {
        try {
          const xautPriceRes = await getPrice('XAUT', 'USD');
          if (xautPriceRes.success && xautPriceRes.data?.price) {
            const xautPrice = parseFloat(xautPriceRes.data.price as string);
            const xautUsd = parseFloat(tok.balance) * xautPrice;
            totalUsdValue += xautUsd;
            tok.usdValue = `$${xautUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
          }
        } catch {
          // Price may fail
        }
      } else if (tok.symbol === 'WETH') {
        const wethUsd = parseFloat(tok.balance) * ethPrice;
        totalUsdValue += wethUsd;
        tok.usdValue = `$${wethUsd.toFixed(2)}`;
      }
    }

    const delta = getPortfolioDelta(totalUsdValue, userId);
    const totalLine = totalUsdValue > 0
      ? `Total: $${totalUsdValue.toFixed(2)}${delta ? ` (${delta})` : ''}`
      : null;

    const lines = [
      `*Portfolio on Arbitrum:*`,
      `Address: \`${address.slice(0, 10)}...${address.slice(-8)}\``,
      ...(totalLine ? [totalLine] : []),
      ``,
      `*Balances:*`,
      `• ETH: ${readableEth}${ethUsdValue !== 'N/A' ? ` (${ethUsdValue})` : ''}`,
    ];

    for (const tok of tokenBalances) {
      lines.push(`• ${tok.symbol}: ${tok.balance}${tok.usdValue ? ` (${tok.usdValue})` : ''}`);
    }

    if (tokenBalances.length === 0) {
      lines.push(`• No token balances found`);
    }

    logReasoning({
      agent: 'Market',
      action: 'portfolioSummary',
      reasoning: `Found ${tokenBalances.length} non-zero token balances. Total: $${totalUsdValue.toFixed(2)}`,
      result: tokenBalances.map(t => `${t.symbol}:${t.balance}`).join(', ') || 'none',
      status: 'pass',
    });

    return {
      success: true,
      message: lines.join('\n'),
      data: { chain, address, nativeBalance: readableEth, tokens: tokenBalances, ethPrice: String(ethPrice), totalUsdValue: String(totalUsdValue) },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Portfolio summary failed: ${msg}` };
  }
}

async function marketConditions(): Promise<AgentResponse> {
  logReasoning({
    agent: 'Market',
    action: 'marketConditions',
    reasoning: 'Assessing overall market conditions for strategy guidance',
    status: 'pass',
  });

  try {
    const [ethResult, btcResult, fearGreed, goldSignal] = await Promise.all([
      getPrice('ETH', 'USD'),
      getPrice('BTC', 'USD'),
      getFearGreedSignal(),
      getGoldSignal(),
    ]);

    const prices: string[] = [];
    if (ethResult.success) {
      prices.push(`ETH: ${ethResult.message}`);
    }
    if (btcResult.success) {
      prices.push(`BTC: ${btcResult.message}`);
    }
    if (fearGreed.value !== null) {
      prices.push(`Fear & Greed Index: ${fearGreed.value} (${fearGreed.classification ?? 'unknown'})`);
    }
    if (goldSignal.spotUsd !== null || goldSignal.xautUsd !== null) {
      const goldParts = [
        goldSignal.spotUsd !== null ? `Gold spot: $${goldSignal.spotUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : null,
        goldSignal.xautUsd !== null ? `XAUT: $${goldSignal.xautUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : null,
        goldSignal.change24hPct !== null ? `24h: ${goldSignal.change24hPct.toFixed(2)}%` : null,
      ].filter(Boolean);
      prices.push(goldParts.join(' | '));
    }

    const priceContext = prices.join('\n');

    const assessment = await llmComplete(
      [
        {
          role: 'system',
          content: 'You are a DeFi strategist for a USDT treasury on Arbitrum. Based on current prices and regime signals, give a 2-3 sentence market condition assessment. Be explicit about whether conditions favor holding USDT, rotating part of reserves into XAUT, or supplying idle USDT to Aave. Be specific and actionable.',
        },
        {
          role: 'user',
          content: `Current market data:\n${priceContext}\n\nAssess conditions and recommend strategy for a treasury that prioritizes capital preservation first, then productive idle-capital deployment.`,
        },
      ],
      { model: 'routing' },
    );

    return {
      success: true,
      message: `*Market Conditions:*\n${priceContext}\n\n${assessment}`,
      data: { assessment, fearGreed, goldSignal },
      reasoning: assessment,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Market conditions check failed: ${msg}` };
  }
}

async function getPremiumIntel(userId: string): Promise<AgentResponse> {
  logReasoning({
    agent: 'Market',
    action: 'getPremiumIntel',
    reasoning: 'Fetching premium market intelligence via x402 payment protocol',
    status: 'pass',
  });

  try {
    const webPort = process.env.WEB_PORT ?? '3000';
    const res = await x402Fetch(`http://localhost:${webPort}/api/premium/market-intel`, userId);

    if (!res.ok) {
      return { success: false, message: `Premium intel request failed: HTTP ${res.status}` };
    }

    const data = await res.json() as {
      success: boolean;
      data: {
        topArbitrumYields?: Array<{ protocol: string; asset: string; apy: string; tvl: string }>;
        recommendation?: string;
        timestamp?: string;
      };
      paymentVerified: boolean;
    };

    const lines = ['*Premium Market Intelligence* (x402 paid)'];

    if (data.data.topArbitrumYields && data.data.topArbitrumYields.length > 0) {
      lines.push('', '*Top Arbitrum Yields:*');
      for (const pool of data.data.topArbitrumYields.slice(0, 5)) {
        lines.push(`• ${pool.protocol} ${pool.asset}: ${pool.apy} APY (TVL: ${pool.tvl})`);
      }
    }

    if (data.data.recommendation) {
      lines.push('', `_${data.data.recommendation}_`);
    }

    if (data.paymentVerified) {
      lines.push('', '✅ Paid via x402 protocol — autonomous agent micropayment');
      lines.push('_Policy bound: whitelist only, $2/payment max, $10/day ops budget_');
    }

    logReasoning({
      agent: 'Market',
      action: 'getPremiumIntel',
      reasoning: `Premium data received — ${data.data.topArbitrumYields?.length ?? 0} yield pools`,
      status: 'pass',
    });

    return {
      success: true,
      message: lines.join('\n'),
      data: data.data,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Premium intel failed: ${msg}` };
  }
}
