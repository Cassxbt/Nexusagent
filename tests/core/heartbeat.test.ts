import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'nexus-heartbeat-'));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  const { closeDb } = await import('../../src/core/db.js');
  closeDb();
  delete process.env.DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('service heartbeat', () => {
  it('marks the service degraded when autopilot heartbeat is stale', async () => {
    const heartbeat = await import('../../src/core/heartbeat.js');

    heartbeat.markAutopilotCycleStarted(1_000);
    heartbeat.markAutopilotCycleCompleted({
      success: true,
      durationMs: 1_500,
      alertCount: 0,
      completedAtMs: 2_000,
    });

    const status = heartbeat.readServiceHeartbeat({
      nowMs: 2_000 + (11 * 60 * 1000),
      expectedCycleMs: 5 * 60 * 1000,
      autopilotRunning: true,
    });

    expect(status.autopilot.stale).toBe(true);
    expect(status.status).toBe('degraded');
  });

  it('tracks unhealthy data sources in the aggregate status', async () => {
    const heartbeat = await import('../../src/core/heartbeat.js');

    heartbeat.markAutopilotCycleStarted(1_000);
    heartbeat.markAutopilotCycleCompleted({
      success: true,
      durationMs: 500,
      alertCount: 1,
      completedAtMs: 2_000,
    });
    heartbeat.markSourceHeartbeat('guard', 'ok', 'on-chain guard available', { source: 'on-chain' }, 2_000);
    heartbeat.markSourceHeartbeat('gold', 'unavailable', 'gold feed offline', null, 2_000);

    const status = heartbeat.readServiceHeartbeat({
      nowMs: 2_500,
      expectedCycleMs: 5 * 60 * 1000,
      autopilotRunning: true,
    });

    expect(status.sources.guard.status).toBe('ok');
    expect(status.sources.gold.status).toBe('unavailable');
    expect(status.status).toBe('degraded');
  });
});
