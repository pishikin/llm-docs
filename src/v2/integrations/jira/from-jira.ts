import path from 'node:path';
import {
  copyFileSafe,
  ensureDir,
  normalizeRelativePath,
  writeTextAtomic,
} from '../../../utils/fs.js';
import { readArtifactIndex, writeArtifactIndex } from '../../task/artifacts.js';
import { createTaskBundle } from '../../task/bundle.js';
import { updateTaskMeta } from '../../task/meta.js';
import type {
  ArtifactIndex,
  ArtifactKind,
  ArtifactRecord,
  LlmDocsConfigV2,
  WorkspacePaths,
} from '../../types.js';
import { resolveTaskBundlePath } from '../../workspace/paths.js';
import { type PullJiraIssueOptions, pullJiraIssue } from './pull.js';
import { renderJiraTaskContext } from './render.js';
import type { JiraPullResult, JiraTaskImportResult } from './types.js';

export interface ImportJiraTaskOptions extends PullJiraIssueOptions {
  createIfExists?: boolean;
}

function artifactKindForFile(filename: string): ArtifactKind {
  const ext = path.extname(filename).toLowerCase();

  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) {
    return 'image';
  }

  if (ext === '.json') {
    return 'json';
  }

  if (['.md', '.txt', '.pdf', '.doc', '.docx'].includes(ext)) {
    return 'doc';
  }

  return 'other';
}

function artifactNumber(record: ArtifactRecord): number {
  const value = Number.parseInt(record.id.replace(/^art-/, ''), 10);
  return Number.isFinite(value) ? value : 0;
}

function nextArtifactId(value: number): string {
  return `art-${String(value).padStart(4, '0')}`;
}

function artifactRecord(
  existing: ArtifactRecord | undefined,
  id: string,
  input: {
    filename: string;
    kind: ArtifactKind;
    sourcePath: string;
    summary: string;
    tags: string[];
  },
): ArtifactRecord {
  const attachedAt = new Date().toISOString();

  return {
    id: existing?.id ?? id,
    filename: input.filename,
    relativePath: `artifacts/${input.filename}`,
    kind: input.kind,
    sourcePath: input.sourcePath,
    storageMode: 'copy',
    attachedAt,
    summary: input.summary,
    tags: input.tags,
  };
}

async function copyArtifact(
  projectRoot: string,
  paths: WorkspacePaths,
  taskId: string,
  sourceRelativePath: string,
  filename: string,
): Promise<string> {
  const sourcePath = path.join(projectRoot, sourceRelativePath);
  const destinationPath = path.join(resolveTaskBundlePath(paths, taskId), 'artifacts', filename);
  await copyFileSafe(sourcePath, destinationPath);
  return normalizeRelativePath(sourceRelativePath);
}

async function syncJiraArtifacts(
  projectRoot: string,
  paths: WorkspacePaths,
  taskId: string,
  pull: JiraPullResult,
): Promise<string[]> {
  const artifactDir = path.join(resolveTaskBundlePath(paths, taskId), 'artifacts');
  await ensureDir(artifactDir);

  const index = await readArtifactIndex(paths, taskId);
  const syncedRecords = new Map<string, ArtifactRecord>();
  let nextIdNumber = Math.max(0, ...index.artifacts.map(artifactNumber));
  const sourceFiles = [
    {
      filename: 'jira-raw.json',
      sourcePath: pull.rawPath,
      kind: 'json' as const,
      summary: `Raw Jira issue snapshot for ${pull.issueKey}.`,
      tags: ['jira', 'source'],
    },
    {
      filename: 'jira-issue.md',
      sourcePath: pull.issuePath,
      kind: 'doc' as const,
      summary: `Rendered Jira issue brief for ${pull.issueKey}.`,
      tags: ['jira', 'source'],
    },
  ];

  for (const source of sourceFiles) {
    const sourcePath = await copyArtifact(
      projectRoot,
      paths,
      taskId,
      source.sourcePath,
      source.filename,
    );
    const existing = index.artifacts.find((artifact) => artifact.filename === source.filename);
    if (!existing) {
      nextIdNumber += 1;
    }
    syncedRecords.set(
      source.filename,
      artifactRecord(existing, nextArtifactId(nextIdNumber), {
        filename: source.filename,
        kind: source.kind,
        sourcePath,
        summary: source.summary,
        tags: source.tags,
      }),
    );
  }

  for (const attachment of pull.attachments.filter((item) => item.downloaded)) {
    const sourcePath = await copyArtifact(
      projectRoot,
      paths,
      taskId,
      attachment.path,
      attachment.filename,
    );
    const existing = index.artifacts.find((artifact) => artifact.filename === attachment.filename);
    if (!existing) {
      nextIdNumber += 1;
    }
    syncedRecords.set(
      attachment.filename,
      artifactRecord(existing, nextArtifactId(nextIdNumber), {
        filename: attachment.filename,
        kind: artifactKindForFile(attachment.filename),
        sourcePath,
        summary: `Jira attachment for ${pull.issueKey}.`,
        tags: ['jira', 'attachment'],
      }),
    );
  }

  const untouchedRecords = index.artifacts.filter((record) => !syncedRecords.has(record.filename));
  const nextArtifacts = [...untouchedRecords, ...syncedRecords.values()].sort((left, right) =>
    left.filename.localeCompare(right.filename),
  );

  await writeArtifactIndex(paths, taskId, {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    artifacts: nextArtifacts,
  });

  await updateTaskMeta(paths, taskId, (meta) => ({
    ...meta,
    artifacts: {
      ...meta.artifacts,
      count: nextArtifacts.length,
    },
  }));

  return [...syncedRecords.values()].map((record) => record.relativePath);
}

export async function importJiraTaskBundle(
  projectRoot: string,
  config: LlmDocsConfigV2,
  paths: WorkspacePaths,
  issueKey: string,
  options: ImportJiraTaskOptions = {},
): Promise<JiraTaskImportResult> {
  const pull = await pullJiraIssue(config, paths, issueKey, options);
  const createResult = await createTaskBundle(projectRoot, config, paths, {
    taskId: pull.issueKey,
    title: pull.issue.fields.summary?.trim() || pull.issueKey,
    source: {
      type: 'jira',
      ref: pull.issueKey,
      url: pull.browseUrl,
      rawText: null,
    },
    createIfExists: options.createIfExists ?? true,
  });

  if (createResult.created) {
    await writeContext(
      projectRoot,
      createResult.files.context,
      renderJiraTaskContext(pull.issue, pull.browseUrl, pull.attachments),
    );
  }

  const artifacts = await syncJiraArtifacts(projectRoot, paths, pull.issueKey, pull);

  return {
    taskId: pull.issueKey,
    title: pull.issue.fields.summary?.trim() || pull.issueKey,
    created: createResult.created,
    bundlePath: createResult.bundlePath,
    contextPath: createResult.files.context ?? null,
    rawPath: pull.rawPath,
    issuePath: pull.issuePath,
    manifestPath: pull.manifestPath,
    artifacts,
    activeScope: 'none',
    sessionId: null,
  };
}

async function writeContext(
  projectRoot: string,
  contextRelativePath: string | undefined,
  content: string,
): Promise<void> {
  if (!contextRelativePath) {
    return;
  }

  const contextPath = path.join(projectRoot, contextRelativePath);
  await writeTextAtomic(contextPath, content);
}
