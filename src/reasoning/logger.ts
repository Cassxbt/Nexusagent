import { AsyncLocalStorage } from 'node:async_hooks';

export type RiskTier = 'APPROVE' | 'REVIEW' | 'BLOCK';

export interface ReasoningStep {
  agent: string;
  action: string;
  reasoning: string;
  result?: string;
  status?: 'pass' | 'warn' | 'fail';
  riskScore?: number;
  riskTier?: RiskTier;
  timestamp: number;
}

const userLogs = new Map<string, ReasoningStep[]>();
const reasoningUserContext = new AsyncLocalStorage<string>();
const GLOBAL_REASONING_USER = '__global__';

function getScopedUserId(userId?: string): string {
  return userId ?? reasoningUserContext.getStore() ?? GLOBAL_REASONING_USER;
}

export function setActiveUser(userId: string): void {
  reasoningUserContext.enterWith(userId || GLOBAL_REASONING_USER);
}

export function logReasoning(
  step: Omit<ReasoningStep, 'timestamp'>,
  options?: { userId?: string },
): void {
  const entry: ReasoningStep = { ...step, timestamp: Date.now() };
  const userId = getScopedUserId(options?.userId);

  if (!userLogs.has(userId)) {
    userLogs.set(userId, []);
  }
  userLogs.get(userId)!.push(entry);

  const statusIcon = entry.status === 'pass' ? '✓' : entry.status === 'fail' ? '✗' : entry.status === 'warn' ? '⚠' : '→';
  console.log(`[${entry.agent}] ${statusIcon} ${entry.action}: ${entry.reasoning}`);
  if (entry.result) console.log(`  └─ ${entry.result}`);
}

export function getReasoningLog(userId?: string): ReasoningStep[] {
  const id = getScopedUserId(userId);
  return [...(userLogs.get(id) ?? [])];
}

export function clearReasoningLog(userId?: string): void {
  const id = getScopedUserId(userId);
  userLogs.delete(id);
}

/** Structured reasoning display */
export function formatReasoningForUser(log: ReasoningStep[]): string {
  if (log.length === 0) return '';

  const agentsSeen = new Set(log.map(s => s.agent));
  const passed = log.filter(s => s.status === 'pass').length;
  const warned = log.filter(s => s.status === 'warn').length;
  const failed = log.filter(s => s.status === 'fail').length;

  const summary = `_${agentsSeen.size} agents consulted | ${passed} passed | ${warned} warnings | ${failed} blocked_`;

  const steps = log.map((s, i) => {
    const icon = s.status === 'pass' ? '✅' : s.status === 'fail' ? '🚫' : s.status === 'warn' ? '⚠️' : '🔄';
    const riskBadge = s.riskScore != null ? ` [Risk: ${s.riskScore}/10 ${s.riskTier}]` : '';
    const line = `${i + 1}. ${icon} *${s.agent}* → \`${s.action}\`${riskBadge}\n   ${s.reasoning}`;
    return s.result ? `${line}\n   _Result: ${s.result}_` : line;
  });

  return `${summary}\n\n${steps.join('\n\n')}`;
}
