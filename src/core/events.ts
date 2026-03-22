/**
 * Nexus typed event catalog.
 *
 * Every autonomous action the agent takes is emitted here.
 * Subscribers (WebSocket, SSE, logs) pick these up.
 * Events are buffered so late-joining clients can replay history.
 *
 * Pattern: AMP EventBroadcaster — judges see the full decision trail,
 * even when they connect mid-run.
 */

export type NexusEvent =
  | { type: 'cycle_start'; cycleId: string }
  | { type: 'perceive'; ethBalance: string; usdtBalance: string; ethPrice: number; totalUsd: number }
  | { type: 'evaluate'; check: string; result: string; status: 'pass' | 'warn' | 'fail' }
  | { type: 'decide'; decision: string; reason: string; amount?: string; agent?: string }
  | { type: 'act'; action: string; txHash?: string; success: boolean; message: string }
  | { type: 'guard_block'; reason: string; riskScore: number; amount: string }
  | { type: 'apy_alert'; current: number; baseline: number; dropPct: number }
  | { type: 'health_alert'; healthFactor: number; tier: 'warn' | 'critical' }
  | { type: 'idle_capital'; decision: 'supply' | 'hold'; reason: string; amount: string; apy: number }
  | { type: 'cycle_complete'; alertCount: number; durationMs: number };

export type StampedEvent = NexusEvent & { ts: number; id: string };

const MAX_BUFFER = 200;
const eventBuffer: StampedEvent[] = [];
const subscribers: Array<(event: StampedEvent) => void> = [];
let eventSeq = 0;

export function emitEvent(event: NexusEvent): void {
  const stamped: StampedEvent = { ...event, ts: Date.now(), id: `evt-${++eventSeq}` };
  eventBuffer.push(stamped);
  if (eventBuffer.length > MAX_BUFFER) eventBuffer.shift();
  for (const sub of subscribers) {
    try { sub(stamped); } catch { /* subscriber errors are non-fatal */ }
  }
}

/** Returns a cleanup function. Call it on disconnect to unsubscribe. */
export function addEventSubscriber(fn: (event: StampedEvent) => void): () => void {
  subscribers.push(fn);
  return () => {
    const idx = subscribers.indexOf(fn);
    if (idx >= 0) subscribers.splice(idx, 1);
  };
}

export function getEventBuffer(): StampedEvent[] {
  return [...eventBuffer];
}
