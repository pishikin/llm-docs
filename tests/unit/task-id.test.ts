import { describe, expect, it } from 'vitest';
import {
  deriveTaskId,
  generateLocalTaskId,
  isJiraLikeTaskId,
  normalizeTaskId,
} from '../../src/engine/task/id.js';

describe('task ids', () => {
  it('normalizes jira-like ids and human slugs', () => {
    expect(normalizeTaskId(' abc-123 ')).toBe('ABC-123');
    expect(normalizeTaskId('issue 456')).toBe('issue-456');
    expect(normalizeTaskId('Auth flaky tests')).toBe('auth-flaky-tests');
  });

  it('detects jira-like ids', () => {
    expect(isJiraLikeTaskId('ABC-123')).toBe(true);
    expect(isJiraLikeTaskId('auth-123')).toBe(false);
  });

  it('generates and derives local ids deterministically', () => {
    const now = new Date('2026-04-16T12:00:00Z');

    expect(generateLocalTaskId('Auth flaky tests', now)).toBe('local-auth-flaky-tests-2026-04-16');
    expect(
      deriveTaskId({
        title: 'Auth flaky tests',
        sourceType: 'prompt',
        now,
      }),
    ).toBe('local-auth-flaky-tests-2026-04-16');
    expect(
      deriveTaskId({
        sourceRef: 'ABC-123',
        title: 'ignored',
      }),
    ).toBe('ABC-123');
  });
});
