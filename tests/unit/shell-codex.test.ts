import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/shell.js', () => ({
  execCommand: vi.fn(),
}));

import { CodexShellProvider } from '../../src/providers/shell-codex.js';
import { execCommand } from '../../src/utils/shell.js';

const mockExec = vi.mocked(execCommand);
const jsonEvent = (event: unknown) => JSON.stringify(event);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CodexShellProvider', () => {
  it('generates text via codex CLI with merged prompt and json parsing', async () => {
    mockExec.mockResolvedValue({
      stdout: [
        jsonEvent({ type: 'thread.started' }),
        jsonEvent({
          type: 'item.completed',
          item: { type: 'agent_message', text: '---FILE: AGENTS.md---\n# Test Project' },
        }),
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    });

    const provider = new CodexShellProvider();
    const result = await provider.generate('user prompt', 'system prompt');

    expect(result).toContain('# Test Project');

    const [cmd, args] = mockExec.mock.calls[0];
    expect(cmd).toBe('codex');
    expect(args[0]).toBe('exec');
    expect(args).toContain('-s');
    expect(args).toContain('read-only');
    expect(args).toContain('--json');
    expect(args).toContain('--skip-git-repo-check');
    expect(args).not.toContain('--full-auto');

    // Verify prompt was passed as combined (system + user)
    const promptArg = args[1];
    expect(promptArg).toContain('<system>');
    expect(promptArg).toContain('system prompt');
    expect(promptArg).toContain('</system>');
    expect(promptArg).toContain('user prompt');
  });

  it('passes model flag when specified', async () => {
    mockExec.mockResolvedValue({
      stdout: jsonEvent({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'output' },
      }),
      stderr: '',
      exitCode: 0,
    });

    const provider = new CodexShellProvider('gpt-4o');
    await provider.generate('prompt', 'system');

    const args = mockExec.mock.calls[0][1];
    expect(args).toContain('--model');
    expect(args).toContain('gpt-4o');
  });

  it('passes reasoning effort override when specified', async () => {
    mockExec.mockResolvedValue({
      stdout: jsonEvent({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'output' },
      }),
      stderr: '',
      exitCode: 0,
    });

    const provider = new CodexShellProvider(undefined, { reasoningEffort: 'low' });
    await provider.generate('prompt', 'system');

    const args = mockExec.mock.calls[0][1];
    expect(args).toContain('-c');
    expect(args).toContain('model_reasoning_effort="low"');
  });

  it('omits model flag when not specified', async () => {
    mockExec.mockResolvedValue({
      stdout: jsonEvent({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'output' },
      }),
      stderr: '',
      exitCode: 0,
    });

    const provider = new CodexShellProvider();
    await provider.generate('prompt', 'system');

    const args = mockExec.mock.calls[0][1];
    expect(args).not.toContain('--model');
  });

  it('throws ProviderError on non-zero exit', async () => {
    mockExec.mockResolvedValue({
      stdout: '',
      stderr: 'authentication failed',
      exitCode: 1,
    });

    const provider = new CodexShellProvider();
    await expect(provider.generate('prompt', 'system')).rejects.toThrow('Codex CLI failed');
  });

  it('retries once on empty response and succeeds', async () => {
    mockExec
      .mockResolvedValueOnce({
        stdout: jsonEvent({ type: 'turn.completed' }),
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: jsonEvent({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'final output' },
        }),
        stderr: '',
        exitCode: 0,
      });

    const provider = new CodexShellProvider();
    const result = await provider.generate('prompt', 'system');
    expect(result).toBe('final output');
    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it('throws ProviderError on empty response after retry', async () => {
    mockExec.mockResolvedValue({
      stdout: jsonEvent({ type: 'turn.completed' }),
      stderr: '',
      exitCode: 0,
    });

    const provider = new CodexShellProvider();
    await expect(provider.generate('prompt', 'system')).rejects.toThrow('empty response');
    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it('does not retry empty response when maxEmptyRetries is zero', async () => {
    mockExec.mockResolvedValue({
      stdout: jsonEvent({ type: 'turn.completed' }),
      stderr: '',
      exitCode: 0,
    });

    const provider = new CodexShellProvider(undefined, { maxEmptyRetries: 0 });
    await expect(provider.generate('prompt', 'system')).rejects.toThrow('empty response');
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it('passes output-last-message path to codex exec', async () => {
    mockExec.mockResolvedValue({
      stdout: jsonEvent({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'output' },
      }),
      stderr: '',
      exitCode: 0,
    });

    const provider = new CodexShellProvider();
    await provider.generate('prompt', 'system');

    const args = mockExec.mock.calls[0][1];
    const outputIdx = args.indexOf('--output-last-message');
    expect(outputIdx).toBeGreaterThan(-1);
    expect(args[outputIdx + 1]).toContain('llmdocs-codex-last-');
  });

  it('uses stdin for large combined prompts', async () => {
    mockExec.mockResolvedValue({
      stdout: jsonEvent({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'output' },
      }),
      stderr: '',
      exitCode: 0,
    });

    const largePrompt = 'x'.repeat(60_000);
    const provider = new CodexShellProvider();
    await provider.generate(largePrompt, 'system');

    const args = mockExec.mock.calls[0][1];
    expect(args[1]).toBe('-');

    const options = mockExec.mock.calls[0][2];
    expect(options?.stdin).toContain(largePrompt);
  });

  it('falls back to plain text stdout when json events are unavailable', async () => {
    mockExec.mockResolvedValue({
      stdout: '---FILE: AGENTS.md---\n# Plain text',
      stderr: '',
      exitCode: 0,
    });

    const provider = new CodexShellProvider();
    const result = await provider.generate('prompt', 'system');
    expect(result).toContain('# Plain text');
  });

  it('uses the last valid file-block message when final message is non-file text', async () => {
    mockExec.mockResolvedValue({
      stdout: [
        jsonEvent({
          type: 'item.completed',
          item: { type: 'agent_message', text: '---FILE: AGENTS.md---\n# Valid output' },
        }),
        jsonEvent({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'Done. Generation complete.' },
        }),
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    });

    const provider = new CodexShellProvider();
    const result = await provider.generate('prompt', 'system');
    expect(result).toContain('---FILE: AGENTS.md---');
    expect(result).toContain('# Valid output');
  });

  it('aggregates agent messages when file blocks are split across events', async () => {
    mockExec.mockResolvedValue({
      stdout: [
        jsonEvent({
          type: 'item.completed',
          item: { type: 'agent_message', text: '---FILE: AGENTS.md---' },
        }),
        jsonEvent({
          type: 'item.completed',
          item: { type: 'agent_message', text: '# Reconstructed from parts' },
        }),
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    });

    const provider = new CodexShellProvider();
    const result = await provider.generate('prompt', 'system');
    expect(result).toContain('---FILE: AGENTS.md---');
    expect(result).toContain('# Reconstructed from parts');
  });
});
