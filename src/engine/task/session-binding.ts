import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeRelativePath, readFileSafe, writeJsonAtomic } from '../../utils/fs.js';
import type { ActiveTaskResolution, WorkspacePaths } from '../types.js';
import { normalizeTaskId } from './id.js';

export type CodexSessionBindingSource =
  | ActiveTaskResolution['resolvedBy']
  | 'explicit-user-intent'
  | 'autosave'
  | 'user-pause';

export interface CodexPendingResume {
  kind: 'checkpoint' | 'actualization';
  capturedAt: string;
  originalPrompt: string | null;
}

export interface CodexSessionBinding {
  schemaVersion: 1;
  host: 'codex';
  sessionId: string;
  taskId: string | null;
  paused?: boolean;
  boundAt: string;
  updatedAt: string;
  source: CodexSessionBindingSource;
  bundlePath: string | null;
  transcriptPath: string | null;
  transcriptOffset: number | null;
  estimatedTranscriptTokens: number | null;
  lastAssistantMessage: string | null;
  lastUserPrompt: string | null;
  hookEventName: string | null;
  pendingResume: CodexPendingResume | null;
}

export interface BindCodexSessionInput {
  sessionId: string;
  taskId: string;
  source: CodexSessionBindingSource;
  bundlePath?: string | null;
  transcriptPath?: string | null;
  transcriptOffset?: number | null;
  estimatedTranscriptTokens?: number | null;
  lastAssistantMessage?: string | null;
  lastUserPrompt?: string | null;
  hookEventName?: string | null;
  pendingResume?: CodexPendingResume | null;
}

export interface PauseCodexSessionInput {
  sessionId: string;
  source?: 'user-pause';
}

const MAX_PROMPT_PREVIEW_CHARS = 2000;

export function normalizeCodexSessionId(sessionId: string): string {
  const value = sessionId.trim();
  if (!value) {
    throw new Error('Codex session id is empty.');
  }
  return value;
}

export function resolveCodexSessionIdFromEnv(): string | null {
  return (
    process.env.LLMDOCS_CODEX_SESSION_ID?.trim() || process.env.CODEX_SESSION_ID?.trim() || null
  );
}

function safeSessionFileName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'session';
}

function normalizePromptPreview(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return null;
  }

  return compact.length > MAX_PROMPT_PREVIEW_CHARS
    ? `${compact.slice(0, MAX_PROMPT_PREVIEW_CHARS - 1)}…`
    : compact;
}

export function resolveCodexSessionBindingPath(paths: WorkspacePaths, sessionId: string): string {
  return path.join(
    paths.workspaceRoot,
    '.llm-docs/runtime/codex/sessions',
    `${safeSessionFileName(normalizeCodexSessionId(sessionId))}.json`,
  );
}

export function codexSessionBindingRelativePath(paths: WorkspacePaths, sessionId: string): string {
  return normalizeRelativePath(
    path.relative(paths.projectRoot, resolveCodexSessionBindingPath(paths, sessionId)),
  );
}

function isBinding(value: unknown): value is CodexSessionBinding {
  const candidate = value as Partial<CodexSessionBinding>;
  const taskIdValid =
    typeof candidate?.taskId === 'string' ||
    (candidate?.taskId === null && candidate.paused === true);

  return (
    candidate?.schemaVersion === 1 &&
    candidate.host === 'codex' &&
    typeof candidate.sessionId === 'string' &&
    taskIdValid &&
    typeof candidate.boundAt === 'string' &&
    typeof candidate.updatedAt === 'string' &&
    typeof candidate.source === 'string'
  );
}

function normalizePendingResume(value: unknown): CodexPendingResume | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<CodexPendingResume>;
  if (
    (candidate.kind !== 'checkpoint' && candidate.kind !== 'actualization') ||
    typeof candidate.capturedAt !== 'string'
  ) {
    return null;
  }

  return {
    kind: candidate.kind,
    capturedAt: candidate.capturedAt,
    originalPrompt:
      typeof candidate.originalPrompt === 'string'
        ? normalizePromptPreview(candidate.originalPrompt)
        : null,
  };
}

export async function readCodexSessionBinding(
  paths: WorkspacePaths,
  sessionId: string,
): Promise<CodexSessionBinding | null> {
  const content = await readFileSafe(resolveCodexSessionBindingPath(paths, sessionId));
  if (!content) {
    return null;
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isBinding(parsed)) {
      return null;
    }

    return {
      ...parsed,
      sessionId: normalizeCodexSessionId(parsed.sessionId),
      taskId: parsed.taskId === null ? null : normalizeTaskId(parsed.taskId),
      paused: parsed.paused === true,
      bundlePath: parsed.bundlePath ?? null,
      transcriptPath: parsed.transcriptPath ?? null,
      transcriptOffset: parsed.transcriptOffset ?? null,
      estimatedTranscriptTokens: parsed.estimatedTranscriptTokens ?? null,
      lastAssistantMessage: parsed.lastAssistantMessage ?? null,
      lastUserPrompt: normalizePromptPreview(parsed.lastUserPrompt),
      hookEventName: parsed.hookEventName ?? null,
      pendingResume: normalizePendingResume(parsed.pendingResume),
    };
  } catch {
    return null;
  }
}

export async function bindCodexSessionToTask(
  paths: WorkspacePaths,
  input: BindCodexSessionInput,
): Promise<CodexSessionBinding> {
  const sessionId = normalizeCodexSessionId(input.sessionId);
  const taskId = normalizeTaskId(input.taskId);
  const existing = await readCodexSessionBinding(paths, sessionId);
  const now = new Date().toISOString();
  const keepBoundAt = existing?.taskId === taskId ? existing.boundAt : now;
  const source =
    input.source === 'autosave' && existing?.taskId === taskId ? existing.source : input.source;
  const binding: CodexSessionBinding = {
    schemaVersion: 1,
    host: 'codex',
    sessionId,
    taskId,
    paused: false,
    boundAt: keepBoundAt,
    updatedAt: now,
    source,
    bundlePath: input.bundlePath ?? existing?.bundlePath ?? null,
    transcriptPath: input.transcriptPath ?? existing?.transcriptPath ?? null,
    transcriptOffset: input.transcriptOffset ?? existing?.transcriptOffset ?? null,
    estimatedTranscriptTokens:
      input.estimatedTranscriptTokens ?? existing?.estimatedTranscriptTokens ?? null,
    lastAssistantMessage: input.lastAssistantMessage ?? existing?.lastAssistantMessage ?? null,
    lastUserPrompt:
      input.lastUserPrompt === undefined
        ? (existing?.lastUserPrompt ?? null)
        : normalizePromptPreview(input.lastUserPrompt),
    hookEventName: input.hookEventName ?? existing?.hookEventName ?? null,
    pendingResume:
      input.pendingResume === undefined
        ? (existing?.pendingResume ?? null)
        : normalizePendingResume(input.pendingResume),
  };

  await writeJsonAtomic(resolveCodexSessionBindingPath(paths, sessionId), binding);
  return binding;
}

export async function pauseCodexSessionBinding(
  paths: WorkspacePaths,
  input: PauseCodexSessionInput,
): Promise<CodexSessionBinding> {
  const sessionId = normalizeCodexSessionId(input.sessionId);
  const existing = await readCodexSessionBinding(paths, sessionId);
  const now = new Date().toISOString();
  const binding: CodexSessionBinding = {
    schemaVersion: 1,
    host: 'codex',
    sessionId,
    taskId: null,
    paused: true,
    boundAt: existing?.boundAt ?? now,
    updatedAt: now,
    source: input.source ?? 'user-pause',
    bundlePath: null,
    transcriptPath: existing?.transcriptPath ?? null,
    transcriptOffset: existing?.transcriptOffset ?? null,
    estimatedTranscriptTokens: existing?.estimatedTranscriptTokens ?? null,
    lastAssistantMessage: existing?.lastAssistantMessage ?? null,
    lastUserPrompt: existing?.lastUserPrompt ?? null,
    hookEventName: existing?.hookEventName ?? null,
    pendingResume: null,
  };

  await writeJsonAtomic(resolveCodexSessionBindingPath(paths, sessionId), binding);
  return binding;
}

export async function rememberCodexUserPrompt(
  paths: WorkspacePaths,
  input: BindCodexSessionInput & { lastUserPrompt: string },
): Promise<CodexSessionBinding> {
  return bindCodexSessionToTask(paths, {
    ...input,
    lastUserPrompt: input.lastUserPrompt,
    pendingResume: null,
  });
}

export async function setCodexPendingResume(
  paths: WorkspacePaths,
  input: BindCodexSessionInput & {
    kind: CodexPendingResume['kind'];
    originalPrompt: string | null;
  },
): Promise<CodexSessionBinding> {
  return bindCodexSessionToTask(paths, {
    ...input,
    pendingResume: {
      kind: input.kind,
      capturedAt: new Date().toISOString(),
      originalPrompt: normalizePromptPreview(input.originalPrompt),
    },
  });
}

export async function clearCodexSessionBinding(
  paths: WorkspacePaths,
  sessionId: string,
): Promise<void> {
  await fs.rm(resolveCodexSessionBindingPath(paths, sessionId), { force: true });
}
