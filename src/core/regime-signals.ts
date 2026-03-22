import { pricing } from './pricing.js';

export interface FearGreedSignal {
  value: number | null;
  classification: string | null;
  source: 'alternative_me' | 'unavailable';
  fetchedAt: string;
}

export interface GoldSignal {
  spotUsd: number | null;
  xautUsd: number | null;
  change24hPct: number | null;
  source: 'gold_api' | 'xaut_fallback' | 'unavailable';
  fetchedAt: string;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000;

let fearGreedCache: CacheEntry<FearGreedSignal> | null = null;
let goldCache: CacheEntry<GoldSignal> | null = null;

function isFresh<T>(entry: CacheEntry<T> | null): entry is CacheEntry<T> {
  return !!entry && entry.expiresAt > Date.now();
}

export async function getFearGreedSignal(): Promise<FearGreedSignal> {
  if (isFresh(fearGreedCache)) return fearGreedCache.value;

  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=1', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const body = await res.json() as {
      data?: Array<{ value?: string; value_classification?: string }>;
    };
    const item = body.data?.[0];
    const signal: FearGreedSignal = {
      value: item?.value ? Number(item.value) : null,
      classification: item?.value_classification ?? null,
      source: 'alternative_me',
      fetchedAt: new Date().toISOString(),
    };
    fearGreedCache = { value: signal, expiresAt: Date.now() + TTL_MS };
    return signal;
  } catch {
    const fallback: FearGreedSignal = {
      value: null,
      classification: null,
      source: 'unavailable',
      fetchedAt: new Date().toISOString(),
    };
    fearGreedCache = { value: fallback, expiresAt: Date.now() + TTL_MS };
    return fallback;
  }
}

export async function getGoldSignal(): Promise<GoldSignal> {
  if (isFresh(goldCache)) return goldCache.value;

  try {
    const res = await fetch('https://api.gold-api.com/price/XAU', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const body = await res.json() as {
      price?: number;
      chp?: number;
    };
    const xautUsd = await pricing.getCurrentPrice('XAUT', 'USD').catch(() => null);
    const signal: GoldSignal = {
      spotUsd: typeof body.price === 'number' ? body.price : null,
      xautUsd,
      change24hPct: typeof body.chp === 'number' ? body.chp : null,
      source: 'gold_api',
      fetchedAt: new Date().toISOString(),
    };
    goldCache = { value: signal, expiresAt: Date.now() + TTL_MS };
    return signal;
  } catch {
    const xautUsd = await pricing.getCurrentPrice('XAUT', 'USD').catch(() => null);
    const fallback: GoldSignal = {
      spotUsd: null,
      xautUsd,
      change24hPct: null,
      source: xautUsd !== null ? 'xaut_fallback' : 'unavailable',
      fetchedAt: new Date().toISOString(),
    };
    goldCache = { value: fallback, expiresAt: Date.now() + TTL_MS };
    return fallback;
  }
}
