import type { LlmDocsConfigV2, TaskMeta, WorkspacePaths } from '../types.js';
import { updateTaskMeta } from './meta.js';
import { syncRegistryFromMeta } from './registry.js';

export async function archiveTask(
  paths: WorkspacePaths,
  taskId: string,
  reason: string,
): Promise<TaskMeta> {
  const archivedAt = new Date().toISOString();
  const meta = await updateTaskMeta(paths, taskId, (current) => ({
    ...current,
    status: 'archived',
    phase: 'archived',
    history: {
      archived: true,
      archived_at: archivedAt,
      archive_reason: reason,
    },
  }));

  await syncRegistryFromMeta(paths, meta, { linkBranches: false });
  return meta;
}

export async function maybeMoveBundleToArchive(
  _paths: WorkspacePaths,
  _taskId: string,
  _config: LlmDocsConfigV2,
): Promise<boolean> {
  return false;
}
