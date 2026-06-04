import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runContextStatus } from '../../src/commands/context.js';
import { createRuntime } from '../../src/engine/runtime.js';
import { saveCodexAutosaveSnapshot } from '../../src/engine/task/autosave.js';
import { bootstrapWorkspace } from '../../src/engine/workspace/bootstrap.js';
import { initGitRepo, makeTempProject, prepareWorkspace } from './test-helpers.js';

describe('context status', () => {
  it('reports active task files, budget status, and transcript risk', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    const { config, paths } = await prepareWorkspace(projectRoot, {
      contextBudget: {
        activeContextMaxBytes: 20,
        researchDocMaxBytes: 10,
        checkpointMaxBytes: 6000,
        checkpointMaxBullets: 30,
        transcriptRiskTokens: 1,
      },
    });
    await bootstrapWorkspace(projectRoot, config);
    const runtime = await createRuntime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Context status',
      source: { type: 'prompt', ref: null, url: null, rawText: 'context status flow' },
    });
    await fs.writeFile(
      path.join(projectRoot, '.claude/.llm-docs/tasks/ABC-123/research-large.md'),
      '# Research\n\nlarge research body\n',
      'utf-8',
    );
    await fs.writeFile(path.join(projectRoot, 'transcript.jsonl'), 'large transcript\n', 'utf-8');
    await runtime.saveContextCheckpoint('ABC-123', {
      summary: ['status checkpoint'],
    });
    await saveCodexAutosaveSnapshot(paths, 'ABC-123', {
      sessionId: 'context-status',
      transcriptPath: path.join(projectRoot, 'transcript.jsonl'),
    });

    const report = await runContextStatus({ json: true }, projectRoot);

    expect(report.activeTaskId).toBe('ABC-123');
    expect(report.risk).toBe('new-thread');
    expect(report.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'context', status: 'large' }),
        expect.objectContaining({ kind: 'research', status: 'large' }),
      ]),
    );
    expect(report.transcript.estimatedTokens).toBeGreaterThanOrEqual(1);
    expect(report.reasons).toEqual(
      expect.arrayContaining(['Codex transcript is near a conservative compaction risk threshold']),
    );
    expect(report.reloadFiles).toEqual(
      expect.arrayContaining([
        '.claude/.llm-docs/tasks/ABC-123/context.md',
        '.claude/.llm-docs/tasks/ABC-123/state.json',
        '.claude/.llm-docs/tasks/ABC-123/changelog.md',
      ]),
    );
  });
});
