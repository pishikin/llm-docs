import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/shell.js', () => ({
  execCommand: vi.fn(),
}));

import { ClaudeCodeShellProvider } from '../../src/providers/shell-claude-code.js';
import { execCommand } from '../../src/utils/shell.js';

const mockExec = vi.mocked(execCommand);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ClaudeCodeShellProvider', () => {
  it('generates text via claude CLI', async () => {
    mockExec.mockResolvedValue({
      stdout: '---FILE: CLAUDE.md---\n# Test Project',
      stderr: '',
      exitCode: 0,
    });

    const provider = new ClaudeCodeShellProvider('sonnet');
    const result = await provider.generate('prompt', 'system prompt');

    expect(result).toContain('# Test Project');

    const [cmd, args] = mockExec.mock.calls[0];
    expect(cmd).toBe('claude');
    expect(args).toContain('--tools');
    expect(args).toContain('');
    expect(args).toContain('--max-turns');
    expect(args).toContain('1');
    expect(args).toContain('--system-prompt');
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('dontAsk');
    expect(args).toContain('--output-format');
    expect(args).toContain('text');
    const options = mockExec.mock.calls[0][2];
    expect(options?.stdin).toBe('prompt');
  });

  it('uses default model when none provided', async () => {
    mockExec.mockResolvedValue({
      stdout: 'output',
      stderr: '',
      exitCode: 0,
    });

    const provider = new ClaudeCodeShellProvider();
    await provider.generate('prompt', 'system');

    const args = mockExec.mock.calls[0][1];
    expect(args).not.toContain('--model');
  });

  it('throws ProviderError on non-zero exit', async () => {
    mockExec.mockResolvedValue({
      stdout: '',
      stderr: 'auth required',
      exitCode: 1,
    });

    const provider = new ClaudeCodeShellProvider();
    await expect(provider.generate('prompt', 'system')).rejects.toThrow('Claude Code CLI failed');
  });

  it('throws ProviderError on empty response', async () => {
    mockExec.mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
    });

    const provider = new ClaudeCodeShellProvider();
    await expect(provider.generate('prompt', 'system')).rejects.toThrow('empty response');
  });

  it('throws ProviderError on timeout', async () => {
    mockExec.mockRejectedValue(new Error('Command timed out after 180s'));

    const provider = new ClaudeCodeShellProvider();
    await expect(provider.generate('prompt', 'system')).rejects.toThrow('timed out');
  });

  it('uses stdin for large prompts', async () => {
    mockExec.mockResolvedValue({
      stdout: 'output',
      stderr: '',
      exitCode: 0,
    });

    const largePrompt = 'x'.repeat(60_000);
    const provider = new ClaudeCodeShellProvider();
    await provider.generate(largePrompt, 'system');

    const options = mockExec.mock.calls[0][2];
    expect(options?.stdin).toBe(largePrompt);
  });
});
