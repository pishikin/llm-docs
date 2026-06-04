import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FactPackProjectFacts } from '../types/index.js';
import { fileExists, readFileSafe } from '../utils/fs.js';

const SOURCE_SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const IGNORED_SCAN_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.claude',
  '.cursor',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  'tmp',
  '.turbo',
]);

const MAX_SCAN_FILES = 420;
const MAX_SCAN_DEPTH = 8;

function toRelative(rootDir: string, fullPath: string): string {
  return path.relative(rootDir, fullPath).replace(/\\/g, '/');
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function normalizeRoutePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) return '';
  if (trimmed === '/') return '/';
  return trimmed.replace(/\/+$/, '');
}

async function collectFilesUnderDirs(
  rootDir: string,
  directories: string[],
  maxFiles = MAX_SCAN_FILES,
  maxDepth = MAX_SCAN_DEPTH,
): Promise<string[]> {
  const queue: Array<{ dir: string; depth: number }> = [];
  for (const dir of directories) {
    queue.push({ dir: path.join(rootDir, dir), depth: 0 });
  }

  const files: string[] = [];
  while (queue.length > 0 && files.length < maxFiles) {
    const current = queue.shift();
    if (!current) break;

    let entries: Dirent[];
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) break;

      const fullPath = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth >= maxDepth || IGNORED_SCAN_DIRS.has(entry.name)) {
          continue;
        }
        queue.push({ dir: fullPath, depth: current.depth + 1 });
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (SOURCE_SCAN_EXTENSIONS.has(ext)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function extractRoutePaths(content: string): string[] {
  const routes = new Set<string>();
  const objectPathPattern = /\bpath\s*:\s*['"`]([^'"`]+)['"`]/g;
  const jsxRoutePattern = /<Route[^>]*\bpath\s*=\s*(?:\{)?['"`]([^'"`]+)['"`](?:\})?/g;

  for (const match of content.matchAll(objectPathPattern)) {
    const routePath = normalizeRoutePath(match[1] ?? '');
    if (routePath) routes.add(routePath);
  }

  for (const match of content.matchAll(jsxRoutePattern)) {
    const routePath = normalizeRoutePath(match[1] ?? '');
    if (routePath) routes.add(routePath);
  }

  return Array.from(routes);
}

function extractAuthEndpoints(content: string): string[] {
  const endpoints = new Set<string>();
  const quotedPathRegex = /['"`](\/[a-zA-Z0-9/_:-]+)['"`]/g;
  const inlinePathRegex = /\/auth\/[a-zA-Z0-9/_:-]+/g;

  for (const match of content.matchAll(quotedPathRegex)) {
    const endpoint = (match[1] ?? '').trim().replace(/\/+$/, '').toLowerCase();
    if (endpoint.startsWith('/auth/')) {
      endpoints.add(endpoint);
    }
  }

  for (const match of content.matchAll(inlinePathRegex)) {
    const endpoint = (match[0] ?? '').trim().replace(/\/+$/, '').toLowerCase();
    if (endpoint.startsWith('/auth/')) {
      endpoints.add(endpoint);
    }
  }

  return Array.from(endpoints);
}

function extractAuthApiFunctions(content: string): string[] {
  const names = new Set<string>();
  const exportFunctionPattern = /\bexport\s+(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
  const exportConstPattern = /\bexport\s+const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g;

  for (const match of content.matchAll(exportFunctionPattern)) {
    const name = (match[1] ?? '').trim();
    if (name) names.add(name);
  }

  for (const match of content.matchAll(exportConstPattern)) {
    const name = (match[1] ?? '').trim();
    if (name) names.add(name);
  }

  return Array.from(names);
}

function hasAnyTypeUsage(content: string): boolean {
  const patterns = [
    /:\s*any\b/,
    /\bas\s+any\b/,
    /\bArray<\s*any\s*>/,
    /\bRecord<[^>]+,\s*any\s*>/,
    /\bany\[\]/,
    /<\s*any\s*>/,
  ];
  return patterns.some((pattern) => pattern.test(content));
}

function hasTokenStorageWrite(content: string): boolean {
  const tokenWriteRegex = /localStorage\.setItem\(\s*['"`][^'"`]*token[^'"`]*['"`]/i;
  return tokenWriteRegex.test(content);
}

async function detectNoExplicitAnyRuleConfigured(rootDir: string): Promise<boolean> {
  const candidates = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs'];
  const explicitRulePattern =
    /@typescript-eslint\/no-explicit-any['"]?\s*:\s*(?:\[[^\]]*['"](error|warn)['"][^\]]*\]|['"](error|warn)['"])/s;
  const explicitOffPattern =
    /@typescript-eslint\/no-explicit-any['"]?\s*:\s*(?:\[[^\]]*['"]off['"][^\]]*\]|['"]off['"])/s;

  for (const fileName of candidates) {
    const fullPath = path.join(rootDir, fileName);
    if (!(await fileExists(fullPath))) continue;
    const content = await readFileSafe(fullPath);
    if (!content) continue;

    if (explicitOffPattern.test(content)) {
      return false;
    }
    if (explicitRulePattern.test(content)) {
      return true;
    }
  }

  return false;
}

export async function collectProjectFacts(
  rootDir: string,
  packageJson: Record<string, unknown> | null,
): Promise<FactPackProjectFacts> {
  const sourceFiles = await collectFilesUnderDirs(rootDir, ['src', 'app', 'packages', 'apps']);
  const apiFiles = await collectFilesUnderDirs(rootDir, ['src/api', 'api']);
  const mockFiles = await collectFilesUnderDirs(rootDir, ['src/mocks', 'mocks']);

  const routePaths: string[] = [];
  const authApiFunctions: string[] = [];
  const authApiEndpoints: string[] = [];
  const mockAuthEndpoints: string[] = [];
  const tokenStorageWriteFiles: string[] = [];
  const anyTypeUsageFiles: string[] = [];

  const routeCandidates = sourceFiles.filter((filePath) => {
    const normalized = toRelative(rootDir, filePath).toLowerCase();
    const baseName = path.basename(normalized);
    return (
      baseName.startsWith('route') ||
      baseName.startsWith('routes') ||
      baseName.startsWith('router') ||
      baseName.startsWith('app.')
    );
  });

  for (const filePath of routeCandidates) {
    const content = await readFileSafe(filePath);
    if (!content) continue;
    routePaths.push(...extractRoutePaths(content));
  }

  const authApiFiles = apiFiles.filter((filePath) => /(^|\/)auth\./i.test(filePath));
  for (const filePath of authApiFiles) {
    const content = await readFileSafe(filePath);
    if (!content) continue;
    authApiFunctions.push(...extractAuthApiFunctions(content));
    authApiEndpoints.push(...extractAuthEndpoints(content));
  }

  for (const filePath of mockFiles) {
    const content = await readFileSafe(filePath);
    if (!content) continue;
    mockAuthEndpoints.push(...extractAuthEndpoints(content));
  }

  for (const filePath of sourceFiles) {
    const content = await readFileSafe(filePath);
    if (!content) continue;

    if (hasTokenStorageWrite(content)) {
      tokenStorageWriteFiles.push(toRelative(rootDir, filePath));
    }
    if (hasAnyTypeUsage(content)) {
      anyTypeUsageFiles.push(toRelative(rootDir, filePath));
    }
  }

  const dependencies = (packageJson?.dependencies as Record<string, string>) ?? {};
  const devDependencies = (packageJson?.devDependencies as Record<string, string>) ?? {};
  const scripts = (packageJson?.scripts as Record<string, string>) ?? {};

  const hasJsonServerDependency =
    typeof dependencies['json-server'] === 'string' ||
    typeof devDependencies['json-server'] === 'string';
  const jsonServerScriptNames = Object.entries(scripts)
    .filter(([, command]) => typeof command === 'string' && command.includes('json-server'))
    .map(([name]) => name)
    .slice(0, 8);
  const eslintNoExplicitAnyRuleConfigured = await detectNoExplicitAnyRuleConfigured(rootDir);

  return {
    routePaths: uniqueSorted(routePaths).slice(0, 40),
    authApiFunctions: uniqueSorted(authApiFunctions).slice(0, 40),
    authApiEndpoints: uniqueSorted(authApiEndpoints).slice(0, 40),
    mockAuthEndpoints: uniqueSorted(mockAuthEndpoints).slice(0, 40),
    tokenStorageWriteFiles: uniqueSorted(tokenStorageWriteFiles).slice(0, 20),
    anyTypeUsageFiles: uniqueSorted(anyTypeUsageFiles).slice(0, 20),
    hasJsonServerDependency,
    jsonServerScriptNames: uniqueSorted(jsonServerScriptNames),
    eslintNoExplicitAnyRuleConfigured,
  };
}
