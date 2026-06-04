import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import TOML from '@iarna/toml';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';
import { runSetup } from '../../src/commands/setup.js';
import {
  renderLegacyAgentsRootDoc,
  renderLegacyClaudeRootDoc,
} from '../../src/v2/templates/root-docs.js';
import {
  createGitWorktree,
  initGitRepo,
  makeTempProject,
  readJsonFile,
  writeProjectFile,
} from '../helpers/v2-fixtures.js';

const execFileAsync = promisify(execFile);

async function writeFakePrepareCommitLauncher(projectRoot: string, label: string): Promise<void> {
  const launcherPath = path.join(projectRoot, '.claude/bin/llm-docs.mjs');
  await fs.mkdir(path.dirname(launcherPath), { recursive: true });
  await fs.writeFile(
    launcherPath,
    `#!/usr/bin/env node
import fs from 'node:fs';

const args = process.argv.slice(2);
if (args[0] !== 'internal' || args[1] !== 'git-prepare-commit-msg') {
  console.error('unexpected args: ' + args.join(' '));
  process.exit(2);
}

const messagePath = args[2];
const message = fs.readFileSync(messagePath, 'utf-8');
fs.writeFileSync(messagePath, '[${label}] ' + message);
`,
    { mode: 0o755 },
  );
}

describe('setup command', () => {
  it('bootstraps an empty repo with host packs and git hooks', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);

    const result = await runSetup(
      {
        hosts: 'claude,codex,cursor',
        enableGitHooks: true,
      },
      projectRoot,
    );

    expect(result.configStatus).toBe('created');
    await expect(
      fs.access(path.join(projectRoot, '.claude/bin/llm-docs.mjs')),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(projectRoot, '.mcp.json'))).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(projectRoot, '.claude/settings.json')),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(projectRoot, '.codex/config.toml'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(projectRoot, '.codex/hooks.json'))).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(projectRoot, '.cursor/rules/llm-docs.mdc')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(projectRoot, '.claude/llm-docs.manifest.json')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(projectRoot, '.git/hooks/post-commit')),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(projectRoot, 'CLAUDE.md'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(projectRoot, 'AGENTS.md'))).resolves.toBeUndefined();
  });

  it('merges an existing .mcp.json file', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await writeProjectFile(
      projectRoot,
      '.mcp.json',
      `${JSON.stringify({ mcpServers: { other: { command: 'other-mcp' } } }, null, 2)}\n`,
    );

    await runSetup({ hosts: 'claude' }, projectRoot);

    const mcpConfig = await readJsonFile<{
      mcpServers: Record<string, { command: string; args?: string[] }>;
    }>(path.join(projectRoot, '.mcp.json'));
    expect(mcpConfig.mcpServers.other.command).toBe('other-mcp');
    expect(mcpConfig.mcpServers.llmdocs.command).toBe('node');
    expect(mcpConfig.mcpServers.llmdocs.args).toEqual([
      path.join(projectRoot, '.claude/bin/llm-docs.mjs'),
      'server',
      '--transport',
      'stdio',
    ]);
  });

  it('merges an existing .claude/settings.json file', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await writeProjectFile(
      projectRoot,
      '.claude/settings.json',
      `${JSON.stringify({ editor: { tabSize: 2 } }, null, 2)}\n`,
    );

    await runSetup({ hosts: 'claude' }, projectRoot);

    const settings = await readJsonFile<{
      editor: { tabSize: number };
      hooks: Record<string, unknown>;
    }>(path.join(projectRoot, '.claude/settings.json'));
    expect(settings.editor.tabSize).toBe(2);
    expect(Object.keys(settings.hooks)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'Stop',
      'PreCompact',
    ]);
  });

  it('merges an existing .codex/config.toml file', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await writeProjectFile(
      projectRoot,
      '.codex/config.toml',
      [
        '[features]',
        'custom_feature = true',
        'codex_hooks = true',
        '',
        '[workspace]',
        'name = "temp"',
        '',
      ].join('\n'),
    );

    await runSetup({ hosts: 'codex' }, projectRoot);

    const config = TOML.parse(
      await fs.readFile(path.join(projectRoot, '.codex/config.toml'), 'utf-8'),
    ) as {
      features?: Record<string, unknown>;
      workspace?: { name?: string };
      mcp_servers?: Record<string, { command: string; args?: string[] }>;
    };
    expect(config.features?.custom_feature).toBe(true);
    expect(config.features?.hooks).toBe(true);
    expect(config.features?.codex_hooks).toBeUndefined();
    expect(config.workspace?.name).toBe('temp');
    expect(config.mcp_servers?.llmdocs.command).toBe('node');
    expect(config.mcp_servers?.llmdocs.args).toEqual([
      path.join(projectRoot, '.claude/bin/llm-docs.mjs'),
      'server',
      '--transport',
      'stdio',
    ]);
  });

  it('writes a generated candidate when existing .mcp.json is invalid', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await writeProjectFile(projectRoot, '.mcp.json', '{ invalid json');

    await expect(runSetup({ hosts: 'claude' }, projectRoot)).rejects.toThrow(
      'Invalid existing .mcp.json; cannot merge safely.',
    );
    await expect(fs.access(path.join(projectRoot, '.mcp.generated.json'))).resolves.toBeUndefined();
  });

  it('writes frontmatter-backed skills and launcher-based hooks', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);

    await runSetup({ hosts: 'claude,codex', enableGitHooks: true }, projectRoot);

    const codexSkill = await fs.readFile(
      path.join(projectRoot, '.agents/skills/llm-docs/SKILL.md'),
      'utf-8',
    );
    const codexRecipes = await fs.readFile(
      path.join(projectRoot, '.agents/skills/llm-docs/references/recipes.md'),
      'utf-8',
    );
    const claudeSkill = await fs.readFile(
      path.join(projectRoot, '.claude/skills/llm-docs/SKILL.md'),
      'utf-8',
    );
    const codexHooks = await readJsonFile<{
      hooks: {
        SessionStart: Array<{
          hooks: Array<{ command: string }>;
        }>;
      };
    }>(path.join(projectRoot, '.codex/hooks.json'));
    const gitHook = await fs.readFile(path.join(projectRoot, '.git/hooks/post-commit'), 'utf-8');

    expect(codexSkill.startsWith('---\nname: llm-docs\n')).toBe(true);
    expect(codexSkill).toContain('Commands-only');
    expect(codexSkill).toContain('Execute workflow');
    expect(codexSkill).not.toContain('llm-docs agent route');
    expect(codexRecipes).toContain('llm-docs task from-jira PROJ-324 --attachments');
    expect(claudeSkill.startsWith('---\nname: llm-docs\n')).toBe(true);
    expect(codexHooks.hooks.SessionStart[0]?.hooks[0]?.command).toContain(
      path.join(projectRoot, '.claude/bin/llm-docs.mjs'),
    );
    expect(codexHooks.hooks.SessionStart[0]?.hooks[0]?.command).toContain('env NODE_NO_WARNINGS=1');
    expect(gitHook).toContain('git rev-parse --show-toplevel');
    expect(gitHook).toContain('llmdocs_launcher="$workspace_root"/.claude/bin/llm-docs.mjs');
    expect(gitHook).not.toContain(path.join(projectRoot, '.claude/bin/llm-docs.mjs'));
  });

  it('preserves existing root agent docs and writes candidates', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    const existingClaude = '# Existing Claude Instructions\n\nKeep this file.\n';
    const existingAgents = '# Existing Agent Instructions\n\nKeep this file too.\n';
    await writeProjectFile(projectRoot, 'CLAUDE.md', existingClaude);
    await writeProjectFile(projectRoot, 'AGENTS.md', existingAgents);

    const result = await runSetup({ hosts: 'claude,codex' }, projectRoot);

    expect(await fs.readFile(path.join(projectRoot, 'CLAUDE.md'), 'utf-8')).toBe(existingClaude);
    expect(await fs.readFile(path.join(projectRoot, 'AGENTS.md'), 'utf-8')).toBe(existingAgents);
    await expect(
      fs.access(path.join(projectRoot, 'CLAUDE.llmdocs.generated.md')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(projectRoot, 'AGENTS.llmdocs.generated.md')),
    ).resolves.toBeUndefined();
    expect(result.bootstrapReport.generatedFiles).toContain('CLAUDE.llmdocs.generated.md');
    expect(result.bootstrapReport.generatedFiles).toContain('AGENTS.llmdocs.generated.md');
    const manifest = await readJsonFile<{
      candidates: Array<{ targetPath: string; candidatePath: string }>;
    }>(path.join(projectRoot, '.claude/llm-docs.manifest.json'));
    expect(manifest.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetPath: 'CLAUDE.md',
          candidatePath: 'CLAUDE.llmdocs.generated.md',
        }),
        expect.objectContaining({
          targetPath: 'AGENTS.md',
          candidatePath: 'AGENTS.llmdocs.generated.md',
        }),
      ]),
    );
  });

  it('updates legacy generated root docs in place with managed markers', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await writeProjectFile(projectRoot, 'CLAUDE.md', renderLegacyClaudeRootDoc());
    await writeProjectFile(projectRoot, 'AGENTS.md', renderLegacyAgentsRootDoc());

    await runSetup({ hosts: 'claude,codex' }, projectRoot);

    expect(await fs.readFile(path.join(projectRoot, 'CLAUDE.md'), 'utf-8')).toContain(
      '<!-- llm-docs:start -->',
    );
    expect(await fs.readFile(path.join(projectRoot, 'AGENTS.md'), 'utf-8')).toContain(
      '<!-- llm-docs:start -->',
    );
    await expect(
      fs.access(path.join(projectRoot, 'CLAUDE.llmdocs.generated.md')),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(projectRoot, 'AGENTS.llmdocs.generated.md')),
    ).rejects.toThrow();
  });

  it('installs git hooks inside a git worktree', async () => {
    const mainProjectRoot = await makeTempProject();
    await initGitRepo(mainProjectRoot);
    const worktreeRoot = await createGitWorktree(mainProjectRoot);

    await runSetup({ hosts: 'claude,codex', enableGitHooks: true }, worktreeRoot);

    const hooksDir = path.resolve(
      worktreeRoot,
      (await simpleGit(worktreeRoot).raw(['rev-parse', '--git-path', 'hooks'])).trim(),
    );

    await expect(fs.access(path.join(hooksDir, 'post-commit'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(hooksDir, 'prepare-commit-msg'))).resolves.toBeUndefined();
  });

  it('uses the current worktree launcher from shared git hooks', async () => {
    const mainProjectRoot = await makeTempProject();
    await initGitRepo(mainProjectRoot);
    const worktreeRoot = await createGitWorktree(mainProjectRoot);

    await runSetup({ hosts: 'claude,codex', enableGitHooks: true }, mainProjectRoot);

    const hooksDir = path.resolve(
      worktreeRoot,
      (await simpleGit(worktreeRoot).raw(['rev-parse', '--git-path', 'hooks'])).trim(),
    );
    const hookPath = path.join(hooksDir, 'prepare-commit-msg');
    const hookContent = await fs.readFile(hookPath, 'utf-8');

    expect(hookContent).toContain('git rev-parse --show-toplevel');
    expect(hookContent).not.toContain(path.join(mainProjectRoot, '.claude/bin/llm-docs.mjs'));

    await writeFakePrepareCommitLauncher(mainProjectRoot, 'main');
    await writeFakePrepareCommitLauncher(worktreeRoot, 'worktree');

    const messagePath = path.join(worktreeRoot, 'COMMIT_EDITMSG.test');
    await fs.writeFile(messagePath, 'commit subject\n', 'utf-8');

    await execFileAsync(hookPath, [messagePath], { cwd: worktreeRoot });

    await expect(fs.readFile(messagePath, 'utf-8')).resolves.toBe('[worktree] commit subject\n');
  });

  it('does not overwrite existing user git hooks and writes candidates', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    const hookPath = path.join(projectRoot, '.git/hooks/pre-push');
    const userHook = '#!/bin/sh\nprintf "custom pre-push\\n"\n';
    await fs.writeFile(hookPath, userHook, 'utf-8');
    await fs.chmod(hookPath, 0o755);

    const result = await runSetup({ hosts: 'claude,codex', enableGitHooks: true }, projectRoot);

    expect(await fs.readFile(hookPath, 'utf-8')).toBe(userHook);
    await expect(
      fs.access(path.join(projectRoot, '.git/hooks/pre-push.llmdocs.candidate')),
    ).resolves.toBeUndefined();
    expect(result.bootstrapReport.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '.git/hooks/pre-push',
          kind: 'git-hook',
          action: 'write-candidate',
          candidatePath: '.git/hooks/pre-push.llmdocs.candidate',
        }),
      ]),
    );
  });

  it('updates only the managed block in an existing git hook', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    const hookPath = path.join(projectRoot, '.git/hooks/post-commit');
    await fs.writeFile(
      hookPath,
      [
        '#!/bin/sh',
        'printf "before\\n"',
        '# llm-docs:start hook=post-commit schema=1',
        'old-command "$@"',
        '# llm-docs:end',
        'printf "after\\n"',
        '',
      ].join('\n'),
      'utf-8',
    );

    await runSetup({ hosts: 'claude,codex', enableGitHooks: true }, projectRoot);

    const updated = await fs.readFile(hookPath, 'utf-8');
    expect(updated).toContain('printf "before\\n"');
    expect(updated).toContain('printf "after\\n"');
    expect(updated).toContain('internal git-post-commit');
    expect(updated).not.toContain('old-command');
  });

  it('reports setup preflight as dry-run operations without writing hooks', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);

    const result = await runSetup(
      { hosts: 'claude,codex', enableGitHooks: true, preflight: true },
      projectRoot,
    );

    expect(result.bootstrapReport.dryRun).toBe(true);
    expect(result.bootstrapReport.summary?.creates).toBeGreaterThan(0);
    expect(result.bootstrapReport.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '.git/hooks/post-commit',
          kind: 'git-hook',
          action: 'create',
        }),
      ]),
    );
    await expect(fs.access(path.join(projectRoot, '.git/hooks/post-commit'))).rejects.toThrow();
    await expect(
      fs.access(path.join(projectRoot, '.claude/llm-docs.manifest.json')),
    ).rejects.toThrow();
    await expect(fs.access(path.join(projectRoot, '.agents'))).rejects.toThrow();
    await expect(fs.access(path.join(projectRoot, '.claude/skills'))).rejects.toThrow();
  });
});
