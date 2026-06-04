import fs from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';
import { runSetup } from '../../src/commands/setup.js';
import { runTaskPublish } from '../../src/commands/task-publish.js';
import { createRuntime } from '../../src/engine/runtime.js';
import type { PublishedTaskIndex, TaskPublishManifest } from '../../src/engine/types.js';
import {
  commitProjectFile,
  createGitWorktree,
  initGitRepo,
  makeTempProject,
  readJsonFile,
  writeProjectFile,
} from '../helpers/test-fixtures.js';

async function createMainAndTaskWorktree(taskId = 'ABC-123') {
  const mainRoot = await makeTempProject();
  await initGitRepo(mainRoot);
  await runSetup({ hosts: 'claude,codex' }, mainRoot);
  await simpleGit(mainRoot).add('.');
  await simpleGit(mainRoot).commit('setup llm-docs');

  const worktreeRoot = await createGitWorktree(mainRoot, `feature/${taskId}`);
  try {
    await fs.access(path.join(worktreeRoot, 'llmdocs.config.json'));
  } catch {
    await runSetup({ hosts: 'claude,codex' }, worktreeRoot);
  }
  const runtime = await createRuntime(worktreeRoot, { createIfMissing: false });
  await runtime.createTaskBundle({
    taskId,
    title: `Implement ${taskId}`,
    source: {
      type: 'prompt',
      ref: taskId,
      url: null,
      rawText: `Task ${taskId}`,
    },
  });

  return { mainRoot, worktreeRoot, taskId };
}

describe('task publish command', () => {
  it('builds a dry-run publish plan without writing destination files', async () => {
    const { mainRoot, worktreeRoot, taskId } = await createMainAndTaskWorktree();

    const plan = await runTaskPublish(
      taskId,
      { dryRun: true, dest: mainRoot, json: true },
      worktreeRoot,
    );

    expect(plan.dryRun).toBe(true);
    expect(plan.taskId).toBe(taskId);
    expect(plan.destination.targetPath).toBe(`.claude/docs/tasks/${taskId}`);
    expect(plan.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op: 'copy-tree',
          to: `.claude/docs/tasks/${taskId}`,
        }),
      ]),
    );
    expect(plan.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op: 'write-summary',
          path: `.claude/docs/tasks/${taskId}/summary.md`,
        }),
      ]),
    );
    await expect(fs.access(path.join(mainRoot, `.claude/docs/tasks/${taskId}`))).rejects.toThrow();
  });

  it('publishes a task bundle with manifest and published index', async () => {
    const { mainRoot, worktreeRoot, taskId } = await createMainAndTaskWorktree();

    const report = await runTaskPublish(taskId, { dest: mainRoot }, worktreeRoot);

    expect(report.applied).toBe(true);
    const targetPath = path.join(mainRoot, `.claude/docs/tasks/${taskId}`);
    await expect(fs.access(path.join(targetPath, 'context.md'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(targetPath, 'state.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(targetPath, 'summary.md'))).resolves.toBeUndefined();
    const manifest = await readJsonFile<TaskPublishManifest>(
      path.join(targetPath, 'publish.manifest.json'),
    );
    expect(manifest.taskId).toBe(taskId);
    expect(manifest.source.branch).toBe(`feature/${taskId}`);
    expect(manifest.files.map((file) => file.path)).toContain('context.md');
    expect(manifest.files.map((file) => file.path)).toContain('state.json');
    expect(manifest.files.map((file) => file.path)).toContain('summary.md');
    expect(await fs.readFile(path.join(targetPath, 'summary.md'), 'utf-8')).toContain(
      `# Summary — ${taskId}`,
    );

    const index = await readJsonFile<PublishedTaskIndex>(
      path.join(mainRoot, '.claude/docs/tasks/index.json'),
    );
    expect(index.tasks[taskId]?.path).toBe(`.claude/docs/tasks/${taskId}`);
  });

  it('reruns publish idempotently when the destination manifest matches', async () => {
    const { mainRoot, worktreeRoot, taskId } = await createMainAndTaskWorktree();

    await runTaskPublish(taskId, { dest: mainRoot }, worktreeRoot);
    const second = await runTaskPublish(taskId, { dest: mainRoot }, worktreeRoot);

    expect(second.applied).toBe(true);
    expect(second.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op: 'idempotent-skip',
        }),
      ]),
    );
  });

  it('fails on existing destination without manifest by default', async () => {
    const { mainRoot, worktreeRoot, taskId } = await createMainAndTaskWorktree();
    await writeProjectFile(mainRoot, `.claude/docs/tasks/${taskId}/manual.md`, 'manual docs\n');

    await expect(runTaskPublish(taskId, { dest: mainRoot }, worktreeRoot)).rejects.toThrow(
      'Destination already exists without publish.manifest.json',
    );
    expect(
      await fs.readFile(path.join(mainRoot, `.claude/docs/tasks/${taskId}/manual.md`), 'utf-8'),
    ).toBe('manual docs\n');
  });

  it('renames the target when conflict policy is rename', async () => {
    const { mainRoot, worktreeRoot, taskId } = await createMainAndTaskWorktree();
    await writeProjectFile(mainRoot, `.claude/docs/tasks/${taskId}/manual.md`, 'manual docs\n');

    const report = await runTaskPublish(
      taskId,
      { dest: mainRoot, conflict: 'rename' },
      worktreeRoot,
    );

    expect(report.applied).toBe(true);
    expect(report.destination.targetPath).toMatch(new RegExp(`^\\.claude/docs/tasks/${taskId}-`));
    await expect(
      fs.access(path.join(mainRoot, report.destination.targetPath, 'publish.manifest.json')),
    ).resolves.toBeUndefined();
  });

  it('backs up the existing destination when overwrite is forced', async () => {
    const { mainRoot, worktreeRoot, taskId } = await createMainAndTaskWorktree();
    await writeProjectFile(mainRoot, `.claude/docs/tasks/${taskId}/manual.md`, 'manual docs\n');

    const report = await runTaskPublish(
      taskId,
      { dest: mainRoot, conflict: 'overwrite', force: true },
      worktreeRoot,
    );

    expect(report.applied).toBe(true);
    await expect(
      fs.access(path.join(mainRoot, `.claude/docs/tasks/${taskId}/publish.manifest.json`)),
    ).resolves.toBeUndefined();

    const conflictDir = path.join(mainRoot, `.claude/docs/tasks/.conflicts/${taskId}`);
    const backups = await fs.readdir(conflictDir);
    expect(backups.length).toBe(1);
  });

  it('publishes into archive mode', async () => {
    const { mainRoot, worktreeRoot, taskId } = await createMainAndTaskWorktree();

    const report = await runTaskPublish(taskId, { dest: mainRoot, archive: true }, worktreeRoot);

    expect(report.mode).toBe('archive');
    expect(report.destination.targetPath).toBe(`.claude/docs/archive/tasks/${taskId}`);
    await expect(
      fs.access(path.join(mainRoot, `.claude/docs/archive/tasks/${taskId}/publish.manifest.json`)),
    ).resolves.toBeUndefined();
  });

  it('resolves the main worktree from git worktree list when dest is omitted', async () => {
    const { mainRoot, worktreeRoot, taskId } = await createMainAndTaskWorktree();

    const plan = await runTaskPublish(taskId, { dryRun: true }, worktreeRoot);

    expect(await fs.realpath(plan.destination.projectRoot)).toBe(await fs.realpath(mainRoot));
    expect(plan.destination.resolvedBy).toBe('git-worktree');
  });

  it('blocks stale task publish unless allow-stale is set', async () => {
    const { mainRoot, worktreeRoot, taskId } = await createMainAndTaskWorktree();
    await commitProjectFile(
      worktreeRoot,
      'src/change.ts',
      'export const changed = true;\n',
      'change',
    );

    await expect(runTaskPublish(taskId, { dest: mainRoot }, worktreeRoot)).rejects.toThrow(
      'Task bundle is stale',
    );

    const report = await runTaskPublish(taskId, { dest: mainRoot, allowStale: true }, worktreeRoot);
    expect(report.applied).toBe(true);
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        'Task bundle is stale and will be published because --allow-stale is set.',
      ]),
    );
  });

  it('refuses delete-worktree when the source worktree has local changes', async () => {
    const { mainRoot, worktreeRoot, taskId } = await createMainAndTaskWorktree();
    await writeProjectFile(worktreeRoot, 'local-change.txt', 'dirty\n');

    await expect(
      runTaskPublish(taskId, { dest: mainRoot, deleteWorktree: true }, worktreeRoot),
    ).rejects.toThrow('Cannot delete source worktree because it has local changes');
  });
});
