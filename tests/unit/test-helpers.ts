import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach } from 'vitest';
import { writeConfig } from '../../src/engine/config/load.js';
import { createDefaultConfig } from '../../src/engine/config/migrate.js';
import type { LlmDocsConfig } from '../../src/engine/types.js';
import { resolveWorkspacePaths } from '../../src/engine/workspace/paths.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

export async function makeTempProject(prefix = 'llmdocs-test-'): Promise<string> {
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

export async function prepareWorkspace(
  projectRoot: string,
  overrides?: Partial<LlmDocsConfig>,
): Promise<{
  config: LlmDocsConfig;
  paths: ReturnType<typeof resolveWorkspacePaths>;
}> {
  const baseConfig = await createDefaultConfig(projectRoot);
  const config: LlmDocsConfig = {
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

  await writeConfig(projectRoot, config);

  return {
    config,
    paths: resolveWorkspacePaths(projectRoot, config),
  };
}
