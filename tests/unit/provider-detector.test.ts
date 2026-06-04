import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/shell.js', () => ({
  isCommandAvailable: vi.fn(),
  execCommand: vi.fn(),
}));

import { detectProviders } from '../../src/core/provider-detector.js';
import { execCommand, isCommandAvailable } from '../../src/utils/shell.js';

const mockIsAvailable = vi.mocked(isCommandAvailable);
const mockExec = vi.mocked(execCommand);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ANTHROPIC_API_KEY = '';

  mockIsAvailable.mockResolvedValue(true);
  mockExec.mockImplementation(async (command, args) => {
    if (command === 'claude' && args[0] === '--version') {
      return { stdout: '2.1.44 (Claude Code)', stderr: '', exitCode: 0 };
    }

    if (command === 'claude' && args[0] === 'auth') {
      return {
        stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth' }),
        stderr: '',
        exitCode: 0,
      };
    }

    if (command === 'codex' && args[0] === 'login') {
      return { stdout: '', stderr: 'Logged in using ChatGPT', exitCode: 0 };
    }

    if (command === 'agent' && args[0] === '--version') {
      return { stdout: '0.50.0', stderr: '', exitCode: 0 };
    }

    if (command === 'agent' && args[0] === 'status') {
      return { stdout: '', stderr: 'Logged in as test-user', exitCode: 0 };
    }

    return { stdout: '', stderr: '', exitCode: 0 };
  });
});

describe('detectProviders', () => {
  it('detects all providers when available', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

    const providers = await detectProviders();

    expect(mockIsAvailable).toHaveBeenCalledWith('claude', 1_500);
    expect(mockIsAvailable).toHaveBeenCalledWith('codex', 1_500);
    expect(mockIsAvailable).toHaveBeenCalledWith('agent', 1_500);
    expect(mockIsAvailable).toHaveBeenCalledWith('cursor', 1_500);

    expect(providers).toHaveLength(5);
    expect(providers[0]).toEqual({
      type: 'claude-code',
      name: 'Claude Code CLI',
      available: true,
    });
    expect(providers[1]).toEqual({
      type: 'codex-cli',
      name: 'Codex CLI',
      available: true,
    });
    expect(providers[2]).toEqual({
      type: 'cursor-agent',
      name: 'Cursor Agent CLI',
      available: true,
    });
    expect(providers[3]).toEqual({
      type: 'anthropic',
      name: 'Anthropic API (BYOK)',
      available: true,
    });
    expect(providers[4]).toEqual({
      type: 'custom',
      name: 'Custom API (OpenAI-compatible)',
      available: true,
      reason: 'Requires base URL, model name, and API key env variable',
    });

    const claudeStatusCall = mockExec.mock.calls.find(
      (call) => call[0] === 'claude' && call[1][0] === 'auth' && call[1][1] === 'status',
    );
    expect(claudeStatusCall).toBeDefined();

    const codexStatusCall = mockExec.mock.calls.find(
      (call) => call[0] === 'codex' && call[1][0] === 'login' && call[1][1] === 'status',
    );
    expect(codexStatusCall).toBeDefined();

    const cursorStatusCall = mockExec.mock.calls.find(
      (call) => call[0] === 'agent' && call[1][0] === 'status',
    );
    expect(cursorStatusCall).toBeDefined();
  });

  it('marks providers unavailable when CLIs are not installed', async () => {
    mockIsAvailable.mockResolvedValue(false);

    const providers = await detectProviders();

    expect(providers[0]).toMatchObject({
      type: 'claude-code',
      available: false,
      reason: 'Not installed',
    });
    expect(providers[1]).toMatchObject({
      type: 'codex-cli',
      available: false,
      reason: 'Not installed',
    });
    expect(providers[2]).toMatchObject({
      type: 'cursor-agent',
      available: false,
      reason:
        'Not installed (required command missing: `agent`). Install Agent CLI and add ~/.local/bin to PATH.',
    });
    expect(providers[3]).toMatchObject({
      type: 'anthropic',
      available: false,
      reason: 'ANTHROPIC_API_KEY not set',
    });
  });

  it('marks Claude unavailable when auth status says logged out', async () => {
    mockExec.mockImplementation(async (command, args) => {
      if (command === 'claude' && args[0] === '--version') {
        return { stdout: '2.1.44', stderr: '', exitCode: 0 };
      }

      if (command === 'claude' && args[0] === 'auth') {
        return {
          stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }),
          stderr: '',
          exitCode: 1,
        };
      }

      if (command === 'codex' && args[0] === 'login') {
        return { stdout: '', stderr: 'Logged in using ChatGPT', exitCode: 0 };
      }

      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const providers = await detectProviders();

    expect(providers[0].available).toBe(false);
    expect(providers[0].reason).toContain('claude auth login');
    expect(providers[1].available).toBe(true);
  });

  it('marks Claude unavailable when state files are not accessible', async () => {
    mockExec.mockImplementation(async (command, args) => {
      if (command === 'claude' && args[0] === '--version') {
        return { stdout: '2.1.44', stderr: '', exitCode: 0 };
      }

      if (command === 'claude' && args[0] === 'auth') {
        return {
          stdout: '',
          stderr: "EPERM: operation not permitted, open '/Users/test/.claude.json.tmp.1234'",
          exitCode: 1,
        };
      }

      if (command === 'codex' && args[0] === 'login') {
        return { stdout: '', stderr: 'Logged in using ChatGPT', exitCode: 0 };
      }

      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const providers = await detectProviders();

    expect(providers[0].available).toBe(false);
    expect(providers[0].reason).toContain('cannot access Claude state files');
  });

  it('marks Claude degraded when auth status check times out', async () => {
    mockExec.mockImplementation(async (command, args) => {
      if (command === 'claude' && args[0] === '--version') {
        return { stdout: '2.1.44', stderr: '', exitCode: 0 };
      }

      if (command === 'claude' && args[0] === 'auth') {
        throw new Error('Command timed out after 4s: claude');
      }

      if (command === 'codex' && args[0] === 'login') {
        return { stdout: '', stderr: 'Logged in using ChatGPT', exitCode: 0 };
      }

      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const providers = await detectProviders();

    expect(providers[0]).toMatchObject({
      type: 'claude-code',
      available: true,
      degraded: true,
    });
    expect(providers[0].reason).toContain('timed out');
    expect(providers[1].available).toBe(true);
  });

  it('marks Claude unavailable when version check fails', async () => {
    mockExec.mockImplementation(async (command, args) => {
      if (command === 'claude' && args[0] === '--version') {
        return { stdout: '', stderr: 'failed', exitCode: 1 };
      }

      if (command === 'codex' && args[0] === 'login') {
        return { stdout: '', stderr: 'Logged in using ChatGPT', exitCode: 0 };
      }

      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const providers = await detectProviders();

    expect(providers[0].available).toBe(false);
    expect(providers[0].reason).toBe('Installed, but CLI invocation failed');
    expect(providers[1].available).toBe(true);
  });

  it('marks Codex unavailable when login status says logged out', async () => {
    mockExec.mockImplementation(async (command, args) => {
      if (command === 'claude' && args[0] === '--version') {
        return { stdout: '2.1.44', stderr: '', exitCode: 0 };
      }

      if (command === 'claude' && args[0] === 'auth') {
        return {
          stdout: JSON.stringify({ loggedIn: true }),
          stderr: '',
          exitCode: 0,
        };
      }

      if (command === 'codex' && args[0] === 'login') {
        return { stdout: '', stderr: 'Not logged in. Run codex login', exitCode: 1 };
      }

      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const providers = await detectProviders();

    expect(providers[0].available).toBe(true);
    expect(providers[1].available).toBe(false);
    expect(providers[1].reason).toContain('Run: codex login');
  });

  it('marks Codex degraded when login status check times out', async () => {
    mockExec.mockImplementation(async (command, args) => {
      if (command === 'claude' && args[0] === '--version') {
        return { stdout: '2.1.44', stderr: '', exitCode: 0 };
      }

      if (command === 'claude' && args[0] === 'auth') {
        return {
          stdout: JSON.stringify({ loggedIn: true }),
          stderr: '',
          exitCode: 0,
        };
      }

      if (command === 'codex' && args[0] === 'login') {
        throw new Error('Command timed out after 4s: codex');
      }

      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const providers = await detectProviders();

    expect(providers[1]).toMatchObject({
      type: 'codex-cli',
      available: true,
      degraded: true,
    });
    expect(providers[1].reason).toContain('timed out');
  });

  it('marks Codex degraded when login status command is unsupported', async () => {
    mockExec.mockImplementation(async (command, args) => {
      if (command === 'claude' && args[0] === '--version') {
        return { stdout: '2.1.44', stderr: '', exitCode: 0 };
      }

      if (command === 'claude' && args[0] === 'auth') {
        return {
          stdout: JSON.stringify({ loggedIn: true }),
          stderr: '',
          exitCode: 0,
        };
      }

      if (command === 'codex' && args[0] === 'login') {
        return {
          stdout: '',
          stderr: "error: unrecognized subcommand 'status'",
          exitCode: 2,
        };
      }

      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const providers = await detectProviders();

    expect(providers[1]).toMatchObject({
      type: 'codex-cli',
      available: true,
      degraded: true,
    });
    expect(providers[1].reason).toContain('unsupported');
  });

  it('marks Cursor Agent unavailable when only Cursor IDE shim is present', async () => {
    mockIsAvailable.mockImplementation(async (command) => command !== 'agent');
    mockExec.mockImplementation(async (command, args) => {
      if (command === 'claude' && args[0] === '--version') {
        return { stdout: '2.1.44', stderr: '', exitCode: 0 };
      }

      if (command === 'claude' && args[0] === 'auth') {
        return {
          stdout: JSON.stringify({ loggedIn: true }),
          stderr: '',
          exitCode: 0,
        };
      }

      if (command === 'codex' && args[0] === 'login') {
        return { stdout: '', stderr: 'Logged in using ChatGPT', exitCode: 0 };
      }

      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const providers = await detectProviders();

    expect(providers[2]).toMatchObject({
      type: 'cursor-agent',
      available: false,
    });
    expect(providers[2].reason).toContain('likely IDE shim');
  });

  it('marks Cursor Agent unavailable when status says logged out', async () => {
    mockExec.mockImplementation(async (command, args) => {
      if (command === 'claude' && args[0] === '--version') {
        return { stdout: '2.1.44', stderr: '', exitCode: 0 };
      }

      if (command === 'claude' && args[0] === 'auth') {
        return {
          stdout: JSON.stringify({ loggedIn: true }),
          stderr: '',
          exitCode: 0,
        };
      }

      if (command === 'codex' && args[0] === 'login') {
        return { stdout: '', stderr: 'Logged in using ChatGPT', exitCode: 0 };
      }

      if (command === 'agent' && args[0] === '--version') {
        return { stdout: '0.50.0', stderr: '', exitCode: 0 };
      }

      if (command === 'agent' && args[0] === 'status') {
        return { stdout: '', stderr: 'Not logged in. Run cursor agent login', exitCode: 1 };
      }

      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const providers = await detectProviders();

    expect(providers[2].available).toBe(false);
    expect(providers[2].reason).toContain('agent login');
  });

  it('marks Cursor Agent degraded when status check times out', async () => {
    mockExec.mockImplementation(async (command, args) => {
      if (command === 'claude' && args[0] === '--version') {
        return { stdout: '2.1.44', stderr: '', exitCode: 0 };
      }

      if (command === 'claude' && args[0] === 'auth') {
        return {
          stdout: JSON.stringify({ loggedIn: true }),
          stderr: '',
          exitCode: 0,
        };
      }

      if (command === 'codex' && args[0] === 'login') {
        return { stdout: '', stderr: 'Logged in using ChatGPT', exitCode: 0 };
      }

      if (command === 'agent' && args[0] === '--version') {
        return { stdout: '0.50.0', stderr: '', exitCode: 0 };
      }

      if (command === 'agent' && args[0] === 'status') {
        throw new Error('Command timed out after 4s: agent');
      }

      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const providers = await detectProviders();

    expect(providers[2]).toMatchObject({
      type: 'cursor-agent',
      available: true,
      degraded: true,
    });
    expect(providers[2].reason).toContain('timed out');
  });

  it('marks Cursor Agent degraded when status command is unsupported', async () => {
    mockExec.mockImplementation(async (command, args) => {
      if (command === 'claude' && args[0] === '--version') {
        return { stdout: '2.1.44', stderr: '', exitCode: 0 };
      }

      if (command === 'claude' && args[0] === 'auth') {
        return {
          stdout: JSON.stringify({ loggedIn: true }),
          stderr: '',
          exitCode: 0,
        };
      }

      if (command === 'codex' && args[0] === 'login') {
        return { stdout: '', stderr: 'Logged in using ChatGPT', exitCode: 0 };
      }

      if (command === 'agent' && args[0] === '--version') {
        return { stdout: '0.50.0', stderr: '', exitCode: 0 };
      }

      if (command === 'agent' && args[0] === 'status') {
        return {
          stdout: '',
          stderr: "error: unrecognized subcommand 'status'",
          exitCode: 2,
        };
      }

      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const providers = await detectProviders();

    expect(providers[2]).toMatchObject({
      type: 'cursor-agent',
      available: true,
      degraded: true,
    });
    expect(providers[2].reason).toContain('unsupported');
  });
});
