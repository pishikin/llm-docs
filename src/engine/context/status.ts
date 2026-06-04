import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeRelativePath } from '../../utils/fs.js';
import { shouldRequireContextCheckpoint } from '../task/autosave.js';
import { detectStaleContextPlaceholders } from '../task/context-quality.js';
import { readTaskMeta } from '../task/meta.js';
import { readTaskStateOrNull, resolveTaskStatePath } from '../task/state.js';
import type {
  ActiveTaskResolution,
  LlmDocsConfig,
  SimpleTaskState,
  WorkspacePaths,
} from '../types.js';

export type ContextRiskLevel = 'ok' | 'watch' | 'checkpoint' | 'new-thread';

export interface ContextStatusFile {
  path: string;
  kind: 'context' | 'state' | 'changelog' | 'research';
  sizeBytes: number | null;
  budgetBytes: number | null;
  status: 'ok' | 'missing' | 'large';
}

export interface ContextStatusReport {
  schemaVersion: 1;
  projectRoot: string;
  activeTaskId: string | null;
  resolvedBy: ActiveTaskResolution['resolvedBy'] | null;
  risk: ContextRiskLevel;
  recommendation: string;
  reasons: string[];
  reloadFiles: string[];
  warnings: string[];
  files: ContextStatusFile[];
  transcript: {
    estimatedTokens: number | null;
    riskTokens: number;
  };
}

async function fileSize(filePath: string): Promise<number | null> {
  try {
    return (await fs.stat(filePath)).size;
  } catch {
    return null;
  }
}

function statusForSize(
  sizeBytes: number | null,
  budgetBytes: number | null,
): ContextStatusFile['status'] {
  if (sizeBytes === null) {
    return 'missing';
  }

  if (budgetBytes !== null && sizeBytes > budgetBytes) {
    return 'large';
  }

  return 'ok';
}

async function buildFileEntry(args: {
  projectRoot: string;
  filePath: string;
  kind: ContextStatusFile['kind'];
  budgetBytes: number | null;
}): Promise<ContextStatusFile> {
  const sizeBytes = await fileSize(args.filePath);

  return {
    path: normalizeRelativePath(path.relative(args.projectRoot, args.filePath)),
    kind: args.kind,
    sizeBytes,
    budgetBytes: args.budgetBytes,
    status: statusForSize(sizeBytes, args.budgetBytes),
  };
}

async function listResearchFiles(bundlePath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(bundlePath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => /^research-[A-Za-z0-9._-]+\.md$/.test(name))
      .sort((left, right) => left.localeCompare(right))
      .map((name) => path.join(bundlePath, name));
  } catch {
    return [];
  }
}

function raiseRisk(current: ContextRiskLevel, next: ContextRiskLevel): ContextRiskLevel {
  const order: ContextRiskLevel[] = ['ok', 'watch', 'checkpoint', 'new-thread'];
  return order.indexOf(next) > order.indexOf(current) ? next : current;
}

function addUnique(values: string[], value: string): void {
  if (value && !values.includes(value)) {
    values.push(value);
  }
}

function calculateRiskWithReasons(args: {
  config: LlmDocsConfig;
  state: SimpleTaskState | null;
  files: ContextStatusFile[];
  checkpointReasons: string[];
  placeholderWarnings: string[];
}): { risk: ContextRiskLevel; reasons: string[] } {
  let risk: ContextRiskLevel = 'ok';
  const reasons: string[] = [];

  for (const file of args.files) {
    if (file.status === 'missing' && (file.kind === 'context' || file.kind === 'state')) {
      risk = raiseRisk(risk, 'checkpoint');
      addUnique(reasons, `${file.kind} file is missing: ${file.path}`);
    }

    if (file.status === 'large' && file.kind === 'context') {
      risk = raiseRisk(risk, 'checkpoint');
      addUnique(reasons, `context.md exceeds active context budget: ${file.path}`);
    }

    if (file.status === 'large' && file.kind === 'research') {
      risk = raiseRisk(risk, 'watch');
      addUnique(reasons, `research doc exceeds context budget: ${file.path}`);
    }
  }

  for (const reason of args.checkpointReasons) {
    risk = raiseRisk(risk, 'checkpoint');
    addUnique(reasons, reason);
  }

  if (args.state?.checkpoint.needsQualityCheckpoint) {
    risk = raiseRisk(risk, 'checkpoint');
    addUnique(reasons, 'checkpoint state is marked as needing quality refresh');
  }

  if ((args.state?.checkpoint.promptCountSinceCheckpoint ?? 0) >= 3) {
    risk = raiseRisk(risk, 'checkpoint');
    addUnique(reasons, 'three or more user prompts happened after the last checkpoint');
  }

  const estimatedTokens = args.state?.checkpoint.estimatedTranscriptTokens ?? null;
  if (
    estimatedTokens !== null &&
    estimatedTokens >= args.config.contextBudget.transcriptRiskTokens
  ) {
    risk = raiseRisk(risk, 'new-thread');
    addUnique(reasons, 'Codex transcript is near a conservative compaction risk threshold');
  } else if (
    estimatedTokens !== null &&
    estimatedTokens >= Math.floor(args.config.contextBudget.transcriptRiskTokens * 0.8)
  ) {
    risk = raiseRisk(risk, 'checkpoint');
    addUnique(reasons, 'Codex transcript is approaching the compaction risk threshold');
  }

  if (args.placeholderWarnings.length > 0) {
    risk = raiseRisk(risk, 'checkpoint');
    for (const warning of args.placeholderWarnings) {
      addUnique(reasons, warning);
    }
  }

  return { risk, reasons };
}

function recommendationForRisk(risk: ContextRiskLevel): string {
  switch (risk) {
    case 'ok':
      return 'Continue normally.';
    case 'watch':
      return 'Keep context reads narrow; avoid loading large research docs unless needed.';
    case 'checkpoint':
      return 'Save a compact checkpoint before more substantial work.';
    case 'new-thread':
      return 'Save a checkpoint soon. Continue the current request if it is still safe, and prefer a fresh thread before additional long browsing or tool-heavy work.';
  }
}

export async function buildContextStatusReport(args: {
  projectRoot: string;
  config: LlmDocsConfig;
  paths: WorkspacePaths;
  activeTask: ActiveTaskResolution | null;
}): Promise<ContextStatusReport> {
  if (!args.activeTask) {
    return {
      schemaVersion: 1,
      projectRoot: args.projectRoot,
      activeTaskId: null,
      resolvedBy: null,
      risk: 'ok',
      recommendation: 'No active task is resolved.',
      reasons: [],
      reloadFiles: [],
      warnings: [],
      files: [],
      transcript: {
        estimatedTokens: null,
        riskTokens: args.config.contextBudget.transcriptRiskTokens,
      },
    };
  }

  const meta = await readTaskMeta(args.paths, args.activeTask.taskId);
  const state = await readTaskStateOrNull(args.paths, args.activeTask.taskId);
  const bundlePath = path.join(args.projectRoot, meta.bundle.path);
  const contextPath = path.join(bundlePath, meta.docs.primary.context);
  const statePath = resolveTaskStatePath(args.paths, args.activeTask.taskId);
  const changelogPath = path.join(bundlePath, meta.docs.primary.changelog);
  const researchFiles = await listResearchFiles(bundlePath);
  const files = [
    await buildFileEntry({
      projectRoot: args.projectRoot,
      filePath: contextPath,
      kind: 'context',
      budgetBytes: args.config.contextBudget.activeContextMaxBytes,
    }),
    await buildFileEntry({
      projectRoot: args.projectRoot,
      filePath: statePath,
      kind: 'state',
      budgetBytes: null,
    }),
    await buildFileEntry({
      projectRoot: args.projectRoot,
      filePath: changelogPath,
      kind: 'changelog',
      budgetBytes: null,
    }),
    ...(await Promise.all(
      researchFiles.map((filePath) =>
        buildFileEntry({
          projectRoot: args.projectRoot,
          filePath,
          kind: 'research',
          budgetBytes: args.config.contextBudget.researchDocMaxBytes,
        }),
      ),
    )),
  ];
  const contextContent = await fs.readFile(contextPath, 'utf-8').catch(() => '');
  const placeholderWarnings = contextContent ? detectStaleContextPlaceholders(contextContent) : [];
  const checkpoint = await shouldRequireContextCheckpoint(
    args.projectRoot,
    args.config,
    args.paths,
    args.activeTask.taskId,
  ).catch(() => ({
    required: false,
    blockingReasons: [],
    advisoryReasons: [],
    reasons: [],
    warningKey: null,
  }));
  const riskResult = calculateRiskWithReasons({
    config: args.config,
    state,
    files,
    checkpointReasons: checkpoint.blockingReasons,
    placeholderWarnings,
  });
  const reloadFiles = [contextPath, statePath, changelogPath].map((filePath) =>
    normalizeRelativePath(path.relative(args.projectRoot, filePath)),
  );

  return {
    schemaVersion: 1,
    projectRoot: args.projectRoot,
    activeTaskId: args.activeTask.taskId,
    resolvedBy: args.activeTask.resolvedBy,
    risk: riskResult.risk,
    recommendation: recommendationForRisk(riskResult.risk),
    reasons: riskResult.reasons,
    reloadFiles,
    warnings: placeholderWarnings,
    files,
    transcript: {
      estimatedTokens: state?.checkpoint.estimatedTranscriptTokens ?? null,
      riskTokens: args.config.contextBudget.transcriptRiskTokens,
    },
  };
}
