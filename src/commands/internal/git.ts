import fs from 'node:fs/promises';
import type { Command } from 'commander';
import { readTaskMeta } from '../../engine/task/meta.js';
import type { ActiveResolutionPolicy } from '../../engine/types.js';
import { getRuntimeOrNull, writeTextResponse } from './common.js';
import { markTaskStale } from './hooks.js';

const GIT_HOOK_ACTIVE_RESOLUTION_POLICY: ActiveResolutionPolicy = {
  includeExplicit: true,
  includeCodexSession: true,
  includeEnv: true,
  includeWorkspaceActive: true,
  includeRegistryActive: true,
  includeBranchName: true,
  includeBranchMapping: true,
  includeCwdBundle: true,
  includeFallbackBranchScan: true,
  protectedBranchBehavior: 'session-or-explicit',
};

function commitMessageAlreadyTagged(message: string, taskId: string): boolean {
  return message.startsWith(`[${taskId}]`) || new RegExp(`\\b${taskId}\\b`).test(message);
}

function shouldSkipCommitMessageRewrite(source: string | undefined, message: string): boolean {
  if (source === 'merge' || source === 'squash' || source === 'commit') {
    return true;
  }

  const firstLine = message.split('\n').find((line) => line.trim().length > 0) ?? '';
  return firstLine.startsWith('fixup!') || firstLine.startsWith('squash!');
}

export async function handlePrepareCommitMsg(
  commitMessagePath: string,
  source?: string,
): Promise<void> {
  const runtime = await getRuntimeOrNull();
  if (!runtime) {
    return;
  }

  const resolution = await runtime.resolveActiveTask({
    preferRegistryActive: true,
    policy: GIT_HOOK_ACTIVE_RESOLUTION_POLICY,
  });
  if (!resolution) {
    return;
  }

  const currentMessage = await fs.readFile(commitMessagePath, 'utf-8');
  if (
    shouldSkipCommitMessageRewrite(source, currentMessage) ||
    commitMessageAlreadyTagged(currentMessage, resolution.taskId)
  ) {
    return;
  }

  const lines = currentMessage.split('\n');
  const lineIndex = lines.findIndex((line) => line.trim().length > 0 && !line.startsWith('#'));
  if (lineIndex === -1) {
    return;
  }

  lines[lineIndex] = `[${resolution.taskId}] ${lines[lineIndex]}`;
  await fs.writeFile(commitMessagePath, lines.join('\n'), 'utf-8');
}

export async function handlePostCommit(): Promise<void> {
  const runtime = await getRuntimeOrNull();
  if (!runtime || !runtime.config.taskBundles.markStaleOnPostCommit) {
    return;
  }

  const resolution = await runtime.resolveActiveTask({
    preferRegistryActive: true,
    policy: GIT_HOOK_ACTIVE_RESOLUTION_POLICY,
  });
  if (!resolution) {
    return;
  }

  const meta = await markTaskStale(runtime, resolution.taskId, 'post-commit head advanced');
  process.stderr.write(
    `llm-docs: marked task ${meta.task_id} stale after commit. Update context.md/changelog.md before handoff or publish.\n`,
  );
}

export async function handlePostMerge(): Promise<void> {
  const runtime = await getRuntimeOrNull();
  if (!runtime || !runtime.config.taskBundles.markStaleOnPostMerge) {
    return;
  }

  const resolution = await runtime.resolveActiveTask({
    preferRegistryActive: true,
    policy: GIT_HOOK_ACTIVE_RESOLUTION_POLICY,
  });
  if (!resolution) {
    return;
  }

  const meta = await markTaskStale(runtime, resolution.taskId, 'post-merge baseline changed');
  process.stderr.write(
    `llm-docs: marked task ${meta.task_id} stale after merge. Rebaseline or actualize task docs before handoff or publish.\n`,
  );
}

export async function handlePrePush(strict = false): Promise<number> {
  const runtime = await getRuntimeOrNull();
  if (!runtime) {
    return 0;
  }

  const resolution = await runtime.resolveActiveTask({
    preferRegistryActive: true,
    policy: GIT_HOOK_ACTIVE_RESOLUTION_POLICY,
  });
  if (!resolution) {
    return 0;
  }

  const meta = await readTaskMeta(runtime.paths, resolution.taskId);
  if (!meta.staleness.needs_actualization) {
    return 0;
  }

  const message = `Active task ${meta.task_id} is stale: ${meta.staleness.reasons.join('; ')}`;
  process.stderr.write(`${message}\n`);

  if (strict || process.env.LLMDOCS_GIT_HOOK_STRICT === '1') {
    return 1;
  }

  return 0;
}

export function registerGitHookCommands(group: Command): void {
  group
    .command('git-prepare-commit-msg <commitMessagePath> [source]')
    .description('Internal git hook: prepare-commit-msg')
    .action(async (commitMessagePath: string, source?: string) => {
      await handlePrepareCommitMsg(commitMessagePath, source);
    });

  group
    .command('git-post-commit')
    .description('Internal git hook: post-commit')
    .action(async () => {
      await handlePostCommit();
    });

  group
    .command('git-post-merge')
    .description('Internal git hook: post-merge')
    .action(async () => {
      await handlePostMerge();
    });

  group
    .command('git-pre-push')
    .description('Internal git hook: pre-push')
    .option('--strict', 'exit non-zero when the active task is stale')
    .action(async (options: { strict?: boolean }) => {
      process.exitCode = await handlePrePush(options.strict);
      if (process.exitCode === 0) {
        writeTextResponse('');
      }
    });
}
