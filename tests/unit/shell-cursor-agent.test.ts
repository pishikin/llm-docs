import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/shell.js', () => ({
  execCommand: vi.fn(),
  isCommandAvailable: vi.fn(),
}));

import { CursorAgentShellProvider } from '../../src/providers/shell-cursor-agent.js';
import { execCommand, isCommandAvailable } from '../../src/utils/shell.js';

const mockExec = vi.mocked(execCommand);
const mockIsAvailable = vi.mocked(isCommandAvailable);
const jsonEvent = (event: unknown) => JSON.stringify(event);

beforeEach(() => {
  vi.clearAllMocks();
  mockIsAvailable.mockImplementation(async (command) => command === 'agent');
});

describe('CursorAgentShellProvider', () => {
  it('generates text via agent CLI and parses stream-json output', async () => {
    mockExec.mockResolvedValue({
      stdout: jsonEvent({
        type: 'assistant',
        text: '---FILE: AGENTS.md---\n# Test Project',
      }),
      stderr: '',
      exitCode: 0,
    });

    const provider = new CursorAgentShellProvider();
    const result = await provider.generate('user prompt', 'system prompt');

    expect(result).toContain('# Test Project');
    const [cmd, args] = mockExec.mock.calls[0];
    expect(cmd).toBe('agent');
    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    const promptArg = args[args.indexOf('-p') + 1];
    expect(promptArg).toContain('<system>');
    expect(promptArg).toContain('system prompt');
    expect(promptArg).toContain('user prompt');
  });

  it('passes model flag when specified', async () => {
    mockExec.mockResolvedValue({
      stdout: jsonEvent({
        type: 'assistant',
        text: '---FILE: AGENTS.md---\n# Test',
      }),
      stderr: '',
      exitCode: 0,
    });

    const provider = new CursorAgentShellProvider('claude-4-sonnet');
    await provider.generate('prompt', 'system');

    const args = mockExec.mock.calls[0][1];
    expect(args).toContain('--model');
    expect(args).toContain('claude-4-sonnet');
  });

  it('retries with --model auto when named model is restricted by free plan', async () => {
    mockExec
      .mockResolvedValueOnce({
        stdout: '',
        stderr:
          'Named models unavailable. Free plans can only use Auto. Switch to Auto or upgrade plans to continue.',
        exitCode: 1,
      })
      .mockResolvedValueOnce({
        stdout: jsonEvent({
          type: 'assistant',
          text: '---FILE: AGENTS.md---\n# Auto model output',
        }),
        stderr: '',
        exitCode: 0,
      });

    const provider = new CursorAgentShellProvider('claude-4-sonnet');
    const result = await provider.generate('prompt', 'system');

    expect(result).toContain('Auto model output');
    expect(mockExec).toHaveBeenCalledTimes(2);
    expect(mockExec.mock.calls[0][1]).toContain('--model');
    expect(mockExec.mock.calls[0][1]).toContain('claude-4-sonnet');
    expect(mockExec.mock.calls[1][1]).toContain('--model');
    expect(mockExec.mock.calls[1][1]).toContain('auto');
  });

  it('falls back to default output mode when --output-format is unsupported', async () => {
    mockExec
      .mockResolvedValueOnce({
        stdout: '',
        stderr: 'error: unknown option --output-format',
        exitCode: 1,
      })
      .mockResolvedValueOnce({
        stdout: '',
        stderr: 'error: unknown option --output-format',
        exitCode: 1,
      })
      .mockResolvedValueOnce({
        stdout: '',
        stderr: 'error: unknown option --output-format',
        exitCode: 1,
      })
      .mockResolvedValueOnce({
        stdout: '---FILE: AGENTS.md---\n# Fallback plain output',
        stderr: '',
        exitCode: 0,
      });

    const provider = new CursorAgentShellProvider();
    const result = await provider.generate('prompt', 'system');
    expect(result).toContain('Fallback plain output');
    expect(mockExec).toHaveBeenCalledTimes(4);

    const firstArgs = mockExec.mock.calls[0][1];
    expect(firstArgs).toContain('--output-format');
    expect(firstArgs).toContain('stream-json');

    const lastArgs = mockExec.mock.calls[3][1];
    expect(lastArgs).not.toContain('--output-format');
  });

  it('falls back from stdin mode for large prompts when "-" is unsupported', async () => {
    mockExec
      .mockResolvedValueOnce({
        stdout: '',
        stderr: 'prompt is required',
        exitCode: 1,
      })
      .mockResolvedValueOnce({
        stdout: jsonEvent({
          type: 'assistant',
          text: '---FILE: AGENTS.md---\n# Large prompt output',
        }),
        stderr: '',
        exitCode: 0,
      });

    const largePrompt = 'x'.repeat(60_000);
    const provider = new CursorAgentShellProvider();
    const result = await provider.generate(largePrompt, 'system');
    expect(result).toContain('Large prompt output');

    const firstArgs = mockExec.mock.calls[0][1];
    expect(firstArgs[firstArgs.indexOf('-p') + 1]).toBe('-');
    const firstOpts = mockExec.mock.calls[0][2];
    expect(firstOpts?.stdin).toContain(largePrompt);

    const secondArgs = mockExec.mock.calls[1][1];
    expect(secondArgs[secondArgs.indexOf('-p') + 1]).not.toBe('-');
  });

  it('throws ProviderError on non-zero exit', async () => {
    mockExec.mockResolvedValue({
      stdout: '',
      stderr: 'authentication failed',
      exitCode: 1,
    });

    const provider = new CursorAgentShellProvider();
    await expect(provider.generate('prompt', 'system')).rejects.toThrow('Cursor Agent CLI failed');
  });

  it('maps timeout errors to user-friendly ProviderError', async () => {
    mockExec.mockRejectedValue(new Error('Command timed out after 300s: agent'));

    const provider = new CursorAgentShellProvider(undefined, { timeoutMs: 300_000 });
    await expect(provider.generate('prompt', 'system')).rejects.toThrow('timed out after 300s');
  });

  it('retries with --trust when workspace trust is required', async () => {
    mockExec
      .mockResolvedValueOnce({
        stdout: '',
        stderr: 'Workspace Trust Required. Pass --trust, --yolo, or -f.',
        exitCode: 1,
      })
      .mockResolvedValueOnce({
        stdout: jsonEvent({
          type: 'assistant',
          text: '---FILE: AGENTS.md---\n# Trusted output',
        }),
        stderr: '',
        exitCode: 0,
      });

    const provider = new CursorAgentShellProvider();
    const result = await provider.generate('prompt', 'system');

    expect(result).toContain('Trusted output');
    expect(mockExec).toHaveBeenCalledTimes(2);
    expect(mockExec.mock.calls[0][1]).not.toContain('--trust');
    expect(mockExec.mock.calls[1][1]).toContain('--trust');
  });

  it('uses selected trust mode flag on retry', async () => {
    mockExec
      .mockResolvedValueOnce({
        stdout: '',
        stderr: 'Workspace Trust Required. Pass --trust, --yolo, or -f.',
        exitCode: 1,
      })
      .mockResolvedValueOnce({
        stdout: jsonEvent({
          type: 'assistant',
          text: '---FILE: AGENTS.md---\n# Trusted output',
        }),
        stderr: '',
        exitCode: 0,
      });

    const provider = new CursorAgentShellProvider(undefined, { trustMode: 'yolo' });
    await provider.generate('prompt', 'system');

    expect(mockExec).toHaveBeenCalledTimes(2);
    expect(mockExec.mock.calls[1][1]).toContain('--yolo');
  });

  it('returns actionable error in manual trust mode', async () => {
    mockExec.mockResolvedValue({
      stdout: '',
      stderr: 'Workspace Trust Required. Pass --trust, --yolo, or -f.',
      exitCode: 1,
    });

    const provider = new CursorAgentShellProvider(undefined, { trustMode: 'manual' });
    await expect(provider.generate('prompt', 'system')).rejects.toThrow(
      'provider.cursorAgent.trustMode',
    );
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it('throws a clear error when only Cursor IDE shim is present', async () => {
    mockIsAvailable.mockImplementation(async (command) => command === 'cursor');
    mockExec.mockResolvedValue({
      stdout: jsonEvent({
        type: 'assistant',
        text: '---FILE: AGENTS.md---\n# Cursor subcommand output',
      }),
      stderr: '',
      exitCode: 0,
    });

    const provider = new CursorAgentShellProvider();
    await expect(provider.generate('prompt', 'system')).rejects.toThrow(
      'requires standalone `agent` CLI',
    );
    expect(mockExec).not.toHaveBeenCalled();
  });
});
