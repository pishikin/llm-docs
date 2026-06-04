import path from 'node:path';
import { normalizeRelativePath, readFileSafe, writeTextAtomic } from '../../utils/fs.js';
import { buildGitFacts } from '../git/status.js';
import type {
  ChangelogEpochInput,
  LlmDocsConfig,
  SaveContextCheckpointInput,
  SaveContextCheckpointResult,
  SimpleTaskState,
  TaskQualityProfile,
  WorkspacePaths,
} from '../types.js';
import { protectedBaseBranches } from './branches.js';
import { appendChangelogEpoch } from './changelog.js';
import {
  checkpointQualityWarnings,
  cleanupStarterPlaceholders,
  renderCurrentStateBlock,
  upsertCurrentStateBlock,
} from './context-quality.js';
import { readTaskMeta, updateTaskMeta } from './meta.js';
import { syncRegistryFromMeta } from './registry.js';
import { bindCodexSessionToTask, readCodexSessionBinding } from './session-binding.js';
import {
  readTaskStateOrNull,
  resolveTaskStatePath,
  taskMetaToSimpleState,
  writeTaskState,
} from './state.js';

const CHECKPOINT_START = '<!-- llm-docs:checkpoint:start -->';
const CHECKPOINT_END = '<!-- llm-docs:checkpoint:end -->';

function normalizeItems(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

type CheckpointBudget = Pick<
  LlmDocsConfig['contextBudget'],
  'checkpointMaxBytes' | 'checkpointMaxBullets'
>;

function resolveCheckpointProfile(
  config: LlmDocsConfig,
  state: SimpleTaskState | null,
  input: SaveContextCheckpointInput,
): TaskQualityProfile {
  return (
    input.qualityProfile ?? state?.qualityProfile ?? config.taskBundles.qualityProfile ?? 'normal'
  );
}

function resolveCheckpointBudget(
  config: LlmDocsConfig,
  profile: TaskQualityProfile,
): CheckpointBudget {
  if (profile === 'long-running' || profile === 'large-ui' || profile === 'research-heavy') {
    return {
      checkpointMaxBytes: Math.max(config.contextBudget.checkpointMaxBytes, 12000),
      checkpointMaxBullets: Math.max(config.contextBudget.checkpointMaxBullets, 80),
    };
  }

  return {
    checkpointMaxBytes: config.contextBudget.checkpointMaxBytes,
    checkpointMaxBullets: config.contextBudget.checkpointMaxBullets,
  };
}

function shouldAppendChangelog(
  input: SaveContextCheckpointInput,
  profile: TaskQualityProfile,
): boolean {
  if (typeof input.appendChangelog === 'boolean') {
    return input.appendChangelog;
  }

  return (
    (profile === 'long-running' || profile === 'large-ui' || profile === 'research-heavy') &&
    input.checkpointKind !== 'pause'
  );
}

function changelogLabel(input: SaveContextCheckpointInput): string {
  const kind = input.checkpointKind ?? 'progress';
  const phaseLabel = input.phaseLabel?.trim();
  if (phaseLabel) {
    return `${kind} - ${phaseLabel}`;
  }
  return `${kind} checkpoint`;
}

function changelogSummary(input: SaveContextCheckpointInput): string[] {
  const candidates = [
    ...normalizeItems(input.summary),
    ...normalizeItems(input.userFacingBehavior),
    ...normalizeItems(input.completedWork),
    ...normalizeItems(input.implementationDetails),
    ...normalizeItems(input.currentState),
  ];
  return candidates.length > 0 ? candidates.slice(0, 10) : ['Context checkpoint saved.'];
}

interface CheckpointSectionInput {
  title: string;
  items: string[];
}

function renderBulletSection(title: string, items: string[]): string {
  if (items.length === 0) {
    return '';
  }

  return `### ${title}
${items.map((item) => `- ${item}`).join('\n')}

`;
}

function renderCheckpointFromSections(
  sections: CheckpointSectionInput[],
  timestamp: string,
): string {
  const body =
    sections
      .map((section) => renderBulletSection(section.title, section.items))
      .join('')
      .trim() || '- No checkpoint details provided.';

  return `${CHECKPOINT_START}
## Latest Checkpoint
Updated: ${timestamp}

${body}
${CHECKPOINT_END}`;
}

function buildCheckpointSections(
  input: SaveContextCheckpointInput,
  timestamp: string,
  budget: CheckpointBudget,
): CheckpointSectionInput[] {
  const sourceSections: CheckpointSectionInput[] = [
    { title: 'Summary', items: normalizeItems(input.summary) },
    { title: 'Current State', items: normalizeItems(input.currentState) },
    { title: 'Requirements / Source Brief', items: normalizeItems(input.requirements) },
    { title: 'Prepared Plan', items: normalizeItems(input.plan) },
    { title: 'User-Facing Behavior', items: normalizeItems(input.userFacingBehavior) },
    { title: 'Completed Work', items: normalizeItems(input.completedWork) },
    { title: 'Implementation Details', items: normalizeItems(input.implementationDetails) },
    { title: 'Implementation Map', items: normalizeItems(input.implementationMap) },
    { title: 'Decisions', items: normalizeItems(input.decisions) },
    { title: 'Design Constraints', items: normalizeItems(input.designConstraints) },
    { title: 'Superseded / Historical Notes', items: normalizeItems(input.superseded) },
    { title: 'Files', items: normalizeItems(input.files) },
    { title: 'Verification', items: normalizeItems(input.verification) },
    { title: 'Validation Gaps', items: normalizeItems(input.validationGaps) },
    { title: 'Risks', items: normalizeItems(input.risks) },
    { title: 'Next Steps', items: normalizeItems(input.nextSteps) },
    { title: 'Notes', items: normalizeItems(input.notes) },
  ];
  const maxBullets = budget.checkpointMaxBullets;
  const maxBytes = budget.checkpointMaxBytes;
  const sections: CheckpointSectionInput[] = sourceSections.map((section) => ({
    title: section.title,
    items: [],
  }));
  let usedBullets = 0;

  for (const [index, sourceSection] of sourceSections.entries()) {
    for (const item of sourceSection.items) {
      if (usedBullets >= maxBullets) {
        return sections;
      }

      const nextSections = sections.map((section, sectionIndex) => ({
        title: section.title,
        items: sectionIndex === index ? [...section.items, item] : [...section.items],
      }));
      if (
        Buffer.byteLength(renderCheckpointFromSections(nextSections, timestamp), 'utf-8') > maxBytes
      ) {
        return sections;
      }

      sections[index].items.push(item);
      usedBullets += 1;
    }
  }

  return sections;
}

function renderCheckpoint(
  input: SaveContextCheckpointInput,
  timestamp: string,
  config: LlmDocsConfig,
): string {
  return renderCheckpointFromSections(
    buildCheckpointSections(input, timestamp, {
      checkpointMaxBytes: config.contextBudget.checkpointMaxBytes,
      checkpointMaxBullets: config.contextBudget.checkpointMaxBullets,
    }),
    timestamp,
  );
}

function boundedInputFromSections(sections: CheckpointSectionInput[]): SaveContextCheckpointInput {
  const getItems = (title: string): string[] =>
    sections.find((section) => section.title === title)?.items ?? [];

  return {
    summary: getItems('Summary'),
    currentState: getItems('Current State'),
    requirements: getItems('Requirements / Source Brief'),
    plan: getItems('Prepared Plan'),
    userFacingBehavior: getItems('User-Facing Behavior'),
    completedWork: getItems('Completed Work'),
    implementationDetails: getItems('Implementation Details'),
    implementationMap: getItems('Implementation Map'),
    decisions: getItems('Decisions'),
    designConstraints: getItems('Design Constraints'),
    superseded: getItems('Superseded / Historical Notes'),
    files: getItems('Files'),
    verification: getItems('Verification'),
    validationGaps: getItems('Validation Gaps'),
    risks: getItems('Risks'),
    nextSteps: getItems('Next Steps'),
    notes: getItems('Notes'),
  };
}

function upsertCheckpointSection(content: string, checkpoint: string): string {
  const startIndex = content.indexOf(CHECKPOINT_START);
  const endIndex = content.indexOf(CHECKPOINT_END);

  if (startIndex >= 0 && endIndex > startIndex) {
    return `${content.slice(0, startIndex).trimEnd()}\n\n${checkpoint}\n${content
      .slice(endIndex + CHECKPOINT_END.length)
      .trimStart()}`;
  }

  return `${content.trimEnd()}\n\n${checkpoint}\n`;
}

function updateCheckpointState(
  state: SimpleTaskState,
  input: SaveContextCheckpointInput,
  timestamp: string,
  head: string | null,
  branch: string | null,
  qualityProfile: TaskQualityProfile,
): SimpleTaskState {
  return {
    ...state,
    bundle: {
      ...state.bundle,
      updatedAt: timestamp,
    },
    branch: {
      ...state.branch,
      current: branch ?? state.branch.current,
    },
    qualityProfile,
    checkpoint: {
      ...state.checkpoint,
      lastCheckpointAt: timestamp,
      lastCheckpointHead: input.lastCheckpointHead ?? head,
      promptCountSinceCheckpoint: 0,
      needsQualityCheckpoint: false,
    },
  };
}

export async function saveContextCheckpoint(
  projectRoot: string,
  config: LlmDocsConfig,
  paths: WorkspacePaths,
  taskId: string,
  input: SaveContextCheckpointInput,
): Promise<SaveContextCheckpointResult> {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const meta = await readTaskMeta(paths, taskId);
  const gitFacts = await buildGitFacts(projectRoot, { config, taskMeta: meta });
  const checkpointHead = input.lastCheckpointHead ?? gitFacts.head;
  const contextPath = path.join(paths.projectRoot, meta.bundle.path, meta.docs.primary.context);
  const existingContext =
    (await readFileSafe(contextPath)) ??
    `# ${taskId}: ${meta.title}

## Current State
- Context file was recreated by llm-docs.
`;
  const currentState = (await readTaskStateOrNull(paths, taskId)) ?? taskMetaToSimpleState(meta);
  const qualityProfile = resolveCheckpointProfile(config, currentState, input);
  const checkpointBudget = resolveCheckpointBudget(config, qualityProfile);
  const checkpointSections = buildCheckpointSections(input, timestamp, checkpointBudget);
  const boundedInput = boundedInputFromSections(checkpointSections);
  const checkpoint = renderCheckpointFromSections(checkpointSections, timestamp);
  const currentStateBlock = renderCurrentStateBlock({
    taskId,
    input: boundedInput,
    timestamp,
    meta,
    state: currentState,
    branch: gitFacts.branch,
  });
  const nextContext = upsertCheckpointSection(
    upsertCurrentStateBlock(
      cleanupStarterPlaceholders(existingContext, boundedInput),
      currentStateBlock,
    ),
    checkpoint,
  );
  const nextState = updateCheckpointState(
    currentState,
    input,
    timestamp,
    checkpointHead,
    gitFacts.branch,
    qualityProfile,
  );

  await writeTextAtomic(contextPath, nextContext);
  await writeTaskState(paths, taskId, nextState);
  const updatedMeta = await updateTaskMeta(paths, taskId, (current) => ({
    ...current,
    bundle: {
      ...current.bundle,
      updated_at: timestamp,
    },
    branch: {
      ...current.branch,
      current: gitFacts.branch ?? current.branch.current,
    },
  }));
  await syncRegistryFromMeta(paths, updatedMeta, {
    skipBranches: [...protectedBaseBranches(config)],
  });

  const warnings: string[] = checkpointQualityWarnings(input);
  if (Buffer.byteLength(nextContext, 'utf-8') > config.contextBudget.activeContextMaxBytes) {
    warnings.push(
      `context.md exceeds contextBudget.activeContextMaxBytes (${config.contextBudget.activeContextMaxBytes} bytes).`,
    );
  }

  let changelogAppended = false;
  let changelogPath: string | null = null;
  if (shouldAppendChangelog(input, qualityProfile)) {
    const epoch: ChangelogEpochInput = {
      label: changelogLabel(input),
      summary: changelogSummary(boundedInput),
      structuredState: {
        phase: nextState.phase,
        status: nextState.status,
        branch: gitFacts.branch ?? nextState.branch.current,
      },
      decisions: normalizeItems(boundedInput.decisions).slice(0, 6),
      nextSteps: normalizeItems(boundedInput.nextSteps).slice(0, 6),
      timestamp,
    };
    await appendChangelogEpoch(paths, taskId, epoch);
    changelogAppended = true;
    changelogPath = normalizeRelativePath(
      path.relative(
        paths.projectRoot,
        path.join(paths.projectRoot, updatedMeta.bundle.path, updatedMeta.docs.primary.changelog),
      ),
    );
  }

  let resumeKind: SaveContextCheckpointResult['resumeKind'] = null;
  let resumeOriginalPrompt: string | null = null;
  let resumeGuidance: string | null = null;

  if (input.codexSessionId) {
    const binding = await readCodexSessionBinding(paths, input.codexSessionId);
    if (binding?.taskId === taskId && binding.pendingResume) {
      resumeKind = binding.pendingResume.kind;
      resumeOriginalPrompt = binding.pendingResume.originalPrompt;
      resumeGuidance =
        binding.pendingResume.kind === 'actualization'
          ? 'Checkpoint saved. Reload the bundle and resume the original request only after the narrative docs are current.'
          : 'Checkpoint saved. Reload the bundle and resume the original request if it is still safe to continue.';

      await bindCodexSessionToTask(paths, {
        sessionId: binding.sessionId,
        taskId: binding.taskId,
        source: binding.source,
        bundlePath: binding.bundlePath,
        transcriptPath: binding.transcriptPath,
        transcriptOffset: binding.transcriptOffset,
        estimatedTranscriptTokens: binding.estimatedTranscriptTokens,
        lastAssistantMessage: binding.lastAssistantMessage,
        lastUserPrompt: binding.lastUserPrompt,
        hookEventName: binding.hookEventName,
        pendingResume: null,
      });
    }
  }

  return {
    taskId,
    contextPath: normalizeRelativePath(path.relative(paths.projectRoot, contextPath)),
    statePath: normalizeRelativePath(
      path.relative(paths.projectRoot, resolveTaskStatePath(paths, taskId)),
    ),
    lastCheckpointAt: timestamp,
    needsQualityCheckpoint: nextState.checkpoint.needsQualityCheckpoint,
    warnings,
    changelogAppended,
    changelogPath,
    resumeKind,
    resumeOriginalPrompt,
    resumeGuidance,
  };
}

export function getCheckpointMarkers(): { start: string; end: string } {
  return {
    start: CHECKPOINT_START,
    end: CHECKPOINT_END,
  };
}
