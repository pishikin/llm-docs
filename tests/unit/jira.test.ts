import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importJiraTaskBundle } from '../../src/engine/integrations/jira/from-jira.js';
import { pullJiraIssue } from '../../src/engine/integrations/jira/pull.js';
import { readArtifactIndex } from '../../src/engine/task/artifacts.js';
import { readTaskMeta } from '../../src/engine/task/meta.js';
import { bootstrapWorkspace } from '../../src/engine/workspace/bootstrap.js';
import { initGitRepo, makeTempProject, prepareWorkspace } from './test-helpers.js';

const JIRA_TOKEN = 'test-token';

function issueResponse(summary = 'Add edit translation'): unknown {
  return {
    key: 'PROJ-286',
    fields: {
      summary,
      description: 'Switches language to English while editing a component.',
      status: { name: 'Ready For Release' },
      assignee: { displayName: 'Test Assignee' },
      reporter: { displayName: 'Test Reporter' },
      priority: { name: 'Medium' },
      labels: [],
      components: [],
      created: '2026-04-15T15:12:35.124+0000',
      updated: '2026-05-04T13:50:27.165+0000',
      issuetype: { name: 'Story' },
      attachment: [
        {
          filename: 'screen.png',
          content: 'https://jira.example/secure/attachment/1/screen.png',
          mimeType: 'image/png',
          size: 12,
        },
      ],
    },
  };
}

function stubJiraFetch(summary?: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${JIRA_TOKEN}` });

      if (url.includes('/rest/api/2/issue/PROJ-286')) {
        return Response.json(issueResponse(summary));
      }

      if (url.includes('/secure/attachment/1/screen.png')) {
        return new Response('image-bytes');
      }

      return Response.json({ ok: true });
    }),
  );
}

async function prepareJiraWorkspace(): Promise<Awaited<ReturnType<typeof prepareWorkspace>>> {
  const projectRoot = await makeTempProject();
  await initGitRepo(projectRoot);
  const workspace = await prepareWorkspace(projectRoot, {
    integrations: {
      jira: {
        enabled: true,
        baseUrl: 'https://jira.example',
        tokenEnvVar: 'JIRA_TOKEN',
        projectKeys: ['PROJ'],
      },
    },
  });
  await bootstrapWorkspace(projectRoot, workspace.config);
  return workspace;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Jira integration', () => {
  it('pulls a Jira issue into the local inbox without exposing the token', async () => {
    vi.stubEnv('JIRA_TOKEN', JIRA_TOKEN);
    stubJiraFetch();
    const { config, paths } = await prepareJiraWorkspace();

    const result = await pullJiraIssue(config, paths, 'PROJ-286', { attachments: true });

    expect(result.rawPath).toBe('.claude/inbox/jira/PROJ-286/raw.json');
    expect(result.issuePath).toBe('.claude/inbox/jira/PROJ-286/issue.md');
    expect(result.attachments).toMatchObject([{ filename: 'screen.png', downloaded: true }]);

    const issueMarkdown = await fs.readFile(
      path.join(paths.projectRoot, result.issuePath),
      'utf-8',
    );
    const rawJson = await fs.readFile(path.join(paths.projectRoot, result.rawPath), 'utf-8');
    const attachment = await fs.readFile(
      path.join(paths.projectRoot, '.claude/inbox/jira/PROJ-286/attachments/screen.png'),
      'utf-8',
    );

    expect(issueMarkdown).toContain('# PROJ-286: Add edit translation');
    expect(issueMarkdown).not.toContain(JIRA_TOKEN);
    expect(rawJson).not.toContain(JIRA_TOKEN);
    expect(attachment).toBe('image-bytes');
  });

  it('creates a task bundle from Jira and preserves existing context on refresh', async () => {
    vi.stubEnv('JIRA_TOKEN', JIRA_TOKEN);
    stubJiraFetch();
    const { config, paths } = await prepareJiraWorkspace();

    const first = await importJiraTaskBundle(paths.projectRoot, config, paths, 'PROJ-286', {
      attachments: true,
    });
    const meta = await readTaskMeta(paths, 'PROJ-286');
    const contextPath = path.join(paths.projectRoot, first.contextPath ?? '');

    expect(first.created).toBe(true);
    expect(meta.source).toMatchObject({
      type: 'jira',
      ref: 'PROJ-286',
      url: 'https://jira.example/browse/PROJ-286',
    });
    await expect(
      fs.access(path.join(paths.projectRoot, first.bundlePath, 'artifacts/jira-raw.json')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(paths.projectRoot, first.bundlePath, 'artifacts/screen.png')),
    ).resolves.toBeUndefined();

    await fs.writeFile(contextPath, '# Custom working context\n', 'utf-8');
    stubJiraFetch('Updated summary from Jira');

    const second = await importJiraTaskBundle(paths.projectRoot, config, paths, 'PROJ-286', {
      attachments: true,
    });
    const context = await fs.readFile(contextPath, 'utf-8');
    const artifactIndex = await readArtifactIndex(paths, 'PROJ-286');

    expect(second.created).toBe(false);
    expect(context).toBe('# Custom working context\n');
    expect(artifactIndex.artifacts.map((artifact) => artifact.filename).sort()).toEqual([
      'jira-issue.md',
      'jira-raw.json',
      'screen.png',
    ]);
  });
});
