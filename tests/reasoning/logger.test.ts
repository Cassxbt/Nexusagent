import { describe, it, expect, beforeEach } from 'vitest';
import { clearReasoningLog, getReasoningLog, logReasoning, setActiveUser } from '../../src/reasoning/logger.js';

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('reasoning logger isolation', () => {
  beforeEach(() => {
    clearReasoningLog('user-a');
    clearReasoningLog('user-b');
  });

  it('keeps concurrent reasoning traces scoped to the active user context', async () => {
    const writeForUser = async (userId: string, delayMs: number, action: string) => {
      setActiveUser(userId);
      await wait(delayMs);
      logReasoning({
        agent: 'TestAgent',
        action,
        reasoning: `reasoning for ${userId}`,
        status: 'pass',
      });
    };

    await Promise.all([
      writeForUser('user-a', 10, 'first'),
      writeForUser('user-b', 0, 'second'),
    ]);

    expect(getReasoningLog('user-a').map(step => step.action)).toEqual(['first']);
    expect(getReasoningLog('user-b').map(step => step.action)).toEqual(['second']);
  });
});
