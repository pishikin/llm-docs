import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runResearchCheckpoint,
  runResearchCompact,
  runResearchStart,
} from '../../src/commands/research.js';
import { runSetup } from '../../src/commands/setup.js';
import { createRuntime } from '../../src/engine/runtime.js';
import { initGitRepo, makeTempProject } from '../helpers/test-fixtures.js';

describe('research command', () => {
  it('maintains one markdown research file per active task topic', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await runSetup({}, projectRoot);
    const runtime = await createRuntime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Research flow',
      source: { type: 'prompt', ref: null, url: null, rawText: 'research flow' },
    });

    const started = await runResearchStart(
      'Context Compression',
      { title: 'Context Compression' },
      projectRoot,
    );
    await runResearchCheckpoint(
      'Context Compression',
      {
        source: ['https://example.com/source'],
        finding: ['Context should be loaded in small batches.'],
        decision: ['Use one markdown research file per topic.'],
        nextStep: ['Implement context status.'],
      },
      projectRoot,
    );
    const compacted = await runResearchCompact('Context Compression', {}, projectRoot);
    const researchPath = path.join(projectRoot, compacted.path);
    const content = await fs.readFile(researchPath, 'utf-8');

    expect(started.created).toBe(true);
    expect(compacted.path).toBe('.claude/.llm-docs/tasks/ABC-123/research-context-compression.md');
    expect(content).toContain('## Brief');
    expect(content).toContain('Decision: Use one markdown research file per topic.');
    expect(content).toContain('https://example.com/source');
    expect(content).not.toContain('- Continue research.');
    await expect(
      fs.readdir(path.join(projectRoot, '.claude/.llm-docs/tasks/ABC-123')),
    ).resolves.toEqual(
      expect.arrayContaining(['context.md', 'state.json', 'research-context-compression.md']),
    );
  });
});
