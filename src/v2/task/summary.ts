import path from 'node:path';
import { fileExists, normalizeRelativePath, readFileSafe, readJsonSafe } from '../../utils/fs.js';
import type { AdditionalDocRecord, SimpleTaskState, TaskMeta } from '../types.js';
import { detectStaleContextPlaceholders } from './context-quality.js';

export const PUBLISH_SUMMARY_PATH = 'summary.md';

const CHECKPOINT_START = '<!-- llm-docs:checkpoint:start -->';
const CHECKPOINT_END = '<!-- llm-docs:checkpoint:end -->';
const CURRENT_STATE_START = '<!-- llm-docs:current-state:start -->';
const CURRENT_STATE_END = '<!-- llm-docs:current-state:end -->';
const MAX_ITEMS = 8;

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function uniqueLimited(values: string[], limit = MAX_ITEMS): string[] {
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

function extractManagedBlock(content: string, startMarker: string, endMarker: string): string {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);

  if (start >= 0 && end > start) {
    return content.slice(start + startMarker.length, end);
  }

  return '';
}

function extractCheckpoint(context: string): string {
  return extractManagedBlock(context, CHECKPOINT_START, CHECKPOINT_END) || context;
}

function extractCurrentState(context: string): string {
  return extractManagedBlock(context, CURRENT_STATE_START, CURRENT_STATE_END);
}

function extractBulletSection(markdown: string, headingLevel: 2 | 3, title: string): string[] {
  const hashes = '#'.repeat(headingLevel);
  const nextHeading = headingLevel === 2 ? '\\n## ' : '\\n### |\\n## ';
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(?:^|\\n)${hashes} ${escapedTitle}\\s*\\n([\\s\\S]*?)(?=${nextHeading}|\\n<!--|$)`,
  );
  const match = markdown.match(pattern);
  if (!match) {
    return [];
  }

  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => normalizeLine(line.slice(2)));
}

function extractBulletSections(markdown: string, headingLevel: 2 | 3, titles: string[]): string[] {
  return titles.flatMap((title) => extractBulletSection(markdown, headingLevel, title));
}

function extractAllBullets(markdown: string): string[] {
  return markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => normalizeLine(line.slice(2)))
    .filter(Boolean);
}

function extractChangelogBlocks(changelog: string): string[] {
  return changelog
    .split(/\n---\n/g)
    .map((block) => block.trim())
    .filter((block) => /^## .+ — .+/m.test(block));
}

function extractLatestChangelogBlock(changelog: string): string {
  return extractChangelogBlocks(changelog).at(-1) ?? '';
}

function renderBullets(items: string[], fallback: string): string {
  const values = items.length > 0 ? items : [fallback];
  return `${values.map((item) => `- ${item}`).join('\n')}\n`;
}

function sourceLine(meta: TaskMeta): string {
  const parts: string[] = [meta.source.type];
  if (meta.source.ref) {
    parts.push(meta.source.ref);
  }
  if (meta.source.url) {
    parts.push(meta.source.url);
  }
  return parts.join(' · ');
}

function isPublishMechanics(value: string): boolean {
  return /\b(publish|published|publication|manifest|summary\.md|task bundle|bundle published|llm-docs|apply_task_publish|prepare_task_publish|index\.json)\b/i.test(
    value,
  );
}

function isIncidentMechanics(value: string): boolean {
  return /\b(ci|pipeline|oom|oomkilled|docker build|registry|npm ci|debug|incident|exit code 137|kubernetes)\b/i.test(
    value,
  );
}

function isLowValueOutcome(value: string): boolean {
  return isPublishMechanics(value) || isIncidentMechanics(value);
}

function preferImplementationFacts(values: string[], fallbackValues: string[]): string[] {
  const implementationFacts = values.filter((item) => !isLowValueOutcome(item));
  if (implementationFacts.length > 0) {
    return uniqueLimited(implementationFacts);
  }
  return uniqueLimited(fallbackValues);
}

function duplicatedBullets(markdown: string): string[] {
  const counts = new Map<string, { original: string; count: number }>();
  for (const bullet of extractAllBullets(markdown)) {
    const key = bullet.toLowerCase();
    const current = counts.get(key) ?? { original: bullet, count: 0 };
    current.count += 1;
    counts.set(key, current);
  }

  return [...counts.values()].filter((item) => item.count > 1).map((item) => item.original);
}

function dominatedBy(items: string[], predicate: (value: string) => boolean): boolean {
  if (items.length < 2) {
    return false;
  }

  return items.filter(predicate).length / items.length >= 0.6;
}

async function readState(bundlePath: string, taskId: string): Promise<SimpleTaskState | null> {
  const state = await readJsonSafe<SimpleTaskState>(path.join(bundlePath, 'state.json'));
  return state?.taskId === taskId ? state : null;
}

function activeAdditionalDocs(meta: TaskMeta): AdditionalDocRecord[] {
  return meta.docs.additional.filter((entry) => entry.status === 'active');
}

async function evidencePaths(bundlePath: string, meta: TaskMeta): Promise<string[]> {
  const candidates = [
    PUBLISH_SUMMARY_PATH,
    meta.docs.primary.context,
    'state.json',
    meta.docs.primary.task,
    meta.docs.primary.changelog,
    meta.artifacts.index_path,
    ...activeAdditionalDocs(meta).map((entry) => entry.path),
  ];
  const existing: string[] = [];

  for (const candidate of candidates) {
    if (await fileExists(path.join(bundlePath, candidate))) {
      existing.push(candidate);
    }
  }

  return uniqueLimited(existing, 16);
}

function pathBucket(relativePath: string): string {
  const normalized = relativePath.toLowerCase();
  if (/(__tests__|\.test\.|\.spec\.)/.test(normalized)) {
    return 'Verification and tests';
  }
  if (/modal|wizard|dialog/.test(normalized)) {
    return 'Wizard, modal, and dialog flow';
  }
  if (/page|route|router|routes/.test(normalized)) {
    return 'Pages and routes';
  }
  if (/component|components|widget|widgets/.test(normalized)) {
    return 'Reusable UI components';
  }
  if (/asset|icon|svg|font|woff|png|jpg|scss|css|style/.test(normalized)) {
    return 'Design assets, styles, and fonts';
  }
  if (/package\.json|package-lock|config|tsconfig|vite|webpack|eslint|biome/.test(normalized)) {
    return 'Dependencies and project configuration';
  }
  if (/\.md$/.test(normalized)) {
    return 'Task and research docs';
  }
  return 'Other implementation files';
}

function renderImplementationMap(paths: string[], docs: string[]): string[] {
  const grouped = new Map<string, string[]>();

  for (const relativePath of paths) {
    const bucket = pathBucket(relativePath);
    grouped.set(bucket, [...(grouped.get(bucket) ?? []), relativePath]);
  }

  if (docs.length > 0) {
    grouped.set('Task and research docs', [
      ...(grouped.get('Task and research docs') ?? []),
      ...docs,
    ]);
  }

  return [...grouped.entries()].map(([bucket, bucketPaths]) => {
    const visiblePaths = uniqueLimited(bucketPaths, 4);
    const suffix =
      bucketPaths.length > visiblePaths.length
        ? ` (+${bucketPaths.length - visiblePaths.length} more)`
        : '';
    return `${bucket}: ${visiblePaths.join(', ')}${suffix}`;
  });
}

function bulletsFromChangelog(blocks: string[], section: string): string[] {
  return blocks.flatMap((block) => extractBulletSection(block, 3, section));
}

export async function buildTaskSummaryMarkdown(args: {
  projectRoot: string;
  bundlePath: string;
  meta: TaskMeta;
}): Promise<string> {
  const context =
    (await readFileSafe(path.join(args.bundlePath, args.meta.docs.primary.context))) ?? '';
  const changelog =
    (await readFileSafe(path.join(args.bundlePath, args.meta.docs.primary.changelog))) ?? '';
  const checkpoint = extractCheckpoint(context);
  const currentState = extractCurrentState(context);
  const changelogBlocks = extractChangelogBlocks(changelog);
  const latestChangelog = extractLatestChangelogBlock(changelog);
  const state = await readState(args.bundlePath, args.meta.task_id);
  const truthNote = state?.truth.currentTruthNote ?? args.meta.truth.current_truth_note;
  const sourceTruthPaths = state?.truth.sourceOfTruthPaths ?? args.meta.truth.source_of_truth_paths;
  const sourceTruthDocs = state?.truth.sourceOfTruthDocs ?? args.meta.truth.source_of_truth_docs;
  const activeDocs = activeAdditionalDocs(args.meta);

  const preparedPlan = uniqueLimited(
    [
      ...extractBulletSection(currentState, 3, 'Prepared Plan'),
      ...extractBulletSection(checkpoint, 3, 'Prepared Plan'),
      ...extractBulletSection(context, 2, 'Prepared Plan'),
    ],
    8,
  );
  const userFacingBehavior = uniqueLimited(
    [
      ...extractBulletSection(currentState, 3, 'User-Facing Behavior'),
      ...extractBulletSection(checkpoint, 3, 'User-Facing Behavior'),
      ...extractBulletSection(context, 3, 'User-Facing Behavior'),
    ],
    8,
  );
  const implementationDetails = uniqueLimited(
    [
      ...extractBulletSection(currentState, 3, 'Implementation Details'),
      ...extractBulletSection(checkpoint, 3, 'Implementation Details'),
      ...extractBulletSection(context, 3, 'Implementation Details'),
    ],
    8,
  );
  const explicitImplementationMap = uniqueLimited(
    [
      ...extractBulletSections(currentState, 3, ['Implementation Map', 'Source / Files Map']),
      ...extractBulletSections(checkpoint, 3, ['Implementation Map', 'Source / Files Map']),
      ...extractBulletSection(context, 3, 'Source / Files Map'),
    ],
    12,
  );
  const supersededNotes = uniqueLimited(
    [
      ...extractBulletSection(currentState, 3, 'Superseded / Historical Notes'),
      ...extractBulletSection(checkpoint, 3, 'Superseded / Historical Notes'),
      ...extractBulletSection(context, 2, 'Superseded / Historical Notes'),
    ],
    8,
  );
  const candidateOutcomeFacts = uniqueLimited(
    [
      ...(truthNote ? [truthNote] : []),
      ...userFacingBehavior,
      ...implementationDetails,
      ...extractBulletSection(currentState, 3, 'Summary'),
      ...extractBulletSection(currentState, 3, 'Current State'),
      ...extractBulletSection(currentState, 3, 'Completed Work'),
      ...extractBulletSection(checkpoint, 3, 'Summary'),
      ...extractBulletSection(checkpoint, 3, 'Current State'),
      ...extractBulletSection(checkpoint, 3, 'Completed Work'),
      ...bulletsFromChangelog(changelogBlocks, 'Summary'),
    ],
    18,
  );
  const fallbackOutcomeFacts = uniqueLimited([
    ...extractBulletSection(latestChangelog, 3, 'Summary'),
    ...extractBulletSection(checkpoint, 3, 'Summary'),
    ...extractBulletSection(checkpoint, 3, 'Completed Work'),
  ]);
  const finalOutcome = preferImplementationFacts(candidateOutcomeFacts, fallbackOutcomeFacts);
  const decisions = uniqueLimited([
    ...extractBulletSection(currentState, 3, 'Decisions'),
    ...extractBulletSection(checkpoint, 3, 'Decisions'),
    ...bulletsFromChangelog(changelogBlocks, 'Decisions'),
  ]);
  const implementationMap = uniqueLimited(
    [
      ...explicitImplementationMap,
      ...renderImplementationMap(
        uniqueLimited([...sourceTruthPaths, ...activeDocs.map((doc) => doc.path)], 80),
        uniqueLimited(sourceTruthDocs, 16),
      ),
    ],
    14,
  );
  const verification = uniqueLimited(
    [
      ...extractBulletSection(currentState, 3, 'Verification'),
      ...extractBulletSection(checkpoint, 3, 'Verification'),
      ...bulletsFromChangelog(changelogBlocks, 'Verification'),
    ],
    8,
  );
  const risks = uniqueLimited(
    [
      ...extractBulletSection(currentState, 3, 'Risks'),
      ...extractBulletSection(checkpoint, 3, 'Risks'),
      ...bulletsFromChangelog(changelogBlocks, 'Risks'),
    ],
    8,
  );
  const nextSteps = uniqueLimited(
    [
      ...extractBulletSection(currentState, 3, 'Next Steps'),
      ...extractBulletSection(checkpoint, 3, 'Next Steps'),
      ...bulletsFromChangelog(changelogBlocks, 'Next Steps'),
    ],
    8,
  );
  const evidence = await evidencePaths(args.bundlePath, args.meta);

  return `# Summary — ${args.meta.task_id}

## Request
- ${args.meta.title}
- Source: ${sourceLine(args.meta)}

## Final Outcome
${renderBullets(finalOutcome, 'No final outcome captured in task context.')}

## Prepared Plan
${renderBullets(preparedPlan, 'No prepared plan captured.')}

## User-Facing Behavior
${renderBullets(userFacingBehavior, 'No user-facing behavior captured.')}

## Implementation Notes
${renderBullets(implementationDetails, 'No implementation details captured.')}

## Key Decisions
${renderBullets(decisions, 'No key decisions captured.')}

## Implementation Map
${renderBullets(implementationMap, 'No implementation file map captured.')}

## Verification
${renderBullets(verification, 'No verification captured.')}

## Residual Risks
${renderBullets(risks, 'No residual risks captured.')}

## Superseded / Historical Notes
${renderBullets(supersededNotes, 'No superseded notes captured.')}

## Evidence
${renderBullets(evidence, 'No evidence files found.')}

## Next Steps
${renderBullets(nextSteps, 'No next steps captured.')}
`;
}

export async function buildPublishQualityWarnings(args: {
  bundlePath: string;
  meta: TaskMeta;
  summaryContent: string;
}): Promise<string[]> {
  const warnings: string[] = [];
  const context =
    (await readFileSafe(path.join(args.bundlePath, args.meta.docs.primary.context))) ?? '';
  const checkpoint = extractCheckpoint(context);
  const currentState = extractCurrentState(context);
  const summaryFinalOutcome = extractBulletSection(args.summaryContent, 2, 'Final Outcome');
  const checkpointSummary = [
    ...extractBulletSection(checkpoint, 3, 'Summary'),
    ...extractBulletSection(checkpoint, 3, 'Completed Work'),
  ];

  warnings.push(...detectStaleContextPlaceholders(context));

  if (extractBulletSection(checkpoint, 3, 'Summary').length === 0) {
    warnings.push('Publish summary has no checkpoint Summary facts; outcome may be weak.');
  }
  if (
    extractBulletSection(checkpoint, 3, 'Decisions').length === 0 &&
    extractBulletSection(currentState, 3, 'Decisions').length === 0
  ) {
    warnings.push('Publish summary has no decision facts.');
  }
  if (
    extractBulletSection(checkpoint, 3, 'Verification').length === 0 &&
    extractBulletSection(currentState, 3, 'Verification').length === 0
  ) {
    warnings.push('Publish summary has no verification facts.');
  }
  if (
    extractBulletSection(checkpoint, 3, 'Prepared Plan').length === 0 &&
    extractBulletSection(currentState, 3, 'Prepared Plan').length === 0 &&
    extractBulletSection(context, 2, 'Prepared Plan').length === 0
  ) {
    warnings.push('Publish summary has no prepared plan facts.');
  }
  if (
    extractBulletSection(checkpoint, 3, 'Implementation Details').length === 0 &&
    extractBulletSection(currentState, 3, 'Implementation Details').length === 0 &&
    extractBulletSection(context, 3, 'Implementation Details').length === 0
  ) {
    warnings.push('Publish summary has no implementation detail facts.');
  }
  if (!args.summaryContent.includes('## Final Outcome')) {
    warnings.push('summary.md entry point is missing Final Outcome section.');
  }
  if (dominatedBy(summaryFinalOutcome, isPublishMechanics)) {
    warnings.push('summary.md Final Outcome is dominated by publish/task-bundle mechanics.');
  }
  if (dominatedBy(summaryFinalOutcome, isIncidentMechanics)) {
    warnings.push('summary.md Final Outcome is dominated by CI/debug incident facts.');
  }
  if (dominatedBy(checkpointSummary, isIncidentMechanics)) {
    warnings.push(
      'Latest checkpoint is dominated by CI/debug incident facts; add a final handoff milestone.',
    );
  }

  const duplicates = duplicatedBullets(args.summaryContent);
  if (duplicates.length > 0) {
    warnings.push(`summary.md repeats bullets: ${duplicates.slice(0, 3).join('; ')}`);
  }

  return uniqueLimited(warnings, 12);
}

export function summaryRelativePath(projectRoot: string, bundlePath: string): string {
  return normalizeRelativePath(
    path.relative(projectRoot, path.join(bundlePath, PUBLISH_SUMMARY_PATH)),
  );
}
