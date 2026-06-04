import fs from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';
import { runSetup } from '../../src/commands/setup.js';
import { createV2Runtime } from '../../src/v2/runtime.js';
import { readTaskRegistry } from '../../src/v2/task/registry.js';
import type { PublishedTaskIndex } from '../../src/v2/types.js';
import {
  createGitWorktree,
  initGitRepo,
  makeTempProject,
  readJsonFile,
} from '../helpers/v2-fixtures.js';

async function createMainAndTaskWorktree(taskId = 'ABC-123') {
  const mainRoot = await makeTempProject();
  await initGitRepo(mainRoot);
  await runSetup({ hosts: 'claude,codex' }, mainRoot);
  await simpleGit(mainRoot).add('.');
  await simpleGit(mainRoot).commit('setup llm-docs');

  const worktreeRoot = await createGitWorktree(mainRoot, `feature/${taskId}`);
  await runSetup({ hosts: 'claude,codex' }, worktreeRoot);
  const runtime = await createV2Runtime(worktreeRoot, { createIfMissing: false });
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

  return { mainRoot, worktreeRoot, runtime, taskId };
}

describe('task close command', () => {
  it('publishes the task and removes it from active storage', async () => {
    const { mainRoot, worktreeRoot, runtime, taskId } = await createMainAndTaskWorktree();

    const plan = await runtime.prepareTaskClose({ taskId, dest: mainRoot, dryRun: true });
    expect(plan.publishPlan?.destination.targetPath).toBe(`.claude/docs/tasks/${taskId}`);
    expect(plan.operations.map((operation) => operation.op)).toEqual(
      expect.arrayContaining([
        'publish-task',
        'archive-active-bundle',
        'remove-active-registry-entry',
      ]),
    );

    const report = await runtime.applyTaskClose({ taskId, dest: mainRoot });

    expect(report.applied).toBe(true);
    await expect(
      fs.access(path.join(mainRoot, `.claude/docs/tasks/${taskId}/context.md`)),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(worktreeRoot, `.claude/.llm-docs/tasks/${taskId}`)),
    ).rejects.toThrow();

    const archives = await fs.readdir(path.join(worktreeRoot, '.claude/.llm-docs/archive/tasks'));
    expect(archives.some((entry) => entry.startsWith(`${taskId}-`))).toBe(true);

    const registry = await readTaskRegistry(runtime.paths);
    expect(registry.activeTaskId).toBeNull();
    expect(registry.tasks[taskId]).toBeUndefined();
    expect(Object.values(registry.branchToTask)).not.toContain(taskId);

    const index = await readJsonFile<PublishedTaskIndex>(
      path.join(mainRoot, '.claude/docs/tasks/index.json'),
    );
    expect(index.tasks[taskId]?.path).toBe(`.claude/docs/tasks/${taskId}`);
  });
});
