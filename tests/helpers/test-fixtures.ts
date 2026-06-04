import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { simpleGit } from 'simple-git';
import { afterEach } from 'vitest';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
let buildPromise: Promise<void> | null = null;

const TEST_REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

export async function makeTempProject(prefix = 'llmdocs-test-'): Promise<string> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(projectRoot);
  return projectRoot;
}

export async function initGitRepo(projectRoot: string, branch = 'main'): Promise<void> {
  const git = simpleGit(projectRoot);

  await fs.writeFile(
    path.join(projectRoot, 'package.json'),
    `${JSON.stringify({ name: 'llmdocs-test-test', version: '1.0.0' }, null, 2)}\n`,
    'utf-8',
  );
  await fs.writeFile(path.join(projectRoot, 'README.md'), '# Temp Project\n', 'utf-8');

  await git.init();
  await git.addConfig('user.name', 'Test User');
  await git.addConfig('user.email', 'test@example.com');
  await git.add('.');
  await git.commit('initial commit');
  await git.raw(['branch', '-M', 'main']);

  if (branch !== 'main') {
    await git.checkoutLocalBranch(branch);
  }
}

export async function createGitWorktree(
  projectRoot: string,
  branchName = 'feature/worktree-smoke',
): Promise<string> {
  const worktreeRoot = await makeTempProject('llmdocs-worktree-');
  await simpleGit(projectRoot).raw(['worktree', 'add', '-b', branchName, worktreeRoot, 'main']);
  return worktreeRoot;
}

export async function writeProjectFile(
  projectRoot: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const filePath = path.join(projectRoot, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

export async function commitProjectFile(
  projectRoot: string,
  relativePath: string,
  content: string,
  message: string,
): Promise<void> {
  const git = simpleGit(projectRoot);
  await writeProjectFile(projectRoot, relativePath, content);
  await git.add(relativePath);
  await git.commit(message);
}

export async function checkoutNewBranch(projectRoot: string, branchName: string): Promise<void> {
  await simpleGit(projectRoot).checkoutLocalBranch(branchName);
}

export async function checkoutBranch(projectRoot: string, branchName: string): Promise<void> {
  await simpleGit(projectRoot).checkout(branchName);
}

export async function mergeBranch(
  projectRoot: string,
  branchName: string,
  message = `merge ${branchName}`,
): Promise<void> {
  await simpleGit(projectRoot).merge(['--no-ff', branchName, '-m', message]);
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf-8')) as T;
}

export async function ensureBuiltCli(): Promise<void> {
  buildPromise ??= execFileAsync('npm', ['run', 'build'], {
    cwd: TEST_REPO_ROOT,
    env: process.env,
  }).then(() => undefined);

  await buildPromise;
}

export async function createMcpClient(projectRoot: string): Promise<{
  client: Client;
  transport: StdioClientTransport;
}> {
  await ensureBuiltCli();

  const client = new Client({
    name: 'llmdocs-test-client',
    version: '1.0.0',
  });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [path.join(TEST_REPO_ROOT, 'dist/index.js'), 'server', '--transport', 'stdio'],
    cwd: projectRoot,
    stderr: 'pipe',
  });

  await client.connect(transport);

  return { client, transport };
}

export async function closeMcpClient(transport: StdioClientTransport): Promise<void> {
  await transport.close();
}
