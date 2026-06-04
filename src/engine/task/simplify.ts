import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ensureDir,
  fileExists,
  normalizeRelativePath,
  readFileSafe,
  writeTextAtomic,
} from '../../utils/fs.js';
import type { TaskSimplifyInput, TaskSimplifyReport, WorkspacePaths } from '../types.js';
import { readTaskMeta } from './meta.js';
import { taskHasSimpleState, taskMetaToSimpleState, writeTaskState } from './state.js';

function fenceLegacyContent(title: string, content: string | null): string {
  if (!content?.trim()) {
    return '';
  }

  return `## Legacy ${title}

${content.trim()}

`;
}

function buildSimplifiedContext(args: {
  taskId: string;
  title: string;
  existingContext: string | null;
  taskSpec: string | null;
  raw: string | null;
  changelog: string | null;
}): string {
  const base =
    args.existingContext?.trim() ||
    `# ${args.taskId}: ${args.title}

## Goal
${args.title}

## Current State
- Migrated from a full llm-docs bundle.
`;

  const content = `${base}

## Migrated Full Bundle Notes
${fenceLegacyContent('Task Spec', args.taskSpec)}${fenceLegacyContent(
  'Raw Source',
  args.raw,
)}${fenceLegacyContent('Changelog', args.changelog)}
`;

  return `${content.trimEnd()}\n`;
}

async function moveIfExists(sourcePath: string, destinationPath: string): Promise<boolean> {
  if (!(await fileExists(sourcePath))) {
    return false;
  }

  await ensureDir(path.dirname(destinationPath));
  await fs.rename(sourcePath, destinationPath);
  return true;
}

export async function simplifyTaskBundle(
  paths: WorkspacePaths,
  input: TaskSimplifyInput,
): Promise<TaskSimplifyReport> {
  const taskId = input.taskId;
  const dryRun = input.dryRun ?? true;
  const bundlePath = path.join(paths.tasksDir, taskId);
  const alreadySimple = await taskHasSimpleState(paths, taskId);
  const meta = await readTaskMeta(paths, taskId);
  const contextPath = path.join(bundlePath, meta.docs.primary.context);
  const statePath = path.join(bundlePath, 'state.json');
  const legacyDir = path.join(
    bundlePath,
    '.legacy-full-bundle',
    new Date().toISOString().replace(/[:.]/g, '-'),
  );
  const legacyFiles = [
    meta.docs.primary.raw,
    meta.docs.primary.task,
    meta.docs.primary.changelog,
    'task.meta.yaml',
  ];
  const operations: TaskSimplifyReport['operations'] = [];

  if (alreadySimple && !(await fileExists(path.join(bundlePath, 'task.meta.yaml')))) {
    return {
      schemaVersion: 1,
      action: 'task-simplify',
      dryRun,
      taskId,
      sourceLayout: 'simple',
      targetLayout: 'simple',
      operations: [
        { op: 'skip', path: normalizeRelativePath(path.relative(paths.projectRoot, bundlePath)) },
      ],
      files: {
        context: normalizeRelativePath(path.relative(paths.projectRoot, contextPath)),
        state: normalizeRelativePath(path.relative(paths.projectRoot, statePath)),
        legacyDir: null,
      },
    };
  }

  const context = await readFileSafe(contextPath);
  const taskSpec = await readFileSafe(path.join(bundlePath, meta.docs.primary.task));
  const raw = await readFileSafe(path.join(bundlePath, meta.docs.primary.raw));
  const changelog = await readFileSafe(path.join(bundlePath, meta.docs.primary.changelog));
  const simplifiedContext = buildSimplifiedContext({
    taskId,
    title: meta.title,
    existingContext: context,
    taskSpec,
    raw,
    changelog,
  });

  operations.push({
    op: 'write-context',
    path: normalizeRelativePath(path.relative(paths.projectRoot, contextPath)),
  });
  operations.push({
    op: 'write-state',
    path: normalizeRelativePath(path.relative(paths.projectRoot, statePath)),
  });

  if (!input.keepLegacy) {
    for (const file of legacyFiles) {
      operations.push({
        op: 'move-legacy',
        path: normalizeRelativePath(path.relative(paths.projectRoot, path.join(legacyDir, file))),
      });
    }
  }

  if (!dryRun) {
    await writeTextAtomic(contextPath, simplifiedContext);
    await writeTaskState(paths, taskId, taskMetaToSimpleState(meta));

    if (!input.keepLegacy) {
      for (const file of legacyFiles) {
        await moveIfExists(path.join(bundlePath, file), path.join(legacyDir, file));
      }
    }
  }

  return {
    schemaVersion: 1,
    action: 'task-simplify',
    dryRun,
    taskId,
    sourceLayout: alreadySimple ? 'simple' : 'full',
    targetLayout: 'simple',
    operations,
    files: {
      context: normalizeRelativePath(path.relative(paths.projectRoot, contextPath)),
      state: normalizeRelativePath(path.relative(paths.projectRoot, statePath)),
      legacyDir: input.keepLegacy
        ? null
        : normalizeRelativePath(path.relative(paths.projectRoot, legacyDir)),
    },
  };
}
