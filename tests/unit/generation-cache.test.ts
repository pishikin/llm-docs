import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildGenerationCacheHash,
  isGenerationCacheHit,
  readGenerationCache,
  resolveGenerationCachePath,
  updateGenerationCacheEntry,
  writeGenerationCache,
} from '../../src/core/generation-cache.js';
import type { FactPack } from '../../src/types/index.js';

const FACT_PACK_FIXTURE: FactPack = {
  projectName: 'cache-test',
  language: 'typescript',
  packageManager: 'npm',
  scripts: { build: 'tsup', test: 'vitest run' },
  dependencies: ['chalk'],
  devDependencies: ['typescript'],
  directoryTree: ['src/index.ts', 'package.json'],
  detectedTools: {
    linter: 'biome',
    formatter: 'biome',
    bundler: 'tsup',
    testRunner: 'vitest',
    typeChecker: 'typescript',
  },
  entryPoints: ['src/index.ts'],
  configFiles: ['package.json'],
  hasTests: true,
  testFramework: 'vitest',
  hasCI: false,
  ciPlatform: null,
  riskSignals: {
    tokenStorageLocalStorage: false,
    apiMockCoverageGaps: [],
    toolingDependencyGaps: [],
    strictTypeScriptFlags: [],
    notes: [],
  },
  projectFacts: {
    routePaths: [],
    authApiFunctions: [],
    authApiEndpoints: [],
    mockAuthEndpoints: [],
    tokenStorageWriteFiles: [],
    anyTypeUsageFiles: [],
    hasJsonServerDependency: false,
    jsonServerScriptNames: [],
    eslintNoExplicitAnyRuleConfigured: false,
  },
};

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llmdocs-cache-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

describe('generation-cache', () => {
  it('builds stable hash and changes by target/profile inputs', () => {
    const baseInput = {
      factPack: FACT_PACK_FIXTURE,
      provider: { type: 'codex-cli' as const, model: 'gpt-5.3-codex' },
      speedProfile: 'balanced' as const,
      target: 'codex' as const,
      maxDirectoryTreeEntries: 220,
      enableFormatRepair: true,
      enableQualityRepair: true,
      rootOnly: false,
    };

    const first = buildGenerationCacheHash(baseInput);
    const same = buildGenerationCacheHash({
      ...baseInput,
      provider: { model: 'gpt-5.3-codex', type: 'codex-cli' as const },
    });
    const differentTarget = buildGenerationCacheHash({ ...baseInput, target: 'cursor' as const });
    const differentProfile = buildGenerationCacheHash({
      ...baseInput,
      speedProfile: 'fast' as const,
    });
    const differentRootOnly = buildGenerationCacheHash({
      ...baseInput,
      rootOnly: true,
    });

    expect(first).toBe(same);
    expect(first).not.toBe(differentTarget);
    expect(first).not.toBe(differentProfile);
    expect(first).not.toBe(differentRootOnly);
  });

  it('resolves cache path under .git when available', async () => {
    const projectRoot = await makeTempDir();
    await fs.mkdir(path.join(projectRoot, '.git'), { recursive: true });

    const cachePath = await resolveGenerationCachePath(projectRoot);
    expect(cachePath.replace(/\\/g, '/')).toMatch(/\.git\/llmdocs\.cache\.json$/);
  });

  it('reads and writes cache file', async () => {
    const projectRoot = await makeTempDir();
    await fs.mkdir(path.join(projectRoot, '.git'), { recursive: true });
    const cachePath = await resolveGenerationCachePath(projectRoot);

    const cache = {
      version: 2,
      entries: {
        codex: {
          inputHash: 'abc',
          outputFiles: ['AGENTS.md'],
          updatedAt: new Date(0).toISOString(),
        },
      },
    };

    await writeGenerationCache(cachePath, cache);
    const parsed = await readGenerationCache(cachePath);

    expect(parsed.version).toBe(2);
    expect(parsed.entries.codex?.inputHash).toBe('abc');
  });

  it('uses cache hit only when hash and output files match', async () => {
    const projectRoot = await makeTempDir();
    const outputFile = path.join(projectRoot, 'AGENTS.md');
    await fs.writeFile(outputFile, '# test', 'utf-8');

    const cache = { version: 2, entries: {} };
    updateGenerationCacheEntry(projectRoot, cache, 'codex', 'hash-1', [outputFile]);

    await expect(isGenerationCacheHit(projectRoot, cache, 'codex', 'hash-1')).resolves.toBe(true);
    await expect(isGenerationCacheHit(projectRoot, cache, 'codex', 'hash-2')).resolves.toBe(false);

    await fs.rm(outputFile, { force: true });
    await expect(isGenerationCacheHit(projectRoot, cache, 'codex', 'hash-1')).resolves.toBe(false);
  });
});
