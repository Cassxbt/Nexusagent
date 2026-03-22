/**
 * Nexus MCP Server — read-only tools for AI agent orchestration
 *
 * Exposes wallet, market, lending, and risk data via Model Context Protocol.
 * All tools are non-transactional (no signing, no nonce usage) to avoid
 * conflicts with the main Nexus process.
 *
 * Usage:
 *   npm run mcp
 *
 * MCP config (claude_desktop_config.json / mcp.json):
 *   {
 *     "mcpServers": {
 *       "nexus": { "command": "npm", "args": ["run", "mcp"], "cwd": "/path/to/nexus" }
 *     }
 *   }
 */
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

async function main() {
  // Lazy-import agents so dotenv loads first
  const { initWdk } = await import('../core/wdk-setup.js');
  initWdk();

  const { treasuryAgent } = await import('../agents/treasury.js');
  const { marketAgent } = await import('../agents/market.js');
  const { yieldAgent } = await import('../agents/yield.js');
  const { riskAgent } = await import('../agents/risk.js');

  const server = new McpServer({ name: 'nexus', version: '0.1.0' });
  const userId = 'mcp';

  // --- Wallet ---

  server.registerTool('get_balance', {
    description: 'Get the native ETH balance of the Nexus wallet on Arbitrum',
    inputSchema: {},
  }, async () => {
    const r = await treasuryAgent.execute({ intent: 'get_balance', params: { chain: 'ethereum' }, userId });
    return { content: [{ type: 'text' as const, text: r.message }] };
  });

  server.registerTool('get_token_balance', {
    description: 'Get an ERC-20 token balance (USDT, USDC, DAI, WETH, XAUT) from the Nexus wallet',
    inputSchema: {
      token: z.string().describe('Token symbol: USDT, USDC, DAI, WETH, or XAUT'),
    },
  }, async ({ token }) => {
    const r = await treasuryAgent.execute({ intent: 'get_token_balance', params: { chain: 'ethereum', token }, userId });
    return { content: [{ type: 'text' as const, text: r.message }] };
  });

  server.registerTool('get_address', {
    description: 'Get the Nexus wallet address on Arbitrum',
    inputSchema: {},
  }, async () => {
    const r = await treasuryAgent.execute({ intent: 'get_address', params: { chain: 'ethereum' }, userId });
    return { content: [{ type: 'text' as const, text: r.message }] };
  });

  // --- Market ---

  server.registerTool('get_price', {
    description: 'Get real-time asset price from dual sources: Bitfinex + CoinGecko with deviation detection',
    inputSchema: {
      token: z.string().describe('Token symbol: ETH, BTC, USDT, XAUT, etc.'),
    },
  }, async ({ token }) => {
    const r = await marketAgent.execute({ intent: 'get_price', params: { base: token, quote: 'USD' }, userId });
    return { content: [{ type: 'text' as const, text: r.message }] };
  });

  server.registerTool('get_portfolio', {
    description: 'Get full portfolio summary with USD valuations for all tokens in the Nexus wallet',
    inputSchema: {},
  }, async () => {
    const r = await marketAgent.execute({ intent: 'portfolio_summary', params: { chain: 'ethereum' }, userId });
    return { content: [{ type: 'text' as const, text: r.message }] };
  });

  // --- Aave V3 ---

  server.registerTool('get_aave_position', {
    description: 'Get Aave V3 lending position: health factor, total collateral, total debt, available borrows',
    inputSchema: {},
  }, async () => {
    const r = await yieldAgent.execute({ intent: 'account_data', params: { chain: 'ethereum' }, userId });
    return { content: [{ type: 'text' as const, text: r.message }] };
  });

  // --- Risk ---

  server.registerTool('get_risk_limits', {
    description: 'Get current risk configuration: max transaction USD, daily cap, max slippage, min health factor',
    inputSchema: {},
  }, async () => {
    const r = await riskAgent.execute({ intent: 'get_limits', params: {}, userId });
    return { content: [{ type: 'text' as const, text: r.message }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[MCP] Fatal: ${err}\n`);
  process.exit(1);
});
