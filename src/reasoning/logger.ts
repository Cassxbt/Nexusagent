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

// Per-user reasoning logs — no more global state leak
const userLogs = new Map<string, ReasoningStep[]>();
let activeUserId = '__global__';

export function setActiveUser(userId: string): void {
  activeUserId = userId;
}

export function logReasoning(step: Omit<ReasoningStep, 'timestamp'>): void {
  const entry: ReasoningStep = { ...step, timestamp: Date.now() };

  if (!userLogs.has(activeUserId)) {
    userLogs.set(activeUserId, []);
  }
  userLogs.get(activeUserId)!.push(entry);

  const statusIcon = entry.status === 'pass' ? '✓' : entry.status === 'fail' ? '✗' : entry.status === 'warn' ? '⚠' : '→';
  console.log(`[${entry.agent}] ${statusIcon} ${entry.action}: ${entry.reasoning}`);
  if (entry.result) console.log(`  └─ ${entry.result}`);
}

export function getReasoningLog(userId?: string): ReasoningStep[] {
  const id = userId ?? activeUserId;
  return [...(userLogs.get(id) ?? [])];
}

export function clearReasoningLog(userId?: string): void {
  const id = userId ?? activeUserId;
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
