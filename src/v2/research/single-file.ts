import path from 'node:path';
import { normalizeRelativePath, readFileSafe, writeTextAtomic } from '../../utils/fs.js';
import { readTaskMeta } from '../task/meta.js';
import type { WorkspacePaths } from '../types.js';

export interface ResearchStartInput {
  taskId: string;
  slug: string;
  title?: string | null;
}

export interface ResearchCheckpointInput {
  taskId: string;
  slug: string;
  sources?: string[];
  findings?: string[];
  decisions?: string[];
  nextSteps?: string[];
}

export interface ResearchCompactInput {
  taskId: string;
  slug: string;
}

export interface ResearchFileResult {
  taskId: string;
  slug: string;
  path: string;
  created: boolean;
}

const PLACEHOLDER_BULLETS = new Set([
  'None yet.',
  'Research started.',
  'Continue research.',
  'No brief yet.',
]);

function normalizeSlug(slug: string): string {
  return slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeItems(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function renderResearchTemplate(slug: string, title?: string | null): string {
  const heading = title?.trim() || slug;

  return `# Research: ${heading}

## Brief
- Research started.

## Sources
- None yet.

## Findings
- None yet.

## Decisions
- None yet.

## Next Steps
- Continue research.
`;
}

async function resolveResearchFile(
  paths: WorkspacePaths,
  taskId: string,
  slug: string,
): Promise<{ slug: string; absolutePath: string; relativePath: string }> {
  const normalizedSlug = normalizeSlug(slug);
  if (!normalizedSlug) {
    throw new Error('Research slug cannot be empty.');
  }

  const meta = await readTaskMeta(paths, taskId);
  const relativePath = normalizeRelativePath(
    path.posix.join(meta.bundle.path, `research-${normalizedSlug}.md`),
  );

  return {
    slug: normalizedSlug,
    absolutePath: path.join(paths.projectRoot, relativePath),
    relativePath,
  };
}

function findSection(
  content: string,
  title: string,
): { start: number; bodyStart: number; end: number } | null {
  const headingPattern = new RegExp(`^## ${title}\\s*$`, 'm');
  const match = headingPattern.exec(content);
  if (!match || match.index === undefined) {
    return null;
  }

  const bodyStart = match.index + match[0].length;
  const nextMatch = /^##\s+/m.exec(content.slice(bodyStart));
  const end = nextMatch?.index === undefined ? content.length : bodyStart + nextMatch.index;

  return { start: match.index, bodyStart, end };
}

function replaceSection(content: string, title: string, body: string): string {
  const normalizedBody = `\n${body.trim()}\n\n`;
  const section = findSection(content, title);

  if (!section) {
    return `${content.trimEnd()}\n\n## ${title}${normalizedBody}`;
  }

  return `${content.slice(0, section.bodyStart)}${normalizedBody}${content.slice(section.end).trimStart()}`;
}

function sectionBullets(content: string, title: string): string[] {
  const section = findSection(content, title);
  if (!section) {
    return [];
  }

  return content
    .slice(section.bodyStart, section.end)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter((line) => line && !PLACEHOLDER_BULLETS.has(line));
}

function appendBullets(content: string, title: string, items: string[]): string {
  const nextItems = [...sectionBullets(content, title), ...items];
  const body =
    nextItems.length > 0 ? nextItems.map((item) => `- ${item}`).join('\n') : '- None yet.';

  return replaceSection(content, title, body);
}

export async function startResearchFile(
  paths: WorkspacePaths,
  input: ResearchStartInput,
): Promise<ResearchFileResult> {
  const file = await resolveResearchFile(paths, input.taskId, input.slug);
  const existing = await readFileSafe(file.absolutePath);

  if (existing === null) {
    await writeTextAtomic(file.absolutePath, renderResearchTemplate(file.slug, input.title));
  }

  return {
    taskId: input.taskId,
    slug: file.slug,
    path: file.relativePath,
    created: existing === null,
  };
}

export async function checkpointResearchFile(
  paths: WorkspacePaths,
  input: ResearchCheckpointInput,
): Promise<ResearchFileResult> {
  const started = await startResearchFile(paths, input);
  const file = await resolveResearchFile(paths, input.taskId, input.slug);
  let content = (await readFileSafe(file.absolutePath)) ?? renderResearchTemplate(file.slug);

  content = appendBullets(content, 'Sources', normalizeItems(input.sources));
  content = appendBullets(content, 'Findings', normalizeItems(input.findings));
  content = appendBullets(content, 'Decisions', normalizeItems(input.decisions));
  content = appendBullets(content, 'Next Steps', normalizeItems(input.nextSteps));

  await writeTextAtomic(file.absolutePath, content);

  return started;
}

export async function compactResearchFile(
  paths: WorkspacePaths,
  input: ResearchCompactInput,
): Promise<ResearchFileResult> {
  const started = await startResearchFile(paths, input);
  const file = await resolveResearchFile(paths, input.taskId, input.slug);
  const content = (await readFileSafe(file.absolutePath)) ?? renderResearchTemplate(file.slug);
  const decisions = sectionBullets(content, 'Decisions').slice(0, 5);
  const findings = sectionBullets(content, 'Findings').slice(0, 7);
  const nextSteps = sectionBullets(content, 'Next Steps').slice(0, 3);
  const briefItems = [
    ...decisions.map((item) => `Decision: ${item}`),
    ...findings.map((item) => `Finding: ${item}`),
    ...nextSteps.map((item) => `Next: ${item}`),
  ];
  const nextBrief =
    briefItems.length > 0 ? briefItems.map((item) => `- ${item}`).join('\n') : '- No brief yet.';

  await writeTextAtomic(file.absolutePath, replaceSection(content, 'Brief', nextBrief));

  return started;
}
