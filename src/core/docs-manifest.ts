import path from 'node:path';
import type { Target } from '../types/index.js';
import { fileExists, readJsonSafe, writeFileSafe } from '../utils/fs.js';
import type { OutputLayout } from './output-layout.js';
import { buildManagedFilesForTargets } from './output-layout.js';

export const DOCS_MANIFEST_FILE = 'llmdocs.manifest.json';
export const DOCS_MANIFEST_SCHEMA_VERSION = 1;

export interface DocsManifest {
  schemaVersion: number;
  updatedAt: string;
  targets: Target[];
  layout: OutputLayout;
  managedFiles: string[];
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function normalizeManagedFiles(paths: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const rawPath of paths) {
    const rel = normalizeRelativePath(rawPath);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    normalized.push(rel);
  }

  return normalized.sort((a, b) => a.localeCompare(b));
}

export function resolveDocsManifestPath(projectRoot: string): string {
  return path.join(projectRoot, DOCS_MANIFEST_FILE);
}

export async function readDocsManifest(projectRoot: string): Promise<DocsManifest | null> {
  const manifestPath = resolveDocsManifestPath(projectRoot);
  if (!(await fileExists(manifestPath))) {
    return null;
  }

  const parsed = await readJsonSafe<DocsManifest>(manifestPath);
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.schemaVersion !== DOCS_MANIFEST_SCHEMA_VERSION) return null;
  if (!Array.isArray(parsed.managedFiles)) return null;
  if (!Array.isArray(parsed.targets)) return null;
  if (!parsed.layout || typeof parsed.layout !== 'object') return null;
  if (
    typeof parsed.layout.canonicalDocsDir !== 'string' ||
    typeof parsed.layout.cursorRulesDir !== 'string'
  ) {
    return null;
  }

  return {
    schemaVersion: DOCS_MANIFEST_SCHEMA_VERSION,
    updatedAt:
      typeof parsed.updatedAt === 'string' && parsed.updatedAt.length > 0
        ? parsed.updatedAt
        : new Date(0).toISOString(),
    targets: parsed.targets,
    layout: parsed.layout,
    managedFiles: normalizeManagedFiles(parsed.managedFiles),
  };
}

export async function writeDocsManifest(
  projectRoot: string,
  manifest: Omit<DocsManifest, 'schemaVersion' | 'updatedAt'> & { updatedAt?: string },
): Promise<void> {
  const payload: DocsManifest = {
    schemaVersion: DOCS_MANIFEST_SCHEMA_VERSION,
    updatedAt: manifest.updatedAt ?? new Date().toISOString(),
    targets: manifest.targets,
    layout: manifest.layout,
    managedFiles: normalizeManagedFiles(manifest.managedFiles),
  };
  await writeFileSafe(resolveDocsManifestPath(projectRoot), JSON.stringify(payload, null, 2));
}

export function buildManagedFilesManifest(
  targets: Target[],
  layout: OutputLayout,
  options?: { includeCanonicalForCursorOnly?: boolean },
): string[] {
  return normalizeManagedFiles(buildManagedFilesForTargets(targets, layout, options));
}
