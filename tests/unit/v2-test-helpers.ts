import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach } from 'vitest';
import { writeConfigV2 } from '../../src/v2/config/load.js';
import { createDefaultConfigV2 } from '../../src/v2/config/migrate.js';
import type { LlmDocsConfigV2 } from '../../src/v2/types.js';
import { resolveWorkspacePaths } from '../../src/v2/workspace/paths.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

export async function makeTempProject(prefix = 'llmdocs-v2-'): Promise<string> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(projectRoot);
  return projectRoot;
}

export async function initGitRepo(projectRoot: string, branch = 'main'): Promise<void> {
  const git = simpleGit(projectRoot);

  await git.init();
  await git.addConfig('user.name', 'Test User');
  await git.addConfig('user.email', 'test@example.com');
  await fs.writeFile(path.join(projectRoot, 'README.md'), '# Temp Project\n', 'utf-8');
  await git.add('.');
  await git.commit('initial commit');
  await git.raw(['branch', '-M', 'main']);

  if (branch !== 'main') {
    await git.checkoutLocalBranch(branch);
  }
}

export async function prepareV2Workspace(
  projectRoot: string,
  overrides?: Partial<LlmDocsConfigV2>,
): Promise<{
  config: LlmDocsConfigV2;
  paths: ReturnType<typeof resolveWorkspacePaths>;
}> {
  const baseConfig = await createDefaultConfigV2(projectRoot);
  const config: LlmDocsConfigV2 = {
    ...baseConfig,
    ...overrides,
    workspace: {
      ...baseConfig.workspace,
      ...overrides?.workspace,
    },
    taskBundles: {
      ...baseConfig.taskBundles,
      ...overrides?.taskBundles,
    },
    hosts: {
      ...baseConfig.hosts,
      ...overrides?.hosts,
      claude: {
        ...baseConfig.hosts.claude,
        ...overrides?.hosts?.claude,
      },
      codex: {
        ...baseConfig.hosts.codex,
        ...overrides?.hosts?.codex,
      },
      cursor: {
        ...baseConfig.hosts.cursor,
        ...overrides?.hosts?.cursor,
      },
    },
    integrations: {
      ...baseConfig.integrations,
      ...overrides?.integrations,
      jira: {
        ...baseConfig.integrations.jira,
        ...overrides?.integrations?.jira,
      },
      github: {
        ...baseConfig.integrations.github,
        ...overrides?.integrations?.github,
      },
    },
  };

  await writeConfigV2(projectRoot, config);

  return {
    config,
    paths: resolveWorkspacePaths(projectRoot, config),
  };
}
