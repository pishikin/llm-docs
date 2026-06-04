import { describe, expect, it } from 'vitest';
import { createAdditionalDoc, createTaskBundle } from '../../src/engine/task/bundle.js';
import {
  appendChangelogEpoch,
  parseChangelogEpochs,
  readLatestChangelogEpoch,
} from '../../src/engine/task/changelog.js';
import { readTaskMeta, setTaskStaleness } from '../../src/engine/task/meta.js';
import { resolveTaskByBranch } from '../../src/engine/task/registry.js';
import { bootstrapWorkspace } from '../../src/engine/workspace/bootstrap.js';
import { initGitRepo, makeTempProject, prepareWorkspace } from './test-helpers.js';

describe('task state services', () => {
  it('updates metadata, changelog, and branch registry for a created task', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot, 'feature/ABC-123-oauth-rollout');
    const { config, paths } = await prepareWorkspace(projectRoot, {
      taskBundles: { layout: 'full' },
    });
    await bootstrapWorkspace(projectRoot, config);

    await createTaskBundle(projectRoot, config, paths, {
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
      relatedDocs: ['.claude/docs/architecture.md'],
      tags: ['auth', 'oauth'],
    });

    await createAdditionalDoc(
      paths,
      'ABC-123',
      'context',
      'dev-fixes',
      'Post-dev fixes context',
      'dev-fixes',
    );
    await setTaskStaleness(paths, 'ABC-123', true, ['HEAD differs from last_actualized_commit']);
    await appendChangelogEpoch(paths, 'ABC-123', {
      label: 'post-dev-fixes',
      summary: ['Updated OAuth callback handling.'],
      structuredState: {
        phase: 'dev-fixes',
        status: 'active',
        branch: 'feature/ABC-123-oauth-rollout',
      },
      nextSteps: ['Run validation tests.'],
    });

    const meta = await readTaskMeta(paths, 'ABC-123');
    const latestEpoch = await readLatestChangelogEpoch(paths, 'ABC-123');
    const epochs = await parseChangelogEpochs(paths, 'ABC-123');
    const branchEntry = await resolveTaskByBranch(paths, 'feature/ABC-123-oauth-rollout');

    expect(meta.staleness.needs_actualization).toBe(true);
    expect(meta.docs.additional[0]).toMatchObject({
      id: 'dev-fixes-context',
      path: 'docs/context--dev-fixes.md',
      status: 'active',
    });
    expect(latestEpoch?.label).toBe('post-dev-fixes');
    expect(epochs).toHaveLength(2);
    expect(branchEntry?.taskId).toBe('ABC-123');
  });
});
