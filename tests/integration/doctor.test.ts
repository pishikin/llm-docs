import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/commands/doctor.js';
import { runSetup } from '../../src/commands/setup.js';
import { loadConfig, writeConfig } from '../../src/engine/config/load.js';
import { createDefaultConfig } from '../../src/engine/config/migrate.js';
import { createRuntime } from '../../src/engine/runtime.js';
import { readTaskRegistry, writeTaskRegistry } from '../../src/engine/task/registry.js';
import { readTaskState, writeTaskState } from '../../src/engine/task/state.js';
import { bootstrapWorkspace } from '../../src/engine/workspace/bootstrap.js';
import { initGitRepo, makeTempProject, writeProjectFile } from '../helpers/test-fixtures.js';

describe('doctor command', () => {
  it('reports a healthy workspace', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await runSetup({ hosts: 'claude,codex', enableGitHooks: true }, projectRoot);

    const result = await runDoctor({}, projectRoot);

    expect(result.exitCode).toBe(0);
    expect(result.report.ok).toBe(true);
    expect(result.report.checks.some((check) => check.id === 'workspace:config')).toBe(true);
  });

  it('fails when a task bundle metadata file is corrupted', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await runSetup({}, projectRoot);
    const runtime = await createRuntime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Corrupt metadata',
      source: { type: 'jira', ref: 'ABC-123', url: null, rawText: 'raw' },
    });

    await fs.writeFile(
      path.join(projectRoot, '.claude/.llm-docs/tasks/ABC-123/state.json'),
      '{not-json',
      'utf-8',
    );

    const result = await runDoctor({}, projectRoot);

    expect(result.exitCode).toBe(1);
    expect(result.report.ok).toBe(false);
    expect(
      result.report.checks.some(
        (check) => check.id === 'registry:meta:ABC-123' && check.severity === 'error',
      ),
    ).toBe(true);
  });

  it('warns about unresolved generated candidates', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await writeProjectFile(projectRoot, 'AGENTS.md', '# Existing agents\n');
    await runSetup({ hosts: 'codex' }, projectRoot);

    const result = await runDoctor({}, projectRoot);

    expect(result.exitCode).toBe(0);
    expect(result.report.ok).toBe(true);
    expect(result.report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'candidate:AGENTS.llmdocs.generated.md',
          severity: 'warning',
        }),
      ]),
    );
  });

  it('validates the installed agent guide pack', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await runSetup({ hosts: 'claude,codex' }, projectRoot);

    const result = await runDoctor({}, projectRoot);

    expect(result.exitCode).toBe(0);
    expect(result.report.ok).toBe(true);
    expect(result.report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'agent-guide:codex:llm-docs/SKILL.md',
          severity: 'info',
        }),
        expect.objectContaining({
          id: 'agent-guide:codex:root-router',
          severity: 'info',
        }),
        expect.objectContaining({
          id: 'agent-guide:claude:llm-docs/references/recipes.md',
          severity: 'info',
        }),
      ]),
    );
  });

  it('warns when an agent guide skill is stale', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await runSetup({ hosts: 'codex' }, projectRoot);
    await writeProjectFile(projectRoot, '.agents/skills/llm-docs/SKILL.md', '# stale\n');

    const result = await runDoctor({}, projectRoot);

    expect(result.exitCode).toBe(0);
    expect(result.report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'agent-guide:codex:llm-docs/SKILL.md',
          severity: 'warning',
        }),
      ]),
    );
  });

  it('warns when a protected branch has workspace active task state', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot, 'main');
    await runSetup({}, projectRoot);
    const runtime = await createRuntime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Protected branch active warning',
      source: { type: 'prompt', ref: null, url: null, rawText: 'protected active warning' },
    });

    const result = await runDoctor({}, projectRoot);

    expect(result.exitCode).toBe(0);
    expect(result.report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'active-task:protected-branch-passive',
          severity: 'warning',
        }),
      ]),
    );
  });

  it('warns when the active task is stale even if checkpoint flags look current', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot, 'feature/ABC-123-stale');
    await runSetup({}, projectRoot);
    const runtime = await createRuntime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Stale active task',
      source: { type: 'prompt', ref: null, url: null, rawText: 'stale active task warning' },
    });
    await runtime.saveContextCheckpoint('ABC-123', {
      timestamp: '2026-05-28T10:00:00.000Z',
      summary: ['Checkpoint looked current.'],
      verification: ['npm test passed'],
    });
    const state = await readTaskState(runtime.paths, 'ABC-123');
    await writeTaskState(runtime.paths, 'ABC-123', {
      ...state,
      bundle: {
        ...state.bundle,
        updatedAt: '2026-05-29T12:30:41.810Z',
      },
      staleness: {
        needsActualization: true,
        reasons: ['post-commit head advanced'],
        lastCheckedAt: '2026-05-29T12:30:41.811Z',
      },
    });

    const result = await runDoctor({}, projectRoot);

    expect(result.exitCode).toBe(0);
    expect(result.report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'active-task:stale',
          severity: 'warning',
        }),
        expect.objectContaining({
          id: 'active-task:checkpoint',
          severity: 'warning',
          message: expect.stringContaining('stale'),
        }),
        expect.objectContaining({
          id: 'active-task:narrative-stale',
          severity: 'warning',
        }),
      ]),
    );
  });

  it('fails when the worktree seed manifest is invalid', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await runSetup({}, projectRoot);
    await writeProjectFile(projectRoot, '.claude/docs/seed.manifest.json', '{not-json\n');

    const result = await runDoctor({}, projectRoot);

    expect(result.exitCode).toBe(1);
    expect(result.report.ok).toBe(false);
    expect(result.report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'worktree-seed:manifest',
          severity: 'error',
        }),
      ]),
    );
  });

  it('warns when legacy active tasks and published task docs diverge', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    const baseConfig = await createDefaultConfig(projectRoot);
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

    await writeConfig(projectRoot, config);
    await bootstrapWorkspace(projectRoot, config);
    const runtime = await createRuntime(projectRoot, { createIfMissing: false });
    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Legacy divergence',
      source: { type: 'prompt', ref: 'ABC-123', url: null, rawText: 'legacy divergence' },
    });
    await writeProjectFile(
      projectRoot,
      '.claude/docs/tasks/ABC-123/context.md',
      '# Published ABC-123\n',
    );

    const registry = await readTaskRegistry(runtime.paths);
    registry.branchToTask.main = 'ABC-123';
    await writeTaskRegistry(runtime.paths, registry);

    const result = await runDoctor({}, projectRoot);
    const warningIds = result.report.checks
      .filter((check) => check.severity === 'warning')
      .map((check) => check.id);

    expect(result.exitCode).toBe(0);
    expect(warningIds).toEqual(
      expect.arrayContaining([
        'layout:ambiguous-task-dirs',
        'active-task:default-branch-mapping:main',
        'active-task:published-not-closed:ABC-123',
      ]),
    );
  });

  it('warns when active context files exceed configured budgets', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await runSetup({}, projectRoot);
    const config = await loadConfig(projectRoot);

    await writeConfig(projectRoot, {
      ...config,
      contextBudget: {
        ...config.contextBudget,
        activeContextMaxBytes: 1,
      },
    });
    const runtime = await createRuntime(projectRoot, { createIfMissing: false });
    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Context budget warning',
      source: { type: 'prompt', ref: null, url: null, rawText: 'budget warning' },
    });

    const result = await runDoctor({}, projectRoot);

    expect(result.exitCode).toBe(0);
    expect(result.report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringContaining('context-budget:context:'),
          severity: 'warning',
        }),
      ]),
    );
  });

  it('checks context budget for branch-mapped active tasks', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot, 'feature/ABC-123-context-budget');
    await runSetup({}, projectRoot);
    const config = await loadConfig(projectRoot);

    await writeConfig(projectRoot, {
      ...config,
      contextBudget: {
        ...config.contextBudget,
        activeContextMaxBytes: 1,
      },
    });
    const runtime = await createRuntime(projectRoot, { createIfMissing: false });
    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Branch mapped budget warning',
      source: { type: 'prompt', ref: null, url: null, rawText: 'branch mapped budget warning' },
    });

    const registry = await readTaskRegistry(runtime.paths);
    registry.activeTaskId = null;
    registry.branchToTask['feature/ABC-123-context-budget'] = 'ABC-123';
    await writeTaskRegistry(runtime.paths, registry);
    await fs.rm(path.join(runtime.paths.tasksDir, 'ACTIVE'), { force: true });

    const result = await runDoctor({}, projectRoot);

    expect(result.exitCode).toBe(0);
    expect(result.report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringContaining('context-budget:context:'),
          severity: 'warning',
        }),
      ]),
    );
  });
});
