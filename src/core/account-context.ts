import { getDb } from './db.js';

export type ExecutionMode = 'approval_gated' | 'delegated';
export type WalletMode = 'inherit' | 'eoa' | 'erc4337';
const RESERVED_OPERATOR_ACCOUNT_INDEX = 0;

export interface UserAccountContext {
  userId: string;
  chain: string;
  accountIndex: number;
  executionMode: ExecutionMode;
  walletMode: WalletMode;
  ownerAddress?: string;
  smartAccountAddress?: string;
  createdAt: number;
  updatedAt: number;
}

interface UserAccountRow {
  user_id: string;
  chain: string;
  account_index: number;
  execution_mode: ExecutionMode;
  wallet_mode: WalletMode;
  owner_address: string | null;
  smart_account_address: string | null;
  created_at: number;
  updated_at: number;
}

function mapRow(row: UserAccountRow): UserAccountContext {
  return {
    userId: row.user_id,
    chain: row.chain,
    accountIndex: row.account_index,
    executionMode: row.execution_mode,
    walletMode: row.wallet_mode,
    ownerAddress: row.owner_address ?? undefined,
    smartAccountAddress: row.smart_account_address ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getOrCreateUserAccountContext(
  userId: string,
  chain: string = 'ethereum',
): UserAccountContext {
  const db = getDb();
  const existing = db.prepare(`
    SELECT user_id, chain, account_index, execution_mode, wallet_mode, owner_address, smart_account_address, created_at, updated_at
    FROM user_account_contexts
    WHERE user_id = ? AND chain = ?
  `).get(userId, chain) as UserAccountRow | undefined;

  if (existing) return mapRow(existing);

  const nextAccountIndex = allocateNextAccountIndex(chain);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO user_account_contexts (
      user_id,
      chain,
      account_index,
      execution_mode,
      wallet_mode,
      owner_address,
      smart_account_address,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, 'approval_gated', 'inherit', NULL, NULL, ?, ?)
  `).run(userId, chain, nextAccountIndex, now, now);

  return {
    userId,
    chain,
    accountIndex: nextAccountIndex,
    executionMode: 'approval_gated',
    walletMode: 'inherit',
    createdAt: now,
    updatedAt: now,
  };
}

export function getOrCreateWalletAccountContext(
  ownerAddress: string,
  chain: string = 'ethereum',
): UserAccountContext {
  const db = getDb();
  const normalizedOwnerAddress = ownerAddress.toLowerCase();
  const existing = db.prepare(`
    SELECT user_id, chain, account_index, execution_mode, wallet_mode, owner_address, smart_account_address, created_at, updated_at
    FROM user_account_contexts
    WHERE owner_address = ? AND chain = ?
  `).get(normalizedOwnerAddress, chain) as UserAccountRow | undefined;

  if (existing) return mapRow(existing);

  const userId = `wallet:${normalizedOwnerAddress}`;
  const nextAccountIndex = allocateNextAccountIndex(chain);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO user_account_contexts (
      user_id,
      chain,
      account_index,
      execution_mode,
      wallet_mode,
      owner_address,
      smart_account_address,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, 'approval_gated', 'inherit', ?, NULL, ?, ?)
  `).run(userId, chain, nextAccountIndex, normalizedOwnerAddress, now, now);

  return {
    userId,
    chain,
    accountIndex: nextAccountIndex,
    executionMode: 'approval_gated',
    walletMode: 'inherit',
    ownerAddress: normalizedOwnerAddress,
    createdAt: now,
    updatedAt: now,
  };
}

export function getUserAccountContext(
  userId: string,
  chain: string = 'ethereum',
): UserAccountContext | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT user_id, chain, account_index, execution_mode, wallet_mode, owner_address, smart_account_address, created_at, updated_at
    FROM user_account_contexts
    WHERE user_id = ? AND chain = ?
  `).get(userId, chain) as UserAccountRow | undefined;

  return row ? mapRow(row) : null;
}

export function listUserAccountContexts(chain: string = 'ethereum'): UserAccountContext[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT user_id, chain, account_index, execution_mode, wallet_mode, owner_address, smart_account_address, created_at, updated_at
    FROM user_account_contexts
    WHERE chain = ?
    ORDER BY created_at ASC
  `).all(chain) as UserAccountRow[];

  return rows.map(mapRow);
}

function allocateNextAccountIndex(chain: string): number {
  const db = getDb();
  const row = db.prepare(`
    SELECT COALESCE(MAX(account_index), ?) AS max_index
    FROM user_account_contexts
    WHERE chain = ?
  `).get(RESERVED_OPERATOR_ACCOUNT_INDEX, chain) as { max_index: number | null };

  const maxIndex = row.max_index ?? RESERVED_OPERATOR_ACCOUNT_INDEX;
  return Math.max(RESERVED_OPERATOR_ACCOUNT_INDEX + 1, maxIndex + 1);
}
