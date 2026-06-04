import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProjectConfig } from '../../types/index.js';
import { writeJsonAtomic } from '../../utils/fs.js';
import { ConfigMigrationError } from '../errors.js';
import type {
  LlmDocsConfigV2,
  LoadOrMigrateConfigOptions,
  LoadOrMigrateConfigResult,
} from '../types.js';
import { createDefaultConfigV2, isLikelyV1Config, migrateV1ConfigToV2 } from './migrate.js';
import { configV2Schema } from './schema.js';

const CONFIG_FILE = 'llmdocs.config.json';

async function readConfigFile(projectRoot: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(projectRoot, CONFIG_FILE), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

export async function loadConfigV2(projectRoot: string): Promise<LlmDocsConfigV2> {
  const rawConfig = await readConfigFile(projectRoot);
  if (rawConfig === null) {
    throw new ConfigMigrationError('llmdocs.config.json not found');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig);
  } catch (error) {
    throw new ConfigMigrationError('llmdocs.config.json is not valid JSON', error);
  }

  const result = configV2Schema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigMigrationError('llmdocs.config.json is not a valid v2 config', result.error);
  }

  return result.data;
}

export async function writeConfigV2(projectRoot: string, config: LlmDocsConfigV2): Promise<string> {
  const parsed = configV2Schema.safeParse(config);
  if (!parsed.success) {
    throw new ConfigMigrationError('Refusing to write invalid v2 config', parsed.error);
  }

  const configPath = path.join(projectRoot, CONFIG_FILE);
  await writeJsonAtomic(configPath, parsed.data);
  return configPath;
}

export async function loadOrMigrateConfig(
  projectRoot: string,
  options: LoadOrMigrateConfigOptions = {},
): Promise<LoadOrMigrateConfigResult> {
  const configPath = path.join(projectRoot, CONFIG_FILE);
  const rawConfig = await readConfigFile(projectRoot);

  if (rawConfig === null) {
    if (!options.createIfMissing) {
      throw new ConfigMigrationError('llmdocs.config.json not found');
    }

    const config = await createDefaultConfigV2(projectRoot);

    if (!options.dryRun) {
      await writeConfigV2(projectRoot, config);
    }

    return {
      config,
      configPath,
      status: 'created',
      wroteConfig: !options.dryRun,
      migrationSummary: ['Created new v2 config with default context-ops workspace settings.'],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig);
  } catch (error) {
    throw new ConfigMigrationError('llmdocs.config.json is not valid JSON', error);
  }

  const v2Result = configV2Schema.safeParse(parsed);
  if (v2Result.success) {
    return {
      config: v2Result.data,
      configPath,
      status: 'loaded',
      wroteConfig: false,
      migrationSummary: [],
    };
  }

  if (!isLikelyV1Config(parsed)) {
    throw new ConfigMigrationError(
      'llmdocs.config.json is neither a valid v2 config nor a supported v1 config',
      v2Result.error,
    );
  }

  const migrated = await migrateV1ConfigToV2(
    parsed as ProjectConfig & Record<string, unknown>,
    projectRoot,
  );

  if (!options.dryRun) {
    await writeConfigV2(projectRoot, migrated);
  }

  return {
    config: migrated,
    configPath,
    status: 'migrated',
    wroteConfig: !options.dryRun,
    migrationSummary: [
      'Migrated legacy v1 config to schemaVersion 2.',
      'Preserved legacy docs generation settings under legacyAgentDocs.',
    ],
  };
}
