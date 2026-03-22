import { getDb } from './db.js';

export type HeartbeatStatus = 'ok' | 'degraded' | 'unavailable';

interface SourceHeartbeatRecord {
  status: HeartbeatStatus;
  checkedAt: number;
  message?: string;
  meta?: Record<string, unknown> | null;
}

export interface ServiceHeartbeat {
  status: HeartbeatStatus;
  autopilot: {
    lastStartedAt: number | null;
    lastSucceededAt: number | null;
    lastFailedAt: number | null;
    lastDurationMs: number | null;
    lastAlertCount: number | null;
    stale: boolean;
    staleByMs: number | null;
  };
  sources: Record<string, SourceHeartbeatRecord>;
}

const AUTOPILOT_STARTED_KEY = 'service:autopilot:last_started_at';
const AUTOPILOT_SUCCEEDED_KEY = 'service:autopilot:last_succeeded_at';
const AUTOPILOT_FAILED_KEY = 'service:autopilot:last_failed_at';
const AUTOPILOT_DURATION_KEY = 'service:autopilot:last_duration_ms';
const AUTOPILOT_ALERT_COUNT_KEY = 'service:autopilot:last_alert_count';
const AUTOPILOT_ERROR_KEY = 'service:autopilot:last_error';
const SOURCE_PREFIX = 'service:source:';

function writeState(key: string, value: unknown): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO autopilot_state (key, value, updated_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value));
}

function readState<T>(key: string): T | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT value
    FROM autopilot_state
    WHERE key = ?
  `).get(key) as { value: string } | undefined;

  if (!row) return null;

  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function markAutopilotCycleStarted(startedAtMs: number = Date.now()): void {
  writeState(AUTOPILOT_STARTED_KEY, startedAtMs);
}

export function markAutopilotCycleCompleted(params: {
  success: boolean;
  durationMs: number;
  alertCount: number;
  completedAtMs?: number;
  error?: string;
}): void {
  const completedAtMs = params.completedAtMs ?? Date.now();
  writeState(AUTOPILOT_DURATION_KEY, params.durationMs);
  writeState(AUTOPILOT_ALERT_COUNT_KEY, params.alertCount);

  if (params.success) {
    writeState(AUTOPILOT_SUCCEEDED_KEY, completedAtMs);
    writeState(AUTOPILOT_ERROR_KEY, null);
  } else {
    writeState(AUTOPILOT_FAILED_KEY, completedAtMs);
    writeState(AUTOPILOT_ERROR_KEY, params.error ?? 'unknown autopilot failure');
  }
}

export function markSourceHeartbeat(
  name: string,
  status: HeartbeatStatus,
  message?: string,
  meta?: Record<string, unknown> | null,
  checkedAtMs: number = Date.now(),
): void {
  writeState(`${SOURCE_PREFIX}${name}`, {
    status,
    checkedAt: checkedAtMs,
    message,
    meta: meta ?? null,
  } satisfies SourceHeartbeatRecord);
}

export function readServiceHeartbeat(
  opts: {
    nowMs?: number;
    expectedCycleMs?: number;
    autopilotRunning?: boolean;
  } = {},
): ServiceHeartbeat {
  const nowMs = opts.nowMs ?? Date.now();
  const expectedCycleMs = opts.expectedCycleMs ?? (5 * 60 * 1000);
  const staleThresholdMs = expectedCycleMs * 2;

  const lastStartedAt = readState<number>(AUTOPILOT_STARTED_KEY);
  const lastSucceededAt = readState<number>(AUTOPILOT_SUCCEEDED_KEY);
  const lastFailedAt = readState<number>(AUTOPILOT_FAILED_KEY);
  const lastDurationMs = readState<number>(AUTOPILOT_DURATION_KEY);
  const lastAlertCount = readState<number>(AUTOPILOT_ALERT_COUNT_KEY);

  const staleByMs = lastSucceededAt === null ? null : nowMs - lastSucceededAt;
  const stale = opts.autopilotRunning === true && (lastSucceededAt === null || staleByMs === null || staleByMs > staleThresholdMs);

  const db = getDb();
  const rows = db.prepare(`
    SELECT key, value
    FROM autopilot_state
    WHERE key LIKE ?
  `).all(`${SOURCE_PREFIX}%`) as Array<{ key: string; value: string }>;

  const sources: Record<string, SourceHeartbeatRecord> = {};
  for (const row of rows) {
    const name = row.key.slice(SOURCE_PREFIX.length);
    try {
      const parsed = JSON.parse(row.value) as SourceHeartbeatRecord;
      sources[name] = parsed;
    } catch {
      sources[name] = {
        status: 'unavailable',
        checkedAt: 0,
        message: 'Could not parse heartbeat state',
        meta: null,
      };
    }
  }

  let status: HeartbeatStatus = 'ok';
  if (stale) {
    status = 'degraded';
  }
  if (opts.autopilotRunning === false) {
    status = 'degraded';
  }
  if (Object.values(sources).some((source) => source.status === 'unavailable')) {
    status = 'degraded';
  }

  return {
    status,
    autopilot: {
      lastStartedAt,
      lastSucceededAt,
      lastFailedAt,
      lastDurationMs,
      lastAlertCount,
      stale,
      staleByMs,
    },
    sources,
  };
}
