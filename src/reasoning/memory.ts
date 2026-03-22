import { getDb } from '../core/db.js';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

const MAX_HISTORY = 20;

export function addMessage(userId: string, role: 'user' | 'assistant', content: string): void {
  const db = getDb();
  db.prepare(
    'INSERT INTO conversations (user_id, role, content, timestamp) VALUES (?, ?, ?, ?)',
  ).run(userId, role, content, Date.now());

  // Trim old messages beyond limit
  db.prepare(`
    DELETE FROM conversations WHERE id IN (
      SELECT id FROM conversations WHERE user_id = ?
      ORDER BY timestamp DESC LIMIT -1 OFFSET ?
    )
  `).run(userId, MAX_HISTORY);
}

export function getHistory(userId: string): Message[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT role, content, timestamp FROM conversations WHERE user_id = ? ORDER BY timestamp ASC',
  ).all(userId) as Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }>;
  return rows;
}

export function getContextSummary(userId: string): string {
  const history = getHistory(userId);
  if (history.length === 0) return '';

  return history
    .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
    .join('\n');
}

export function clearHistory(userId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM conversations WHERE user_id = ?').run(userId);
}
