import type { ProviderType } from '../types/index.js';
import { execCommand, isCommandAvailable } from '../utils/shell.js';

export interface AvailableProvider {
  type: ProviderType;
  name: string;
  available: boolean;
  degraded?: boolean;
  reason?: string;
}

const COMMAND_AVAILABILITY_TIMEOUT = 1_500;
const CLI_VERSION_CHECK_TIMEOUT = 2_500;
const STATUS_CHECK_TIMEOUT = 4_000;

function toNormalizedOutput(stdout: string, stderr: string): string {
  return `${stderr}\n${stdout}`.toLowerCase();
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    // no-op
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    return null;
  }

  try {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseClaudeAuthLoggedIn(stdout: string, stderr: string): boolean | undefined {
  const stdoutJson = parseJsonObject(stdout);
  if (stdoutJson && typeof stdoutJson.loggedIn === 'boolean') {
    return stdoutJson.loggedIn;
  }

  const stderrJson = parseJsonObject(stderr);
  if (stderrJson && typeof stderrJson.loggedIn === 'boolean') {
    return stderrJson.loggedIn;
  }

  return undefined;
}

function isLoginRequired(output: string): boolean {
  return (
    output.includes('not logged in') ||
    output.includes('please run /login') ||
    output.includes('run /login') ||
    output.includes('run: claude login') ||
    output.includes('claude login')
  );
}

function isClaudeStatePermissionIssue(output: string): boolean {
  const hasPermissionHint =
    output.includes('eperm') ||
    output.includes('eacces') ||
    output.includes('permission denied') ||
    output.includes('operation not permitted');

  const hasClaudeStatePath =
    output.includes('.claude') ||
    output.includes('.claude.json') ||
    output.includes('claude.json.tmp');

  return hasPermissionHint && hasClaudeStatePath;
}

function isUnsupportedStatusCommand(output: string): boolean {
  return (
    output.includes('unknown command') ||
    output.includes('unknown option') ||
    output.includes('unrecognized option') ||
    output.includes('unrecognized subcommand')
  );
}

function classifyCodexLoginStatus(
  output: string,
): 'logged-in' | 'logged-out' | 'unsupported' | 'unknown' {
  if (
    output.includes('not logged in') ||
    output.includes('not authenticated') ||
    output.includes('login required') ||
    output.includes('run codex login') ||
    output.includes('run `codex login`')
  ) {
    return 'logged-out';
  }

  if (output.includes('logged in')) {
    return 'logged-in';
  }

  if (isUnsupportedStatusCommand(output)) {
    return 'unsupported';
  }

  return 'unknown';
}

function classifyCursorAgentLoginStatus(
  output: string,
): 'logged-in' | 'logged-out' | 'unsupported' | 'unknown' {
  if (
    output.includes('not logged in') ||
    output.includes('not authenticated') ||
    output.includes('login required') ||
    output.includes('run agent login') ||
    output.includes('run `agent login`') ||
    output.includes('run cursor-agent login') ||
    output.includes('run `cursor-agent login`') ||
    output.includes('run cursor login') ||
    output.includes('run cursor agent login')
  ) {
    return 'logged-out';
  }

  if (
    output.includes('logged in') ||
    output.includes('authenticated') ||
    output.includes('active account') ||
    output.includes('account:')
  ) {
    return 'logged-in';
  }

  if (isUnsupportedStatusCommand(output)) {
    return 'unsupported';
  }

  return 'unknown';
}

async function checkClaudeCode(): Promise<AvailableProvider> {
  const base: Pick<AvailableProvider, 'type' | 'name'> = {
    type: 'claude-code',
    name: 'Claude Code CLI',
  };

  if (!(await isCommandAvailable('claude', COMMAND_AVAILABILITY_TIMEOUT))) {
    return { ...base, available: false, reason: 'Not installed' };
  }

  try {
    const version = await execCommand('claude', ['--version'], {
      timeout: CLI_VERSION_CHECK_TIMEOUT,
    });

    if (version.exitCode !== 0) {
      return {
        ...base,
        available: false,
        reason: 'Installed, but CLI invocation failed',
      };
    }
  } catch {
    return {
      ...base,
      available: false,
      reason: 'Installed, but CLI invocation failed',
    };
  }

  try {
    const result = await execCommand('claude', ['auth', 'status'], {
      timeout: STATUS_CHECK_TIMEOUT,
    });

    const output = toNormalizedOutput(result.stdout, result.stderr);
    const loggedIn = parseClaudeAuthLoggedIn(result.stdout, result.stderr);

    if (loggedIn === true) {
      return { ...base, available: true };
    }

    if (loggedIn === false || isLoginRequired(output)) {
      return {
        ...base,
        available: false,
        reason: 'Not logged in. Run: claude auth login',
      };
    }

    if (isClaudeStatePermissionIssue(output)) {
      return {
        ...base,
        available: false,
        reason: 'Installed, but cannot access Claude state files (~/.claude*)',
      };
    }

    if (isUnsupportedStatusCommand(output)) {
      return {
        ...base,
        available: true,
        degraded: true,
        reason: 'Auth status command unsupported in this Claude CLI version',
      };
    }

    if (result.exitCode === 0) {
      return {
        ...base,
        available: true,
        degraded: true,
        reason: 'Auth status output was not recognized',
      };
    }

    return {
      ...base,
      available: true,
      degraded: true,
      reason: 'Auth status check failed (provider still selectable)',
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

    if (isLoginRequired(message)) {
      return {
        ...base,
        available: false,
        reason: 'Not logged in. Run: claude auth login',
      };
    }

    if (isClaudeStatePermissionIssue(message)) {
      return {
        ...base,
        available: false,
        reason: 'Installed, but cannot access Claude state files (~/.claude*)',
      };
    }

    if (message.includes('timed out')) {
      return {
        ...base,
        available: true,
        degraded: true,
        reason: 'Auth status check timed out (provider still selectable)',
      };
    }

    return {
      ...base,
      available: true,
      degraded: true,
      reason: 'Auth status check could not complete (provider still selectable)',
    };
  }
}

async function checkCodexCli(): Promise<AvailableProvider> {
  const base: Pick<AvailableProvider, 'type' | 'name'> = {
    type: 'codex-cli',
    name: 'Codex CLI',
  };

  if (!(await isCommandAvailable('codex', COMMAND_AVAILABILITY_TIMEOUT))) {
    return { ...base, available: false, reason: 'Not installed' };
  }

  try {
    const result = await execCommand('codex', ['login', 'status'], {
      timeout: STATUS_CHECK_TIMEOUT,
    });

    const status = classifyCodexLoginStatus(toNormalizedOutput(result.stdout, result.stderr));
    if (status === 'logged-in') {
      return { ...base, available: true };
    }

    if (status === 'logged-out') {
      return {
        ...base,
        available: false,
        reason: 'Not logged in. Run: codex login',
      };
    }

    if (status === 'unsupported') {
      return {
        ...base,
        available: true,
        degraded: true,
        reason: 'Login status command unsupported in this Codex CLI version',
      };
    }

    if (result.exitCode === 0) {
      return {
        ...base,
        available: true,
        degraded: true,
        reason: 'Login status output was not recognized',
      };
    }

    return {
      ...base,
      available: true,
      degraded: true,
      reason: 'Login status check failed (provider still selectable)',
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    const status = classifyCodexLoginStatus(message);

    if (status === 'logged-out') {
      return {
        ...base,
        available: false,
        reason: 'Not logged in. Run: codex login',
      };
    }

    if (message.includes('timed out')) {
      return {
        ...base,
        available: true,
        degraded: true,
        reason: 'Login status check timed out (provider still selectable)',
      };
    }

    return {
      ...base,
      available: true,
      degraded: true,
      reason: 'Installed, but login status check could not complete',
    };
  }
}

async function checkCursorAgent(): Promise<AvailableProvider> {
  const base: Pick<AvailableProvider, 'type' | 'name'> = {
    type: 'cursor-agent',
    name: 'Cursor Agent CLI',
  };

  const hasAgentBinary = await isCommandAvailable('agent', COMMAND_AVAILABILITY_TIMEOUT);
  const hasCursorBinary = await isCommandAvailable('cursor', COMMAND_AVAILABILITY_TIMEOUT);

  if (!hasAgentBinary && hasCursorBinary) {
    return {
      ...base,
      available: false,
      reason:
        'Agent CLI (`agent`) not found, but `cursor` command exists (likely IDE shim). Install Agent CLI and add ~/.local/bin to PATH.',
    };
  }

  if (!hasAgentBinary) {
    return {
      ...base,
      available: false,
      reason:
        'Not installed (required command missing: `agent`). Install Agent CLI and add ~/.local/bin to PATH.',
    };
  }

  try {
    const version = await execCommand('agent', ['--version'], {
      timeout: CLI_VERSION_CHECK_TIMEOUT,
    });
    if (version.exitCode !== 0) {
      return {
        ...base,
        available: false,
        reason: 'Installed, but CLI invocation failed',
      };
    }
  } catch {
    return {
      ...base,
      available: false,
      reason: 'Installed, but CLI invocation failed',
    };
  }

  try {
    const result = await execCommand('agent', ['status'], {
      timeout: STATUS_CHECK_TIMEOUT,
    });
    const status = classifyCursorAgentLoginStatus(toNormalizedOutput(result.stdout, result.stderr));

    if (status === 'logged-in') {
      return { ...base, available: true };
    }

    if (status === 'logged-out') {
      return {
        ...base,
        available: false,
        reason: 'Not logged in. Run: agent login',
      };
    }

    if (status === 'unsupported') {
      return {
        ...base,
        available: true,
        degraded: true,
        reason: 'Status command unsupported in this Cursor Agent CLI version',
      };
    }

    if (result.exitCode === 0) {
      return {
        ...base,
        available: true,
        degraded: true,
        reason: 'Status output was not recognized',
      };
    }

    return {
      ...base,
      available: true,
      degraded: true,
      reason: 'Status check failed (provider still selectable)',
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    const status = classifyCursorAgentLoginStatus(message);

    if (status === 'logged-out') {
      return {
        ...base,
        available: false,
        reason: 'Not logged in. Run: agent login',
      };
    }

    if (message.includes('timed out')) {
      return {
        ...base,
        available: true,
        degraded: true,
        reason: 'Status check timed out (provider still selectable)',
      };
    }

    return {
      ...base,
      available: true,
      degraded: true,
      reason: 'Installed, but status check could not complete',
    };
  }
}

function checkAnthropicApi(): AvailableProvider {
  const base: Pick<AvailableProvider, 'type' | 'name'> = {
    type: 'anthropic',
    name: 'Anthropic API (BYOK)',
  };

  if (process.env.ANTHROPIC_API_KEY) {
    return { ...base, available: true };
  }

  return {
    ...base,
    available: false,
    reason: 'ANTHROPIC_API_KEY not set',
  };
}

function checkCustomApi(): AvailableProvider {
  return {
    type: 'custom',
    name: 'Custom API (OpenAI-compatible)',
    available: true,
    reason: 'Requires base URL, model name, and API key env variable',
  };
}

export async function detectProviders(): Promise<AvailableProvider[]> {
  const [claudeCode, codexCli, cursorAgent] = await Promise.all([
    checkClaudeCode(),
    checkCodexCli(),
    checkCursorAgent(),
  ]);

  const anthropic = checkAnthropicApi();
  const custom = checkCustomApi();

  return [claudeCode, codexCli, cursorAgent, anthropic, custom];
}
