import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTaskBundle, loadTaskBundle } from '../../src/v2/task/bundle.js';
import { readTaskMeta } from '../../src/v2/task/meta.js';
import { readTaskRegistry } from '../../src/v2/task/registry.js';
import { bootstrapWorkspace } from '../../src/v2/workspace/bootstrap.js';
import { initGitRepo, makeTempProject, prepareV2Workspace } from './v2-test-helpers.js';

describe('v2 bundle lifecycle', () => {
  it('creates a simple task bundle with registry, state, and context', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot, 'feature/ABC-123-oauth-rollout');
    const { config, paths } = await prepareV2Workspace(projectRoot);
    await bootstrapWorkspace(projectRoot, config);

    const result = await createTaskBundle(projectRoot, config, paths, {
      taskId: 'ABC-123',
      title: 'OAuth rollout for admin auth',
      source: {
        type: 'jira',
        ref: 'ABC-123',
        url: null,
        rawText: 'Original issue text',
      },
      branch: 'feature/ABC-123-oauth-rollout',
      baseBranch: 'main',
      tags: ['auth', 'oauth'],
      relatedDocs: ['.claude/docs/architecture/overview.md'],
    });

    const meta = await readTaskMeta(paths, 'ABC-123');
    const registry = await readTaskRegistry(paths);
    const snapshot = await loadTaskBundle(paths, 'ABC-123', {
      includeContents: true,
      includeArtifacts: true,
    });

    expect(result.created).toBe(true);
    expect(result.bundlePath).toBe('.claude/.llm-docs/tasks/ABC-123');
    expect(meta.bundle.path).toBe('.claude/.llm-docs/tasks/ABC-123');
    expect(result.files.state).toBe('.claude/.llm-docs/tasks/ABC-123/state.json');
    expect(result.files.context).toBe('.claude/.llm-docs/tasks/ABC-123/context.md');
    expect(meta.artifacts.index_path).toBe('artifacts/index.json');
    expect(registry.activeTaskId).toBe('ABC-123');
    expect(registry.branchToTask['feature/ABC-123-oauth-rollout']).toBe('ABC-123');
    expect(snapshot.primaryDocs.context).toContain('# ABC-123: OAuth rollout for admin auth');
    expect(snapshot.artifactIndex?.artifacts).toEqual([]);

    await expect(fs.stat(path.join(projectRoot, result.files.state ?? ''))).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(projectRoot, '.claude/.llm-docs/tasks/ABC-123/task.meta.yaml')),
    ).rejects.toThrow();
    await expect(
      fs.stat(path.join(projectRoot, '.claude/.llm-docs/tasks/ABC-123/artifacts/index.json')),
    ).resolves.toBeTruthy();
  });

  it('keeps the full task bundle layout available through config', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot, 'feature/ABC-123-oauth-rollout');
    const { config, paths } = await prepareV2Workspace(projectRoot, {
      taskBundles: { layout: 'full' },
    });
    await bootstrapWorkspace(projectRoot, config);

    const result = await createTaskBundle(projectRoot, config, paths, {
      taskId: 'ABC-123',
      title: 'OAuth rollout for admin auth',
      source: {
        type: 'jira',
        ref: 'ABC-123',
        url: null,
        rawText: 'Original issue text',
      },
      branch: 'feature/ABC-123-oauth-rollout',
      baseBranch: 'main',
    });
    const snapshot = await loadTaskBundle(paths, 'ABC-123', {
      includeContents: true,
      includeArtifacts: true,
    });

    expect(result.files.meta).toBe('.claude/.llm-docs/tasks/ABC-123/task.meta.yaml');
    expect(snapshot.primaryDocs.task).toContain('# Task Spec — ABC-123');
    await expect(fs.stat(path.join(projectRoot, result.files.meta ?? ''))).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(projectRoot, '.claude/.llm-docs/tasks/ABC-123/artifacts/index.json')),
    ).resolves.toBeTruthy();
  });

  it('returns existing bundle when createIfExists is true', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    const { config, paths } = await prepareV2Workspace(projectRoot);
    await bootstrapWorkspace(projectRoot, config);

    await createTaskBundle(projectRoot, config, paths, {
      taskId: 'issue-456',
      title: 'Retry flaky auth tests',
      source: {
        type: 'issue',
        ref: 'issue-456',
        url: null,
        rawText: 'Retry flaky auth tests',
      },
    });

    const second = await createTaskBundle(projectRoot, config, paths, {
      taskId: 'issue-456',
      title: 'Retry flaky auth tests',
      source: {
        type: 'issue',
        ref: 'issue-456',
        url: null,
        rawText: 'Retry flaky auth tests',
      },
      createIfExists: true,
    });

    expect(second.created).toBe(false);
    expect(second.taskId).toBe('issue-456');
  });

  it('does not auto-link the default branch to an active task', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot, 'main');
    const { config, paths } = await prepareV2Workspace(projectRoot);
    await bootstrapWorkspace(projectRoot, config);

    await createTaskBundle(projectRoot, config, paths, {
      taskId: 'ABC-123',
      title: 'Main branch docs cleanup',
      source: {
        type: 'prompt',
        ref: 'ABC-123',
        url: null,
        rawText: 'Main branch task',
      },
      branch: 'main',
      baseBranch: 'main',
    });

    const registry = await readTaskRegistry(paths);

    expect(registry.activeTaskId).toBe('ABC-123');
    expect(registry.branchToTask.main).toBeUndefined();
  });
});
