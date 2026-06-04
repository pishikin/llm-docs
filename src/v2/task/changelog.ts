import path from 'node:path';
import { readFileSafe, writeTextAtomic } from '../../utils/fs.js';
import { TaskBundleError } from '../errors.js';
import type { ChangelogEpoch, ChangelogEpochInput, WorkspacePaths } from '../types.js';
import { readTaskMeta, updateTaskMeta } from './meta.js';

function parseBulletSection(block: string, title: string): string[] {
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`### ${escapedTitle}\\n([\\s\\S]*?)(?=\\n### |\\n---$|$)`, 'm');
  const match = block.match(pattern);

  if (!match) {
    return [];
  }

  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2));
}

function parseChangelogBlock(block: string): ChangelogEpoch | null {
  const normalized = block.trim();
  if (!normalized) {
    return null;
  }

  const headerMatch = normalized.match(/^## (.+?) — (.+)$/m);
  if (!headerMatch) {
    return null;
  }

  return {
    timestamp: headerMatch[1],
    label: headerMatch[2],
    summary: parseBulletSection(normalized, 'Summary'),
    structuredState: parseBulletSection(normalized, 'Structured State'),
    decisions: parseBulletSection(normalized, 'Decisions'),
    nextSteps: parseBulletSection(normalized, 'Next Steps'),
  };
}

function renderBulletSection(title: string, items: string[]): string {
  if (items.length === 0) {
    return '';
  }

  return `### ${title}
${items.map((item) => `- ${item}`).join('\n')}

`;
}

function renderEpoch(input: ChangelogEpochInput): string {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const structuredState = [
    input.structuredState?.phase ? `phase: ${input.structuredState.phase}` : null,
    input.structuredState?.status ? `status: ${input.structuredState.status}` : null,
    input.structuredState?.branch ? `branch: ${input.structuredState.branch}` : null,
  ].filter((value): value is string => Boolean(value));

  return `## ${timestamp} — ${input.label}

${renderBulletSection('Summary', input.summary)}${renderBulletSection(
  'Structured State',
  structuredState,
)}${renderBulletSection('Decisions', input.decisions ?? [])}${renderBulletSection(
  'Next Steps',
  input.nextSteps ?? [],
)}---
`;
}

async function resolveChangelogPath(paths: WorkspacePaths, taskId: string): Promise<string> {
  const meta = await readTaskMeta(paths, taskId);
  return path.join(paths.tasksDir, taskId, meta.docs.primary.changelog);
}

export async function appendChangelogEpoch(
  paths: WorkspacePaths,
  taskId: string,
  epochInput: ChangelogEpochInput,
): Promise<void> {
  const changelogPath = await resolveChangelogPath(paths, taskId);
  const existing = (await readFileSafe(changelogPath)) ?? `# Changelog — ${taskId}\n\n`;
  const separator = existing.endsWith('\n') ? '' : '\n';
  const nextContent = `${existing}${separator}${renderEpoch(epochInput)}\n`;

  await writeTextAtomic(changelogPath, nextContent);
  await updateTaskMeta(paths, taskId, (meta) => meta);
}

export async function parseChangelogEpochs(
  paths: WorkspacePaths,
  taskId: string,
): Promise<ChangelogEpoch[]> {
  const changelogPath = await resolveChangelogPath(paths, taskId);
  const content = await readFileSafe(changelogPath);

  if (!content) {
    throw new TaskBundleError(`Changelog file not found for task ${taskId}`);
  }

  return content
    .split(/\n---\n/g)
    .map((block) => parseChangelogBlock(block))
    .filter((epoch): epoch is ChangelogEpoch => epoch !== null);
}

export async function readLatestChangelogEpoch(
  paths: WorkspacePaths,
  taskId: string,
): Promise<ChangelogEpoch | null> {
  const epochs = await parseChangelogEpochs(paths, taskId);
  return epochs.at(-1) ?? null;
}
