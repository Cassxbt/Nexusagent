import { randomBytes } from 'crypto';
import { getAddress, verifyMessage } from 'ethers';
import { getDb } from '../core/db.js';
import { getOrCreateWalletAccountContext } from '../core/account-context.js';

const CHALLENGE_TTL_SECONDS = 10 * 60;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

interface AuthChallengeRow {
  owner_address: string;
  challenge_message: string;
  nonce: string;
  created_at: number;
  expires_at: number;
}

interface WebSessionRow {
  session_token: string;
  user_id: string;
  owner_address: string;
  created_at: number;
  expires_at: number;
}

export interface WebSession {
  sessionToken: string;
  userId: string;
  ownerAddress: string;
  createdAt: number;
  expiresAt: number;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function normalizeOwnerAddress(address: string): string {
  return getAddress(address).toLowerCase();
}

function buildChallengeMessage(address: string, nonce: string, issuedAtIso: string): string {
  return [
    'Nexus Wallet Login',
    '',
    `Address: ${address}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAtIso}`,
    'Chain: Arbitrum One',
    '',
    'Sign this message to log in to Nexus.',
    'This does not grant transaction permissions.',
  ].join('\n');
}

function mapSession(row: WebSessionRow): WebSession {
  return {
    sessionToken: row.session_token,
    userId: row.user_id,
    ownerAddress: row.owner_address,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export function createAuthChallenge(rawAddress: string): {
  address: string;
  message: string;
  nonce: string;
  expiresAt: number;
} {
  const address = normalizeOwnerAddress(rawAddress);
  const nonce = randomBytes(16).toString('hex');
  const createdAt = nowSeconds();
  const expiresAt = createdAt + CHALLENGE_TTL_SECONDS;
  const message = buildChallengeMessage(address, nonce, new Date(createdAt * 1000).toISOString());
  const db = getDb();

  db.prepare(`
    INSERT INTO web_auth_challenges (owner_address, challenge_message, nonce, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(owner_address) DO UPDATE SET
      challenge_message = excluded.challenge_message,
      nonce = excluded.nonce,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at
  `).run(address, message, nonce, createdAt, expiresAt);

  return { address, message, nonce, expiresAt };
}

export function verifyAuthChallenge(rawAddress: string, signature: string): WebSession {
  const address = normalizeOwnerAddress(rawAddress);
  const db = getDb();
  const challenge = db.prepare(`
    SELECT owner_address, challenge_message, nonce, created_at, expires_at
    FROM web_auth_challenges
    WHERE owner_address = ?
  `).get(address) as AuthChallengeRow | undefined;

  if (!challenge) {
    throw new Error('Auth challenge not found');
  }
  if (challenge.expires_at < nowSeconds()) {
    db.prepare(`DELETE FROM web_auth_challenges WHERE owner_address = ?`).run(address);
    throw new Error('Auth challenge expired');
  }

  const recovered = verifyMessage(challenge.challenge_message, signature).toLowerCase();
  if (recovered !== address) {
    throw new Error('Signature does not match the requested wallet');
  }

  const context = getOrCreateWalletAccountContext(address, 'ethereum');
  const sessionToken = randomBytes(24).toString('hex');
  const createdAt = nowSeconds();
  const expiresAt = createdAt + SESSION_TTL_SECONDS;

  db.prepare(`
    INSERT INTO web_sessions (session_token, user_id, owner_address, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionToken, context.userId, address, createdAt, expiresAt);

  db.prepare(`DELETE FROM web_auth_challenges WHERE owner_address = ?`).run(address);

  return {
    sessionToken,
    userId: context.userId,
    ownerAddress: address,
    createdAt,
    expiresAt,
  };
}

export function getWebSession(sessionToken: string): WebSession | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT session_token, user_id, owner_address, created_at, expires_at
    FROM web_sessions
    WHERE session_token = ?
  `).get(sessionToken) as WebSessionRow | undefined;

  if (!row) return null;
  if (row.expires_at < nowSeconds()) {
    db.prepare(`DELETE FROM web_sessions WHERE session_token = ?`).run(sessionToken);
    return null;
  }

  return mapSession(row);
}

export function deleteWebSession(sessionToken: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM web_sessions WHERE session_token = ?`).run(sessionToken);
}
