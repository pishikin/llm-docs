import fs from 'node:fs/promises';
import path from 'node:path';
import { fileExists, normalizeRelativePath, readFileSafe } from '../../utils/fs.js';
import type { DiscoveredDoc, WorkspacePaths } from '../types.js';

async function walkFiles(root: string): Promise<string[]> {
  if (!(await fileExists(root))) {
    return [];
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return walkFiles(entryPath);
      }

      return [entryPath];
    }),
  );

  return files.flat();
}

async function readTitle(filePath: string): Promise<string | null> {
  const content = await readFileSafe(filePath);
  if (!content) {
    return null;
  }

  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

async function mapDocs(
  projectRoot: string,
  files: string[],
  category: DiscoveredDoc['category'],
): Promise<DiscoveredDoc[]> {
  const candidates = files.filter((file) => /\.(md|mdc)$/i.test(file));
  return Promise.all(
    candidates.map(async (file) => ({
      path: normalizeRelativePath(path.relative(projectRoot, file)),
      category,
      title: await readTitle(file),
    })),
  );
}

export async function findCanonicalDocs(
  projectRoot: string,
  paths: WorkspacePaths,
): Promise<DiscoveredDoc[]> {
  const allDocs = await walkFiles(paths.docsDir);
  const excludedRoots = [paths.archiveDir, paths.researchDir, paths.promptsDir].map((dir) =>
    normalizeRelativePath(path.relative(projectRoot, dir)),
  );

  return mapDocs(
    projectRoot,
    allDocs.filter((file) => {
      const relative = normalizeRelativePath(path.relative(projectRoot, file));
      return !excludedRoots.some(
        (excludedRoot) => relative === excludedRoot || relative.startsWith(`${excludedRoot}/`),
      );
    }),
    'canonical',
  );
}

export async function findResearchDocs(
  projectRoot: string,
  paths: WorkspacePaths,
): Promise<DiscoveredDoc[]> {
  return mapDocs(projectRoot, await walkFiles(paths.researchDir), 'research');
}

export async function findArchiveDocs(
  projectRoot: string,
  paths: WorkspacePaths,
): Promise<DiscoveredDoc[]> {
  return mapDocs(projectRoot, await walkFiles(paths.archiveDir), 'archive');
}

export async function findRuleDocs(
  projectRoot: string,
  paths: WorkspacePaths,
): Promise<DiscoveredDoc[]> {
  const rootDocs = ['CLAUDE.md', 'AGENTS.md'].map((file) => path.join(projectRoot, file));
  const cursorRules = await walkFiles(paths.cursorRulesDir);
  const existingFiles = (
    await Promise.all(
      [...rootDocs, ...cursorRules].map(async (file) => ((await fileExists(file)) ? file : null)),
    )
  ).filter((value): value is string => value !== null);

  return mapDocs(projectRoot, existingFiles, 'rules');
}
