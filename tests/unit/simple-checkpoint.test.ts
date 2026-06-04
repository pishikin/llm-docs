import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';
import { createRuntime } from '../../src/engine/runtime.js';
import {
  markContextWarningSeen,
  markPromptSeen,
  saveCodexAutosaveSnapshot,
  shouldRequireContextCheckpoint,
} from '../../src/engine/task/autosave.js';
import { readTaskMeta, setTaskStaleness } from '../../src/engine/task/meta.js';
import {
  bindCodexSessionToTask,
  readCodexSessionBinding,
} from '../../src/engine/task/session-binding.js';
import { readTaskState } from '../../src/engine/task/state.js';
import { bootstrapWorkspace } from '../../src/engine/workspace/bootstrap.js';
import { initGitRepo, makeTempProject, prepareWorkspace } from './test-helpers.js';

async function commitAll(projectRoot: string, message: string): Promise<void> {
  const git = simpleGit(projectRoot);
  await git.add('.');
  await git.commit(message);
}

describe('simple task checkpoints', () => {
  it('creates simple active state and resolves it through the active file', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot, 'ABC-123');
    const { config, paths } = await prepareWorkspace(projectRoot);
    await bootstrapWorkspace(projectRoot, config);
    const runtime = await createRuntime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Compact-safe context',
      source: { type: 'prompt', ref: null, url: null, rawText: 'context checkpoint flow' },
    });

    const resolved = await runtime.resolveActiveTask({ preferRegistryActive: false });
    const state = await readTaskState(paths, 'ABC-123');

    expect(resolved?.resolvedBy).toBe('active-file');
    expect(state.docs.context).toBe('context.md');
    expect(state.qualityProfile).toBe('normal');
    expect(state.truth.sourceOfTruthDocs).toEqual(['context.md', 'raw.md', 'changelog.md']);
    expect(await fs.readdir(path.join(projectRoot, '.claude/.llm-docs/tasks/ABC-123'))).toEqual(
      expect.arrayContaining(['context.md', 'raw.md', 'changelog.md', 'state.json']),
    );
    const context = await fs.readFile(
      path.join(projectRoot, '.claude/.llm-docs/tasks/ABC-123/context.md'),
      'utf-8',
    );
    expect(context).toContain('## Original Request / Source Brief');
    expect(context).toContain('context checkpoint flow');
    expect(context).toContain('## Prepared Plan');
    expect(context).toContain('## Implementation Notes');
  });

  it('saves a checkpoint into context.md without marking the task actualized', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    const { config } = await prepareWorkspace(projectRoot);
    await bootstrapWorkspace(projectRoot, config);
    const runtime = await createRuntime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Checkpoint updates context',
      source: { type: 'prompt', ref: null, url: null, rawText: 'checkpoint flow' },
    });
    await setTaskStaleness(runtime.paths, 'ABC-123', true, ['test stale reason']);

    const result = await runtime.saveContextCheckpoint('ABC-123', {
      summary: ['Implemented checkpoint writer.'],
      currentState: ['Context is now compact and current.'],
      decisions: ['Keep checkpoint separate from actualization.'],
      files: ['src/engine/task/checkpoint.ts'],
      verification: ['npm run typecheck'],
      nextSteps: ['Run validation.'],
    });
    const context = await fs.readFile(path.join(projectRoot, result.contextPath), 'utf-8');
    const meta = await readTaskMeta(runtime.paths, 'ABC-123');
    const state = await readTaskState(runtime.paths, 'ABC-123');

    expect(context).toContain('Implemented checkpoint writer.');
    expect(meta.staleness.needs_actualization).toBe(true);
    expect(meta.staleness.reasons).toContain('test stale reason');
    expect(state.checkpoint.needsQualityCheckpoint).toBe(false);
    expect(state.checkpoint.lastCheckpointAt).toBe(result.lastCheckpointAt);
    expect(result.warnings).toEqual([]);
  });

  it('records richer semantic checkpoint sections without requiring a long-task profile', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    const { config } = await prepareWorkspace(projectRoot);
    await bootstrapWorkspace(projectRoot, config);
    const runtime = await createRuntime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Rich default checkpoint',
      source: { type: 'prompt', ref: null, url: null, rawText: 'Implement a richer bundle.' },
    });

    const result = await runtime.saveContextCheckpoint('ABC-123', {
      checkpointKind: 'milestone',
      summary: ['Rich bundle sections are now part of the default checkpoint contract.'],
      currentState: ['Implementation is in progress.'],
      requirements: ['Preserve the original task request in a compact source brief.'],
      plan: ['Create semantic context sections before coding continues.'],
      userFacingBehavior: [
        'Future agents can reload the task from context.md without reading every file.',
      ],
      implementationDetails: ['Checkpoint payload supports structured implementation details.'],
      implementationMap: ['Task docs: context.md, raw.md, changelog.md'],
      decisions: ['Make normal profile richer by default, not only large-ui.'],
      designConstraints: ['Do not dump raw transcripts into the bundle.'],
      superseded: [
        'Old empty simple template is replaced by a source/plan/implementation skeleton.',
      ],
      files: ['src/engine/templates/simple-context.ts'],
      verification: ['vitest focused checkpoint test'],
      validationGaps: ['Full integration suite may still need separate validation.'],
      nextSteps: ['Run typecheck and focused tests.'],
    });
    const context = await fs.readFile(path.join(projectRoot, result.contextPath), 'utf-8');

    expect(context).toContain('### Requirements / Source Brief');
    expect(context).toContain('Preserve the original task request');
    expect(context).toContain('### Prepared Plan');
    expect(context).toContain('### User-Facing Behavior');
    expect(context).toContain('### Implementation Details');
    expect(context).toContain('### Superseded / Historical Notes');
    expect(result.warnings).toEqual([]);
  });

  it('updates Current Working State and removes stale starter placeholders', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    const { config } = await prepareWorkspace(projectRoot);
    await bootstrapWorkspace(projectRoot, config);
    const runtime = await createRuntime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Cleanup starter context',
      source: { type: 'prompt', ref: null, url: null, rawText: 'cleanup starter context' },
    });

    const result = await runtime.saveContextCheckpoint('ABC-123', {
      summary: ['Starter placeholders were replaced with live task facts.'],
      currentState: ['Context reflects the latest checkpoint.'],
      decisions: ['Use a managed Current Working State block.'],
      files: ['src/engine/task/context-quality.ts'],
      verification: ['npm run typecheck'],
      risks: ['No known residual risk.'],
      nextSteps: ['Continue from the managed context block.'],
    });
    const context = await fs.readFile(path.join(projectRoot, result.contextPath), 'utf-8');

    expect(context).toContain('<!-- llm-docs:current-state:start -->');
    expect(context).toContain('## Current Working State');
    expect(context).toContain('Starter placeholders were replaced with live task facts.');
    expect(context).toContain('Use a managed Current Working State block.');
    expect(context).not.toContain('## Decisions\n- none');
    expect(context).not.toContain('## Files\n- none');
    expect(context).not.toContain('## Verification\n- not run yet');
    expect(context).not.toContain('Define the first implementation step.');
  });

  it('caps checkpoint bullets before writing context.md', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    const { config } = await prepareWorkspace(projectRoot, {
      contextBudget: {
        activeContextMaxBytes: 10000,
        researchDocMaxBytes: 24000,
        checkpointMaxBytes: 10000,
        checkpointMaxBullets: 2,
        transcriptRiskTokens: 50000,
      },
    });
    await bootstrapWorkspace(projectRoot, config);
    const runtime = await createRuntime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Checkpoint caps',
      source: { type: 'prompt', ref: null, url: null, rawText: 'checkpoint cap flow' },
    });

    const result = await runtime.saveContextCheckpoint('ABC-123', {
      summary: ['first item', 'second item', 'third item'],
      nextSteps: ['should be omitted'],
    });
    const context = await fs.readFile(path.join(projectRoot, result.contextPath), 'utf-8');

    expect(context).toContain('first item');
    expect(context).toContain('second item');
    expect(context).not.toContain('third item');
    expect(context).not.toContain('should be omitted');
  });

  it('appends a compact changelog epoch for explicit long-task checkpoints', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    const { config } = await prepareWorkspace(projectRoot);
    await bootstrapWorkspace(projectRoot, config);
    const runtime = await createRuntime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Long UI checkpoint',
      source: { type: 'prompt', ref: null, url: null, rawText: 'long checkpoint flow' },
    });

    const result = await runtime.saveContextCheckpoint('ABC-123', {
      timestamp: '2026-05-25T12:00:00.000Z',
      checkpointKind: 'milestone',
      phaseLabel: 'alpha wizard shipped',
      qualityProfile: 'large-ui',
      summary: ['Alpha home and wizard implementation are now the source of truth.'],
      completedWork: ['Wizard step components and side dialog are implemented.'],
      decisions: ['Use an expanded checkpoint budget for large UI work.'],
      nextSteps: ['Run final visual QA.'],
    });
    const changelog = await fs.readFile(
      path.join(projectRoot, '.claude/.llm-docs/tasks/ABC-123/changelog.md'),
      'utf-8',
    );
    const state = await readTaskState(runtime.paths, 'ABC-123');

    expect(result.changelogAppended).toBe(true);
    expect(result.changelogPath).toBe('.claude/.llm-docs/tasks/ABC-123/changelog.md');
    expect(changelog).toContain('## 2026-05-25T12:00:00.000Z — milestone - alpha wizard shipped');
    expect(changelog).toContain(
      'Alpha home and wizard implementation are now the source of truth.',
    );
    expect(changelog).toContain('Use an expanded checkpoint budget for large UI work.');
    expect(state.qualityProfile).toBe('large-ui');
  });

  it('treats prompt-count pressure as advisory checkpoint risk', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    const { config, paths } = await prepareWorkspace(projectRoot);
    await bootstrapWorkspace(projectRoot, config);
    const runtime = await createRuntime(projectRoot);
    const transcriptDir = await fs.mkdtemp(path.join(os.tmpdir(), 'llmdocs-transcript-'));
    const transcriptPath = path.join(transcriptDir, 'transcript.jsonl');

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Autosave transcript',
      source: { type: 'prompt', ref: null, url: null, rawText: 'autosave flow' },
    });
    await runtime.saveContextCheckpoint('ABC-123', {
      summary: ['Baseline checkpoint for prompt-count advisory coverage.'],
    });
    await commitAll(projectRoot, 'baseline checkpoint');
    await fs.writeFile(transcriptPath, '{"role":"assistant","content":"done"}\n', 'utf-8');

    const snapshot = await saveCodexAutosaveSnapshot(paths, 'ABC-123', {
      sessionId: 'session-1',
      transcriptPath,
      hookEventName: 'UserPromptSubmit',
      lastAssistantMessage: 'done',
    });
    const stateAfterSnapshot = await readTaskState(paths, 'ABC-123');
    await markPromptSeen(paths, 'ABC-123', true);
    await markPromptSeen(paths, 'ABC-123', true);
    await markPromptSeen(paths, 'ABC-123', true);

    const state = await readTaskState(paths, 'ABC-123');
    const checkpoint = await shouldRequireContextCheckpoint(projectRoot, config, paths, 'ABC-123');

    expect(snapshot?.transcriptOffset).toBeGreaterThan(0);
    expect(state.checkpoint.lastAutosaveAt).toBeTruthy();
    expect(stateAfterSnapshot.checkpoint.needsQualityCheckpoint).toBe(false);
    expect(state.checkpoint.needsQualityCheckpoint).toBe(true);
    expect(checkpoint.required).toBe(false);
    expect(checkpoint.blockingReasons).toEqual([]);
    expect(checkpoint.advisoryReasons).toEqual(
      expect.arrayContaining(['three or more user prompts happened after the last checkpoint']),
    );
  });

  it('treats transcript threshold pressure as advisory and dedupes warning keys', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    const { config, paths } = await prepareWorkspace(projectRoot, {
      contextBudget: {
        activeContextMaxBytes: 12000,
        researchDocMaxBytes: 24000,
        checkpointMaxBytes: 6000,
        checkpointMaxBullets: 30,
        transcriptRiskTokens: 1,
      },
    });
    await bootstrapWorkspace(projectRoot, config);
    const runtime = await createRuntime(projectRoot);
    const transcriptDir = await fs.mkdtemp(path.join(os.tmpdir(), 'llmdocs-transcript-'));
    const transcriptPath = path.join(transcriptDir, 'large-transcript.jsonl');

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Configurable transcript threshold',
      source: { type: 'prompt', ref: null, url: null, rawText: 'threshold flow' },
    });
    await runtime.saveContextCheckpoint('ABC-123', {
      timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      summary: ['Baseline checkpoint for transcript-risk advisory coverage.'],
    });
    await commitAll(projectRoot, 'baseline checkpoint');
    await fs.writeFile(transcriptPath, 'large enough for one estimated token\n', 'utf-8');
    await saveCodexAutosaveSnapshot(paths, 'ABC-123', {
      sessionId: 'threshold',
      transcriptPath,
    });

    const checkpoint = await shouldRequireContextCheckpoint(projectRoot, config, paths, 'ABC-123');

    expect(checkpoint.required).toBe(false);
    expect(checkpoint.blockingReasons).toEqual([]);
    expect(checkpoint.advisoryReasons).toContain(
      'Codex transcript is near a conservative compaction risk threshold',
    );
    expect(checkpoint.reasons).toContain(
      'Codex transcript is near a conservative compaction risk threshold',
    );
    expect(await markContextWarningSeen(paths, 'ABC-123', checkpoint.warningKey ?? '')).toBe(true);
    expect(await markContextWarningSeen(paths, 'ABC-123', checkpoint.warningKey ?? '')).toBe(false);
  });

  it('ignores unrelated dirty files when checkpoint pressure has scoped source-of-truth paths', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    const { config, paths } = await prepareWorkspace(projectRoot);
    await bootstrapWorkspace(projectRoot, config);
    const runtime = await createRuntime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Scoped checkpoint relevance',
      source: { type: 'prompt', ref: null, url: null, rawText: 'scoped relevance flow' },
    });
    await runtime.saveContextCheckpoint('ABC-123', {
      timestamp: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      summary: ['Baseline checkpoint before unrelated dirty files appear.'],
    });
    await runtime.applyActualizationState('ABC-123', {
      clearStaleness: true,
      lastActualizedCommit: await simpleGit(projectRoot).revparse(['HEAD']),
      sourceOfTruthPaths: ['src/relevant.ts'],
    });
    await commitAll(projectRoot, 'checkpoint baseline with scoped source-of-truth');
    await runtime.applyActualizationState('ABC-123', {
      clearStaleness: true,
      lastActualizedCommit: await simpleGit(projectRoot).revparse(['HEAD']),
      sourceOfTruthPaths: ['src/relevant.ts'],
    });

    await fs.mkdir(path.join(projectRoot, 'docs'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'docs/unrelated.md'), 'unrelated\n', 'utf-8');
    await markPromptSeen(paths, 'ABC-123', true);

    const checkpoint = await shouldRequireContextCheckpoint(projectRoot, config, paths, 'ABC-123');

    expect(checkpoint.required).toBe(false);
    expect(checkpoint.blockingReasons).toEqual([]);
  });

  it('returns structured resume details after saving a checkpoint for a blocked Codex session', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    const { config, paths } = await prepareWorkspace(projectRoot);
    await bootstrapWorkspace(projectRoot, config);
    const runtime = await createRuntime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Structured resume checkpoint',
      source: { type: 'prompt', ref: null, url: null, rawText: 'structured resume flow' },
    });
    await bindCodexSessionToTask(paths, {
      sessionId: 'resume-session',
      taskId: 'ABC-123',
      source: 'explicit-user-intent',
      lastUserPrompt: 'реализуй финальную правку и прогоняй тесты',
      pendingResume: {
        kind: 'checkpoint',
        capturedAt: '2026-06-03T10:00:00.000Z',
        originalPrompt: 'реализуй финальную правку и прогоняй тесты',
      },
    });

    const result = await runtime.saveContextCheckpoint('ABC-123', {
      codexSessionId: 'resume-session',
      summary: ['Checkpoint saved after a forced Codex interruption.'],
    });
    const binding = await readCodexSessionBinding(paths, 'resume-session');

    expect(result.resumeKind).toBe('checkpoint');
    expect(result.resumeOriginalPrompt).toBe('реализуй финальную правку и прогоняй тесты');
    expect(result.resumeGuidance).toContain('resume the original request');
    expect(binding?.pendingResume).toBeNull();
  });

  it('stores compact prompt previews in Codex session bindings', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    const { config, paths } = await prepareWorkspace(projectRoot);
    await bootstrapWorkspace(projectRoot, config);
    const runtime = await createRuntime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Compact prompt preview',
      source: { type: 'prompt', ref: null, url: null, rawText: 'prompt preview flow' },
    });

    const bindingAfterWrite = await bindCodexSessionToTask(paths, {
      sessionId: 'prompt-preview',
      taskId: 'ABC-123',
      source: 'explicit-user-intent',
      lastUserPrompt: `line 1\n${'x'.repeat(2500)}\nline 2`,
      pendingResume: {
        kind: 'checkpoint',
        capturedAt: '2026-06-03T10:00:00.000Z',
        originalPrompt: `line 1\n${'x'.repeat(2500)}\nline 2`,
      },
    });

    const binding = await readCodexSessionBinding(paths, 'prompt-preview');

    expect(bindingAfterWrite.lastUserPrompt).not.toContain('\n');
    expect(bindingAfterWrite.lastUserPrompt?.length).toBeLessThanOrEqual(2000);
    expect(bindingAfterWrite.pendingResume?.originalPrompt).not.toContain('\n');
    expect(bindingAfterWrite.pendingResume?.originalPrompt?.length).toBeLessThanOrEqual(2000);
    expect(binding?.lastUserPrompt).not.toContain('\n');
    expect(binding?.lastUserPrompt?.length).toBeLessThanOrEqual(2000);
    expect(binding?.pendingResume?.originalPrompt).not.toContain('\n');
    expect(binding?.pendingResume?.originalPrompt?.length).toBeLessThanOrEqual(2000);
  });

  it('resolves Codex session binding before env and workspace active task', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    const { config, paths } = await prepareWorkspace(projectRoot);
    await bootstrapWorkspace(projectRoot, config);
    const runtime = await createRuntime(projectRoot);
    const previousEnv = process.env.LLMDOCS_ACTIVE_TASK;

    try {
      await runtime.createTaskBundle({
        taskId: 'TASK-A',
        title: 'Session A',
        source: { type: 'prompt', ref: null, url: null, rawText: 'session A flow' },
      });
      await runtime.createTaskBundle({
        taskId: 'TASK-B',
        title: 'Session B',
        source: { type: 'prompt', ref: null, url: null, rawText: 'session B flow' },
      });
      await bindCodexSessionToTask(paths, {
        sessionId: 'codex-session-a',
        taskId: 'TASK-A',
        source: 'explicit-user-intent',
        bundlePath: '.claude/.llm-docs/tasks/TASK-A',
      });
      await bindCodexSessionToTask(paths, {
        sessionId: 'codex-session-b',
        taskId: 'TASK-B',
        source: 'explicit-user-intent',
        bundlePath: '.claude/.llm-docs/tasks/TASK-B',
      });
      process.env.LLMDOCS_ACTIVE_TASK = 'task-b';

      const sessionA = await runtime.resolveActiveTask({
        codexSessionId: 'codex-session-a',
        preferRegistryActive: true,
      });
      const sessionB = await runtime.resolveActiveTask({
        codexSessionId: 'codex-session-b',
        preferRegistryActive: true,
      });
      const noSession = await runtime.resolveActiveTask({ preferRegistryActive: true });

      expect(sessionA).toMatchObject({ taskId: 'task-a', resolvedBy: 'codex-session' });
      expect(sessionB).toMatchObject({ taskId: 'task-b', resolvedBy: 'codex-session' });
      expect(noSession).toMatchObject({ taskId: 'task-b', resolvedBy: 'env' });
    } finally {
      if (previousEnv === undefined) {
        Reflect.deleteProperty(process.env, 'LLMDOCS_ACTIVE_TASK');
      } else {
        process.env.LLMDOCS_ACTIVE_TASK = previousEnv;
      }
    }
  });

  it('creates a Codex session binding from fallback resolution and clears missing bindings', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    const { config, paths } = await prepareWorkspace(projectRoot);
    await bootstrapWorkspace(projectRoot, config);
    const runtime = await createRuntime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'TASK-A',
      title: 'Fallback A',
      source: { type: 'prompt', ref: null, url: null, rawText: 'fallback A flow' },
    });

    const firstResolution = await runtime.resolveActiveTask({
      codexSessionId: 'new-session',
      bindCodexSession: true,
      preferRegistryActive: true,
    });
    const firstBinding = await readCodexSessionBinding(paths, 'new-session');

    expect(firstResolution).toMatchObject({ taskId: 'task-a', resolvedBy: 'active-file' });
    expect(firstBinding?.taskId).toBe('task-a');

    await runtime.createTaskBundle({
      taskId: 'TASK-B',
      title: 'Fallback B',
      source: { type: 'prompt', ref: null, url: null, rawText: 'fallback B flow' },
    });
    await bindCodexSessionToTask(paths, {
      sessionId: 'new-session',
      taskId: 'MISSING-TASK',
      source: 'explicit-user-intent',
    });

    const fallbackResolution = await runtime.resolveActiveTask({
      codexSessionId: 'new-session',
      bindCodexSession: true,
      preferRegistryActive: true,
    });
    const fallbackBinding = await readCodexSessionBinding(paths, 'new-session');

    expect(fallbackResolution).toMatchObject({ taskId: 'task-b' });
    expect(fallbackBinding?.taskId).toBe('task-b');
  });
});
