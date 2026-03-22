import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Wallet } from 'ethers';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'nexus-auth-'));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  const { closeDb } = await import('../../src/core/db.js');
  closeDb();
  delete process.env.DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('wallet auth flow', () => {
  it('creates a challenge, verifies the signature, and restores the session', async () => {
    const wallet = Wallet.createRandom();
    const auth = await import('../../src/web/auth.js');

    const challenge = auth.createAuthChallenge(wallet.address);
    expect(challenge.address).toBe(wallet.address.toLowerCase());
    expect(challenge.message).toContain('Nexus Wallet Login');

    const signature = await wallet.signMessage(challenge.message);
    const session = auth.verifyAuthChallenge(wallet.address, signature);
    expect(session.ownerAddress).toBe(wallet.address.toLowerCase());
    expect(session.userId).toBe(`wallet:${wallet.address.toLowerCase()}`);

    const restored = auth.getWebSession(session.sessionToken);
    expect(restored?.userId).toBe(session.userId);
    expect(restored?.ownerAddress).toBe(session.ownerAddress);

    auth.deleteWebSession(session.sessionToken);
    expect(auth.getWebSession(session.sessionToken)).toBeNull();
  });

  it('rejects signatures from the wrong wallet', async () => {
    const wallet = Wallet.createRandom();
    const attacker = Wallet.createRandom();
    const auth = await import('../../src/web/auth.js');

    const challenge = auth.createAuthChallenge(wallet.address);
    const badSignature = await attacker.signMessage(challenge.message);

    expect(() => auth.verifyAuthChallenge(wallet.address, badSignature)).toThrow(/signature does not match/i);
  });
});
