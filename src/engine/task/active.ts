import fs from 'node:fs/promises';
import path from 'node:path';
import {
  fileExists,
  normalizeRelativePath,
  readFileSafe,
  writeTextAtomic,
} from '../../utils/fs.js';
import type { WorkspacePaths } from '../types.js';
import { normalizeTaskId } from './id.js';

export const ACTIVE_TASK_FILE = 'ACTIVE';

export function resolveActiveTaskFilePath(paths: WorkspacePaths): string {
  return path.join(paths.tasksDir, ACTIVE_TASK_FILE);
}

export async function readActiveTaskFile(paths: WorkspacePaths): Promise<string | null> {
  const content = await readFileSafe(resolveActiveTaskFilePath(paths));
  const value = content?.trim();
  return value ? normalizeTaskId(value) : null;
}

export async function writeActiveTaskFile(
  paths: WorkspacePaths,
  taskId: string | null,
): Promise<void> {
  const filePath = resolveActiveTaskFilePath(paths);

  if (taskId === null) {
    if (await fileExists(filePath)) {
      await fs.rm(filePath, { force: true });
    }
    return;
  }

  await writeTextAtomic(filePath, `${normalizeTaskId(taskId)}\n`);
}

export function activeTaskFileRelativePath(paths: WorkspacePaths): string {
  return normalizeRelativePath(path.relative(paths.projectRoot, resolveActiveTaskFilePath(paths)));
}
