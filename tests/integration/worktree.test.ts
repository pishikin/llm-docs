import fs from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';
import { runSetup } from '../../src/commands/setup.js';
import { runWorktreeCreate } from '../../src/commands/worktree-create.js';
import { runWorktreeSeed } from '../../src/commands/worktree-seed.js';
import {
  createGitWorktree,
  initGitRepo,
  makeTempProject,
  writeProjectFile,
} from '../helpers/test-fixtures.js';

async function createMainWithLocalDocs(): Promise<string> {
  const mainRoot = await makeTempProject();
  await initGitRepo(mainRoot);
  await runSetup({ hosts: 'claude,codex' }, mainRoot);

  await writeProjectFile(mainRoot, '.claude/rules/code-conventions.md', '# Code conventions\n');
  await writeProjectFile(mainRoot, '.claude/rules/frontend-patterns.md', '# Frontend\n');
  await writeProjectFile(mainRoot, '.claude/docs/architecture/overview.md', '# Overview\n');
  await writeProjectFile(mainRoot, '.claude/docs/architecture/frontend.md', '# Frontend arch\n');
  await writeProjectFile(mainRoot, '.claude/docs/guides/development.md', '# Development\n');
  await writeProjectFile(mainRoot, '.claude/docs/archive/old.md', '# Old archive\n');
  await writeProjectFile(mainRoot, '.claude/docs/tasks/ABC-1/task.md', '# Published task\n');
  await writeProjectFile(mainRoot, '.claude/docs/research/legacy/old.md', '# Legacy research\n');
  await writeProjectFile(mainRoot, '.claude/docs/architecture/network.log', 'large log\n');
  await writeProjectFile(mainRoot, '.claude/.llm-docs/tasks/ACTIVE/context.md', '# Active task\n');
  await writeProjectFile(mainRoot, '.claude/tasks/LEGACY/context.md', '# Legacy active task\n');

  return mainRoot;
}

async function addIgnoredRuntimeSnapshot(mainRoot: string): Promise<void> {
  await writeProjectFile(mainRoot, '.gitignore', '.env\nnode_modules/\n.claude/local/\n');
  await simpleGit(mainRoot).add('.gitignore');
  await simpleGit(mainRoot).commit('add ignore rules');

  await writeProjectFile(mainRoot, '.env', 'API_KEY=main-runtime-value\n');
  await writeProjectFile(mainRoot, 'node_modules/example/index.js', 'module.exports = 1;\n');
  await fs.mkdir(path.join(mainRoot, 'node_modules/.bin'), { recursive: true });
  await fs.symlink('../example/index.js', path.join(mainRoot, 'node_modules/.bin/example-tool'));
  await writeProjectFile(mainRoot, '.claude/local/private.md', '# Private local note\n');
}

describe('worktree seed command', () => {
  it('copies rules and architecture docs into an existing worktree', async () => {
    const mainRoot = await createMainWithLocalDocs();
    const worktreeRoot = await createGitWorktree(mainRoot, 'feature/seed-docs');

    const report = await runWorktreeSeed({ from: mainRoot }, worktreeRoot);

    expect(report.summary.copied).toBeGreaterThan(0);
    await expect(
      fs.access(path.join(worktreeRoot, '.claude/rules/code-conventions.md')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(worktreeRoot, '.claude/docs/architecture/overview.md')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(worktreeRoot, '.claude/docs/guides/development.md')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(worktreeRoot, '.agents/skills/llm-docs/SKILL.md')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(worktreeRoot, '.agents/skills/llm-docs/references/recipes.md')),
    ).resolves.toBeUndefined();
  });

  it('copies ignored local project files while keeping local agent state out', async () => {
    const mainRoot = await createMainWithLocalDocs();
    await addIgnoredRuntimeSnapshot(mainRoot);
    const worktreeRoot = await createGitWorktree(mainRoot, 'feature/seed-ignored-runtime');

    const report = await runWorktreeSeed({ from: mainRoot }, worktreeRoot);

    expect(report.summary.ignoredFiles).toBeGreaterThan(0);
    expect(report.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'ignored',
          path: '.env',
          action: 'copy',
        }),
        expect.objectContaining({
          source: 'ignored',
          path: 'node_modules/example/index.js',
          action: 'copy',
        }),
      ]),
    );
    await expect(fs.access(path.join(worktreeRoot, '.env'))).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(worktreeRoot, 'node_modules/example/index.js')),
    ).resolves.toBeUndefined();
    const toolSymlink = await fs.lstat(path.join(worktreeRoot, 'node_modules/.bin/example-tool'));
    expect(toolSymlink.isSymbolicLink()).toBe(true);
    await expect(fs.access(path.join(worktreeRoot, '.claude/local/private.md'))).rejects.toThrow();
  });

  it('keeps archive, published tasks, legacy research, and logs out of the seed', async () => {
    const mainRoot = await createMainWithLocalDocs();
    const worktreeRoot = await createGitWorktree(mainRoot, 'feature/seed-excludes');

    const report = await runWorktreeSeed({ from: mainRoot, dryRun: true }, worktreeRoot);
    const plannedPaths = report.files.map((file) => file.path);

    expect(plannedPaths).toContain('.claude/docs/architecture/overview.md');
    expect(plannedPaths).toContain('.claude/rules/code-conventions.md');
    expect(plannedPaths).not.toContain('.claude/docs/archive/old.md');
    expect(plannedPaths).not.toContain('.claude/docs/tasks/ABC-1/task.md');
    expect(plannedPaths).not.toContain('.claude/docs/research/legacy/old.md');
    expect(plannedPaths).not.toContain('.claude/docs/architecture/network.log');
  });

  it('allows custom manifests to include archived or published docs but still blocks active task state', async () => {
    const mainRoot = await createMainWithLocalDocs();
    const worktreeRoot = await createGitWorktree(mainRoot, 'feature/seed-custom-manifest');
    await writeProjectFile(
      mainRoot,
      '.claude/docs/seed.manifest.json',
      `${JSON.stringify(
        {
          schemaVersion: 1,
          profiles: {
            default: {
              include: [
                '.claude/docs/architecture/**',
                '.claude/docs/archive/**',
                '.claude/docs/tasks/**',
                '.claude/.llm-docs/**',
                '.claude/tasks/**',
              ],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const report = await runWorktreeSeed({ from: mainRoot, dryRun: true }, worktreeRoot);
    const plannedPaths = report.files.map((file) => file.path);

    expect(plannedPaths).toContain('.claude/docs/architecture/overview.md');
    expect(plannedPaths).toContain('.claude/docs/archive/old.md');
    expect(plannedPaths).toContain('.claude/docs/tasks/ABC-1/task.md');
    expect(plannedPaths).not.toContain('.claude/.llm-docs/tasks/ACTIVE/context.md');
    expect(plannedPaths).not.toContain('.claude/tasks/LEGACY/context.md');
    expect(plannedPaths).not.toContain('.claude/docs/architecture/network.log');
  });

  it('writes candidates instead of overwriting user-owned files by default', async () => {
    const mainRoot = await createMainWithLocalDocs();
    const worktreeRoot = await createGitWorktree(mainRoot, 'feature/seed-candidate');
    await writeProjectFile(worktreeRoot, 'AGENTS.md', '# Custom agents\n');

    const report = await runWorktreeSeed({ from: mainRoot }, worktreeRoot);

    expect(report.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'AGENTS.md',
          action: 'candidate',
          candidatePath: 'AGENTS.llmdocs.seed.candidate.md',
        }),
      ]),
    );
    await expect(fs.readFile(path.join(worktreeRoot, 'AGENTS.md'), 'utf-8')).resolves.toBe(
      '# Custom agents\n',
    );
    await expect(
      fs.access(path.join(worktreeRoot, 'AGENTS.llmdocs.seed.candidate.md')),
    ).resolves.toBeUndefined();
  });

  it('writes candidates for ignored runtime files instead of overwriting local values', async () => {
    const mainRoot = await createMainWithLocalDocs();
    await addIgnoredRuntimeSnapshot(mainRoot);
    const worktreeRoot = await createGitWorktree(mainRoot, 'feature/seed-ignored-candidate');
    await writeProjectFile(worktreeRoot, '.env', 'API_KEY=worktree-runtime-value\n');

    const report = await runWorktreeSeed({ from: mainRoot }, worktreeRoot);

    expect(report.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'ignored',
          path: '.env',
          action: 'candidate',
          candidatePath: '.env.llmdocs.seed.candidate',
        }),
      ]),
    );
    await expect(fs.readFile(path.join(worktreeRoot, '.env'), 'utf-8')).resolves.toBe(
      'API_KEY=worktree-runtime-value\n',
    );
    await expect(
      fs.readFile(path.join(worktreeRoot, '.env.llmdocs.seed.candidate'), 'utf-8'),
    ).resolves.toBe('API_KEY=main-runtime-value\n');
  });
});

describe('worktree create command', () => {
  it('creates a git worktree and seeds curated docs plus ignored runtime files', async () => {
    const mainRoot = await createMainWithLocalDocs();
    await addIgnoredRuntimeSnapshot(mainRoot);
    const targetPath = await makeTempProject('llmdocs-created-worktree-');

    const report = await runWorktreeCreate(
      'ABC-301',
      {
        main: mainRoot,
        target: targetPath,
        hosts: 'claude,codex',
      },
      mainRoot,
    );

    expect(report.dryRun).toBe(false);
    expect(report.targetPath).toBe(targetPath);
    expect(report.branch).toBe('ABC-301');
    expect((await simpleGit(targetPath).branch()).current).toBe('ABC-301');
    await expect(
      fs.access(path.join(targetPath, '.claude/rules/code-conventions.md')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(targetPath, '.claude/docs/architecture/overview.md')),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(targetPath, '.env'))).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(targetPath, 'node_modules/example/index.js')),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(targetPath, 'llmdocs.config.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(targetPath, '.claude/docs/archive/old.md'))).rejects.toThrow();
    await expect(fs.access(path.join(targetPath, '.claude/local/private.md'))).rejects.toThrow();
  });

  it('reuses an existing local branch when creating the worktree', async () => {
    const mainRoot = await createMainWithLocalDocs();
    const targetPath = await makeTempProject('llmdocs-existing-branch-worktree-');
    await simpleGit(mainRoot).raw(['branch', 'ABC-302', 'main']);

    const report = await runWorktreeCreate(
      'ABC-302',
      {
        main: mainRoot,
        target: targetPath,
        hosts: 'claude,codex',
      },
      mainRoot,
    );

    expect(report.branch).toBe('ABC-302');
    expect((await simpleGit(targetPath).branch()).current).toBe('ABC-302');
    await expect(
      fs.access(path.join(targetPath, '.claude/docs/architecture/overview.md')),
    ).resolves.toBeUndefined();
  });
});
