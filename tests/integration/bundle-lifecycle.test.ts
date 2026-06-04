import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSetup } from '../../src/commands/setup.js';
import { createV2Runtime } from '../../src/v2/runtime.js';
import {
  checkoutBranch,
  checkoutNewBranch,
  commitProjectFile,
  initGitRepo,
  makeTempProject,
  mergeBranch,
} from '../helpers/v2-fixtures.js';

describe('v2 bundle lifecycle integration', () => {
  it('creates and loads a task bundle', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await runSetup({}, projectRoot);
    const runtime = await createV2Runtime(projectRoot);

    const createResult = await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'OAuth rollout',
      source: { type: 'jira', ref: 'ABC-123', url: null, rawText: 'OAuth rollout request' },
      tags: ['auth', 'oauth'],
    });
    const bundle = await runtime.loadTaskBundle(createResult.taskId, {
      includeContents: true,
      includeArtifacts: true,
    });

    expect(createResult.created).toBe(true);
    expect(bundle.taskId).toBe('ABC-123');
    expect(bundle.meta.title).toBe('OAuth rollout');
    expect(bundle.primaryDocs.context).toContain('# ABC-123: OAuth rollout');
    expect(bundle.primaryDocs.state).toContain('"taskId": "ABC-123"');
  });

  it('prepares and applies actualization after code changes', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await checkoutNewBranch(projectRoot, 'feature/ABC-123-oauth');
    await commitProjectFile(
      projectRoot,
      'src/auth.ts',
      'export const auth = true;\n',
      'add auth module',
    );
    await runSetup({}, projectRoot);
    const runtime = await createV2Runtime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'OAuth rollout',
      source: { type: 'jira', ref: 'ABC-123', url: null, rawText: 'OAuth rollout request' },
    });

    await commitProjectFile(
      projectRoot,
      'src/auth.ts',
      'export const auth = "updated";\n',
      'update auth module',
    );

    const report = await runtime.prepareActualization('ABC-123', { includeRelatedTasks: true });

    expect(report.needsActualization).toBe(true);
    expect(report.reasons).toContain('HEAD differs from last_actualized_commit');

    const meta = await runtime.applyActualizationState('ABC-123', {
      taskId: 'ABC-123',
      clearStaleness: true,
      lastActualizedCommit: report.git.head,
      sourceOfTruthPaths: ['src/auth.ts'],
      truthNote: 'Implementation branch remains active truth.',
    });

    expect(meta.staleness.needs_actualization).toBe(false);
    expect(meta.truth.source_of_truth_paths).toEqual(['src/auth.ts']);
  });

  it('attaches artifacts with deterministic collision handling', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await runSetup({}, projectRoot);
    const runtime = await createV2Runtime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Attach logs',
      source: { type: 'prompt', ref: null, url: null, rawText: 'collect logs' },
    });

    const sourcePath = path.join(projectRoot, 'artifacts-source', 'llmdocs-artifact.log');
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, 'first log', 'utf-8');

    const first = await runtime.attachArtifact('ABC-123', {
      sourcePath,
      kind: 'log',
    });
    const second = await runtime.attachArtifact('ABC-123', {
      sourcePath,
      kind: 'log',
    });

    expect(first.relativePath).toBe('artifacts/llmdocs-artifact.log');
    expect(second.relativePath).toBe('artifacts/llmdocs-artifact-01.log');
  });

  it('prepares and applies rebaseline after merge', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await checkoutNewBranch(projectRoot, 'feature/ABC-123-oauth');
    await commitProjectFile(
      projectRoot,
      'src/service.ts',
      'export const service = 1;\n',
      'feature work',
    );
    await runSetup({}, projectRoot);
    const runtime = await createV2Runtime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Merge flow',
      source: { type: 'jira', ref: 'ABC-123', url: null, rawText: 'merge flow' },
    });

    await checkoutBranch(projectRoot, 'main');
    await mergeBranch(projectRoot, 'feature/ABC-123-oauth');

    const report = await runtime.prepareRebaseline('ABC-123', { targetBranch: 'main' });

    expect(report.suggestedPhase).toBe('merged');

    const meta = await runtime.applyRebaselineState('ABC-123', {
      taskId: 'ABC-123',
      phase: 'merged',
      status: 'done',
      currentBranch: 'main',
      lastVerifiedCommit: report.head,
      sourceOfTruthPaths: ['src/service.ts'],
      historicalDocs: [],
      archiveTask: false,
    });

    expect(meta.phase).toBe('merged');
    expect(meta.status).toBe('done');
    expect(meta.branch.current).toBe('main');
  });
});
