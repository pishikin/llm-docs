import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfigV2, loadOrMigrateConfig } from '../../src/v2/config/load.js';
import { migrateV1ConfigToV2 } from '../../src/v2/config/migrate.js';
import { ConfigMigrationError } from '../../src/v2/errors.js';
import { makeTempProject } from './v2-test-helpers.js';

describe('v2 config', () => {
  it('migrates a v1 config into the exact v2 shape', async () => {
    const projectRoot = await makeTempProject();

    const migrated = await migrateV1ConfigToV2(
      {
        name: 'llm-docs',
        targets: ['claude'],
        provider: { type: 'codex-cli' },
        excludeDirs: ['node_modules'],
        docsDir: '.claude/docs',
        legacyField: 'kept',
      },
      projectRoot,
    );

    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.mode).toBe('context-ops');
    expect(migrated.contextBudget.transcriptRiskTokens).toBe(50000);
    expect(migrated.workspace.rootDir).toBe('.claude');
    expect(migrated.taskBundles.registryPath).toBe('.claude/.llm-docs/tasks/index.json');
    expect(migrated.legacyAgentDocs).toMatchObject({
      enabled: true,
      docsDir: '.claude/docs',
      excludeDirs: ['node_modules'],
    });
    expect(migrated.legacyAgentDocs?.extra).toEqual({ legacyField: 'kept' });
  });

  it('creates a new default v2 config when missing', async () => {
    const projectRoot = await makeTempProject();

    const result = await loadOrMigrateConfig(projectRoot, { createIfMissing: true });

    expect(result.status).toBe('created');
    expect(result.wroteConfig).toBe(true);

    const persisted = await loadConfigV2(projectRoot);
    expect(persisted.schemaVersion).toBe(2);
    expect(persisted.contextBudget.activeContextMaxBytes).toBe(18000);
    expect(persisted.taskBundles.qualityProfile).toBe('normal');
    expect(persisted.workspace.rootDir).toBe('.claude');
  });

  it('migrates and writes a legacy v1 config file', async () => {
    const projectRoot = await makeTempProject();
    const configPath = path.join(projectRoot, 'llmdocs.config.json');

    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          name: 'llm-docs',
          targets: ['claude'],
          provider: { type: 'codex-cli' },
          excludeDirs: [],
          docsDir: '.claude/docs',
        },
        null,
        2,
      ),
      'utf-8',
    );

    const result = await loadOrMigrateConfig(projectRoot);

    expect(result.status).toBe('migrated');
    expect(result.config.legacyAgentDocs?.targets).toEqual(['claude']);

    const persisted = await loadConfigV2(projectRoot);
    expect(persisted.schemaVersion).toBe(2);
  });

  it('fails fast on malformed config content', async () => {
    const projectRoot = await makeTempProject();
    await fs.writeFile(path.join(projectRoot, 'llmdocs.config.json'), '{bad json', 'utf-8');

    await expect(loadOrMigrateConfig(projectRoot)).rejects.toBeInstanceOf(ConfigMigrationError);
  });
});
