import fs from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { simpleGit } from 'simple-git';
import { ensureDir, fileExists } from '../utils/fs.js';
import { loadOrMigrateConfig } from '../v2/config/load.js';
import type {
  WorktreeCreateInput,
  WorktreeCreateReport,
  WorktreeSeedConflictPolicy,
} from '../v2/types.js';
import { applyWorktreeSeed, prepareWorktreeSeed } from '../v2/worktree/seed.js';
import { runSetup } from './setup.js';

export interface WorktreeCreateCommandOptions {
  main?: string;
  target?: string;
  branch?: string;
  base?: string;
  hosts?: string;
  seedProfile?: string;
  conflict?: WorktreeSeedConflictPolicy;
  dryRun?: boolean;
  json?: boolean;
}

function assertConflictPolicy(value: string | undefined): WorktreeSeedConflictPolicy | undefined {
  if (!value) {
    return undefined;
  }

  if (value === 'fail' || value === 'candidate' || value === 'overwrite-managed') {
    return value;
  }

  throw new Error('Unsupported conflict policy. Expected fail, candidate, or overwrite-managed.');
}

async function resolveGitProjectRoot(startDir?: string): Promise<string> {
  const cwd = startDir ?? process.cwd();
  return (await simpleGit(cwd).raw(['rev-parse', '--show-toplevel'])).trim();
}

function defaultTargetPath(mainRoot: string, taskId: string): string {
  return path.join(path.dirname(mainRoot), `${path.basename(mainRoot)}-${taskId}`);
}

async function toInput(
  taskId: string,
  options: WorktreeCreateCommandOptions,
  startDir?: string,
): Promise<WorktreeCreateInput> {
  const mainRoot = path.resolve(options.main ?? (await resolveGitProjectRoot(startDir)));
  const config = (await loadOrMigrateConfig(mainRoot, { createIfMissing: false })).config;

  return {
    taskId,
    mainRoot,
    targetPath: options.target ? path.resolve(options.target) : defaultTargetPath(mainRoot, taskId),
    branch: options.branch ?? taskId,
    base: options.base ?? config.worktrees?.mainBranch ?? config.taskBundles.defaultBaseBranch,
    hosts: options.hosts,
    seedProfile: options.seedProfile ?? 'default',
    conflictPolicy: assertConflictPolicy(options.conflict),
    dryRun: options.dryRun,
  };
}

async function assertTargetAvailable(targetPath: string): Promise<void> {
  if (!(await fileExists(targetPath))) {
    return;
  }

  const entries = await fs.readdir(targetPath);
  if (entries.length === 0) {
    return;
  }

  throw new Error(`Target worktree path already exists and is not empty: ${targetPath}`);
}

async function localBranchExists(mainRoot: string, branch: string): Promise<boolean> {
  const branches = await simpleGit(mainRoot).branchLocal();
  return branches.all.includes(branch);
}

function formatCreateHuman(report: WorktreeCreateReport): void {
  console.log(`${report.dryRun ? 'Worktree create plan' : 'Created worktree'} ${report.taskId}:`);
  console.log(`- Main: ${report.mainRoot}`);
  console.log(`- Target: ${report.targetPath}`);
  console.log(`- Branch: ${report.branch}`);
  console.log(`- Base: ${report.base}`);
  console.log(`- Seed copied: ${report.seed.summary.copied}`);
  console.log(`- Seed skipped: ${report.seed.summary.skipped}`);
  console.log(`- Seed candidates: ${report.seed.summary.candidates}`);
}

export async function runWorktreeCreate(
  taskId: string,
  options: WorktreeCreateCommandOptions,
  startDir?: string,
): Promise<WorktreeCreateReport> {
  const input = await toInput(taskId, options, startDir);
  const seedInput = {
    sourceRoot: input.mainRoot,
    destinationRoot: input.targetPath ?? defaultTargetPath(input.mainRoot, input.taskId),
    profile: input.seedProfile,
    conflictPolicy: input.conflictPolicy,
    dryRun: input.dryRun,
  };
  const targetPath = seedInput.destinationRoot;
  const branch = input.branch ?? input.taskId;
  const base = input.base ?? 'main';

  if (input.dryRun) {
    const seed = await prepareWorktreeSeed(seedInput);

    return {
      schemaVersion: 1,
      action: 'worktree-create',
      dryRun: true,
      taskId: input.taskId,
      mainRoot: input.mainRoot,
      targetPath,
      branch,
      base,
      seed,
      setup: null,
    };
  }

  await assertTargetAvailable(targetPath);
  await ensureDir(path.dirname(targetPath));
  const git = simpleGit(input.mainRoot);
  if (await localBranchExists(input.mainRoot, branch)) {
    await git.raw(['worktree', 'add', targetPath, branch]);
  } else {
    await git.raw(['worktree', 'add', '-b', branch, targetPath, base]);
  }

  const appliedSeed = await applyWorktreeSeed({ ...seedInput, dryRun: false });
  const setup = await runSetup({ hosts: input.hosts }, targetPath);

  return {
    schemaVersion: 1,
    action: 'worktree-create',
    dryRun: false,
    taskId: input.taskId,
    mainRoot: input.mainRoot,
    targetPath,
    branch,
    base,
    seed: appliedSeed,
    setup: setup.bootstrapReport,
  };
}

const worktreeCreateCommand = new Command('create')
  .description('Create a git worktree and seed it with curated llm-docs context')
  .argument('<taskId>', 'task id and default branch name')
  .option('--main <path>', 'main worktree path; defaults to the current git root')
  .option('--target <path>', 'target worktree path')
  .option('--branch <branch>', 'new branch name; defaults to task id')
  .option('--base <ref>', 'base ref for git worktree add; defaults to configured main branch')
  .option('--hosts <hosts>', 'hosts to install during setup (claude,codex,cursor)')
  .option(
    '--seed-profile <profile>',
    'seed profile from .claude/docs/seed.manifest.json',
    'default',
  )
  .option('--conflict <policy>', 'fail, candidate, or overwrite-managed', 'candidate')
  .option('--dry-run', 'build a create plan without writing files')
  .option('--json', 'print create plan/report as JSON')
  .action(async (taskId: string, options: WorktreeCreateCommandOptions) => {
    const report = await runWorktreeCreate(taskId, options);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      formatCreateHuman(report);
    }
  });

export default worktreeCreateCommand;
