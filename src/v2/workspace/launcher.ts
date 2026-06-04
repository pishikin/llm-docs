import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRelativePath } from '../../utils/fs.js';
import type { WorkspacePaths } from '../types.js';

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quoteJavascriptString(value: string | null): string {
  if (value === null) {
    return 'null';
  }

  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isRunnableJavascriptFile(filePath: string): Promise<boolean> {
  return ['.js', '.mjs', '.cjs'].includes(path.extname(filePath)) && (await fileExists(filePath));
}

async function isLikelyCliEntrypoint(filePath: string): Promise<boolean> {
  if (!(await isRunnableJavascriptFile(filePath))) {
    return false;
  }

  try {
    const content = await readFile(filePath, 'utf-8');
    return (
      content.includes("name('llm-docs')") ||
      content.includes('.name("llm-docs")') ||
      (content.includes('llm-docs') && content.includes('version('))
    );
  } catch {
    return false;
  }
}

async function findPackageRoot(startDir: string): Promise<string | null> {
  let current = path.resolve(startDir);

  while (true) {
    const packageJsonPath = path.join(current, 'package.json');
    if (await fileExists(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8')) as {
          name?: unknown;
        };
        if (packageJson.name === 'llm-docs') {
          return current;
        }
      } catch {
        return null;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export async function resolveSetupCliEntrypoint(): Promise<string | null> {
  const envEntrypoint = process.env.LLMDOCS_CLI_ENTRYPOINT?.trim();
  if (envEntrypoint && (await isRunnableJavascriptFile(path.resolve(envEntrypoint)))) {
    return path.resolve(envEntrypoint);
  }

  const argvEntrypoint = process.argv[1] ? path.resolve(process.argv[1]) : null;
  if (argvEntrypoint && (await isLikelyCliEntrypoint(argvEntrypoint))) {
    return argvEntrypoint;
  }

  const moduleFile = fileURLToPath(import.meta.url);
  const moduleDir = path.dirname(moduleFile);
  const packageRoot = await findPackageRoot(moduleDir);
  const candidates = [
    packageRoot ? path.join(packageRoot, 'dist', 'index.js') : null,
    path.resolve(moduleDir, '..', '..', 'index.js'),
    path.resolve(moduleDir, '..', 'index.js'),
    path.resolve(moduleDir, 'index.js'),
    moduleFile,
  ].filter((candidate): candidate is string => candidate !== null);

  for (const candidate of candidates) {
    if (await isLikelyCliEntrypoint(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function buildLauncherCommand(paths: WorkspacePaths, args: string[]): string {
  return ['node', quoteShellArg(paths.cliLauncherPath), ...args.map(quoteShellArg)].join(' ');
}

export function buildWorktreeLauncherCommand(paths: WorkspacePaths, args: string[]): string {
  return [
    'workspace_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"',
    `llmdocs_launcher="$workspace_root"/${quoteShellArg(paths.relative.cliLauncherPath)}`,
    ['node', '"$llmdocs_launcher"', ...args.map(quoteShellArg)].join(' '),
  ].join('\n');
}

export interface RenderCliLauncherOptions {
  setupCliEntrypoint?: string | null;
}

export function renderCliLauncher(
  paths: WorkspacePaths,
  options: RenderCliLauncherOptions = {},
): string {
  const relativeProjectRoot = normalizeRelativePath(
    path.relative(paths.workspaceBinDir, paths.projectRoot),
  );
  const setupCliEntrypoint = options.setupCliEntrypoint
    ? path.resolve(options.setupCliEntrypoint)
    : null;

  return `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const launcherFile = fileURLToPath(import.meta.url);
const launcherDir = path.dirname(launcherFile);
const projectRoot = path.resolve(launcherDir, ${quoteJavascriptString(relativeProjectRoot)});
const embeddedCliEntrypoint = ${quoteJavascriptString(setupCliEntrypoint)};
const localDistEntrypoint = path.join(projectRoot, 'dist', 'index.js');
const workspaceBinEntrypoint = path.join(projectRoot, 'node_modules', '.bin', 'llm-docs');
const argv = process.argv.slice(2);

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isLlmDocsSourceRepo() {
  try {
    const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf-8'));
    return packageJson && packageJson.name === 'llm-docs';
  } catch {
    return false;
  }
}

function forwardSignals(child) {
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];

  for (const signal of signals) {
    process.on(signal, () => {
      if (!child.killed) {
        child.kill(signal);
      }
    });
  }
}

function runCandidate(candidate) {
  return new Promise((resolve) => {
    const command = candidate.kind === 'node' ? process.execPath : candidate.command;
    const args = candidate.kind === 'node' ? [candidate.entrypoint, ...argv] : argv;
    const child = spawn(command, args, { stdio: 'inherit', cwd: projectRoot });

    forwardSignals(child);

    child.on('error', (error) => {
      if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT') {
        resolve({ ok: false, reason: \`missing command: \${command}\` });
        return;
      }

      console.error(
        \`llm-docs launcher error: failed to start \${candidate.label}: \${error instanceof Error ? error.message : String(error)}\`,
      );
      process.exit(1);
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }

      process.exit(code ?? 0);
    });
  });
}

const attempts = [];
let candidates = [];
let candidateIndex = 0;

async function runNextCandidate() {
  while (candidateIndex < candidates.length) {
    const candidate = candidates[candidateIndex++];

    if (candidate.kind === 'node') {
      if (!(await exists(candidate.entrypoint))) {
        attempts.push(\`\${candidate.label}: not found at \${candidate.entrypoint}\`);
        continue;
      }
    } else if (candidate.kind === 'command' && candidate.command === workspaceBinEntrypoint) {
      if (!(await exists(workspaceBinEntrypoint))) {
        attempts.push(\`workspace node_modules llm-docs: not found at \${workspaceBinEntrypoint}\`);
        continue;
      }
    }

    const result = await runCandidate(candidate);
    attempts.push(\`\${candidate.label}: \${result.reason}\`);
  }

  console.error(
    [
      'llm-docs launcher error: cannot resolve the llm-docs CLI entrypoint.',
      'Tried:',
      ...attempts.map((attempt) => \`- \${attempt}\`),
      'Repair: rerun llm-docs setup from a built llm-docs checkout, install llm-docs in this workspace, or set LLMDOCS_CLI_ENTRYPOINT=/absolute/path/to/dist/index.js.',
    ].join('\\n'),
  );
  process.exit(127);
}

async function main() {
  const envEntrypoint = process.env.LLMDOCS_CLI_ENTRYPOINT?.trim();
  candidates = [
    envEntrypoint
      ? { kind: 'node', label: 'LLMDOCS_CLI_ENTRYPOINT', entrypoint: path.resolve(envEntrypoint) }
      : null,
    embeddedCliEntrypoint
      ? { kind: 'node', label: 'setup-time llm-docs CLI entrypoint', entrypoint: embeddedCliEntrypoint }
      : null,
    { kind: 'command', label: 'workspace node_modules llm-docs', command: workspaceBinEntrypoint },
    { kind: 'command', label: 'global llm-docs on PATH', command: 'llm-docs' },
    (await isLlmDocsSourceRepo())
      ? { kind: 'node', label: 'local llm-docs source dist entrypoint', entrypoint: localDistEntrypoint }
      : null,
  ].filter(Boolean);

  await runNextCandidate();
}

main().catch((error) => {
  console.error(
    \`llm-docs launcher error: \${error instanceof Error ? error.message : String(error)}\`,
  );
  process.exit(1);
});
`;
}

export interface CliLauncherSmokeResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
}

export async function smokeTestCliLauncher(
  paths: WorkspacePaths,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CliLauncherSmokeResult> {
  if (!(await fileExists(paths.cliLauncherPath))) {
    return {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      error: `Launcher file is missing: ${paths.cliLauncherPath}`,
    };
  }

  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const child = spawn(process.execPath, [paths.cliLauncherPath, '--version'], {
      cwd: paths.projectRoot,
      env: { ...process.env, ...options.env, NODE_NO_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGTERM');
      resolve({
        ok: false,
        exitCode: null,
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: Buffer.concat(stderr).toString('utf-8'),
        error: `Launcher smoke test timed out after ${options.timeoutMs ?? 5000}ms.`,
      });
    }, options.timeoutMs ?? 5000);

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: Buffer.concat(stderr).toString('utf-8'),
        error: error instanceof Error ? error.message : String(error),
      });
    });
    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const stdoutText = Buffer.concat(stdout).toString('utf-8');
      const stderrText = Buffer.concat(stderr).toString('utf-8');
      resolve({
        ok: code === 0 && /^\d+\.\d+\.\d+/.test(stdoutText.trim()),
        exitCode: code,
        stdout: stdoutText,
        stderr: stderrText,
        error: code === 0 ? null : `Launcher exited with code ${code ?? 'null'}.`,
      });
    });
  });
}
