import path from 'node:path';
import { Command } from 'commander';
import { createRuntime } from '../engine/runtime.js';
import type {
  TaskPublishArtifactPolicy,
  TaskPublishConflictPolicy,
  TaskPublishPlan,
  TaskPublishPrepareInput,
  TaskPublishReport,
} from '../engine/types.js';
import { getProjectRoot } from '../utils/fs.js';

export interface TaskPublishCommandOptions {
  dryRun?: boolean;
  dest?: string;
  archive?: boolean;
  keepSource?: boolean;
  deleteWorktree?: boolean;
  force?: boolean;
  json?: boolean;
  allowStale?: boolean;
  skipRebaselineCheck?: boolean;
  conflict?: TaskPublishConflictPolicy;
  includeArtifacts?: TaskPublishArtifactPolicy;
}

function assertOptionValue<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  label: string,
): T | undefined {
  if (!value) {
    return undefined;
  }

  if (allowed.includes(value as T)) {
    return value as T;
  }

  throw new Error(`Unsupported ${label}: ${value}. Expected ${allowed.join(', ')}.`);
}

function toInput(
  taskId: string | undefined,
  options: TaskPublishCommandOptions,
): TaskPublishPrepareInput {
  return {
    taskId,
    dest: options.dest,
    archive: options.archive,
    keepSource: options.keepSource,
    deleteWorktree: options.deleteWorktree,
    force: options.force,
    allowStale: options.allowStale,
    skipRebaselineCheck: options.skipRebaselineCheck,
    conflictPolicy: assertOptionValue(
      options.conflict,
      ['fail', 'rename', 'overwrite'],
      'conflict policy',
    ),
    includeArtifacts: assertOptionValue(
      options.includeArtifacts,
      ['copy', 'manifest-only', 'none'],
      'artifact policy',
    ),
    dryRun: options.dryRun,
  };
}

function formatPublishHuman(report: TaskPublishPlan | TaskPublishReport): void {
  const mode = report.mode === 'archive' ? 'archive' : 'docs';
  const target = path.join(report.destination.projectRoot, report.destination.targetPath);
  console.log(`${report.dryRun ? 'Publish plan' : 'Published'} ${report.taskId} to ${mode}:`);
  console.log(`- Target: ${target}`);
  console.log(`- Source branch: ${report.source.branch ?? 'unknown'}`);
  console.log(`- Source commit: ${report.source.commit ?? 'unknown'}`);
  console.log(`- Files: ${report.files.length}`);
  console.log(`- Bundle hash: ${report.source.bundleHash ?? 'unknown'}`);

  if (report.conflicts.length > 0) {
    console.log('Conflicts:');
    for (const conflict of report.conflicts) {
      console.log(`- ${conflict.message}`);
    }
  }

  if (report.warnings.length > 0) {
    console.log('Warnings:');
    for (const warning of report.warnings) {
      console.log(`- ${warning}`);
    }
  }
}

export async function runTaskPublish(
  taskId: string | undefined,
  options: TaskPublishCommandOptions,
  startDir?: string,
) {
  const projectRoot = await getProjectRoot(startDir);
  const runtime = await createRuntime(projectRoot, { createIfMissing: false });
  const input = toInput(taskId, options);

  if (options.dryRun) {
    return runtime.prepareTaskPublish({ ...input, dryRun: true });
  }

  return runtime.applyTaskPublish({ ...input, dryRun: false });
}

const taskPublishCommand = new Command('publish')
  .description('Publish a task bundle into long-lived docs in the main worktree')
  .argument('[taskId]', 'task id to publish')
  .option('--dry-run', 'build a publish plan without writing files')
  .option('--dest <path>', 'main worktree destination path')
  .option('--archive', 'publish into docs archive tasks directory')
  .option(
    '--keep-source',
    'accepted for workflow compatibility; source is kept unless --delete-worktree',
  )
  .option('--delete-worktree', 'remove source git worktree after successful publish')
  .option('--force', 'allow explicit force behavior for overwrite/delete safety checks')
  .option('--json', 'print publish plan/report as JSON')
  .option('--allow-stale', 'allow publishing a stale task bundle')
  .option('--skip-rebaseline-check', 'reserved for compatibility with future rebaseline checks')
  .option('--conflict <policy>', 'fail, rename, or overwrite', 'fail')
  .option('--include-artifacts <policy>', 'copy, manifest-only, or none', 'copy')
  .action(async (taskId: string | undefined, options: TaskPublishCommandOptions) => {
    const report = await runTaskPublish(taskId, options);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      formatPublishHuman(report);
    }
  });

export default taskPublishCommand;
