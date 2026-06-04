import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execCommand, isCommandAvailable } from '../../src/utils/shell.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';

const mockExecFile = vi.mocked(execFile);
type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('execCommand', () => {
  it('returns stdout, stderr and exitCode on success', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      const cb = callback as ExecFileCallback;
      cb(null, 'output text', '');
      return {} as ReturnType<typeof execFile>;
    });

    const result = await execCommand('echo', ['hello']);

    expect(result.stdout).toBe('output text');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('returns non-zero exit code on command failure', async () => {
    const error = Object.assign(new Error('fail'), { code: 1 });
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      const cb = callback as ExecFileCallback;
      cb(error, '', 'some error');
      return {} as ReturnType<typeof execFile>;
    });

    const result = await execCommand('bad', ['cmd']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('some error');
  });

  it('rejects on timeout (killed process)', async () => {
    const error = Object.assign(new Error('timeout'), { killed: true });
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      const cb = callback as ExecFileCallback;
      cb(error, '', '');
      return {} as ReturnType<typeof execFile>;
    });

    await expect(execCommand('slow', [], { timeout: 1000 })).rejects.toThrow('timed out');
  });

  it('passes stdin to child process', async () => {
    const mockStdin = { write: vi.fn(), end: vi.fn() };
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      const cb = callback as ExecFileCallback;
      cb(null, 'ok', '');
      return { stdin: mockStdin } as unknown as ReturnType<typeof execFile>;
    });

    await execCommand('cmd', [], { stdin: 'input data' });

    expect(mockStdin.write).toHaveBeenCalledWith('input data');
    expect(mockStdin.end).toHaveBeenCalled();
  });
});

describe('isCommandAvailable', () => {
  it('returns true when command is found', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      const cb = callback as ExecFileCallback;
      cb(null, '/usr/bin/node', '');
      return {} as ReturnType<typeof execFile>;
    });

    const result = await isCommandAvailable('node');
    expect(result).toBe(true);
  });

  it('returns false when command is not found', async () => {
    const error = Object.assign(new Error('not found'), { code: 1 });
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      const cb = callback as ExecFileCallback;
      cb(error, '', '');
      return {} as ReturnType<typeof execFile>;
    });

    const result = await isCommandAvailable('nonexistent');
    expect(result).toBe(false);
  });
});
