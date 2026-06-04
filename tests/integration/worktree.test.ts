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

  return mainRoot;
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

  it('applies safety excludes even when a custom manifest includes unsafe paths', async () => {
    const mainRoot = await createMainWithLocalDocs();
    const worktreeRoot = await createGitWorktree(mainRoot, 'feature/seed-custom-safety');
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
    expect(plannedPaths).not.toContain('.claude/docs/archive/old.md');
    expect(plannedPaths).not.toContain('.claude/docs/tasks/ABC-1/task.md');
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
});

describe('worktree create command', () => {
  it('creates a git worktree and seeds rules plus architecture docs', async () => {
    const mainRoot = await createMainWithLocalDocs();
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
    await expect(fs.access(path.join(targetPath, 'llmdocs.config.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(targetPath, '.claude/docs/archive/old.md'))).rejects.toThrow();
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
