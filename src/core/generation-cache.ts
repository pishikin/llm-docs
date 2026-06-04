import { createHash } from 'node:crypto';
import path from 'node:path';
import type { FactPack, ProviderConfig, SpeedProfile, Target } from '../types/index.js';
import { fileExists, readJsonSafe, writeFileSafe } from '../utils/fs.js';

const CACHE_VERSION = 2;
const CACHE_FILE_NAME = 'llmdocs.cache.json';

export interface GenerationCacheEntry {
  inputHash: string;
  outputFiles: string[];
  updatedAt: string;
}

export interface GenerationCacheFile {
  version: number;
  entries: Partial<Record<Target, GenerationCacheEntry>>;
}

export interface GenerationCacheHashInput {
  factPack: FactPack;
  provider: ProviderConfig;
  speedProfile: SpeedProfile;
  target: Target;
  maxDirectoryTreeEntries: number;
  enableFormatRepair: boolean;
  enableQualityRepair: boolean;
  rootOnly: boolean;
  ensureCursorCanonicalDocs?: boolean;
}

function normalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForHash(item));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [key, item] of entries) {
    normalized[key] = normalizeForHash(item);
  }
  return normalized;
}

function toRelativePaths(projectRoot: string, filePaths: string[]): string[] {
  return filePaths.map((filePath) => path.relative(projectRoot, filePath).replace(/\\/g, '/'));
}

async function allFilesExist(projectRoot: string, relativePaths: string[]): Promise<boolean> {
  if (relativePaths.length === 0) return false;

  for (const relativePath of relativePaths) {
    const absolutePath = path.join(projectRoot, relativePath);
    if (!(await fileExists(absolutePath))) {
      return false;
    }
  }

  return true;
}

export async function resolveGenerationCachePath(projectRoot: string): Promise<string> {
  const gitDir = path.join(projectRoot, '.git');
  if (await fileExists(gitDir)) {
    return path.join(gitDir, CACHE_FILE_NAME);
  }
  return path.join(projectRoot, CACHE_FILE_NAME);
}

export async function readGenerationCache(cachePath: string): Promise<GenerationCacheFile> {
  const parsed = await readJsonSafe<GenerationCacheFile>(cachePath);
  if (!parsed || parsed.version !== CACHE_VERSION || typeof parsed.entries !== 'object') {
    return { version: CACHE_VERSION, entries: {} };
  }
  return parsed;
}

export async function writeGenerationCache(
  cachePath: string,
  cache: GenerationCacheFile,
): Promise<void> {
  await writeFileSafe(cachePath, JSON.stringify(cache, null, 2));
}

export function buildGenerationCacheHash(input: GenerationCacheHashInput): string {
  const payload = normalizeForHash({
    version: CACHE_VERSION,
    target: input.target,
    speedProfile: input.speedProfile,
    maxDirectoryTreeEntries: input.maxDirectoryTreeEntries,
    enableFormatRepair: input.enableFormatRepair,
    enableQualityRepair: input.enableQualityRepair,
    rootOnly: input.rootOnly,
    ensureCursorCanonicalDocs: input.ensureCursorCanonicalDocs ?? false,
    provider: {
      type: input.provider.type,
      model: input.provider.model ?? null,
    },
    factPack: input.factPack,
  });

  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export async function isGenerationCacheHit(
  projectRoot: string,
  cache: GenerationCacheFile,
  target: Target,
  expectedHash: string,
): Promise<boolean> {
  const entry = cache.entries[target];
  if (!entry) return false;
  if (entry.inputHash !== expectedHash) return false;

  return allFilesExist(projectRoot, entry.outputFiles);
}

export function updateGenerationCacheEntry(
  projectRoot: string,
  cache: GenerationCacheFile,
  target: Target,
  inputHash: string,
  outputFiles: string[],
): void {
  cache.entries[target] = {
    inputHash,
    outputFiles: toRelativePaths(projectRoot, outputFiles),
    updatedAt: new Date().toISOString(),
  };
}
