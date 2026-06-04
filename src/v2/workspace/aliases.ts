import path from 'node:path';
import { fileExists, normalizeRelativePath } from '../../utils/fs.js';
import type { WorkspaceLegacyAliasHit, WorkspacePaths } from '../types.js';

function relativeFromWorkspace(paths: WorkspacePaths, relativePath: string): string {
  return normalizeRelativePath(path.relative(paths.workspaceRoot, relativePath));
}

export function resolveArchiveDirCandidates(paths: WorkspacePaths): string[] {
  return [paths.archiveDir, path.join(path.dirname(paths.archiveDir), 'archieve')];
}

export function resolvePromptsDirCandidates(paths: WorkspacePaths): string[] {
  return [paths.promptsDir, path.join(path.dirname(paths.promptsDir), 'promts')];
}

export async function findExistingLegacyAlias(
  paths: WorkspacePaths,
): Promise<WorkspaceLegacyAliasHit[]> {
  const hits: WorkspaceLegacyAliasHit[] = [];

  const archiveAlias = resolveArchiveDirCandidates(paths)[1];
  if (await fileExists(archiveAlias)) {
    hits.push({
      kind: 'archive',
      canonicalPath: relativeFromWorkspace(paths, paths.archiveDir),
      aliasPath: relativeFromWorkspace(paths, archiveAlias),
    });
  }

  const promptsAlias = resolvePromptsDirCandidates(paths)[1];
  if (await fileExists(promptsAlias)) {
    hits.push({
      kind: 'prompts',
      canonicalPath: relativeFromWorkspace(paths, paths.promptsDir),
      aliasPath: relativeFromWorkspace(paths, promptsAlias),
    });
  }

  return hits;
}
