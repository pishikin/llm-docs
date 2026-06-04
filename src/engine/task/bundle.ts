import path from 'node:path';
import { simpleGit } from 'simple-git';
import {
  ensureDir,
  fileExists,
  normalizeRelativePath,
  readFileSafe,
  writeJsonAtomic,
  writeTextAtomic,
} from '../../utils/fs.js';
import { artifactIndexSchema } from '../config/schema.js';
import { TaskBundleError } from '../errors.js';
import { renderAdditionalDocTemplate } from '../templates/additional-doc.js';
import {
  renderChangelogEpochBlock,
  renderInitialChangelogTemplate,
} from '../templates/changelog.js';
import { renderContextTemplate } from '../templates/context.js';
import { renderRawTemplate } from '../templates/raw.js';
import { renderSimpleContextTemplate } from '../templates/simple-context.js';
import { renderTaskTemplate } from '../templates/task.js';
import type {
  AdditionalDocType,
  ArtifactIndex,
  LlmDocsConfig,
  TaskBundleCreateInput,
  TaskBundleCreateResult,
  TaskBundleSnapshot,
  TaskMeta,
  WorkspacePaths,
} from '../types.js';
import {
  resolveTaskAdditionalDocsDir,
  resolveTaskArtifactsDir,
  resolveTaskBundlePath,
  resolveTaskMetaPath,
} from '../workspace/paths.js';
import { shouldAutoLinkBranch } from './branches.js';
import { deriveTaskId } from './id.js';
import { readTaskMeta, registerAdditionalDoc, writeTaskMeta } from './meta.js';
import {
  buildRegistryEntryFromMeta,
  linkBranchToTask,
  readTaskRegistry,
  setActiveTask,
  upsertRegistryEntry,
} from './registry.js';
import {
  buildInitialSimpleTaskState,
  resolveTaskContextPath,
  resolveTaskStatePath,
  simpleStateToTaskMeta,
  taskHasSimpleState,
  writeTaskState,
} from './state.js';

function normalizeStringList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => normalizeRelativePath(value)).filter(Boolean))];
}

async function getCurrentBranch(projectRoot: string): Promise<string | null> {
  try {
    const git = simpleGit(projectRoot);
    const branch = await git.revparse(['--abbrev-ref', 'HEAD']);
    const trimmed = branch.trim();
    return trimmed === 'HEAD' ? null : trimmed;
  } catch {
    return null;
  }
}

async function getHeadCommit(projectRoot: string): Promise<string | null> {
  try {
    const git = simpleGit(projectRoot);
    const head = await git.revparse(['HEAD']);
    return head.trim() || null;
  } catch {
    return null;
  }
}

function createEmptyArtifactIndex(updatedAt: string): ArtifactIndex {
  return {
    schemaVersion: 1,
    updatedAt,
    artifacts: [],
  };
}

async function readArtifactIndexFile(
  bundlePath: string,
  relativePath: string,
): Promise<ArtifactIndex> {
  const artifactIndexPath = path.join(bundlePath, relativePath);
  const content = await readFileSafe(artifactIndexPath);

  if (content === null) {
    return createEmptyArtifactIndex(new Date().toISOString());
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new TaskBundleError(`Artifact index JSON parse failed: ${artifactIndexPath}`, error);
  }

  return artifactIndexSchema.parse(parsed);
}

function buildInitialTaskMeta(args: {
  projectRoot: string;
  paths: WorkspacePaths;
  taskId: string;
  input: TaskBundleCreateInput;
  now: string;
  branch: string | null;
  baseBranch: string;
  head: string | null;
}): TaskMeta {
  const bundlePath = normalizeRelativePath(
    path.relative(args.projectRoot, resolveTaskBundlePath(args.paths, args.taskId)),
  );
  const tags = normalizeStringList(args.input.tags).map((tag) => tag.toLowerCase());

  return {
    schema_version: 1,
    task_id: args.taskId,
    title: args.input.title,
    status: 'active',
    phase: 'implementation',
    source: {
      type: args.input.source.type,
      ref: args.input.source.ref,
      url: args.input.source.url,
    },
    bundle: {
      path: bundlePath,
      created_at: args.now,
      updated_at: args.now,
      created_by: 'llm-docs',
      version: 1,
    },
    branch: {
      current: args.branch,
      base: args.baseBranch,
      linked_branches: args.branch ? [args.branch] : [],
      last_verified_commit: args.head,
      last_actualized_commit: args.head,
    },
    truth: {
      source_of_truth_paths: [],
      source_of_truth_docs: ['task.md', 'context.md'],
      current_truth_note: args.branch
        ? 'Implementation branch is current truth until merge.'
        : null,
    },
    staleness: {
      needs_actualization: false,
      reasons: [],
      last_checked_at: args.now,
    },
    related: {
      docs: normalizeStringList(args.input.relatedDocs),
      tasks: [],
      tags,
    },
    docs: {
      primary: {
        raw: 'raw.md',
        task: 'task.md',
        context: 'context.md',
        changelog: 'changelog.md',
      },
      additional: [],
    },
    artifacts: {
      index_path: 'artifacts/index.json',
      count: 0,
    },
    history: {
      archived: false,
      archived_at: null,
      archive_reason: null,
    },
  };
}

async function writePrimaryDocs(
  paths: WorkspacePaths,
  taskId: string,
  input: TaskBundleCreateInput,
  meta: TaskMeta,
): Promise<void> {
  const bundlePath = resolveTaskBundlePath(paths, taskId);
  const rawPath = path.join(bundlePath, meta.docs.primary.raw);
  const taskPath = path.join(bundlePath, meta.docs.primary.task);
  const contextPath = path.join(bundlePath, meta.docs.primary.context);
  const changelogPath = path.join(bundlePath, meta.docs.primary.changelog);

  await writeTextAtomic(rawPath, renderRawTemplate(input.source, input.title));
  await writeTextAtomic(taskPath, renderTaskTemplate(taskId, input.title, meta.related.docs));
  await writeTextAtomic(
    contextPath,
    renderContextTemplate(taskId, input, {
      branch: meta.branch.current,
      baseBranch: meta.branch.base,
      head: meta.branch.last_verified_commit,
      lastVerifiedCommit: meta.branch.last_verified_commit,
    }),
  );
  await writeTextAtomic(
    changelogPath,
    renderInitialChangelogTemplate(taskId, {
      label: 'bundle-created',
      summary: ['Initial task bundle created.'],
      structuredState: {
        phase: meta.phase,
        status: meta.status,
        branch: meta.branch.current,
      },
      nextSteps: ['Normalize task spec.', 'Build initial context.'],
      timestamp: meta.bundle.created_at,
    }),
  );
}

function buildCreateResult(
  paths: WorkspacePaths,
  taskId: string,
  meta: TaskMeta,
  created: boolean,
  layout: 'full' | 'simple' = 'full',
): TaskBundleCreateResult {
  const bundlePath = resolveTaskBundlePath(paths, taskId);
  const files =
    layout === 'simple'
      ? {
          raw: normalizeRelativePath(
            path.relative(paths.projectRoot, path.join(bundlePath, meta.docs.primary.raw)),
          ),
          context: normalizeRelativePath(
            path.relative(paths.projectRoot, resolveTaskContextPath(paths, taskId)),
          ),
          changelog: normalizeRelativePath(
            path.relative(paths.projectRoot, path.join(bundlePath, meta.docs.primary.changelog)),
          ),
          state: normalizeRelativePath(
            path.relative(paths.projectRoot, resolveTaskStatePath(paths, taskId)),
          ),
        }
      : {
          meta: normalizeRelativePath(
            path.relative(paths.projectRoot, resolveTaskMetaPath(paths, taskId)),
          ),
          raw: normalizeRelativePath(
            path.relative(paths.projectRoot, path.join(bundlePath, meta.docs.primary.raw)),
          ),
          task: normalizeRelativePath(
            path.relative(paths.projectRoot, path.join(bundlePath, meta.docs.primary.task)),
          ),
          context: normalizeRelativePath(
            path.relative(paths.projectRoot, path.join(bundlePath, meta.docs.primary.context)),
          ),
          changelog: normalizeRelativePath(
            path.relative(paths.projectRoot, path.join(bundlePath, meta.docs.primary.changelog)),
          ),
        };

  return {
    taskId,
    bundlePath: normalizeRelativePath(path.relative(paths.projectRoot, bundlePath)),
    created,
    files,
    initialContextFacts: {
      branch: meta.branch.current,
      baseBranch: meta.branch.base,
      head: meta.branch.last_verified_commit,
    },
  };
}

function resolveCreateLayout(config: LlmDocsConfig): 'simple' | 'full' {
  return config.taskBundles.layout === 'full' ? 'full' : 'simple';
}

function normalizeDocSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/[-_.]{2,}/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '');
}

export async function createTaskBundle(
  projectRoot: string,
  config: LlmDocsConfig,
  paths: WorkspacePaths,
  input: TaskBundleCreateInput,
): Promise<TaskBundleCreateResult> {
  const nowDate = input.now ?? new Date();
  const now = nowDate.toISOString();
  const taskId = deriveTaskId({
    taskId: input.taskId,
    title: input.title,
    sourceRef: input.source.ref,
    sourceType: input.source.type,
    now: nowDate,
  });
  const bundlePath = resolveTaskBundlePath(paths, taskId);
  const bundleExists = await fileExists(bundlePath);

  if (bundleExists) {
    if (!input.createIfExists) {
      throw new TaskBundleError(`Task bundle already exists for ${taskId}`);
    }

    const meta = await readTaskMeta(paths, taskId);
    return buildCreateResult(
      paths,
      taskId,
      meta,
      false,
      (await taskHasSimpleState(paths, taskId)) ? 'simple' : 'full',
    );
  }

  const branch = input.branch ?? (await getCurrentBranch(projectRoot));
  const baseBranch = input.baseBranch ?? config.taskBundles.defaultBaseBranch;
  const head = await getHeadCommit(projectRoot);
  const layout = resolveCreateLayout(config);

  if (layout === 'simple') {
    const state = buildInitialSimpleTaskState({
      projectRoot,
      paths,
      taskId,
      input,
      now,
      branch,
      baseBranch,
      head,
    });
    const meta = simpleStateToTaskMeta(state);

    await ensureDir(bundlePath);
    await ensureDir(resolveTaskArtifactsDir(paths, taskId));
    await writeTextAtomic(
      path.join(bundlePath, meta.docs.primary.raw),
      renderRawTemplate(input.source, input.title),
    );
    await writeTextAtomic(
      resolveTaskContextPath(paths, taskId),
      renderSimpleContextTemplate(taskId, input, { branch, baseBranch, head }),
    );
    await writeTextAtomic(
      path.join(bundlePath, meta.docs.primary.changelog),
      renderInitialChangelogTemplate(taskId, {
        label: 'bundle-created',
        summary: [
          'Initial task bundle created with source brief, plan, and implementation-note sections.',
        ],
        structuredState: {
          phase: meta.phase,
          status: meta.status,
          branch: meta.branch.current,
        },
        nextSteps: ['Fill the prepared plan.', 'Record the first implementation checkpoint.'],
        timestamp: meta.bundle.created_at,
      }),
    );
    await writeJsonAtomic(
      path.join(resolveTaskArtifactsDir(paths, taskId), 'index.json'),
      artifactIndexSchema.parse(createEmptyArtifactIndex(now)),
    );
    await writeTaskState(paths, taskId, state);
    await upsertRegistryEntry(paths, buildRegistryEntryFromMeta(meta));
    await setActiveTask(paths, taskId);

    if (shouldAutoLinkBranch(branch, config)) {
      await linkBranchToTask(paths, branch, taskId);
    }

    return buildCreateResult(paths, taskId, meta, true, 'simple');
  }

  const meta = buildInitialTaskMeta({
    projectRoot,
    paths,
    taskId,
    input,
    now,
    branch,
    baseBranch,
    head,
  });
  const artifactIndex = artifactIndexSchema.parse(createEmptyArtifactIndex(now));

  await ensureDir(bundlePath);
  await ensureDir(resolveTaskArtifactsDir(paths, taskId));
  await ensureDir(resolveTaskAdditionalDocsDir(paths, taskId));
  await writePrimaryDocs(paths, taskId, input, meta);
  await writeTaskMeta(paths, taskId, meta);
  await writeJsonAtomic(
    path.join(resolveTaskArtifactsDir(paths, taskId), 'index.json'),
    artifactIndex,
  );

  await upsertRegistryEntry(paths, {
    taskId,
    title: meta.title,
    status: meta.status,
    phase: meta.phase,
    bundlePath: meta.bundle.path,
    sourceType: meta.source.type,
    sourceRef: meta.source.ref,
    currentBranch: meta.branch.current,
    linkedBranches: meta.branch.linked_branches,
    lastVerifiedCommit: meta.branch.last_verified_commit,
    lastActualizedCommit: meta.branch.last_actualized_commit,
    needsActualization: meta.staleness.needs_actualization,
    archived: meta.history.archived,
    updatedAt: now,
  });
  await setActiveTask(paths, taskId);

  if (shouldAutoLinkBranch(branch, config)) {
    await linkBranchToTask(paths, branch, taskId);
  }

  return buildCreateResult(paths, taskId, meta, true, 'full');
}

export async function loadTaskBundle(
  paths: WorkspacePaths,
  taskId: string,
  options: {
    includeContents?: boolean;
    includeArtifacts?: boolean;
  } = {},
): Promise<TaskBundleSnapshot> {
  const meta = await readTaskMeta(paths, taskId);
  const registry = await readTaskRegistry(paths);
  const bundlePath = resolveTaskBundlePath(paths, taskId);
  const primaryDocs = options.includeContents
    ? {
        meta: (await readFileSafe(resolveTaskMetaPath(paths, taskId))) ?? '',
        state: (await readFileSafe(resolveTaskStatePath(paths, taskId))) ?? '',
        raw: (await readFileSafe(path.join(bundlePath, meta.docs.primary.raw))) ?? '',
        task: (await readFileSafe(path.join(bundlePath, meta.docs.primary.task))) ?? '',
        context: (await readFileSafe(path.join(bundlePath, meta.docs.primary.context))) ?? '',
        changelog: (await readFileSafe(path.join(bundlePath, meta.docs.primary.changelog))) ?? '',
      }
    : {};

  const artifactIndex = options.includeArtifacts
    ? await readArtifactIndexFile(bundlePath, meta.artifacts.index_path)
    : null;

  return {
    taskId,
    bundlePath: normalizeRelativePath(path.relative(paths.projectRoot, bundlePath)),
    meta,
    registryEntry: registry.tasks[taskId] ?? null,
    primaryDocs,
    additionalDocs: meta.docs.additional,
    artifactIndex,
  };
}

export async function ensurePrimaryDocs(paths: WorkspacePaths, taskId: string): Promise<void> {
  const meta = await readTaskMeta(paths, taskId);
  const bundlePath = resolveTaskBundlePath(paths, taskId);

  if (await taskHasSimpleState(paths, taskId)) {
    const files = [
      {
        relativePath: meta.docs.primary.raw,
        content: renderRawTemplate(
          { type: meta.source.type, ref: meta.source.ref, url: meta.source.url, rawText: null },
          meta.title,
        ),
      },
      {
        relativePath: meta.docs.primary.context,
        content: renderSimpleContextTemplate(
          taskId,
          {
            title: meta.title,
            source: { ...meta.source, rawText: null },
          },
          {
            branch: meta.branch.current,
            baseBranch: meta.branch.base,
            head: meta.branch.last_verified_commit,
          },
        ),
      },
      {
        relativePath: meta.docs.primary.changelog,
        content: renderInitialChangelogTemplate(taskId, {
          label: 'bundle-created',
          summary: [
            'Initial task bundle created with source brief, plan, and implementation-note sections.',
          ],
          structuredState: {
            phase: meta.phase,
            status: meta.status,
            branch: meta.branch.current,
          },
          nextSteps: ['Fill the prepared plan.', 'Record the first implementation checkpoint.'],
          timestamp: meta.bundle.created_at,
        }),
      },
    ];

    for (const file of files) {
      const targetPath = path.join(bundlePath, file.relativePath);
      if (!(await fileExists(targetPath))) {
        await writeTextAtomic(targetPath, file.content);
      }
    }

    await ensureDir(resolveTaskArtifactsDir(paths, taskId));
    const artifactIndexPath = path.join(resolveTaskArtifactsDir(paths, taskId), 'index.json');
    if (!(await fileExists(artifactIndexPath))) {
      await writeJsonAtomic(artifactIndexPath, createEmptyArtifactIndex(new Date().toISOString()));
    }

    return;
  }

  const files = [
    {
      relativePath: meta.docs.primary.raw,
      content: renderRawTemplate(
        { type: meta.source.type, ref: meta.source.ref, url: meta.source.url, rawText: null },
        meta.title,
      ),
    },
    {
      relativePath: meta.docs.primary.task,
      content: renderTaskTemplate(taskId, meta.title, meta.related.docs),
    },
    {
      relativePath: meta.docs.primary.context,
      content: renderContextTemplate(
        taskId,
        {
          title: meta.title,
          source: { ...meta.source, rawText: null },
        },
        {
          branch: meta.branch.current,
          baseBranch: meta.branch.base,
          head: meta.branch.last_verified_commit,
          lastVerifiedCommit: meta.branch.last_verified_commit,
        },
      ),
    },
    {
      relativePath: meta.docs.primary.changelog,
      content: `# Changelog — ${taskId}\n\n${renderChangelogEpochBlock({
        label: 'bundle-created',
        summary: ['Initial task bundle created.'],
        structuredState: {
          phase: meta.phase,
          status: meta.status,
          branch: meta.branch.current,
        },
        nextSteps: ['Normalize task spec.', 'Build initial context.'],
        timestamp: meta.bundle.created_at,
      })}\n`,
    },
  ];

  for (const file of files) {
    const targetPath = path.join(bundlePath, file.relativePath);
    if (!(await fileExists(targetPath))) {
      await writeTextAtomic(targetPath, file.content);
    }
  }
}

export async function createAdditionalDoc(
  paths: WorkspacePaths,
  taskId: string,
  docType: AdditionalDocType,
  slug: string,
  title: string,
  phase: TaskMeta['phase'],
): Promise<{ id: string; path: string }> {
  const normalizedSlug = normalizeDocSlug(slug);
  if (!normalizedSlug) {
    throw new TaskBundleError('Additional doc slug cannot be empty');
  }

  const meta = await readTaskMeta(paths, taskId);
  const docsDir = resolveTaskAdditionalDocsDir(paths, taskId);
  const relativePath = `docs/${docType}--${normalizedSlug}.md`;
  const absolutePath = path.join(resolveTaskBundlePath(paths, taskId), relativePath);
  const timestamp = new Date().toISOString();
  const entryId = `${normalizedSlug}-${docType}`;

  await ensureDir(docsDir);
  if (!(await fileExists(absolutePath))) {
    await writeTextAtomic(
      absolutePath,
      renderAdditionalDocTemplate({ taskId, title, description: `Doc type: ${docType}` }),
    );
  }

  await registerAdditionalDoc(paths, taskId, {
    id: entryId,
    path: relativePath,
    doc_type: docType,
    phase,
    status: 'active',
    title,
    created_at: meta.docs.additional.find((entry) => entry.id === entryId)?.created_at ?? timestamp,
    updated_at: timestamp,
  });

  return {
    id: entryId,
    path: relativePath,
  };
}
