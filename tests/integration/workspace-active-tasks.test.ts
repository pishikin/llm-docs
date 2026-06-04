import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeConfigV2 } from '../../src/v2/config/load.js';
import { createDefaultConfigV2 } from '../../src/v2/config/migrate.js';
import { createV2Runtime } from '../../src/v2/runtime.js';
import { readTaskRegistry } from '../../src/v2/task/registry.js';
import { bootstrapWorkspace } from '../../src/v2/workspace/bootstrap.js';
import { initGitRepo, makeTempProject } from '../helpers/v2-fixtures.js';

async function prepareLegacyActiveTaskWorkspace() {
  const projectRoot = await makeTempProject();
  await initGitRepo(projectRoot, 'feature/ABC-123');
  const baseConfig = await createDefaultConfigV2(projectRoot);
  const config = {
    ...baseConfig,
    workspace: {
      ...baseConfig.workspace,
      tasksDir: 'tasks',
    },
    taskBundles: {
      ...baseConfig.taskBundles,
      registryPath: '.claude/tasks/index.json',
    },
  };

  await writeConfigV2(projectRoot, config);
  await bootstrapWorkspace(projectRoot, config);
  const runtime = await createV2Runtime(projectRoot, { createIfMissing: false });
  await runtime.createTaskBundle({
    taskId: 'ABC-123',
    title: 'Legacy active storage',
    source: { type: 'prompt', ref: 'ABC-123', url: null, rawText: 'legacy active storage' },
  });

  return { projectRoot, runtime };
}

describe('active task workspace storage', () => {
  it('migrates legacy .claude/tasks bundles into hidden .claude/.llm-docs/tasks', async () => {
    const { projectRoot, runtime } = await prepareLegacyActiveTaskWorkspace();

    const plan = await runtime.prepareActiveTasksMigration({ dryRun: true });
    expect(plan.sourceTasksDir).toBe('.claude/tasks');
    expect(plan.targetTasksDir).toBe('.claude/.llm-docs/tasks');
    expect(plan.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op: 'move-task-bundle',
          from: '.claude/tasks/ABC-123',
          to: '.claude/.llm-docs/tasks/ABC-123',
        }),
      ]),
    );

    const report = await runtime.applyActiveTasksMigration({ dryRun: false });

    expect(report.dryRun).toBe(false);
    await expect(
      fs.access(path.join(projectRoot, '.claude/.llm-docs/tasks/ABC-123/context.md')),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(projectRoot, '.claude/tasks/index.json'))).rejects.toThrow();

    const migratedRuntime = await createV2Runtime(projectRoot, { createIfMissing: false });
    const resolved = await migratedRuntime.resolveActiveTask({ preferRegistryActive: false });
    const registry = await readTaskRegistry(migratedRuntime.paths);

    expect(migratedRuntime.config.workspace.tasksDir).toBe('.llm-docs/tasks');
    expect(resolved?.taskId).toBe('ABC-123');
    expect(registry.tasks['ABC-123']?.bundlePath).toBe('.claude/.llm-docs/tasks/ABC-123');
  });
});
