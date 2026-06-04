import path from 'node:path';
import YAML from 'yaml';
import { readFileSafe, writeYamlAtomic } from '../../utils/fs.js';
import { taskMetaSchema } from '../config/schema.js';
import { TaskMetaError } from '../errors.js';
import type { AdditionalDocRecord, TaskMeta, WorkspacePaths } from '../types.js';
import { resolveTaskMetaPath } from '../workspace/paths.js';
import {
  readTaskState,
  simpleStateToTaskMeta,
  taskHasSimpleState,
  taskMetaToSimpleState,
  writeTaskState,
} from './state.js';

function touchTaskMeta(meta: TaskMeta, timestamp: string): TaskMeta {
  return {
    ...meta,
    bundle: {
      ...meta.bundle,
      updated_at: timestamp,
    },
  };
}

function sortAdditionalDocs(additionalDocs: AdditionalDocRecord[]): AdditionalDocRecord[] {
  return [...additionalDocs].sort((left, right) => left.path.localeCompare(right.path));
}

export async function readTaskMeta(paths: WorkspacePaths, taskId: string): Promise<TaskMeta> {
  const metaPath = resolveTaskMetaPath(paths, taskId);
  const content = await readFileSafe(metaPath);

  if (content === null) {
    if (await taskHasSimpleState(paths, taskId)) {
      return simpleStateToTaskMeta(await readTaskState(paths, taskId));
    }

    throw new TaskMetaError(
      `Task metadata not found or invalid YAML: ${path.relative(paths.projectRoot, metaPath)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch (error) {
    throw new TaskMetaError(`Task metadata YAML parse failed for ${taskId}`, error);
  }

  const result = taskMetaSchema.safeParse(parsed);
  if (!result.success) {
    throw new TaskMetaError(`Task metadata schema validation failed for ${taskId}`, result.error);
  }

  if (result.data.task_id !== taskId) {
    throw new TaskMetaError(
      `Task metadata id mismatch: expected ${taskId}, got ${result.data.task_id}`,
    );
  }

  return result.data;
}

export async function writeTaskMeta(
  paths: WorkspacePaths,
  taskId: string,
  meta: TaskMeta,
): Promise<TaskMeta> {
  const metaPath = resolveTaskMetaPath(paths, taskId);
  if (!(await readFileSafe(metaPath)) && (await taskHasSimpleState(paths, taskId))) {
    const currentState = await readTaskState(paths, taskId);
    await writeTaskState(paths, taskId, {
      ...taskMetaToSimpleState(meta),
      qualityProfile: currentState.qualityProfile,
      checkpoint: currentState.checkpoint,
    });
    return meta;
  }

  const result = taskMetaSchema.safeParse(meta);

  if (!result.success) {
    throw new TaskMetaError(`Refusing to write invalid task metadata for ${taskId}`, result.error);
  }

  if (result.data.task_id !== taskId) {
    throw new TaskMetaError(
      `Task metadata id mismatch: expected ${taskId}, got ${result.data.task_id}`,
    );
  }

  await writeYamlAtomic(metaPath, result.data);
  return result.data;
}

export async function updateTaskMeta(
  paths: WorkspacePaths,
  taskId: string,
  updater: (meta: TaskMeta) => TaskMeta | Promise<TaskMeta>,
): Promise<TaskMeta> {
  const current = await readTaskMeta(paths, taskId);
  const timestamp = new Date().toISOString();
  const next = await updater(current);
  return writeTaskMeta(paths, taskId, touchTaskMeta(next, timestamp));
}

export async function registerAdditionalDoc(
  paths: WorkspacePaths,
  taskId: string,
  docEntry: AdditionalDocRecord,
): Promise<TaskMeta> {
  return updateTaskMeta(paths, taskId, (meta) => {
    const existing = meta.docs.additional.filter((entry) => entry.id !== docEntry.id);

    return {
      ...meta,
      docs: {
        ...meta.docs,
        additional: sortAdditionalDocs([...existing, docEntry]),
      },
    };
  });
}

export async function markDocsHistorical(
  paths: WorkspacePaths,
  taskId: string,
  docPaths: string[],
): Promise<TaskMeta> {
  const docPathSet = new Set(docPaths);

  return updateTaskMeta(paths, taskId, (meta) => ({
    ...meta,
    docs: {
      ...meta.docs,
      additional: meta.docs.additional.map((entry) =>
        docPathSet.has(entry.path)
          ? {
              ...entry,
              status: 'historical',
            }
          : entry,
      ),
    },
  }));
}

export async function setTaskStaleness(
  paths: WorkspacePaths,
  taskId: string,
  needsActualization: boolean,
  reasons: string[],
): Promise<TaskMeta> {
  return updateTaskMeta(paths, taskId, (meta) => ({
    ...meta,
    staleness: {
      needs_actualization: needsActualization,
      reasons: [...reasons],
      last_checked_at: new Date().toISOString(),
    },
  }));
}
