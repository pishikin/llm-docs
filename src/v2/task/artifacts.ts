import path from 'node:path';
import {
  copyFileSafe,
  fileExists,
  readFileSafe,
  tryHardlinkOrCopy,
  trySymlinkOrCopy,
} from '../../utils/fs.js';
import { artifactIndexSchema } from '../config/schema.js';
import { ArtifactAttachError } from '../errors.js';
import type {
  ArtifactIndex,
  ArtifactRecord,
  AttachArtifactInput,
  AttachArtifactResult,
  LlmDocsConfigV2,
  WorkspacePaths,
} from '../types.js';
import { updateTaskMeta } from './meta.js';
import { readTaskMeta } from './meta.js';

function createEmptyArtifactIndex(updatedAt: string): ArtifactIndex {
  return {
    schemaVersion: 1,
    updatedAt,
    artifacts: [],
  };
}

function normalizeFilename(fileName: string): string {
  return fileName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-');
}

function resolveUniqueFilename(existingFiles: Set<string>, requestedName: string): string {
  const parsed = path.parse(requestedName);
  let attempt = 0;
  let next = requestedName;

  while (existingFiles.has(next)) {
    attempt += 1;
    next = `${parsed.name}-${String(attempt).padStart(2, '0')}${parsed.ext}`;
  }

  return next;
}

export async function readArtifactIndex(
  paths: WorkspacePaths,
  taskId: string,
): Promise<ArtifactIndex> {
  const meta = await readTaskMeta(paths, taskId);
  const indexPath = path.join(paths.tasksDir, taskId, meta.artifacts.index_path);
  const content = await readFileSafe(indexPath);

  if (content === null) {
    return createEmptyArtifactIndex(new Date().toISOString());
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new ArtifactAttachError(`Artifact index JSON parse failed for ${taskId}`, error);
  }

  return artifactIndexSchema.parse(parsed);
}

export async function writeArtifactIndex(
  paths: WorkspacePaths,
  taskId: string,
  index: ArtifactIndex,
): Promise<ArtifactIndex> {
  const meta = await readTaskMeta(paths, taskId);
  const indexPath = path.join(paths.tasksDir, taskId, meta.artifacts.index_path);
  const normalized = artifactIndexSchema.parse(index);
  const { writeJsonAtomic } = await import('../../utils/fs.js');
  await writeJsonAtomic(indexPath, normalized);
  return normalized;
}

export function allocateArtifactId(index: ArtifactIndex): string {
  const maxValue = index.artifacts.reduce((max, artifact) => {
    const value = Number.parseInt(artifact.id.replace(/^art-/, ''), 10);
    return Number.isFinite(value) ? Math.max(max, value) : max;
  }, 0);

  return `art-${String(maxValue + 1).padStart(4, '0')}`;
}

export async function attachArtifact(
  _projectRoot: string,
  config: LlmDocsConfigV2,
  paths: WorkspacePaths,
  taskId: string,
  input: AttachArtifactInput,
): Promise<AttachArtifactResult> {
  if (!(await fileExists(input.sourcePath))) {
    throw new ArtifactAttachError(`Artifact source does not exist: ${input.sourcePath}`);
  }

  const meta = await readTaskMeta(paths, taskId);
  const artifactDir = path.join(paths.tasksDir, taskId, 'artifacts');
  const index = await readArtifactIndex(paths, taskId);
  const requestedName = normalizeFilename(
    input.filename?.trim() || path.basename(input.sourcePath),
  );
  const fileName = resolveUniqueFilename(
    new Set(index.artifacts.map((artifact) => artifact.filename)),
    requestedName,
  );
  const destinationPath = path.join(artifactDir, fileName);
  const relativePath = `artifacts/${fileName}`;
  const desiredStorageMode = input.storageMode ?? config.taskBundles.artifactStorageMode;
  let actualStorageMode = desiredStorageMode;
  let warning: string | undefined;

  if (desiredStorageMode === 'copy') {
    await copyFileSafe(input.sourcePath, destinationPath);
  } else if (desiredStorageMode === 'hardlink') {
    actualStorageMode = await tryHardlinkOrCopy(input.sourcePath, destinationPath);
    if (actualStorageMode !== desiredStorageMode) {
      warning = 'Hardlink unsupported, fell back to copy.';
    }
  } else {
    actualStorageMode = await trySymlinkOrCopy(input.sourcePath, destinationPath);
    if (actualStorageMode !== desiredStorageMode) {
      warning = 'Symlink unsupported, fell back to copy.';
    }
  }

  const attachedAt = new Date().toISOString();
  const record: ArtifactRecord = {
    id: allocateArtifactId(index),
    filename: fileName,
    relativePath,
    kind: input.kind,
    sourcePath: input.sourcePath,
    storageMode: actualStorageMode,
    attachedAt,
    summary: input.summary ?? null,
    tags: [...new Set((input.tags ?? []).map((tag) => tag.toLowerCase()))],
  };

  await writeArtifactIndex(paths, taskId, {
    schemaVersion: 1,
    updatedAt: attachedAt,
    artifacts: [...index.artifacts, record],
  });

  await updateTaskMeta(paths, taskId, (current) => ({
    ...current,
    artifacts: {
      ...current.artifacts,
      count: current.artifacts.count + 1,
    },
  }));

  return {
    taskId,
    artifactId: record.id,
    relativePath,
    storageMode: actualStorageMode,
    ...(warning ? { warning } : {}),
  };
}
