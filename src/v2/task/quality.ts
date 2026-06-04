import path from 'node:path';
import { fileExists, readFileSafe } from '../../utils/fs.js';
import { buildGitFacts } from '../git/status.js';
import type {
  GitFacts,
  LlmDocsConfigV2,
  SimpleTaskState,
  TaskMeta,
  TaskQualityFinding,
  TaskQualityProfile,
  TaskQualityReport,
  WorkspacePaths,
} from '../types.js';
import { readTaskMeta } from './meta.js';
import { readTaskStateOrNull } from './state.js';
import { PUBLISH_SUMMARY_PATH } from './summary.js';

const CHECKPOINT_START = '<!-- llm-docs:checkpoint:start -->';
const CHECKPOINT_END = '<!-- llm-docs:checkpoint:end -->';
const CURRENT_STATE_START = '<!-- llm-docs:current-state:start -->';
const CURRENT_STATE_END = '<!-- llm-docs:current-state:end -->';

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf-8');
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of values.map(normalizeLine).filter(Boolean)) {
    const key = item.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

function extractManagedBlock(content: string, start: string, end: string): string {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (startIndex >= 0 && endIndex > startIndex) {
    return content.slice(startIndex + start.length, endIndex);
  }
  return '';
}

function extractCheckpoint(content: string): string {
  return extractManagedBlock(content, CHECKPOINT_START, CHECKPOINT_END) || content;
}

function extractCurrentState(content: string): string {
  return extractManagedBlock(content, CURRENT_STATE_START, CURRENT_STATE_END);
}

function extractUpdatedAt(markdown: string): string | null {
  return markdown.match(/^Updated:\s*(\S+)/m)?.[1] ?? null;
}

function extractBulletSection(markdown: string, headingLevel: 2 | 3, title: string): string[] {
  const hashes = '#'.repeat(headingLevel);
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nextHeading = headingLevel === 2 ? '\\n## ' : '\\n### |\\n## ';
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

function extractAllBullets(markdown: string): string[] {
  return markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => normalizeLine(line.slice(2)))
    .filter(Boolean);
}

function latestChangelogTimestamp(changelog: string): string | null {
  const timestamps = [...changelog.matchAll(/^##\s+(\S+)\s+—\s+.+$/gm)].map((match) => match[1]);
  return timestamps.at(-1) ?? null;
}

function activeAdditionalDocs(meta: TaskMeta): string[] {
  return meta.docs.additional
    .filter((entry) => entry.status === 'active')
    .map((entry) => entry.path)
    .filter(
      (docPath) => docPath !== meta.docs.primary.changelog && docPath !== meta.docs.primary.context,
    );
}

function isTimestampAfter(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }

  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime > rightTime;
}

function sameCommitReference(left: string, right: string): boolean {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();

  return normalizedLeft.startsWith(normalizedRight) || normalizedRight.startsWith(normalizedLeft);
}

function extractHeadReferences(markdown: string): string[] {
  return [...markdown.matchAll(/\bHEAD:?\s*`?([0-9a-f]{7,40})/gi)].map((match) => match[1]);
}

async function missingSourceTruthPaths(
  projectRoot: string,
  sourcePaths: string[],
): Promise<string[]> {
  const missing: string[] = [];

  for (const sourcePath of sourcePaths) {
    if (/[*?[\]{}]/.test(sourcePath)) {
      continue;
    }

    const fullPath = path.isAbsolute(sourcePath) ? sourcePath : path.join(projectRoot, sourcePath);
    if (!(await fileExists(fullPath))) {
      missing.push(sourcePath);
    }
  }

  return missing;
}

function hasMeaningfulVerification(...contents: string[]): boolean {
  const combined = contents.join('\n');
  const bullets = [
    ...extractBulletSection(combined, 2, 'Verification'),
    ...extractBulletSection(combined, 3, 'Verification'),
  ];
  if (bullets.some((item) => !/not run|none|missing|no verification/i.test(item))) {
    return true;
  }

  return /\b(npm run|typecheck|lint|test|jest|vitest|build|verified|passed|прош(е|ё)л|провер)/i.test(
    combined,
  );
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

function dominatedBy(items: string[], predicate: (value: string) => boolean): boolean {
  if (items.length < 2) {
    return false;
  }
  return items.filter(predicate).length / items.length >= 0.6;
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

function likelyUiTask(paths: string[], tags: string[]): boolean {
  const combined = [...paths, ...tags].join('\n');
  return /frontend|component|page|modal|wizard|dialog|css|scss|tailwind|pixso|ui|tsx|jsx/i.test(
    combined,
  );
}

function suggestProfile(
  state: SimpleTaskState | null,
  meta: TaskMeta,
): {
  profile: TaskQualityProfile;
  reasons: string[];
} {
  const sourcePaths = state?.truth.sourceOfTruthPaths ?? meta.truth.source_of_truth_paths;
  const tags = state?.related.tags ?? meta.related.tags;
  const transcriptTokens = state?.checkpoint.estimatedTranscriptTokens ?? null;
  const createdAt = Date.parse(state?.bundle.createdAt ?? meta.bundle.created_at);
  const updatedAt = Date.parse(state?.bundle.updatedAt ?? meta.bundle.updated_at);
  const ageDays =
    Number.isFinite(createdAt) && Number.isFinite(updatedAt)
      ? Math.max(0, Math.floor((updatedAt - createdAt) / 86_400_000))
      : 0;
  const reasons: string[] = [];

  if (sourcePaths.length >= 12) {
    reasons.push(`source-of-truth map has ${sourcePaths.length} paths`);
  }
  if ((transcriptTokens ?? 0) >= 100_000) {
    reasons.push(`transcript estimate is ${transcriptTokens} tokens`);
  }
  if (ageDays >= 3) {
    reasons.push(`task age is ${ageDays} days`);
  }
  if (meta.docs.additional.filter((entry) => entry.status === 'active').length >= 3) {
    reasons.push('multiple active additional docs are attached');
  }

  if (likelyUiTask(sourcePaths, tags) && (sourcePaths.length >= 10 || reasons.length > 0)) {
    return { profile: 'large-ui', reasons: ['UI-heavy source paths detected', ...reasons] };
  }
  if (
    tags.some((tag) => /research|analysis/i.test(tag)) ||
    meta.docs.additional.some((doc) => doc.doc_type === 'research')
  ) {
    return {
      profile: 'research-heavy',
      reasons: ['research or analysis docs detected', ...reasons],
    };
  }
  if (reasons.length > 0) {
    return { profile: 'long-running', reasons };
  }
  return { profile: 'normal', reasons: [] };
}

function effectiveProfile(
  config: LlmDocsConfigV2,
  state: SimpleTaskState | null,
  meta: TaskMeta,
): TaskQualityReport['profile'] {
  const suggested = suggestProfile(state, meta);
  const configured = state?.qualityProfile ?? config.taskBundles.qualityProfile ?? null;
  return {
    effective: configured ?? suggested.profile,
    configured,
    suggested: suggested.profile,
    reasons: suggested.reasons,
  };
}

function addFinding(findings: TaskQualityFinding[], finding: TaskQualityFinding): void {
  if (findings.some((item) => item.id === finding.id)) {
    return;
  }
  findings.push(finding);
}

function scoreFindings(findings: TaskQualityFinding[]): number {
  const penalty = findings.reduce((sum, finding) => {
    if (finding.severity === 'error') {
      return sum + 25;
    }
    if (finding.severity === 'warning') {
      return sum + 10;
    }
    return sum;
  }, 0);
  return Math.max(0, 100 - penalty);
}

async function readBundleFile(bundlePath: string, relativePath: string): Promise<string> {
  return (await readFileSafe(path.join(bundlePath, relativePath))) ?? '';
}

export async function buildTaskQualityReport(args: {
  projectRoot: string;
  config: LlmDocsConfigV2;
  paths: WorkspacePaths;
  taskId: string;
}): Promise<TaskQualityReport> {
  const meta = await readTaskMeta(args.paths, args.taskId);
  const state = await readTaskStateOrNull(args.paths, args.taskId);
  const bundlePath = path.join(args.projectRoot, meta.bundle.path);
  const [context, changelog, summary] = await Promise.all([
    readBundleFile(bundlePath, meta.docs.primary.context),
    readBundleFile(bundlePath, meta.docs.primary.changelog),
    readBundleFile(bundlePath, PUBLISH_SUMMARY_PATH),
  ]);
  const checkpoint = extractCheckpoint(context);
  const currentState = extractCurrentState(context);
  const latestCheckpointAt = state?.checkpoint.lastCheckpointAt ?? extractUpdatedAt(checkpoint);
  const latestChangelogAt = latestChangelogTimestamp(changelog);
  const sourcePaths = state?.truth.sourceOfTruthPaths ?? meta.truth.source_of_truth_paths;
  const activeDocs = activeAdditionalDocs(meta);
  let gitFacts: GitFacts | null = null;
  try {
    gitFacts = await buildGitFacts(args.projectRoot, {
      config: args.config,
      taskMeta: meta,
    });
  } catch {
    gitFacts = null;
  }
  const missingTruthPaths = await missingSourceTruthPaths(args.projectRoot, sourcePaths);
  const profile = effectiveProfile(args.config, state, meta);
  const findings: TaskQualityFinding[] = [];
  const summaryFinalOutcome = extractBulletSection(summary, 2, 'Final Outcome');
  const checkpointSummary = [
    ...extractBulletSection(checkpoint, 3, 'Summary'),
    ...extractBulletSection(currentState, 3, 'Summary'),
    ...extractBulletSection(checkpoint, 3, 'Completed Work'),
  ];

  if (latestCheckpointAt && latestChangelogAt && latestCheckpointAt > latestChangelogAt) {
    addFinding(findings, {
      id: 'changelog-stale-after-checkpoint',
      severity: 'warning',
      message: 'Latest checkpoint is newer than the latest changelog epoch.',
      evidence: [`checkpoint=${latestCheckpointAt}`, `changelog=${latestChangelogAt}`],
      suggestion:
        'Append a compact changelog epoch for the milestone, handoff, or incident checkpoint.',
    });
  }

  if (!summary) {
    addFinding(findings, {
      id: 'summary-missing',
      severity:
        profile.effective === 'compact' || profile.effective === 'normal' ? 'warning' : 'error',
      message: 'summary.md is missing, so the published/handoff entry point is weak.',
      suggestion:
        'Generate a summary from current truth, changelog, implementation map, verification, and active docs.',
    });
  } else if (
    summaryFinalOutcome.length === 0 ||
    summaryFinalOutcome.some((item) => /No final outcome captured/i.test(item))
  ) {
    addFinding(findings, {
      id: 'final-outcome-missing',
      severity: 'warning',
      message: 'summary.md does not capture a concrete final outcome.',
      suggestion:
        'Add user-facing behavior delivered and implementation outcome, not only the latest checkpoint.',
    });
  }

  if (dominatedBy(summaryFinalOutcome, isPublishMechanics)) {
    addFinding(findings, {
      id: 'summary-dominated-by-publish-mechanics',
      severity: 'warning',
      message: 'Final Outcome is dominated by publish/task-bundle mechanics.',
      evidence: summaryFinalOutcome.filter(isPublishMechanics).slice(0, 3),
      suggestion:
        'Rewrite the outcome around delivered product/code behavior and keep publish mechanics in Evidence.',
    });
  }

  if (dominatedBy(checkpointSummary, isIncidentMechanics)) {
    addFinding(findings, {
      id: 'latest-checkpoint-dominated-by-incident',
      severity: 'warning',
      message:
        'Latest checkpoint is dominated by CI/debug/incident facts instead of the implementation story.',
      evidence: checkpointSummary.filter(isIncidentMechanics).slice(0, 3),
      suggestion:
        'Add a handoff or milestone checkpoint that synthesizes the whole task after the incident note.',
    });
  }

  const duplicates = duplicatedBullets(summary);
  if (duplicates.length > 0) {
    addFinding(findings, {
      id: 'duplicate-summary-bullets',
      severity: 'warning',
      message: 'summary.md repeats bullets, which makes the handoff noisy.',
      evidence: duplicates.slice(0, 5),
      suggestion: 'Deduplicate generated summary bullets before publishing.',
    });
  }

  const contextAndSummary = `${context}\n${summary}`;
  if (
    /wizard|modal|dialog/i.test(sourcePaths.join('\n')) &&
    /(wizard|modal|dialog)[^\n]*(no-op|out of scope|postponed|not implemented)|template\/wizard flows remain visual or no-op/i.test(
      contextAndSummary,
    )
  ) {
    addFinding(findings, {
      id: 'possible-superseded-noop-context',
      severity: 'warning',
      message:
        'Context still describes wizard/dialog behavior as no-op or out of scope while source-of-truth paths include wizard/dialog implementation files.',
      evidence: sourcePaths.filter((item) => /wizard|modal|dialog/i.test(item)).slice(0, 5),
      suggestion:
        'Mark the old plan as superseded and summarize the shipped wizard/dialog behavior.',
    });
  }

  if (sourcePaths.length >= 10) {
    const implementationMap = extractBulletSection(summary, 2, 'Implementation Map');
    const mapIsFlatPaths =
      implementationMap.length > 0 &&
      implementationMap.filter((item) => /\.(ts|tsx|js|jsx|css|scss|json|svg|woff2?)\b/i.test(item))
        .length /
        implementationMap.length >=
        0.8;
    if (!summary || implementationMap.length === 0 || mapIsFlatPaths) {
      addFinding(findings, {
        id: 'source-truth-without-readable-map',
        severity: 'warning',
        message:
          'Many source-of-truth paths are present but no readable grouped implementation map is available.',
        evidence: [`sourceOfTruthPaths=${sourcePaths.length}`],
        suggestion:
          'Group files by product area/component/verification instead of exposing only a flat path list.',
      });
    }
  }

  if (missingTruthPaths.length > 0) {
    addFinding(findings, {
      id: 'source-truth-missing-paths',
      severity: 'warning',
      message: 'Source-of-truth paths include files that do not exist in the current worktree.',
      evidence: missingTruthPaths.slice(0, 8),
      suggestion:
        'Refresh source-of-truth paths during actualization so deleted or renamed files do not stay authoritative.',
    });
  }

  if (!hasMeaningfulVerification(checkpoint, currentState, changelog, summary)) {
    addFinding(findings, {
      id: 'verification-missing',
      severity: 'warning',
      message:
        'No meaningful verification evidence is surfaced from checkpoint, changelog, or summary.',
      suggestion: 'Capture tests/builds/manual QA and state what remains unverified.',
    });
  }

  const sourceBriefFacts = [
    ...extractBulletSection(context, 2, 'Original Request / Source Brief'),
    ...extractBulletSection(currentState, 3, 'Requirements / Source Brief'),
    ...extractBulletSection(checkpoint, 3, 'Requirements / Source Brief'),
  ];
  const hasRawSource = /## Raw Source|# Raw|source/i.test(
    await readBundleFile(bundlePath, meta.docs.primary.raw),
  );
  if (sourceBriefFacts.length === 0 && !hasRawSource) {
    addFinding(findings, {
      id: 'source-brief-missing',
      severity: 'info',
      message: 'No compact original request/source brief is surfaced in the task bundle.',
      suggestion:
        'Capture the initial user request, Jira summary, acceptance criteria, or prompt excerpt in context.md or raw.md.',
    });
  }

  const planFacts = [
    ...extractBulletSection(context, 2, 'Prepared Plan'),
    ...extractBulletSection(currentState, 3, 'Prepared Plan'),
    ...extractBulletSection(checkpoint, 3, 'Prepared Plan'),
    ...extractBulletSection(summary, 2, 'Prepared Plan'),
  ];
  if (planFacts.length === 0 && profile.effective !== 'compact') {
    addFinding(findings, {
      id: 'prepared-plan-missing',
      severity: 'info',
      message: 'No prepared plan is surfaced for the coding agent handoff.',
      suggestion:
        'Add 3-7 plan bullets covering implementation sequence, boundaries, and validation route.',
    });
  }

  const implementationDetails = [
    ...extractBulletSection(currentState, 3, 'Implementation Details'),
    ...extractBulletSection(checkpoint, 3, 'Implementation Details'),
    ...extractBulletSection(summary, 2, 'Implementation Notes'),
  ];
  const behaviorDetails = [
    ...extractBulletSection(currentState, 3, 'User-Facing Behavior'),
    ...extractBulletSection(checkpoint, 3, 'User-Facing Behavior'),
    ...extractBulletSection(summary, 2, 'User-Facing Behavior'),
  ];
  if (
    sourcePaths.length >= 3 &&
    implementationDetails.length === 0 &&
    behaviorDetails.length === 0
  ) {
    addFinding(findings, {
      id: 'implementation-story-missing',
      severity: 'warning',
      message:
        'Source paths indicate implementation work, but no user-facing behavior or implementation detail story is surfaced.',
      evidence: [`sourceOfTruthPaths=${sourcePaths.length}`],
      suggestion:
        'Record grouped implementation details and delivered behavior instead of only listing files.',
    });
  }

  const taskIsStale = !!(state?.staleness.needsActualization || meta.staleness.needs_actualization);
  if (taskIsStale) {
    addFinding(findings, {
      id: 'active-task-stale',
      severity: 'warning',
      message: 'Task state is marked as needing actualization.',
      evidence: unique([...(state?.staleness.reasons ?? []), ...meta.staleness.reasons]).slice(
        0,
        5,
      ),
      suggestion: 'Run actualization before handoff/publish so docs reflect current source truth.',
    });
  }

  if (
    taskIsStale &&
    state &&
    isTimestampAfter(state.bundle.updatedAt, state.checkpoint.lastCheckpointAt)
  ) {
    addFinding(findings, {
      id: 'state-newer-than-narrative-docs',
      severity: 'warning',
      message:
        'Task state was updated after the latest checkpoint, so the bundle may only contain a stale metadata marker.',
      evidence: [
        `state.updatedAt=${state.bundle.updatedAt}`,
        `checkpoint=${state.checkpoint.lastCheckpointAt}`,
      ],
      suggestion:
        'Save a semantic checkpoint and changelog/summary update; do not treat state.json-only freshness as task documentation freshness.',
    });
  }

  if (
    gitFacts?.head &&
    state?.checkpoint.lastCheckpointHead &&
    !sameCommitReference(state.checkpoint.lastCheckpointHead, gitFacts.head)
  ) {
    addFinding(findings, {
      id: 'checkpoint-head-behind-current-head',
      severity: taskIsStale ? 'warning' : 'info',
      message: 'Latest checkpoint was saved for an older HEAD than the current worktree HEAD.',
      evidence: [
        `checkpointHead=${state.checkpoint.lastCheckpointHead}`,
        `currentHead=${gitFacts.head}`,
      ],
      suggestion:
        'Refresh context.md and related narrative docs from the current source state before relying on this bundle.',
    });
  }

  const missingDocLinks = activeDocs.filter((docPath) => !contextAndSummary.includes(docPath));
  if (missingDocLinks.length > 0) {
    addFinding(findings, {
      id: 'active-additional-docs-not-surfaced',
      severity: 'warning',
      message: 'Active additional docs are not surfaced from context.md or summary.md.',
      evidence: missingDocLinks.slice(0, 8),
      suggestion: 'Add a navigation map that labels active, historical, and superseded docs.',
    });
  }

  const staleSummaryHeadReferences = gitFacts?.head
    ? extractHeadReferences(summary).filter(
        (reference) => !sameCommitReference(reference, gitFacts.head ?? ''),
      )
    : [];
  if (staleSummaryHeadReferences.length > 0) {
    addFinding(findings, {
      id: 'summary-head-stale',
      severity: 'warning',
      message: 'summary.md references a HEAD that is not the current worktree HEAD.',
      evidence: [
        ...staleSummaryHeadReferences.slice(0, 3).map((reference) => `summaryHead=${reference}`),
        `currentHead=${gitFacts?.head}`,
      ],
      suggestion:
        'Regenerate or edit summary.md during actualization so its Current Truth section is current.',
    });
  }

  const truthNote = state?.truth.currentTruthNote ?? meta.truth.current_truth_note;
  const staleTruthHeadReferences =
    truthNote && gitFacts?.head
      ? extractHeadReferences(truthNote).filter(
          (reference) => !sameCommitReference(reference, gitFacts?.head ?? ''),
        )
      : [];
  if (staleTruthHeadReferences.length > 0) {
    addFinding(findings, {
      id: 'structured-truth-head-stale',
      severity: 'warning',
      message: 'Structured currentTruthNote references a HEAD that is not current.',
      evidence: [
        ...staleTruthHeadReferences.slice(0, 3).map((reference) => `truthHead=${reference}`),
        `currentHead=${gitFacts?.head}`,
      ],
      suggestion: 'Update currentTruthNote when applying actualization state.',
    });
  }

  if (
    truthNote &&
    !contextAndSummary.toLowerCase().includes(truthNote.slice(0, 48).toLowerCase())
  ) {
    addFinding(findings, {
      id: 'structured-truth-not-synthesized',
      severity: 'info',
      message:
        'Structured currentTruthNote contains useful implementation truth that is not directly synthesized in human entry points.',
      evidence: [truthNote],
      suggestion: 'Promote currentTruthNote into Current Working State or summary.md.',
    });
  }

  if (
    profile.effective !== 'compact' &&
    profile.effective !== 'normal' &&
    !activeDocs.some((docPath) =>
      /implementation-(journal|map)|verification|decisions/i.test(docPath),
    ) &&
    sourcePaths.length >= 12
  ) {
    addFinding(findings, {
      id: 'long-task-optional-docs-missing',
      severity: 'info',
      message:
        'Long-task profile would benefit from implementation-map.md, implementation-journal.md, verification.md, or decisions.md.',
      suggestion: 'Create optional long-task docs only when the task profile needs them.',
    });
  }

  if (!(await fileExists(bundlePath))) {
    addFinding(findings, {
      id: 'bundle-path-missing',
      severity: 'error',
      message: `Bundle path does not exist: ${meta.bundle.path}`,
    });
  }

  const metrics = {
    contextBytes: byteLength(context),
    changelogBytes: byteLength(changelog),
    summaryBytes: byteLength(summary),
    additionalDocCount: activeDocs.length,
    sourceOfTruthPathCount: sourcePaths.length,
    latestCheckpointAt,
    latestChangelogAt,
    activeTaskStale: !!(state?.staleness.needsActualization || meta.staleness.needs_actualization),
    estimatedTranscriptTokens: state?.checkpoint.estimatedTranscriptTokens ?? null,
  };
  const score = scoreFindings(findings);
  const status: TaskQualityReport['status'] =
    findings.some((finding) => finding.severity === 'error') || score < 60
      ? 'fail'
      : findings.some((finding) => finding.severity === 'warning')
        ? 'warn'
        : 'pass';

  return {
    schemaVersion: 1,
    taskId: meta.task_id,
    bundlePath: meta.bundle.path,
    generatedAt: new Date().toISOString(),
    status,
    score,
    profile,
    metrics,
    findings,
  };
}
