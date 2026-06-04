import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTaskBundle } from '../../src/v2/task/bundle.js';
import { appendChangelogEpoch } from '../../src/v2/task/changelog.js';
import { saveContextCheckpoint } from '../../src/v2/task/checkpoint.js';
import { prepareJiraDoc } from '../../src/v2/task/jira-doc.js';
import type { PublishedTaskIndex } from '../../src/v2/types.js';
import { bootstrapWorkspace } from '../../src/v2/workspace/bootstrap.js';
import { initGitRepo, makeTempProject, prepareV2Workspace } from './v2-test-helpers.js';

async function createTaskWithCheckpoint(
  projectRoot: string,
  taskId: string,
): Promise<Awaited<ReturnType<typeof prepareV2Workspace>>> {
  await initGitRepo(projectRoot, `feature/${taskId}`);
  const workspace = await prepareV2Workspace(projectRoot, {
    integrations: {
      jira: {
        enabled: true,
        baseUrl: null,
        tokenEnvVar: 'JIRA_TOKEN',
        projectKeys: ['PROJ'],
      },
      github: {
        enabled: false,
      },
    },
  });
  await bootstrapWorkspace(projectRoot, workspace.config);
  await createTaskBundle(projectRoot, workspace.config, workspace.paths, {
    taskId,
    title: 'Localize process modal buttons',
    source: {
      type: 'jira',
      ref: taskId,
      url: null,
      rawText: 'Localize process modal buttons',
    },
  });
  await saveContextCheckpoint(projectRoot, workspace.config, workspace.paths, taskId, {
    summary: ['Локализованы кнопки Cancel и Save в модалке деталей процесса.'],
    completedWork: [
      'Добавлено дефолтное описание хедера модалки.',
      'Подключена общая i18n-логика для кнопки Finish Editing.',
    ],
    decisions: ['Локализация вынесена в общий helper, чтобы не дублировать fallback-логику.'],
    verification: ['npm run verify'],
  });
  await appendChangelogEpoch(workspace.paths, taskId, {
    label: 'jira-doc-fixture',
    summary: ['Исправлено отображение описаний starter-шаблонов через shared i18n helper.'],
  });

  return workspace;
}

async function publishFixtureBundle(
  projectRoot: string,
  activeBundlePath: string,
  taskId: string,
): Promise<void> {
  const targetPath = path.join(projectRoot, '.claude/docs/tasks', taskId);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.cp(path.join(projectRoot, activeBundlePath), targetPath, { recursive: true });
  await fs.writeFile(
    path.join(targetPath, 'summary.md'),
    `# Summary — ${taskId}

## Final Outcome
- Published summary: кнопки модалки локализованы и поведение подтверждено.

## Key Decisions
- Published summary decision is preferred for Jira facts.

## Verification
- npm run verify

## Residual Risks
- No known residual risk.
`,
    'utf-8',
  );
  await fs.writeFile(
    path.join(targetPath, 'publish.manifest.json'),
    `${JSON.stringify({ schemaVersion: 1, taskId }, null, 2)}\n`,
    'utf-8',
  );

  const index: PublishedTaskIndex = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    tasks: {
      [taskId]: {
        taskId,
        title: 'Localize process modal buttons',
        status: 'active',
        phase: 'implementation',
        publishedAt: new Date().toISOString(),
        path: `.claude/docs/tasks/${taskId}`,
        sourceBranch: `feature/${taskId}`,
        sourceCommit: null,
        destinationCommit: null,
        bundleHash: null,
        manifestPath: `.claude/docs/tasks/${taskId}/publish.manifest.json`,
      },
    },
  };
  await fs.writeFile(
    path.join(projectRoot, '.claude/docs/tasks/index.json'),
    `${JSON.stringify(index, null, 2)}\n`,
    'utf-8',
  );
}

describe('prepareJiraDoc', () => {
  it('prepares compact facts from a published task and expands numeric Jira ids', async () => {
    const projectRoot = await makeTempProject();
    const taskId = 'PROJ-251';
    const workspace = await createTaskWithCheckpoint(projectRoot, taskId);
    await publishFixtureBundle(projectRoot, `.claude/.llm-docs/tasks/${taskId}`, taskId);

    const result = await prepareJiraDoc(workspace.config, workspace.paths, {
      taskId: '251',
    });

    expect(result.taskId).toBe(taskId);
    expect(result.source.kind).toBe('published');
    expect(result.source.bundlePath).toBe(`.claude/docs/tasks/${taskId}`);
    expect(result.source.manifestPath).toBe(`.claude/docs/tasks/${taskId}/publish.manifest.json`);
    expect(result.sourcePaths).toContain(`.claude/docs/tasks/${taskId}/summary.md`);
    expect(result.sourcePaths).toContain(`.claude/docs/tasks/${taskId}/state.json`);
    expect(result.sourcePaths).not.toContain(`.claude/docs/tasks/${taskId}/task.meta.yaml`);
    expect(result.warnings).toContain('Expanded numeric task id 251 with Jira project key PROJ.');
    expect(result.facts.summary).toContain(
      'Published summary: кнопки модалки локализованы и поведение подтверждено.',
    );
    expect(result.facts.decisions).toContain(
      'Published summary decision is preferred for Jira facts.',
    );
    expect(result.facts.completedWork).toEqual(
      expect.arrayContaining([
        'Добавлено дефолтное описание хедера модалки.',
        'Исправлено отображение описаний starter-шаблонов через shared i18n helper.',
      ]),
    );
    expect(result.facts.verification).toEqual(['npm run verify']);
    expect(result.styleRules.join('\n')).toContain('at or below 15 lines');
  });

  it('falls back to an active task bundle when published docs are absent', async () => {
    const projectRoot = await makeTempProject();
    const taskId = 'PROJ-251';
    const workspace = await createTaskWithCheckpoint(projectRoot, taskId);

    const result = await prepareJiraDoc(workspace.config, workspace.paths, {
      taskId,
    });

    expect(result.source.kind).toBe('active');
    expect(result.source.bundlePath).toBe(`.claude/.llm-docs/tasks/${taskId}`);
    expect(result.warnings).toContain(
      `Published task ${taskId} was not found; used active task bundle fallback.`,
    );
  });

  it('refuses ambiguous numeric task ids when no single Jira project key is configured', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    const workspace = await prepareV2Workspace(projectRoot, {
      integrations: {
        jira: {
          enabled: true,
          baseUrl: null,
          tokenEnvVar: 'JIRA_TOKEN',
          projectKeys: [],
        },
        github: {
          enabled: false,
        },
      },
    });
    await bootstrapWorkspace(projectRoot, workspace.config);
    await fs.mkdir(path.join(projectRoot, '.claude/docs/tasks/ABC-251'), { recursive: true });
    await fs.mkdir(path.join(projectRoot, '.claude/docs/tasks/PROJ-251'), { recursive: true });

    await expect(
      prepareJiraDoc(workspace.config, workspace.paths, { taskId: '251' }),
    ).rejects.toThrow('Task id 251 is ambiguous');
  });
});
