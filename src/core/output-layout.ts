import path from 'node:path';
import type { ProjectConfig, Target } from '../types/index.js';
import { getRequiredDetailedDocs } from './docs-contract.js';

const DEFAULT_CANONICAL_DOCS_DIR = '.claude/docs';
const DEFAULT_CURSOR_RULES_DIR = '.cursor/rules';

function toPosixRelative(input: string): string {
  const normalized = input.replace(/\\/g, '/').trim();
  if (!normalized) return '';
  const withoutLeadingDot = normalized.replace(/^\.\//, '');
  const withoutTrailingSlash = withoutLeadingDot.replace(/\/+$/, '');
  if (!withoutTrailingSlash) return '';
  return withoutTrailingSlash;
}

function normalizeDocsDir(input: string | undefined): string {
  const normalized = toPosixRelative(input ?? '');
  if (!normalized) return DEFAULT_CANONICAL_DOCS_DIR;
  if (path.isAbsolute(normalized)) return DEFAULT_CANONICAL_DOCS_DIR;
  return normalized;
}

export interface OutputLayout {
  canonicalDocsDir: string;
  cursorRulesDir: string;
}

export function resolveOutputLayout(config?: Partial<ProjectConfig>): OutputLayout {
  return {
    canonicalDocsDir: normalizeDocsDir(config?.docsDir),
    cursorRulesDir: DEFAULT_CURSOR_RULES_DIR,
  };
}

export function getRootOutputPath(target: Target, layout: OutputLayout): string {
  switch (target) {
    case 'claude':
      return 'CLAUDE.md';
    case 'codex':
      return 'AGENTS.md';
    case 'cursor':
      return `${layout.cursorRulesDir}/project.mdc`;
  }
}

export function getDetailedOutputDir(target: Target, layout: OutputLayout): string {
  return target === 'cursor' ? layout.cursorRulesDir : layout.canonicalDocsDir;
}

function pushUnique(target: string[], seen: Set<string>, relativePath: string): void {
  const normalized = toPosixRelative(relativePath);
  if (!normalized || seen.has(normalized)) return;
  seen.add(normalized);
  target.push(normalized);
}

export function buildManagedFilesForTargets(
  targets: Target[],
  layout: OutputLayout,
  options?: { includeCanonicalForCursorOnly?: boolean },
): string[] {
  const includeCanonicalForCursorOnly = options?.includeCanonicalForCursorOnly ?? false;
  const includeCanonicalDocs =
    targets.includes('claude') ||
    targets.includes('codex') ||
    (includeCanonicalForCursorOnly && targets.length === 1 && targets[0] === 'cursor');

  const files: string[] = [];
  const seen = new Set<string>();

  for (const target of targets) {
    pushUnique(files, seen, getRootOutputPath(target, layout));
    const detailsDir = getDetailedOutputDir(target, layout);
    for (const filename of getRequiredDetailedDocs(target)) {
      pushUnique(files, seen, `${detailsDir}/${filename}`);
    }
  }

  if (includeCanonicalDocs) {
    for (const filename of getRequiredDetailedDocs('claude')) {
      pushUnique(files, seen, `${layout.canonicalDocsDir}/${filename}`);
    }
  }

  return files;
}

export function toAbsolutePath(projectRoot: string, relativePath: string): string {
  return path.join(projectRoot, relativePath);
}
