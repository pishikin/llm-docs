import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProjectConfig } from '../../types/index.js';
import { writeJsonAtomic } from '../../utils/fs.js';
import { ConfigMigrationError } from '../errors.js';
import type {
  LlmDocsConfig,
  LoadOrMigrateConfigOptions,
  LoadOrMigrateConfigResult,
} from '../types.js';
import { createDefaultConfig, isLikelyLegacyConfig, migrateLegacyConfig } from './migrate.js';
import { configSchema } from './schema.js';

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

export async function loadConfig(projectRoot: string): Promise<LlmDocsConfig> {
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

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigMigrationError('llmdocs.config.json is not a valid config', result.error);
  }

  return result.data;
}

export async function writeConfig(projectRoot: string, config: LlmDocsConfig): Promise<string> {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) {
    throw new ConfigMigrationError('Refusing to write invalid config', parsed.error);
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

    const config = await createDefaultConfig(projectRoot);

    if (!options.dryRun) {
      await writeConfig(projectRoot, config);
    }

    return {
      config,
      configPath,
      status: 'created',
      wroteConfig: !options.dryRun,
      migrationSummary: ['Created new config with default context-ops workspace settings.'],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig);
  } catch (error) {
    throw new ConfigMigrationError('llmdocs.config.json is not valid JSON', error);
  }

  const v2Result = configSchema.safeParse(parsed);
  if (v2Result.success) {
    return {
      config: v2Result.data,
      configPath,
      status: 'loaded',
      wroteConfig: false,
      migrationSummary: [],
    };
  }

  if (!isLikelyLegacyConfig(parsed)) {
    throw new ConfigMigrationError(
      'llmdocs.config.json is neither a valid current config nor a supported legacy config',
      v2Result.error,
    );
  }

  const migrated = await migrateLegacyConfig(
    parsed as ProjectConfig & Record<string, unknown>,
    projectRoot,
  );

  if (!options.dryRun) {
    await writeConfig(projectRoot, migrated);
  }

  return {
    config: migrated,
    configPath,
    status: 'migrated',
    wroteConfig: !options.dryRun,
    migrationSummary: [
      'Migrated legacy config to the current schema.',
      'Preserved legacy docs generation settings under legacyAgentDocs.',
    ],
  };
}
