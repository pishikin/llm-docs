import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';
import {
  handlePostCommit,
  handlePrePush,
  handlePrepareCommitMsg,
} from '../../src/commands/internal/git.js';
import { markTaskStale } from '../../src/commands/internal/hooks.js';
import { runSetup } from '../../src/commands/setup.js';
import { createV2Runtime } from '../../src/v2/runtime.js';
import { bindCodexSessionToTask } from '../../src/v2/task/session-binding.js';
import {
  checkoutNewBranch,
  commitProjectFile,
  ensureBuiltCli,
  initGitRepo,
  makeTempProject,
} from '../helpers/v2-fixtures.js';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

async function commitAll(projectRoot: string, message: string): Promise<void> {
  const git = simpleGit(projectRoot);
  await git.add('.');
  await git.commit(message);
}

async function runBuiltCli(
  projectRoot: string,
  args: string[],
  stdin: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  await ensureBuiltCli();

  const child = spawn(process.execPath, [path.join(repoRoot, 'dist/index.js'), ...args], {
    cwd: projectRoot,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];

  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(stdin);

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 0));
  });

  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString('utf-8'),
    stderr: Buffer.concat(stderr).toString('utf-8'),
  };
}

describe('internal git commands', () => {
  it('prefixes commit messages with the active task id when safe', async () => {
    const projectRoot = await makeTempProject();
    const previousCwd = process.cwd();

    try {
      await initGitRepo(projectRoot);
      await checkoutNewBranch(projectRoot, 'feature/ABC-123-prefix');
      await runSetup({}, projectRoot);
      const runtime = await createV2Runtime(projectRoot);
      await runtime.createTaskBundle({
        taskId: 'ABC-123',
        title: 'Prefix commit message',
        source: { type: 'jira', ref: 'ABC-123', url: null, rawText: 'prefix flow' },
      });

      const commitMessagePath = path.join(projectRoot, '.git/COMMIT_EDITMSG');
      await fs.writeFile(commitMessagePath, 'feat: update auth\n', 'utf-8');

      process.chdir(projectRoot);
      await handlePrepareCommitMsg(commitMessagePath);

      expect(await fs.readFile(commitMessagePath, 'utf-8')).toContain(
        '[ABC-123] feat: update auth',
      );
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('does not prefix commit messages from weak active-task sources on protected branches', async () => {
    const projectRoot = await makeTempProject();
    const previousCwd = process.cwd();

    try {
      await initGitRepo(projectRoot, 'main');
      await runSetup({}, projectRoot);
      const runtime = await createV2Runtime(projectRoot);
      await runtime.createTaskBundle({
        taskId: 'DOCS-123',
        title: 'Protected branch task',
        source: { type: 'prompt', ref: null, url: null, rawText: 'protected branch flow' },
      });

      const commitMessagePath = path.join(projectRoot, '.git/COMMIT_EDITMSG');
      await fs.writeFile(commitMessagePath, 'docs: update guide\n', 'utf-8');

      process.chdir(projectRoot);
      await handlePrepareCommitMsg(commitMessagePath);

      expect(await fs.readFile(commitMessagePath, 'utf-8')).toBe('docs: update guide\n');
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('returns a blocking exit code on strict pre-push when the active task is stale', async () => {
    const projectRoot = await makeTempProject();
    const previousCwd = process.cwd();

    try {
      await initGitRepo(projectRoot);
      await checkoutNewBranch(projectRoot, 'feature/ABC-123-stale');
      await runSetup({}, projectRoot);
      const runtime = await createV2Runtime(projectRoot);
      await runtime.createTaskBundle({
        taskId: 'ABC-123',
        title: 'Stale push',
        source: { type: 'jira', ref: 'ABC-123', url: null, rawText: 'stale push flow' },
      });
      await commitProjectFile(
        projectRoot,
        'src/stale.ts',
        'export const stale = true;\n',
        'introduce stale change',
      );

      process.chdir(projectRoot);
      await handlePostCommit();

      expect(await handlePrePush(true)).toBe(1);
    } finally {
      process.chdir(previousCwd);
    }
  });
});

describe('internal host hook commands', () => {
  it('emits valid continue JSON for non-blocking Codex stop hooks', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await runSetup({}, projectRoot);

    const payload = `${JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'non-blocking-stop',
      cwd: projectRoot,
      last_assistant_message: 'nothing to block',
    })}\n`;
    const codex = await runBuiltCli(projectRoot, ['internal', 'codex-stop'], payload);

    expect(codex.exitCode).toBe(0);
    expect(codex.stderr).toBe('');
    expect(JSON.parse(codex.stdout)).toEqual({ continue: true });
  }, 30_000);

  it('keeps Codex hooks passive on protected branches without an explicit session task', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot, 'main');
    await runSetup({}, projectRoot);
    const runtime = await createV2Runtime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Passive main hook',
      source: { type: 'prompt', ref: null, url: null, rawText: 'passive main hook flow' },
    });
    await markTaskStale(runtime, 'ABC-123', 'stale but passive on main', false);

    const payload = `${JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 'main-passive-hooks',
      cwd: projectRoot,
      last_assistant_message: 'docs work',
    })}\n`;
    const sessionStart = await runBuiltCli(
      projectRoot,
      ['internal', 'codex-session-start'],
      payload,
    );
    expect(sessionStart.exitCode).toBe(0);
    expect(sessionStart.stdout).toBe('');

    const promptSubmit = await runBuiltCli(
      projectRoot,
      ['internal', 'codex-user-prompt-submit'],
      `${JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'main-passive-hooks',
        cwd: projectRoot,
        prompt: 'обнови документацию и context overview',
      })}\n`,
    );
    expect(promptSubmit.exitCode).toBe(0);
    expect(promptSubmit.stdout).toBe('');

    const stop = await runBuiltCli(
      projectRoot,
      ['internal', 'codex-stop'],
      `${JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'main-passive-hooks',
        cwd: projectRoot,
      })}\n`,
    );
    expect(stop.exitCode).toBe(0);
    expect(JSON.parse(stop.stdout)).toEqual({ continue: true });
    await expect(
      fs.access(
        path.join(projectRoot, '.claude/.llm-docs/runtime/codex/sessions/main-passive-hooks.json'),
      ),
    ).rejects.toThrow();
  });

  it('keeps Codex stop stdout valid JSON when payload parsing fails', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await runSetup({}, projectRoot);

    const codex = await runBuiltCli(projectRoot, ['internal', 'codex-stop'], 'not-json\n');

    expect(codex.exitCode).toBe(0);
    expect(codex.stderr).toContain('llm-docs codex-stop hook failed');
    expect(JSON.parse(codex.stdout)).toEqual({ continue: true });
  });

  it('emits JSON for stale Codex stop hooks while preserving Claude text output', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await runSetup({}, projectRoot);
    const runtime = await createV2Runtime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Stale stop hook',
      source: { type: 'prompt', ref: null, url: null, rawText: 'stale stop hook flow' },
    });
    await markTaskStale(runtime, 'ABC-123', 'test stale reason', false);
    await bindCodexSessionToTask(runtime.paths, {
      sessionId: 'debug-stop-hook',
      taskId: 'ABC-123',
      source: 'explicit-user-intent',
    });

    const payload = `${JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'debug-stop-hook',
      cwd: projectRoot,
      transcript_path: '/tmp/llmdocs-codex-stop-debug.jsonl',
      last_assistant_message: 'debug',
    })}\n`;

    const codex = await runBuiltCli(projectRoot, ['internal', 'codex-stop'], payload);
    expect(codex.exitCode).toBe(0);
    const codexJson = JSON.parse(codex.stdout) as { decision: string; reason: string };
    expect(codexJson.decision).toBe('block');
    expect(codexJson.reason).toContain(
      'Active task ABC-123 is stale. Do not close or continue substantial work with only state.json updated.',
    );
    expect(codexJson.reason).toContain('context.md, changelog.md');
    expect(codexJson.reason).toContain('Refresh from:');
    expect(codexJson.reason).toContain('.claude/.llm-docs/tasks/ABC-123/context.md');

    const claude = await runBuiltCli(projectRoot, ['internal', 'claude-stop'], payload);
    expect(claude.exitCode).toBe(0);
    expect(claude.stdout).toContain(
      'Active task ABC-123 is stale. Do not close or continue substantial work with only state.json updated.',
    );
    expect(claude.stdout).toContain('Refresh from:');
  });

  it('keeps Codex prompt submit passive for stale tasks and preserves the original prompt for stop-time resume', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await runSetup({}, projectRoot);
    const runtime = await createV2Runtime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Russian prompt stale task',
      source: { type: 'prompt', ref: null, url: null, rawText: 'russian prompt stale flow' },
    });
    await markTaskStale(runtime, 'ABC-123', 'post-commit head advanced', false);
    await bindCodexSessionToTask(runtime.paths, {
      sessionId: 'russian-coding-prompt',
      taskId: 'ABC-123',
      source: 'explicit-user-intent',
    });

    const promptSubmit = await runBuiltCli(
      projectRoot,
      ['internal', 'codex-user-prompt-submit'],
      `${JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'russian-coding-prompt',
        cwd: projectRoot,
        prompt: 'реализуй финальную правку и обнови код',
      })}\n`,
    );
    expect(promptSubmit.exitCode).toBe(0);
    expect(promptSubmit.stdout).toBe('');

    const stop = await runBuiltCli(
      projectRoot,
      ['internal', 'codex-stop'],
      `${JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'russian-coding-prompt',
        cwd: projectRoot,
        last_assistant_message: 'started implementation',
      })}\n`,
    );

    expect(stop.exitCode).toBe(0);
    expect(stop.stdout).toContain(
      'Active task ABC-123 is stale. Do not close or continue substantial work with only state.json updated.',
    );
    expect(stop.stdout).toContain('post-commit head advanced');
    expect(stop.stdout).toContain(
      'Resume original user request after actualization: реализуй финальную правку и обнови код',
    );
  }, 30_000);

  it('keeps Codex prompt submit passive for required checkpoint cases and blocks on stop with structured resume context', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await runSetup({}, projectRoot);
    const runtime = await createV2Runtime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Checkpoint stop hook',
      source: { type: 'prompt', ref: null, url: null, rawText: 'checkpoint stop flow' },
    });
    await bindCodexSessionToTask(runtime.paths, {
      sessionId: 'checkpoint-stop',
      taskId: 'ABC-123',
      source: 'explicit-user-intent',
    });
    await fs.writeFile(path.join(projectRoot, 'src.ts'), 'export const changed = true;\n', 'utf-8');
    const promptSubmit = await runBuiltCli(
      projectRoot,
      ['internal', 'codex-user-prompt-submit'],
      `${JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'checkpoint-stop',
        cwd: projectRoot,
        prompt: 'implement the final fix and run focused tests',
      })}\n`,
    );
    expect(promptSubmit.exitCode).toBe(0);
    expect(promptSubmit.stdout).toBe('');

    const payload = `${JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'checkpoint-stop',
      cwd: projectRoot,
      last_assistant_message: 'changed src.ts',
    })}\n`;
    const codex = await runBuiltCli(projectRoot, ['internal', 'codex-stop'], payload);

    expect(codex.exitCode).toBe(0);
    expect(JSON.parse(codex.stdout)).toMatchObject({
      decision: 'block',
    });
    expect(codex.stdout).toContain('needs a context checkpoint');
    expect(codex.stdout).toContain('llmdocs.save_context_checkpoint');
    expect(codex.stdout).toContain('codexSessionId: checkpoint-stop');
    expect(codex.stdout).toContain(
      'Resume original user request after checkpoint: implement the final fix and run focused tests',
    );
    expect(codex.stdout).toContain("resume the user's interrupted request");
  });

  it('keeps transcript-risk checkpoint pressure advisory for ad hoc Codex prompts and stop hooks', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await runSetup({}, projectRoot);
    const runtime = await createV2Runtime(projectRoot);
    const transcriptDir = await fs.mkdtemp(path.join(os.tmpdir(), 'llmdocs-transcript-'));
    const transcriptPath = path.join(transcriptDir, 'large-transcript.jsonl');

    await runtime.createTaskBundle({
      taskId: 'PIXSO-123',
      title: 'Ad hoc prompt under transcript risk',
      source: { type: 'prompt', ref: null, url: null, rawText: 'pixso token check' },
    });
    await runtime.saveContextCheckpoint('PIXSO-123', {
      timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      summary: ['Baseline checkpoint for advisory transcript-risk coverage.'],
    });
    await commitAll(projectRoot, 'baseline checkpoint');
    await bindCodexSessionToTask(runtime.paths, {
      sessionId: 'pixso-advisory',
      taskId: 'PIXSO-123',
      source: 'explicit-user-intent',
    });
    await fs.writeFile(transcriptPath, 'x'.repeat(220_000), 'utf-8');

    const promptSubmit = await runBuiltCli(
      projectRoot,
      ['internal', 'codex-user-prompt-submit'],
      `${JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'pixso-advisory',
        cwd: projectRoot,
        transcript_path: transcriptPath,
        prompt:
          'я выделил фрейм, попробуй подтянуть стили из него с помощью мсп плагина, мне важно понять, можешь ли ты считать токен цвета',
      })}\n`,
    );

    expect(promptSubmit.exitCode).toBe(0);
    expect(promptSubmit.stdout).toBe('');

    const stop = await runBuiltCli(
      projectRoot,
      ['internal', 'codex-stop'],
      `${JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'pixso-advisory',
        cwd: projectRoot,
        transcript_path: transcriptPath,
        last_assistant_message: 'Checked Pixso frame colors.',
      })}\n`,
    );

    expect(stop.exitCode).toBe(0);
    expect(JSON.parse(stop.stdout)).toEqual({ continue: true });
  }, 30_000);

  it('does not block Claude pre-compact when checkpoint state is current', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await runSetup({}, projectRoot);
    const runtime = await createV2Runtime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Current pre-compact hook',
      source: { type: 'prompt', ref: null, url: null, rawText: 'pre compact current flow' },
    });
    await runtime.saveContextCheckpoint('ABC-123', {
      summary: ['Current checkpoint.'],
    });

    const payload = `${JSON.stringify({
      hook_event_name: 'PreCompact',
      session_id: 'pre-compact-current',
      cwd: projectRoot,
      last_assistant_message: 'checkpoint current',
    })}\n`;
    const claude = await runBuiltCli(projectRoot, ['internal', 'claude-pre-compact'], payload);

    expect(claude.exitCode).toBe(0);
    expect(claude.stdout).toBe('');
  });

  it('saves a Codex transcript snapshot with codex-watch --once', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await runSetup({}, projectRoot);
    const runtime = await createV2Runtime(projectRoot);
    const transcriptPath = path.join(projectRoot, 'transcript.jsonl');

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Codex watcher',
      source: { type: 'prompt', ref: null, url: null, rawText: 'watcher flow' },
    });
    await fs.writeFile(transcriptPath, '{"role":"assistant","content":"checkpoint"}\n', 'utf-8');

    const result = await runBuiltCli(
      projectRoot,
      [
        'internal',
        'codex-watch',
        '--task-id',
        'ABC-123',
        '--session-id',
        'watcher-test',
        '--transcript-path',
        transcriptPath,
        '--once',
      ],
      '',
    );

    expect(result.exitCode).toBe(0);
    await expect(
      fs.access(path.join(projectRoot, '.claude/.llm-docs/runtime/codex/watcher-test.json')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(
        path.join(projectRoot, '.claude/.llm-docs/runtime/codex/sessions/watcher-test.json'),
      ),
    ).resolves.toBeUndefined();
  });

  it('keeps Codex stop bound to its session task after workspace active changes', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await runSetup({}, projectRoot);
    const runtime = await createV2Runtime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'TASK-A',
      title: 'Session stop A',
      source: { type: 'prompt', ref: null, url: null, rawText: 'session stop A flow' },
    });
    await markTaskStale(runtime, 'task-a', 'session A stale reason', false);
    await bindCodexSessionToTask(runtime.paths, {
      sessionId: 'session-stop-a',
      taskId: 'task-a',
      source: 'explicit-user-intent',
    });
    await runtime.createTaskBundle({
      taskId: 'TASK-B',
      title: 'Session stop B',
      source: { type: 'prompt', ref: null, url: null, rawText: 'session stop B flow' },
    });

    const payload = `${JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'session-stop-a',
      cwd: projectRoot,
      last_assistant_message: 'stale A',
    })}\n`;
    const codex = await runBuiltCli(projectRoot, ['internal', 'codex-stop'], payload);

    expect(codex.exitCode).toBe(0);
    const codexJson = JSON.parse(codex.stdout) as { decision: string; reason: string };
    expect(codexJson.decision).toBe('block');
    expect(codexJson.reason).toContain(
      'Active task task-a is stale. Do not close or continue substantial work with only state.json updated.',
    );
    expect(codexJson.reason).toContain('.claude/.llm-docs/tasks/task-a/context.md');
  });

  it('supports task pause/use --none and trace output for paused Codex sessions', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await runSetup({}, projectRoot);
    const runtime = await createV2Runtime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Pause CLI task',
      source: { type: 'prompt', ref: null, url: null, rawText: 'pause CLI flow' },
    });

    const sessionPause = await runBuiltCli(
      projectRoot,
      ['task', 'use', '--none', '--session-id', 'pause-cli-session', '--json'],
      '',
    );
    expect(sessionPause.exitCode).toBe(0);
    expect(JSON.parse(sessionPause.stdout)).toMatchObject({
      paused: true,
      scope: 'codex-session',
      taskId: null,
      sessionId: 'pause-cli-session',
    });

    const trace = await runBuiltCli(
      projectRoot,
      ['task', 'active', '--trace', '--session-id', 'pause-cli-session', '--json'],
      '',
    );
    expect(trace.exitCode).toBe(0);
    const traceJson = JSON.parse(trace.stdout) as { trace: { steps: Array<{ status: string }> } };
    expect(traceJson.trace.steps).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'paused' })]),
    );

    const workspacePause = await runBuiltCli(
      projectRoot,
      ['task', 'pause', '--workspace', '--json'],
      '',
    );
    expect(workspacePause.exitCode).toBe(0);
    expect(JSON.parse(workspacePause.stdout)).toMatchObject({
      paused: true,
      scope: 'workspace',
      taskId: null,
    });

    const registry = await runtime.readTaskRegistry();
    expect(registry.activeTaskId).toBeNull();
    expect(registry.tasks['ABC-123']).toBeTruthy();
  }, 30_000);
});
