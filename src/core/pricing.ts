import { BitfinexPricingClient } from '@tetherto/wdk-pricing-bitfinex-http';

/** Singleton Bitfinex pricing client — shared across all agents */
export const pricing = new BitfinexPricingClient() as BitfinexPricingClient & {
  getCurrentPrice(from: string, to: string): Promise<number>;
  getHistoricalPrice(params: { from: string; to: string }): Promise<unknown>;
};
