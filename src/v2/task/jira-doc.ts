import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { fileExists, normalizeRelativePath, readFileSafe, readJsonSafe } from '../../utils/fs.js';
import { artifactIndexSchema, taskMetaSchema } from '../config/schema.js';
import type {
  ArtifactIndex,
  LlmDocsConfigV2,
  PrepareJiraDocInput,
  PrepareJiraDocResult,
  PublishedTaskIndex,
  SimpleTaskState,
  TaskMeta,
  WorkspacePaths,
} from '../types.js';
import { resolveTaskBundlePath } from '../workspace/paths.js';
import { normalizeTaskId } from './id.js';
import { readTaskMeta } from './meta.js';
import { readTaskRegistry } from './registry.js';
import { SIMPLE_ARTIFACT_INDEX_PATH, simpleStateToTaskMeta } from './state.js';
import { PUBLISH_SUMMARY_PATH } from './summary.js';

const CHECKPOINT_START = '<!-- llm-docs:checkpoint:start -->';
const CHECKPOINT_END = '<!-- llm-docs:checkpoint:end -->';
const DEFAULT_MAX_LINES = 15;
const MAX_FACT_ITEMS = 8;

type JiraDocSourceKind = 'published' | 'active';

interface ResolvedTaskSource {
  taskId: string;
  kind: JiraDocSourceKind;
  bundlePath: string;
  publishedIndexPath: string | null;
  warnings: string[];
}

function toRelative(projectRoot: string, absolutePath: string): string {
  return normalizeRelativePath(path.relative(projectRoot, absolutePath));
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertInside(root: string, target: string, label: string): void {
  if (!isInside(root, target)) {
    throw new Error(`${label} escapes project root: ${target}`);
  }
}

function normalizeProjectKeys(projectKeys: string[]): string[] {
  return [...new Set(projectKeys.map((key) => key.trim().toUpperCase()).filter(Boolean))];
}

function looksLikeFullTaskId(value: string): boolean {
  return /^[A-Z][A-Z0-9]+-\d+$/.test(value.trim().toUpperCase());
}

function isNumericTaskId(value: string): boolean {
  return /^\d+$/.test(value.trim());
}

function docsTasksDir(paths: WorkspacePaths): string {
  return path.join(paths.docsDir, 'tasks');
}

function publishedIndexPath(paths: WorkspacePaths): string {
  return path.join(docsTasksDir(paths), 'index.json');
}

async function readPublishedIndex(paths: WorkspacePaths): Promise<PublishedTaskIndex | null> {
  return readJsonSafe<PublishedTaskIndex>(publishedIndexPath(paths));
}

async function listPublishedTaskIds(paths: WorkspacePaths): Promise<string[]> {
  const ids = new Set<string>();
  const index = await readPublishedIndex(paths);
  for (const taskId of Object.keys(index?.tasks ?? {})) {
    ids.add(taskId);
  }

  try {
    const entries = await fs.readdir(docsTasksDir(paths), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        ids.add(entry.name);
      }
    }
  } catch {
    // Published task docs may not exist yet.
  }

  return [...ids].sort();
}

async function findSuffixMatches(paths: WorkspacePaths, numericTaskId: string): Promise<string[]> {
  const ids = new Set<string>();
  for (const taskId of await listPublishedTaskIds(paths)) {
    ids.add(taskId);
  }

  try {
    const registry = await readTaskRegistry(paths);
    for (const taskId of Object.keys(registry.tasks)) {
      ids.add(taskId);
    }
  } catch {
    // Active registry is optional for published-doc-only flows.
  }

  return [...ids].filter((taskId) => taskId.endsWith(`-${numericTaskId}`)).sort();
}

async function resolveRequestedTaskId(
  config: LlmDocsConfigV2,
  paths: WorkspacePaths,
  rawTaskId: string,
): Promise<{ taskId: string; warnings: string[] }> {
  const trimmed = rawTaskId.trim();
  if (!trimmed) {
    throw new Error('Task id is required for Jira documentation generation.');
  }

  if (looksLikeFullTaskId(trimmed)) {
    return { taskId: normalizeTaskId(trimmed), warnings: [] };
  }

  if (!isNumericTaskId(trimmed)) {
    return { taskId: normalizeTaskId(trimmed), warnings: [] };
  }

  const projectKeys = normalizeProjectKeys(config.integrations.jira.projectKeys);
  if (projectKeys.length === 1) {
    return {
      taskId: `${projectKeys[0]}-${trimmed}`,
      warnings: [`Expanded numeric task id ${trimmed} with Jira project key ${projectKeys[0]}.`],
    };
  }

  const matches = await findSuffixMatches(paths, trimmed);
  if (matches.length === 1) {
    return {
      taskId: matches[0],
      warnings: [`Resolved numeric task id ${trimmed} by matching existing task ${matches[0]}.`],
    };
  }

  if (matches.length > 1) {
    throw new Error(`Task id ${trimmed} is ambiguous. Pass full task id: ${matches.join(', ')}.`);
  }

  throw new Error(
    `Cannot resolve numeric task id ${trimmed}. Configure one Jira project key or pass full task id.`,
  );
}

async function resolvePublishedTaskSource(
  paths: WorkspacePaths,
  taskId: string,
): Promise<ResolvedTaskSource | null> {
  const index = await readPublishedIndex(paths);
  const indexEntry = index?.tasks[taskId] ?? null;
  if (indexEntry) {
    const bundlePath = path.resolve(paths.projectRoot, indexEntry.path);
    assertInside(paths.projectRoot, bundlePath, 'Published task path');
    if (await fileExists(bundlePath)) {
      return {
        taskId,
        kind: 'published',
        bundlePath,
        publishedIndexPath: publishedIndexPath(paths),
        warnings: [],
      };
    }
  }

  const directBundlePath = path.join(docsTasksDir(paths), taskId);
  if (await fileExists(directBundlePath)) {
    return {
      taskId,
      kind: 'published',
      bundlePath: directBundlePath,
      publishedIndexPath: index ? publishedIndexPath(paths) : null,
      warnings: indexEntry
        ? [
            `Published index entry for ${taskId} exists, but its path is missing; used direct docs folder.`,
          ]
        : [`Published index entry for ${taskId} was not found; used direct docs folder.`],
    };
  }

  return null;
}

async function resolveActiveTaskSource(
  paths: WorkspacePaths,
  taskId: string,
): Promise<ResolvedTaskSource | null> {
  try {
    const meta = await readTaskMeta(paths, taskId);
    return {
      taskId: meta.task_id,
      kind: 'active',
      bundlePath: resolveTaskBundlePath(paths, taskId),
      publishedIndexPath: null,
      warnings: [`Published task ${taskId} was not found; used active task bundle fallback.`],
    };
  } catch {
    return null;
  }
}

async function resolveTaskSource(
  paths: WorkspacePaths,
  taskId: string,
): Promise<ResolvedTaskSource> {
  const published = await resolvePublishedTaskSource(paths, taskId);
  if (published) {
    return published;
  }

  const active = await resolveActiveTaskSource(paths, taskId);
  if (active) {
    return active;
  }

  throw new Error(`Task bundle not found for Jira documentation: ${taskId}.`);
}

function parseYamlTaskMeta(content: string, taskId: string): TaskMeta | null {
  try {
    const parsed = YAML.parse(content);
    const result = taskMetaSchema.safeParse(parsed);
    if (result.success && result.data.task_id === taskId) {
      return result.data;
    }
  } catch {
    return null;
  }

  return null;
}

function simpleStateToMeta(content: string, taskId: string): TaskMeta | null {
  try {
    const parsed = JSON.parse(content) as SimpleTaskState;
    if (parsed.taskId !== taskId) {
      return null;
    }

    return simpleStateToTaskMeta(parsed);
  } catch {
    return null;
  }
}

async function readMetaFromBundle(bundlePath: string, taskId: string): Promise<TaskMeta> {
  const yamlMeta = await readFileSafe(path.join(bundlePath, 'task.meta.yaml'));
  if (yamlMeta) {
    const meta = parseYamlTaskMeta(yamlMeta, taskId);
    if (meta) {
      return meta;
    }
  }

  const state = await readFileSafe(path.join(bundlePath, 'state.json'));
  if (state) {
    const meta = simpleStateToMeta(state, taskId);
    if (meta) {
      return meta;
    }
  }

  throw new Error(`Cannot read task metadata for Jira documentation: ${taskId}.`);
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function uniqueLimited(values: string[], limit = MAX_FACT_ITEMS): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values.map(normalizeLine).filter(Boolean)) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
    if (result.length >= limit) {
      break;
    }
  }

  return result;
}

function extractCheckpoint(context: string): string {
  const start = context.indexOf(CHECKPOINT_START);
  const end = context.indexOf(CHECKPOINT_END);

  if (start >= 0 && end > start) {
    return context.slice(start + CHECKPOINT_START.length, end);
  }

  return context;
}

function extractBulletSection(markdown: string, title: string): string[] {
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `^### ${escapedTitle}\\s*\\n([\\s\\S]*?)(?=\\n### |\\n## |\\n<!--|$)`,
    'm',
  );
  const match = markdown.match(pattern);
  if (!match) {
    return [];
  }

  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2));
}

const SUMMARY_FALLBACK_PATTERNS = [
  /^No .* captured/i,
  /^No evidence files found/i,
  /^No implementation file map captured/i,
  /^No key decisions captured/i,
];

function filterSummaryFallbacks(items: string[]): string[] {
  return items.filter(
    (item) => !SUMMARY_FALLBACK_PATTERNS.some((pattern) => pattern.test(item.trim())),
  );
}

function extractSummarySection(markdown: string, title: string): string[] {
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^## ${escapedTitle}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, 'm');
  const match = markdown.match(pattern);
  if (!match) {
    return [];
  }

  return filterSummaryFallbacks(
    match[1]
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2)),
  );
}

function extractLatestChangelogBlock(changelog: string): string {
  const blocks = changelog
    .split(/\n---\n/g)
    .map((block) => block.trim())
    .filter((block) => /^## .+ — .+/m.test(block));

  return blocks.at(-1) ?? '';
}

function extractSourceBrief(taskMarkdown: string): string[] {
  const match = taskMarkdown.match(/^## (?:Goal|Source Brief)\s*\n([\s\S]*?)(?=\n## |$)/m);
  if (!match) {
    return [];
  }

  return uniqueLimited(
    match[1]
      .split('\n')
      .map((line) => line.replace(/^- /, '').trim())
      .filter(Boolean),
    3,
  );
}

async function readArtifactSummaries(bundlePath: string, meta: TaskMeta): Promise<string[]> {
  const artifactPath = path.join(
    bundlePath,
    meta.artifacts.index_path || SIMPLE_ARTIFACT_INDEX_PATH,
  );
  const raw = await readJsonSafe<ArtifactIndex>(artifactPath);
  const parsed = artifactIndexSchema.safeParse(raw);
  if (!parsed.success) {
    return [];
  }

  return uniqueLimited(
    parsed.data.artifacts
      .map((artifact) => artifact.summary?.trim())
      .filter((summary): summary is string => Boolean(summary)),
    5,
  );
}

async function readManifestPath(bundlePath: string): Promise<string | null> {
  const manifestPath = path.join(bundlePath, 'publish.manifest.json');
  return (await fileExists(manifestPath)) ? manifestPath : null;
}

async function existingRelativePaths(
  projectRoot: string,
  filePaths: Array<string | null>,
): Promise<string[]> {
  const existing: string[] = [];

  for (const filePath of filePaths) {
    if (filePath && (await fileExists(filePath))) {
      existing.push(toRelative(projectRoot, filePath));
    }
  }

  return uniqueLimited(existing, 12);
}

function buildStyleRules(maxLines: number): string[] {
  return [
    'Write in Russian.',
    `Keep the final Jira text at or below ${maxLines} lines.`,
    'Use plain human-readable wording.',
    'Focus on implemented product behavior and important technical result.',
    'Do not list every changed file.',
    'Do not mention agent workflow, llm-docs internals, checkpoints, or publish mechanics.',
    'Mention verification only when verification facts are present.',
    'Do not invent facts that are missing from the prepared facts.',
  ];
}

export async function prepareJiraDoc(
  config: LlmDocsConfigV2,
  paths: WorkspacePaths,
  input: PrepareJiraDocInput,
): Promise<PrepareJiraDocResult> {
  const maxLines = input.maxLines ?? DEFAULT_MAX_LINES;
  const resolvedTask = await resolveRequestedTaskId(config, paths, input.taskId);
  const source = await resolveTaskSource(paths, resolvedTask.taskId);
  const meta = await readMetaFromBundle(source.bundlePath, source.taskId);
  const [summary, context, changelog, taskMarkdown, artifactSummaries, manifestPath] =
    await Promise.all([
      readFileSafe(path.join(source.bundlePath, PUBLISH_SUMMARY_PATH)),
      readFileSafe(path.join(source.bundlePath, meta.docs.primary.context)),
      readFileSafe(path.join(source.bundlePath, meta.docs.primary.changelog)),
      readFileSafe(path.join(source.bundlePath, meta.docs.primary.task)),
      readArtifactSummaries(source.bundlePath, meta),
      readManifestPath(source.bundlePath),
    ]);

  const checkpoint = extractCheckpoint(context ?? '');
  const latestChangelog = extractLatestChangelogBlock(changelog ?? '');
  const sourcePaths = await existingRelativePaths(paths.projectRoot, [
    summary ? path.join(source.bundlePath, PUBLISH_SUMMARY_PATH) : null,
    path.join(source.bundlePath, 'state.json'),
    path.join(source.bundlePath, 'task.meta.yaml'),
    context ? path.join(source.bundlePath, meta.docs.primary.context) : null,
    changelog ? path.join(source.bundlePath, meta.docs.primary.changelog) : null,
    taskMarkdown ? path.join(source.bundlePath, meta.docs.primary.task) : null,
    manifestPath,
  ]);

  return {
    taskId: source.taskId,
    requestedTaskId: input.taskId,
    source: {
      kind: source.kind,
      bundlePath: toRelative(paths.projectRoot, source.bundlePath),
      publishedIndexPath: source.publishedIndexPath
        ? toRelative(paths.projectRoot, source.publishedIndexPath)
        : null,
      manifestPath: manifestPath ? toRelative(paths.projectRoot, manifestPath) : null,
    },
    meta: {
      title: meta.title,
      status: meta.status,
      phase: meta.phase,
      sourceType: meta.source.type,
      sourceRef: meta.source.ref,
      sourceUrl: meta.source.url,
    },
    facts: {
      summary: uniqueLimited([
        ...extractSummarySection(summary ?? '', 'Final Outcome'),
        ...extractBulletSection(checkpoint, 'Summary'),
        ...extractBulletSection(latestChangelog, 'Summary'),
        ...extractSourceBrief(taskMarkdown ?? ''),
      ]),
      completedWork: uniqueLimited([
        ...extractSummarySection(summary ?? '', 'Final Outcome'),
        ...extractSummarySection(summary ?? '', 'Implementation Map'),
        ...extractBulletSection(checkpoint, 'Completed Work'),
        ...extractBulletSection(checkpoint, 'Current State'),
        ...extractBulletSection(latestChangelog, 'Summary'),
      ]),
      decisions: uniqueLimited([
        ...extractSummarySection(summary ?? '', 'Key Decisions'),
        ...extractBulletSection(checkpoint, 'Decisions'),
        ...extractBulletSection(latestChangelog, 'Decisions'),
      ]),
      verification: uniqueLimited(
        [
          ...extractSummarySection(summary ?? '', 'Verification'),
          ...extractBulletSection(checkpoint, 'Verification'),
        ],
        5,
      ),
      risks: uniqueLimited(
        [
          ...extractSummarySection(summary ?? '', 'Residual Risks'),
          ...extractBulletSection(checkpoint, 'Risks'),
        ],
        5,
      ),
      artifactSummaries,
    },
    sourcePaths,
    warnings: [...resolvedTask.warnings, ...source.warnings],
    styleRules: buildStyleRules(maxLines),
  };
}
