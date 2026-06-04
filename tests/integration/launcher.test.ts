import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/commands/doctor.js';
import { runSetup } from '../../src/commands/setup.js';
import { loadConfigV2 } from '../../src/v2/config/load.js';
import { renderCliLauncher } from '../../src/v2/workspace/launcher.js';
import { resolveWorkspacePaths } from '../../src/v2/workspace/paths.js';
import { initGitRepo, makeTempProject } from '../helpers/v2-fixtures.js';

const execFileAsync = promisify(execFile);

function restoreEnv(name: string, previousValue: string | undefined): void {
  if (previousValue === undefined) {
    Reflect.deleteProperty(process.env, name);
    return;
  }

  process.env[name] = previousValue;
}

function unsetEnv(name: string): void {
  Reflect.deleteProperty(process.env, name);
}

async function writeFakeCliEntrypoint(projectRoot: string): Promise<string> {
  const cliPath = path.join(projectRoot, 'fake-llm-docs-cli.mjs');
  await fs.writeFile(
    cliPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('0.1.0');
  process.exit(0);
}
if (args[0] === 'internal' && args[1] === 'codex-stop') {
  let input = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    JSON.parse(input || '{}');
    console.log(JSON.stringify({ continue: true }));
  });
  process.stdin.resume();
} else {
  console.error('unexpected fake cli args: ' + args.join(' '));
  process.exit(2);
}
`,
    { mode: 0o755 },
  );
  return cliPath;
}

async function isolatedPathWithNodeAndGit(projectRoot: string): Promise<string> {
  const binDir = path.join(projectRoot, 'test-bin');
  await fs.mkdir(binDir, { recursive: true });
  await fs.symlink(
    process.execPath,
    path.join(binDir, process.platform === 'win32' ? 'node.exe' : 'node'),
  );
  if (process.platform !== 'win32') {
    const { stdout } = await execFileAsync('which', ['git']);
    await fs.symlink(stdout.trim(), path.join(binDir, 'git'));
  }
  return binDir;
}

async function execFileWithInput(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; input: string },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: Buffer.concat(stderr).toString('utf-8'),
        code,
      });
    });
    child.stdin.end(options.input);
  });
}

function oldConsumerLauncher(): string {
  return `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const launcherFile = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(launcherFile), '..', '..');
const argv = process.argv.slice(2);
const globalResult = spawnSync('llm-docs', argv, { stdio: 'inherit', cwd: projectRoot });
if (!globalResult.error) {
  process.exit(globalResult.status ?? 0);
}
const local = path.join(projectRoot, 'dist', 'index.js');
if (!fs.existsSync(local)) {
  console.error(
    'llm-docs launcher error: neither global "llm-docs" nor local dist entrypoint is available at ' + local,
  );
  process.exit(127);
}
const localResult = spawnSync(process.execPath, [local, ...argv], { stdio: 'inherit', cwd: projectRoot });
process.exit(localResult.status ?? 0);
`;
}

describe('generated llm-docs launcher', () => {
  it('runs in a consumer repo without global llm-docs or a consumer dist fallback', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    const fakeCli = await writeFakeCliEntrypoint(projectRoot);
    const previousEntrypoint = process.env.LLMDOCS_CLI_ENTRYPOINT;
    process.env.LLMDOCS_CLI_ENTRYPOINT = fakeCli;

    try {
      await runSetup({ hosts: 'codex' }, projectRoot);
    } finally {
      restoreEnv('LLMDOCS_CLI_ENTRYPOINT', previousEntrypoint);
    }

    await expect(fs.access(path.join(projectRoot, 'dist/index.js'))).rejects.toThrow();
    const launcher = path.join(projectRoot, '.claude/bin/llm-docs.mjs');
    const safePath = await isolatedPathWithNodeAndGit(projectRoot);
    const env = {
      ...process.env,
      PATH: safePath,
      NODE_NO_WARNINGS: '1',
      LLMDOCS_CLI_ENTRYPOINT: '',
    };

    const version = await execFileAsync(process.execPath, [launcher, '--version'], {
      cwd: projectRoot,
      env,
    });
    expect(version.stdout.trim()).toMatch(/^0\.1\.0/);

    const stop = await execFileWithInput(process.execPath, [launcher, 'internal', 'codex-stop'], {
      cwd: projectRoot,
      env,
      input: JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', cwd: projectRoot }),
    });
    expect(stop.code).toBe(0);
    expect(stop.stderr).toBe('');
    expect(stop.stdout.trim()).toBe('{"continue":true}');
  }, 30_000);

  it('doctor reports an old consumer launcher that still exits 127', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await runSetup({ hosts: 'codex' }, projectRoot);
    await fs.writeFile(path.join(projectRoot, '.claude/bin/llm-docs.mjs'), oldConsumerLauncher(), {
      mode: 0o755,
    });
    const safePath = await isolatedPathWithNodeAndGit(projectRoot);
    const previousPath = process.env.PATH;
    const previousEntrypoint = process.env.LLMDOCS_CLI_ENTRYPOINT;
    process.env.PATH = safePath;
    unsetEnv('LLMDOCS_CLI_ENTRYPOINT');

    try {
      const result = await runDoctor({}, projectRoot);
      expect(result.exitCode).toBe(1);
      expect(result.report.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'launcher:smoke',
            severity: 'error',
            ok: false,
          }),
        ]),
      );
    } finally {
      process.env.PATH = previousPath;
      restoreEnv('LLMDOCS_CLI_ENTRYPOINT', previousEntrypoint);
    }
  }, 30_000);

  it('setup dry-run reports an update for stale launcher content', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await runSetup({ hosts: 'codex' }, projectRoot);
    const config = await loadConfigV2(projectRoot);
    const paths = resolveWorkspacePaths(projectRoot, config);
    await fs.writeFile(
      paths.cliLauncherPath,
      renderCliLauncher(paths, { setupCliEntrypoint: null }),
      {
        mode: 0o755,
      },
    );
    const safePath = await isolatedPathWithNodeAndGit(projectRoot);
    const previousPath = process.env.PATH;
    const previousEntrypoint = process.env.LLMDOCS_CLI_ENTRYPOINT;
    process.env.PATH = safePath;
    unsetEnv('LLMDOCS_CLI_ENTRYPOINT');

    try {
      const result = await runSetup({ hosts: 'codex', dryRun: true }, projectRoot);
      expect(result.bootstrapReport.generatedFiles).toContain('.claude/bin/llm-docs.mjs');
      expect(result.bootstrapReport.operations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: '.claude/bin/llm-docs.mjs',
            kind: 'launcher',
            action: 'update',
            message: expect.stringContaining('Updated llm-docs.mjs'),
          }),
        ]),
      );
    } finally {
      process.env.PATH = previousPath;
      restoreEnv('LLMDOCS_CLI_ENTRYPOINT', previousEntrypoint);
    }
  }, 30_000);
});
