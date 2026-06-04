import { describe, expect, it } from 'vitest';
import { adaptPrompt } from '../../src/core/prompt-adapter.js';

describe('adaptPrompt', () => {
  const system = 'You are an assistant.';
  const user = 'Generate docs.';

  it('returns both prompts unchanged for anthropic', () => {
    const result = adaptPrompt(system, user, 'anthropic');
    expect(result.systemPrompt).toBe(system);
    expect(result.userPrompt).toBe(user);
  });

  it('returns both prompts unchanged for claude-code', () => {
    const result = adaptPrompt(system, user, 'claude-code');
    expect(result.systemPrompt).toBe(system);
    expect(result.userPrompt).toBe(user);
  });

  it('returns both prompts unchanged for cursor-agent', () => {
    const result = adaptPrompt(system, user, 'cursor-agent');
    expect(result.systemPrompt).toBe(system);
    expect(result.userPrompt).toBe(user);
  });

  it('returns both prompts unchanged for custom', () => {
    const result = adaptPrompt(system, user, 'custom');
    expect(result.systemPrompt).toBe(system);
    expect(result.userPrompt).toBe(user);
  });

  it('merges system into user prompt for codex-cli', () => {
    const result = adaptPrompt(system, user, 'codex-cli');
    expect(result.systemPrompt).toBeUndefined();
    expect(result.userPrompt).toContain('<system>');
    expect(result.userPrompt).toContain(system);
    expect(result.userPrompt).toContain('</system>');
    expect(result.userPrompt).toContain(user);
  });
});
