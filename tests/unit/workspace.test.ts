import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findExistingLegacyAlias } from '../../src/engine/workspace/aliases.js';
import { bootstrapWorkspace } from '../../src/engine/workspace/bootstrap.js';
import { makeTempProject, prepareWorkspace } from './test-helpers.js';

describe('workspace', () => {
  it('resolves canonical workspace paths and bootstraps foundation directories', async () => {
    const projectRoot = await makeTempProject();
    const { config, paths } = await prepareWorkspace(projectRoot);

    expect(paths.relative.registryPath).toBe('.claude/.llm-docs/tasks/index.json');
    expect(paths.relative.claudeSettingsPath).toBe('.claude/settings.json');
    expect(paths.relative.codexConfigPath).toBe('.codex/config.toml');

    const report = await bootstrapWorkspace(projectRoot, config);

    expect(report.createdDirs.length).toBeGreaterThan(0);
    await expect(fs.stat(paths.workspaceRoot)).resolves.toBeTruthy();
    await expect(fs.stat(paths.tasksDir)).resolves.toBeTruthy();
    await expect(fs.stat(paths.archiveDir)).resolves.toBeTruthy();
    await expect(fs.stat(paths.promptsDir)).resolves.toBeTruthy();
  });

  it('detects legacy spelling aliases without rewriting them', async () => {
    const projectRoot = await makeTempProject();
    const { paths } = await prepareWorkspace(projectRoot);

    await fs.mkdir(path.join(projectRoot, '.claude/docs/archieve'), { recursive: true });
    await fs.mkdir(path.join(projectRoot, '.claude/docs/promts'), { recursive: true });

    const hits = await findExistingLegacyAlias(paths);

    expect(hits).toEqual([
      {
        kind: 'archive',
        canonicalPath: 'docs/archive',
        aliasPath: 'docs/archieve',
      },
      {
        kind: 'prompts',
        canonicalPath: 'docs/prompts',
        aliasPath: 'docs/promts',
      },
    ]);
  });
});
