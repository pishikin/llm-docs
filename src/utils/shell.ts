import { execFile } from 'node:child_process';
import { platform } from 'node:os';

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  timeout?: number;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
}

const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_COMMAND_AVAILABILITY_TIMEOUT = 5_000;

export function execCommand(
  command: string,
  args: string[],
  options?: ExecOptions,
): Promise<ShellResult> {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT;

  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        timeout,
        cwd: options?.cwd,
        env: options?.env ? { ...process.env, ...options.env } : undefined,
        maxBuffer: 10 * 1024 * 1024,
        killSignal: 'SIGTERM',
      },
      (error, stdout, stderr) => {
        if (error && 'killed' in error && error.killed) {
          reject(new Error(`Command timed out after ${timeout / 1000}s: ${command}`));
          return;
        }

        const exitCode =
          error && 'code' in error && typeof error.code === 'number' ? error.code : error ? 1 : 0;

        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
          exitCode,
        });
      },
    );

    if (options?.stdin && child.stdin) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
  });
}

export async function isCommandAvailable(
  command: string,
  timeout = DEFAULT_COMMAND_AVAILABILITY_TIMEOUT,
): Promise<boolean> {
  const whichCmd = platform() === 'win32' ? 'where' : 'which';
  try {
    const result = await execCommand(whichCmd, [command], { timeout });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
