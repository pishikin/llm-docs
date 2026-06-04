import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Command } from 'commander';
import type { LlmDocsRuntime } from '../../engine/runtime.js';
import {
  markPromptSeen,
  saveCodexAutosaveSnapshot,
  shouldRequireContextCheckpoint,
  watchCodexTranscript,
} from '../../engine/task/autosave.js';
import { protectedBaseBranches } from '../../engine/task/branches.js';
import { updateTaskMeta } from '../../engine/task/meta.js';
import { syncRegistryFromMeta } from '../../engine/task/registry.js';
import {
  type CodexSessionBindingSource,
  codexSessionBindingRelativePath,
  readCodexSessionBinding,
  rememberCodexUserPrompt,
  setCodexPendingResume,
} from '../../engine/task/session-binding.js';
import type { ActiveResolutionPolicy, ActiveTaskResolution, TaskMeta } from '../../engine/types.js';
import { getRuntimeOrNull, readJsonStdin, writeJsonResponse, writeTextResponse } from './common.js';

const CODEX_HOOK_ACTIVE_RESOLUTION_POLICY: ActiveResolutionPolicy = {
  includeExplicit: true,
  includeCodexSession: true,
  includeEnv: true,
  includeWorkspaceActive: true,
  includeRegistryActive: true,
  includeBranchName: true,
  includeBranchMapping: true,
  includeCwdBundle: true,
  includeFallbackBranchScan: true,
  bindCodexSession: true,
  protectedBranchBehavior: 'session-or-explicit',
};

interface HookPayload {
  hook_event_name?: string;
  prompt?: string;
  strict?: boolean;
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  last_assistant_message?: string;
  source?: string;
}

type HookHost = 'claude' | 'codex';

function isTaskIntent(prompt: string): boolean {
  return (
    /\b(task|bundle|context|changelog|actualiz|rebaseline)\b/i.test(prompt) ||
    /задач|таск|бандл|контекст|чейнджлог|актуализ|ребейзлайн|артефакт/i.test(prompt)
  );
}

function isCodingWork(prompt: string): boolean {
  return (
    /\b(implement|fix|refactor|debug|test|write|change|update)\b/i.test(prompt) ||
    /код|реализ|почин|рефактор|обнови|измени|правк|тест/i.test(prompt)
  );
}

function formatShortTaskCard(meta: TaskMeta): string {
  const staleLine = meta.staleness.needs_actualization
    ? `Stale: yes (${meta.staleness.reasons.join('; ') || 'unknown reason'})`
    : 'Stale: no';

  return [
    `Active task: ${meta.task_id}`,
    `Title: ${meta.title}`,
    `Phase: ${meta.phase}`,
    `Status: ${meta.status}`,
    `Branch: ${meta.branch.current ?? 'n/a'}`,
    `Context: ${path.posix.join(meta.bundle.path, meta.docs.primary.context)}`,
    staleLine,
  ].join('\n');
}

function formatCodexSessionLine(runtime: LlmDocsRuntime, payload: HookPayload): string | null {
  if (!payload.session_id) {
    return null;
  }

  return `Codex session binding: ${codexSessionBindingRelativePath(runtime.paths, payload.session_id)}`;
}

function buildReloadFiles(meta: TaskMeta): string[] {
  return [
    path.posix.join(meta.bundle.path, meta.docs.primary.context),
    path.posix.join(meta.bundle.path, 'state.json'),
    path.posix.join(meta.bundle.path, meta.docs.primary.changelog),
  ];
}

function formatReloadBlock(meta: TaskMeta, afterCheckpoint = false): string {
  return [
    afterCheckpoint ? 'After saving, refresh from:' : 'Refresh from:',
    ...buildReloadFiles(meta).map((file) => `- ${file}`),
    'Continue from Current Working State / Latest Checkpoint. Ignore stale earlier next steps if they conflict.',
  ].join('\n');
}

function hasCompactionRiskReason(reasons: string[]): boolean {
  return reasons.some((reason) => reason.includes('compaction risk threshold'));
}

function formatCheckpointInstruction(
  meta: TaskMeta,
  reasons: string[],
  options: {
    severity?: 'required' | 'recommended';
    includeResumeHint?: boolean;
    includeFreshThreadHint?: boolean;
    codexSessionId?: string | null;
    originalPrompt?: string | null;
  } = {},
): string {
  const reasonLines =
    reasons.length > 0 ? ['Reasons:', ...reasons.map((reason) => `- ${reason}`)] : [];
  const severity = options.severity ?? 'required';
  const resumeLine = options.includeResumeHint
    ? "After saving the checkpoint, reload the task bundle and resume the user's interrupted request in this thread if it is still safe to continue. Do not treat the checkpoint itself as the task outcome."
    : null;
  const freshThreadLine = options.includeFreshThreadHint
    ? 'If the remaining work still needs more browsing or long tool output after resuming, prefer a fresh thread started from the refreshed checkpoint.'
    : null;

  return [
    severity === 'required'
      ? `Active task ${meta.task_id} needs a context checkpoint before continuing.`
      : `Active task ${meta.task_id} should save a context checkpoint before compaction or further long-context work.`,
    ...reasonLines,
    `Call llmdocs.save_context_checkpoint with taskId: ${meta.task_id}${options.codexSessionId ? ` and codexSessionId: ${options.codexSessionId}` : ''}.`,
    'Include: source requirements, prepared plan, user-facing behavior, implementation details/map, decisions, touched files, verification, validation gaps, risks, and next steps when available.',
    'Keep each section concise (3-7 bullets), grouped, and evidence-based; do not dump transcripts or raw diffs.',
    'For milestone/handoff/publish checkpoints, set checkpointKind and appendChangelog when the milestone should be durable.',
    'A state.json-only stale marker is not a narrative update; make context.md/changelog.md useful before handoff.',
    formatReloadBlock(meta, true),
    options.originalPrompt
      ? `Resume original user request after checkpoint: ${options.originalPrompt}`
      : null,
    resumeLine,
    freshThreadLine,
  ]
    .filter(Boolean)
    .join('\n');
}

function formatStaleActualizationInstruction(
  meta: TaskMeta,
  options: { originalPrompt?: string | null } = {},
): string {
  const reasonLines =
    meta.staleness.reasons.length > 0
      ? ['Reasons:', ...meta.staleness.reasons.map((reason) => `- ${reason}`)]
      : [];

  return [
    `Active task ${meta.task_id} is stale. Do not close or continue substantial work with only state.json updated.`,
    ...reasonLines,
    'Inspect the current source state, then update the human task docs: context.md, changelog.md, summary/implementation/verification docs as needed.',
    'After the narrative docs reflect current implementation truth, apply actualization state so staleness clears.',
    formatReloadBlock(meta),
    options.originalPrompt
      ? `Resume original user request after actualization: ${options.originalPrompt}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function writeCodexStopBlock(reason: string): void {
  // Codex Stop continuation contract: decision=block keeps the turn alive with a reason.
  writeJsonResponse({ decision: 'block', reason });
}

async function resolveActiveTaskMeta(
  runtime: LlmDocsRuntime,
  payload: HookPayload = {},
  host?: HookHost,
): Promise<{
  resolution: ActiveTaskResolution;
  meta: TaskMeta;
} | null> {
  const resolution = await runtime.resolveActiveTask({
    preferRegistryActive: true,
    codexSessionId: host === 'codex' ? payload.session_id : null,
    bindCodexSession: host === 'codex',
    cwd: payload.cwd,
    policy: host === 'codex' ? CODEX_HOOK_ACTIVE_RESOLUTION_POLICY : undefined,
  });
  if (!resolution) {
    return null;
  }

  return {
    resolution,
    meta: await runtime.readTaskMeta(resolution.taskId),
  };
}

function bindingSourceForResolution(resolution: ActiveTaskResolution): CodexSessionBindingSource {
  return resolution.resolvedBy === 'explicit' ? 'explicit-user-intent' : resolution.resolvedBy;
}

function startCodexWatcher(runtime: LlmDocsRuntime, taskId: string, payload: HookPayload): void {
  if (!payload.session_id || !payload.transcript_path || !process.argv[1]) {
    return;
  }

  const child = spawn(
    process.execPath,
    [
      process.argv[1],
      'internal',
      'codex-watch',
      '--task-id',
      taskId,
      '--session-id',
      payload.session_id,
      '--transcript-path',
      payload.transcript_path,
    ],
    {
      cwd: runtime.projectRoot,
      detached: true,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      stdio: 'ignore',
    },
  );
  child.unref();
}

async function saveCodexSnapshotIfPossible(
  runtime: LlmDocsRuntime,
  taskId: string,
  payload: HookPayload,
): Promise<void> {
  if (!payload.session_id || !payload.transcript_path) {
    return;
  }

  await saveCodexAutosaveSnapshot(runtime.paths, taskId, {
    sessionId: payload.session_id,
    transcriptPath: payload.transcript_path,
    hookEventName: payload.hook_event_name,
    lastAssistantMessage: payload.last_assistant_message,
  });
}

export async function handleSessionStart(options: { host?: HookHost } = {}): Promise<void> {
  const payload = (await readJsonStdin<HookPayload>()) ?? {};
  const runtime = await getRuntimeOrNull();
  if (!runtime) {
    return;
  }

  const active = await resolveActiveTaskMeta(runtime, payload, options.host);
  if (!active) {
    return;
  }

  if (options.host === 'codex') {
    await saveCodexSnapshotIfPossible(runtime, active.meta.task_id, payload);
    startCodexWatcher(runtime, active.meta.task_id, payload);
  }

  writeTextResponse(
    [formatShortTaskCard(active.meta), formatCodexSessionLine(runtime, payload)]
      .filter(Boolean)
      .join('\n'),
  );
}

export async function handleUserPromptSubmit(options: { host?: HookHost } = {}): Promise<void> {
  const payload = (await readJsonStdin<HookPayload>()) ?? {};
  const prompt = payload.prompt?.trim() ?? '';
  const runtime = await getRuntimeOrNull();
  const host = options.host ?? 'claude';

  if (!runtime || !prompt) {
    return;
  }

  const active = await resolveActiveTaskMeta(runtime, payload, host);

  if (!active && isTaskIntent(prompt) && host !== 'codex') {
    const sessionHint = '';
    writeTextResponse(
      `No active task bundle is resolved. Create or resolve a task bundle before substantial task work.${sessionHint}`,
    );
    return;
  }

  if (active && options.host === 'codex') {
    await saveCodexSnapshotIfPossible(runtime, active.meta.task_id, payload);
    if (payload.session_id) {
      await rememberCodexUserPrompt(runtime.paths, {
        sessionId: payload.session_id,
        taskId: active.meta.task_id,
        source: bindingSourceForResolution(active.resolution),
        bundlePath: active.meta.bundle.path,
        transcriptPath: payload.transcript_path ?? null,
        lastUserPrompt: prompt,
      });
    }
    await markPromptSeen(runtime.paths, active.meta.task_id, isCodingWork(prompt));

    if (active.meta.staleness.needs_actualization && isCodingWork(prompt)) {
      return;
    }

    const checkpoint = await shouldRequireContextCheckpoint(
      runtime.projectRoot,
      runtime.config,
      runtime.paths,
      active.meta.task_id,
    );

    if (checkpoint.required) {
      return;
    }
  }

  if (active?.meta.staleness.needs_actualization && isCodingWork(prompt)) {
    writeTextResponse(formatStaleActualizationInstruction(active.meta));
    return;
  }
}

export async function handleStop(options: { host?: HookHost } = {}): Promise<void> {
  const payload = (await readJsonStdin<HookPayload>()) ?? {};
  const runtime = await getRuntimeOrNull();
  const host = options.host ?? 'claude';

  if (!runtime) {
    if (host === 'codex') {
      writeJsonResponse({ continue: true });
    }
    return;
  }

  const active = await resolveActiveTaskMeta(runtime, payload, host);
  const originalPrompt =
    host === 'codex' && payload.session_id
      ? ((await readCodexSessionBinding(runtime.paths, payload.session_id))?.lastUserPrompt ?? null)
      : null;
  if (!active || !active.meta.staleness.needs_actualization) {
    if (!active) {
      if (host === 'codex') {
        writeJsonResponse({ continue: true });
      }
      return;
    }

    if (host === 'codex') {
      await saveCodexSnapshotIfPossible(runtime, active.meta.task_id, payload);
    }

    const checkpoint = await shouldRequireContextCheckpoint(
      runtime.projectRoot,
      runtime.config,
      runtime.paths,
      active.meta.task_id,
    );

    if (!checkpoint.required) {
      if (host === 'codex') {
        writeJsonResponse({ continue: true });
      }
      return;
    }

    const message = formatCheckpointInstruction(active.meta, checkpoint.reasons, {
      includeResumeHint: true,
      includeFreshThreadHint: hasCompactionRiskReason(checkpoint.advisoryReasons),
      codexSessionId: payload.session_id ?? null,
      originalPrompt,
    });
    if (host === 'codex') {
      if (payload.session_id) {
        await setCodexPendingResume(runtime.paths, {
          sessionId: payload.session_id,
          taskId: active.meta.task_id,
          source: bindingSourceForResolution(active.resolution),
          bundlePath: active.meta.bundle.path,
          transcriptPath: payload.transcript_path ?? null,
          kind: 'checkpoint',
          originalPrompt,
        });
      }
      writeCodexStopBlock(message);
      return;
    }
    if (payload.strict || process.env.LLMDOCS_HOOK_STRICT === '1') {
      writeJsonResponse({ continue: false, message });
      return;
    }

    writeTextResponse(message);
    return;
  }

  const message = formatStaleActualizationInstruction(active.meta, {
    originalPrompt,
  });
  if (host === 'codex') {
    if (payload.session_id) {
      await setCodexPendingResume(runtime.paths, {
        sessionId: payload.session_id,
        taskId: active.meta.task_id,
        source: bindingSourceForResolution(active.resolution),
        bundlePath: active.meta.bundle.path,
        transcriptPath: payload.transcript_path ?? null,
        kind: 'actualization',
        originalPrompt,
      });
    }
    writeCodexStopBlock(message);
    return;
  }
  if (payload.strict || process.env.LLMDOCS_HOOK_STRICT === '1') {
    writeJsonResponse({ continue: false, message });
    return;
  }

  writeTextResponse(message);
}

export async function handleCodexStop(): Promise<void> {
  try {
    await handleStop({ host: 'codex' });
  } catch (error) {
    console.error(
      `llm-docs codex-stop hook failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    writeJsonResponse({ continue: true });
  }
}

export async function handlePreCompact(options: { host?: HookHost } = {}): Promise<void> {
  const payload = (await readJsonStdin<HookPayload>()) ?? {};
  const runtime = await getRuntimeOrNull();
  const host = options.host ?? 'claude';

  if (!runtime) {
    return;
  }

  const active = await resolveActiveTaskMeta(runtime, payload, host);
  if (!active) {
    return;
  }

  const checkpoint = await shouldRequireContextCheckpoint(
    runtime.projectRoot,
    runtime.config,
    runtime.paths,
    active.meta.task_id,
  );
  if (checkpoint.reasons.length === 0) {
    return;
  }

  const message = formatCheckpointInstruction(active.meta, checkpoint.reasons, {
    severity: checkpoint.required ? 'required' : 'recommended',
    includeFreshThreadHint: hasCompactionRiskReason(checkpoint.advisoryReasons),
  });

  if (host === 'codex' || payload.strict || process.env.LLMDOCS_HOOK_STRICT === '1') {
    writeJsonResponse({ continue: false, message });
    return;
  }

  writeTextResponse(message);
}

export async function markTaskStale(
  runtime: LlmDocsRuntime,
  taskId: string,
  reason: string,
  updateBranch = true,
): Promise<TaskMeta> {
  const gitFacts = await import('../../engine/git/status.js').then(({ buildGitFacts }) =>
    buildGitFacts(runtime.projectRoot, { config: runtime.config }),
  );
  const meta = await updateTaskMeta(runtime.paths, taskId, (current) => ({
    ...current,
    branch: updateBranch
      ? {
          ...current.branch,
          current: gitFacts.branch,
        }
      : current.branch,
    staleness: {
      needs_actualization: true,
      reasons: [...new Set([...current.staleness.reasons, reason])],
      last_checked_at: new Date().toISOString(),
    },
  }));
  await syncRegistryFromMeta(runtime.paths, meta, {
    skipBranches: [...protectedBaseBranches(runtime.config)],
  });
  return meta;
}

export function registerHostHookCommands(group: Command): void {
  group
    .command('claude-session-start')
    .description('Internal Claude hook: session start')
    .action(async () => {
      await handleSessionStart({ host: 'claude' });
    });

  group
    .command('claude-user-prompt-submit')
    .description('Internal Claude hook: prompt submit')
    .action(async () => {
      await handleUserPromptSubmit({ host: 'claude' });
    });

  group
    .command('claude-pre-compact')
    .description('Internal Claude hook: pre compact')
    .action(async () => {
      await handlePreCompact({ host: 'claude' });
    });

  group
    .command('claude-stop')
    .description('Internal Claude hook: stop')
    .action(async () => {
      await handleStop({ host: 'claude' });
    });

  group
    .command('codex-session-start')
    .description('Internal Codex hook: session start')
    .action(async () => {
      await handleSessionStart({ host: 'codex' });
    });

  group
    .command('codex-user-prompt-submit')
    .description('Internal Codex hook: prompt submit')
    .action(async () => {
      await handleUserPromptSubmit({ host: 'codex' });
    });

  group
    .command('codex-stop')
    .description('Internal Codex hook: stop')
    .action(async () => {
      await handleCodexStop();
    });

  group
    .command('codex-watch')
    .description('Internal Codex watcher: save transcript autosave snapshots')
    .option('--task-id <taskId>')
    .requiredOption('--session-id <sessionId>')
    .requiredOption('--transcript-path <path>')
    .option('--once', 'save one snapshot and exit')
    .option('--interval-ms <ms>', 'watch interval in milliseconds', Number.parseInt)
    .option('--timeout-ms <ms>', 'watch timeout in milliseconds', Number.parseInt)
    .action(
      async (options: {
        taskId: string;
        sessionId: string;
        transcriptPath: string;
        once?: boolean;
        intervalMs?: number;
        timeoutMs?: number;
      }) => {
        const runtime = await getRuntimeOrNull();
        if (!runtime) {
          return;
        }

        await watchCodexTranscript(runtime.paths, options.taskId ?? null, {
          sessionId: options.sessionId,
          transcriptPath: options.transcriptPath,
          once: options.once,
          intervalMs: options.intervalMs,
          timeoutMs: options.timeoutMs,
        });
      },
    );
}
