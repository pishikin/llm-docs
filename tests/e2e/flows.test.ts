import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import TOML from '@iarna/toml';
import { describe, expect, it } from 'vitest';
import { runSetup } from '../../src/commands/setup.js';
import { createRuntime } from '../../src/engine/runtime.js';
import {
  checkoutBranch,
  checkoutNewBranch,
  commitProjectFile,
  initGitRepo,
  makeTempProject,
  mergeBranch,
  readJsonFile,
} from '../helpers/test-fixtures.js';

describe('end-to-end flows', () => {
  it('Flow A: create and load bundle', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await runSetup({}, projectRoot);
    const runtime = await createRuntime(projectRoot);

    const created = await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Create flow',
      source: { type: 'jira', ref: 'ABC-123', url: null, rawText: 'flow a' },
    });
    const loaded = await runtime.loadTaskBundle(created.taskId, {
      includeContents: true,
      includeArtifacts: true,
    });

    expect(loaded.bundlePath).toBe('.claude/.llm-docs/tasks/ABC-123');
    expect(loaded.registryEntry?.taskId).toBe('ABC-123');
    expect(loaded.primaryDocs.context).toContain('## Latest Checkpoint');
    expect(loaded.primaryDocs.state).toContain('"taskId": "ABC-123"');
  });

  it('Flow B: actualization after code changes', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await checkoutNewBranch(projectRoot, 'feature/ABC-123-actualization');
    await runSetup({}, projectRoot);
    const runtime = await createRuntime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Actualization flow',
      source: { type: 'jira', ref: 'ABC-123', url: null, rawText: 'flow b' },
    });
    await commitProjectFile(
      projectRoot,
      'src/feature.ts',
      'export const feature = true;\n',
      'add feature',
    );

    const report = await runtime.prepareActualization('ABC-123', { includeRelatedTasks: true });
    expect(report.needsActualization).toBe(true);
    expect(report.suggestions.readFirst).toContain('src/feature.ts');

    const updated = await runtime.applyActualizationState('ABC-123', {
      taskId: 'ABC-123',
      clearStaleness: true,
      lastActualizedCommit: report.git.head,
      sourceOfTruthPaths: ['src/feature.ts'],
      relatedDocs: ['.claude/docs/architecture.md'],
    });
    expect(updated.staleness.needs_actualization).toBe(false);
    expect(updated.related.docs).toContain('.claude/docs/architecture.md');
  });

  it('Flow C: rebaseline after merge', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await checkoutNewBranch(projectRoot, 'feature/ABC-123-rebaseline');
    await runSetup({}, projectRoot);
    const runtime = await createRuntime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Rebaseline flow',
      source: { type: 'jira', ref: 'ABC-123', url: null, rawText: 'flow c' },
    });
    await commitProjectFile(
      projectRoot,
      'src/rebaseline.ts',
      'export const value = 2;\n',
      'feature commit',
    );
    await checkoutBranch(projectRoot, 'main');
    await mergeBranch(projectRoot, 'feature/ABC-123-rebaseline');

    const report = await runtime.prepareRebaseline('ABC-123', { targetBranch: 'main' });
    expect(report.suggestedPhase).toBe('merged');

    const meta = await runtime.applyRebaselineState('ABC-123', {
      taskId: 'ABC-123',
      phase: report.suggestedPhase,
      status: 'done',
      currentBranch: 'main',
      lastVerifiedCommit: report.head,
      sourceOfTruthPaths: ['src/rebaseline.ts'],
      historicalDocs: report.historicalDocs,
    });
    expect(meta.phase).toBe('merged');
    expect(meta.status).toBe('done');
  });

  it('Flow D: artifact lifecycle with collision handling', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await runSetup({}, projectRoot);
    const runtime = await createRuntime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Artifact flow',
      source: { type: 'prompt', ref: null, url: null, rawText: 'flow d' },
    });

    const sourcePath = path.join(os.tmpdir(), 'artifact-flow.log');
    await fs.writeFile(sourcePath, 'artifact data', 'utf-8');

    const first = await runtime.attachArtifact('ABC-123', {
      sourcePath,
      kind: 'log',
    });
    const second = await runtime.attachArtifact('ABC-123', {
      sourcePath,
      kind: 'log',
    });
    const bundle = await runtime.loadTaskBundle('ABC-123', { includeArtifacts: true });

    expect(first.artifactId).toBe('art-0001');
    expect(second.artifactId).toBe('art-0002');
    expect(bundle.artifactIndex?.artifacts).toHaveLength(2);
  });

  it('Flow E: host pack generation and config parsing', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);

    await runSetup(
      {
        hosts: 'claude,codex,cursor',
        enableGitHooks: true,
      },
      projectRoot,
    );

    const mcpConfig = await readJsonFile<{ mcpServers: Record<string, unknown> }>(
      path.join(projectRoot, '.mcp.json'),
    );
    const claudeSettings = await readJsonFile<{ hooks: Record<string, unknown> }>(
      path.join(projectRoot, '.claude/settings.json'),
    );
    const codexHooks = await readJsonFile<{ hooks: Record<string, unknown> }>(
      path.join(projectRoot, '.codex/hooks.json'),
    );
    const codexConfig = TOML.parse(
      await fs.readFile(path.join(projectRoot, '.codex/config.toml'), 'utf-8'),
    ) as { features?: Record<string, unknown>; mcp_servers?: Record<string, unknown> };
    const codexSkill = await fs.readFile(
      path.join(projectRoot, '.agents/skills/llm-docs/SKILL.md'),
      'utf-8',
    );

    expect(mcpConfig.mcpServers.llmdocs).toBeDefined();
    expect(Object.keys(claudeSettings.hooks)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'Stop',
      'PreCompact',
    ]);
    expect(Object.keys(codexHooks.hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop']);
    expect(codexConfig.features?.hooks).toBe(true);
    expect(codexConfig.features?.codex_hooks).toBeUndefined();
    expect(codexConfig.mcp_servers?.llmdocs).toBeDefined();
    expect(codexSkill.startsWith('---\nname: llm-docs\n')).toBe(true);
    await expect(
      fs.access(path.join(projectRoot, '.claude/bin/llm-docs.mjs')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(projectRoot, '.claude/skills/llm-docs/SKILL.md')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(projectRoot, '.agents/skills/llm-docs/SKILL.md')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(projectRoot, '.cursor/rules/llm-docs.mdc')),
    ).resolves.toBeUndefined();
  });
});
