import fs from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';
import { createV2Runtime } from '../../src/v2/runtime.js';
import { readTaskState, writeTaskState } from '../../src/v2/task/state.js';
import { buildTaskSummaryMarkdown } from '../../src/v2/task/summary.js';
import type { AdditionalDocRecord } from '../../src/v2/types.js';
import { bootstrapWorkspace } from '../../src/v2/workspace/bootstrap.js';
import { initGitRepo, makeTempProject, prepareV2Workspace } from './v2-test-helpers.js';

const SOURCE_PATHS = [
  'src/frontend/src/pages/AlphaHomePage/index.tsx',
  'src/frontend/src/pages/AlphaHomePage/constants.ts',
  'src/frontend/src/pages/AlphaHomePage/__tests__/AlphaHomePage.test.tsx',
  'src/frontend/src/components/common/AlphaHero/index.tsx',
  'src/frontend/src/components/common/AlphaHomeCard/index.tsx',
  'src/frontend/src/components/common/AlphaRecentAgentCard/index.tsx',
  'src/frontend/src/components/common/AlphaRecentAgents/index.tsx',
  'src/frontend/src/components/common/AlphaTemplateChip/index.tsx',
  'src/frontend/src/components/common/AlphaSideDialog/index.tsx',
  'src/frontend/src/modals/AlphaAgentWizardModal/index.tsx',
  'src/frontend/src/modals/AlphaAgentWizardModal/AgentSettingsStep.tsx',
  'src/frontend/src/modals/AlphaAgentWizardModal/CommunicationStep.tsx',
  'src/frontend/src/modals/AlphaAgentWizardModal/CompletionStep.tsx',
  'src/frontend/src/assets/AIIcon.svg',
  'src/frontend/package.json',
];

async function writeSourceFile(projectRoot: string, relativePath: string, content = '// test\n') {
  const fullPath = path.join(projectRoot, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

function additionalDoc(pathName: string, title: string, docType: AdditionalDocRecord['doc_type']) {
  return {
    id: pathName.replace(/[^a-z0-9]+/gi, '-').toLowerCase(),
    path: pathName,
    doc_type: docType,
    phase: 'implementation' as const,
    status: 'active' as const,
    title,
    created_at: '2026-05-18T00:00:00.000Z',
    updated_at: '2026-05-19T00:00:00.000Z',
  } satisfies AdditionalDocRecord;
}

async function prepareLongUiTaskFixture() {
  const projectRoot = await makeTempProject();
  await initGitRepo(projectRoot, 'PROJ-349');
  const { config, paths } = await prepareV2Workspace(projectRoot);
  await bootstrapWorkspace(projectRoot, config);
  const runtime = await createV2Runtime(projectRoot);

  await runtime.createTaskBundle({
    taskId: 'PROJ-349',
    title: 'Alpha home page and wizard',
    source: { type: 'jira', ref: 'PROJ-349', url: null, rawText: 'Build alpha home UI' },
    tags: ['frontend', 'home-page', 'wizard', 'design'],
  });
  for (const sourcePath of SOURCE_PATHS) {
    await writeSourceFile(projectRoot, sourcePath);
  }
  await runtime.saveContextCheckpoint('PROJ-349', {
    timestamp: '2026-05-25T12:10:19.346Z',
    checkpointKind: 'incident',
    appendChangelog: false,
    summary: [
      'GitLab Docker build fails during npm run build with exit code 137.',
      'Kubernetes reports OOMKilled for the frontend pipeline.',
      'Local npm ci and local build passed through the corporate registry.',
    ],
    currentState: [
      'Strong suspect: barrel imports from @salutejs/plasma-icons/scalable inflate the CI bundle.',
    ],
    files: ['src/frontend/package-lock.json'],
    verification: ['local npm ci passed', 'local npm run build passed'],
  });

  const contextPath = path.join(paths.tasksDir, 'PROJ-349', 'context.md');
  await fs.appendFile(
    contextPath,
    '\nOlder compact note: template/wizard flows remain visual or no-op; wizard work was out of scope.\n',
    'utf-8',
  );
  await fs.writeFile(
    path.join(paths.tasksDir, 'PROJ-349', 'changelog.md'),
    [
      '# Changelog — PROJ-349',
      '',
      '## 2026-05-21T10:00:00.000Z — SB Sans Display font fix',
      '',
      '### Summary',
      '- SB Sans Display font files were added and validated.',
      '',
      '---',
      '',
    ].join('\n'),
    'utf-8',
  );

  const state = await readTaskState(paths, 'PROJ-349');
  await writeTaskState(paths, 'PROJ-349', {
    ...state,
    qualityProfile: 'large-ui',
    bundle: {
      ...state.bundle,
      createdAt: '2026-05-15T00:00:00.000Z',
      updatedAt: '2026-05-25T12:10:19.346Z',
    },
    staleness: {
      needsActualization: true,
      reasons: ['post-commit head advanced'],
      lastCheckedAt: '2026-05-25T12:10:19.346Z',
    },
    related: {
      ...state.related,
      tags: ['frontend', 'home-page', 'wizard', 'design'],
    },
    truth: {
      sourceOfTruthPaths: SOURCE_PATHS,
      sourceOfTruthDocs: ['context.md'],
      currentTruthNote:
        'Current source of truth is the alpha home implementation under AlphaHomePage, reusable alpha components, AlphaAgentWizardModal step components, AlphaSideDialog, design assets/icons, Plasma icons dependency, and SB Sans Display font fix. Old /flows and legacy home remain out of scope.',
    },
    docs: {
      ...state.docs,
      additional: [
        additionalDoc('research-alpha-home-2026-05-15.md', 'Alpha home research', 'research'),
        additionalDoc('pixso-home-spec-2026-05-18.md', 'Pixso home spec', 'analysis'),
        additionalDoc(
          'final-implementation-plan-2026-05-18.md',
          'Final implementation plan',
          'plan',
        ),
      ],
    },
    checkpoint: {
      ...state.checkpoint,
      lastCheckpointAt: '2026-05-25T12:10:19.346Z',
      estimatedTranscriptTokens: 45_307_440,
    },
  });

  return { projectRoot, runtime };
}

describe('task bundle quality diagnostics', () => {
  it('flags a long UI task whose latest checkpoint overfits the CI incident', async () => {
    const { runtime } = await prepareLongUiTaskFixture();

    const report = await runtime.buildTaskQualityReport('PROJ-349');
    const findingIds = report.findings.map((finding) => finding.id);

    expect(report.status).not.toBe('pass');
    expect(report.profile.effective).toBe('large-ui');
    expect(findingIds).toEqual(
      expect.arrayContaining([
        'summary-missing',
        'changelog-stale-after-checkpoint',
        'latest-checkpoint-dominated-by-incident',
        'possible-superseded-noop-context',
        'source-truth-without-readable-map',
        'active-task-stale',
        'active-additional-docs-not-surfaced',
      ]),
    );
  });

  it('builds a publish summary from current truth and grouped implementation map', async () => {
    const { projectRoot, runtime } = await prepareLongUiTaskFixture();
    const meta = await runtime.readTaskMeta('PROJ-349');
    const summary = await buildTaskSummaryMarkdown({
      projectRoot,
      bundlePath: path.join(projectRoot, meta.bundle.path),
      meta,
    });
    const finalOutcome = summary.match(/## Final Outcome\n([\s\S]*?)\n## Key Decisions/)?.[1] ?? '';

    expect(finalOutcome).toContain('Current source of truth is the alpha home implementation');
    expect(finalOutcome).not.toContain('OOMKilled');
    expect(summary).toContain('Wizard, modal, and dialog flow:');
    expect(summary).toContain('Reusable UI components:');
    expect(summary).toContain('Task and research docs:');
  });

  it('detects duplicate and publish-mechanics dominated summary bullets', async () => {
    const { runtime } = await prepareLongUiTaskFixture();
    const meta = await runtime.readTaskMeta('PROJ-349');
    await fs.writeFile(
      path.join(runtime.projectRoot, meta.bundle.path, 'summary.md'),
      [
        '# Summary — PROJ-349',
        '',
        '## Final Outcome',
        '- Task bundle published to docs/tasks.',
        '- summary.md generated during publish.',
        '- Task bundle published to docs/tasks.',
        '',
      ].join('\n'),
      'utf-8',
    );

    const report = await runtime.buildTaskQualityReport('PROJ-349');
    const findingIds = report.findings.map((finding) => finding.id);

    expect(findingIds).toEqual(
      expect.arrayContaining([
        'summary-dominated-by-publish-mechanics',
        'duplicate-summary-bullets',
      ]),
    );
  });

  it('flags state-only stale markers and stale source-truth references', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot, 'feature/ABC-123-stale-docs');
    const { config, paths } = await prepareV2Workspace(projectRoot);
    await bootstrapWorkspace(projectRoot, config);
    const runtime = await createV2Runtime(projectRoot);
    const git = simpleGit(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Stale narrative docs',
      source: { type: 'prompt', ref: null, url: null, rawText: 'stale narrative flow' },
    });
    await writeSourceFile(projectRoot, 'src/feature.ts', 'export const value = 1;\n');
    await git.add('src/feature.ts');
    await git.commit('add feature source');
    const checkpointHead = (await git.revparse(['HEAD'])).trim();

    await runtime.saveContextCheckpoint('ABC-123', {
      timestamp: '2026-05-28T10:00:00.000Z',
      summary: ['Feature source was implemented.'],
      implementationDetails: ['src/feature.ts owns the feature behavior.'],
      files: ['src/feature.ts'],
      verification: ['npm test passed'],
    });
    await fs.writeFile(
      path.join(paths.tasksDir, 'ABC-123', 'summary.md'),
      [
        '# ABC-123 Summary',
        '',
        '## Final Outcome',
        '- Feature source was implemented.',
        '',
        '## Current Truth',
        `- HEAD: ${checkpointHead}`,
        '',
      ].join('\n'),
      'utf-8',
    );

    await writeSourceFile(projectRoot, 'src/feature.ts', 'export const value = 2;\n');
    await git.add('src/feature.ts');
    await git.commit('advance feature source');
    const state = await readTaskState(paths, 'ABC-123');
    await writeTaskState(paths, 'ABC-123', {
      ...state,
      bundle: {
        ...state.bundle,
        updatedAt: '2026-05-29T12:30:41.810Z',
      },
      branch: {
        ...state.branch,
        lastActualizedCommit: checkpointHead,
      },
      staleness: {
        needsActualization: true,
        reasons: ['post-commit head advanced'],
        lastCheckedAt: '2026-05-29T12:30:41.811Z',
      },
      truth: {
        ...state.truth,
        sourceOfTruthPaths: ['src/feature.ts', 'src/deleted.ts'],
        currentTruthNote: `Current source of truth remains HEAD ${checkpointHead}.`,
      },
    });

    const report = await runtime.buildTaskQualityReport('ABC-123');
    const findingIds = report.findings.map((finding) => finding.id);

    expect(report.status).toBe('fail');
    expect(findingIds).toEqual(
      expect.arrayContaining([
        'active-task-stale',
        'state-newer-than-narrative-docs',
        'checkpoint-head-behind-current-head',
        'summary-head-stale',
        'structured-truth-head-stale',
        'source-truth-missing-paths',
      ]),
    );
  });
});
