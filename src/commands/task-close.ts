import path from 'node:path';
import { Command } from 'commander';
import { createRuntime } from '../engine/runtime.js';
import type {
  TaskClosePlan,
  TaskCloseReport,
  TaskPublishArtifactPolicy,
  TaskPublishConflictPolicy,
} from '../engine/types.js';
import { getProjectRoot } from '../utils/fs.js';

export interface TaskCloseCommandOptions {
  dryRun?: boolean;
  dest?: string;
  archive?: boolean;
  publish?: boolean;
  deleteActive?: boolean;
  force?: boolean;
  json?: boolean;
  allowStale?: boolean;
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

function formatCloseHuman(report: TaskClosePlan | TaskCloseReport): void {
  console.log(`${report.dryRun ? 'Close plan' : 'Closed'} ${report.taskId}:`);
  if (report.publishPlan) {
    console.log(
      `- Published target: ${path.join(
        report.publishPlan.destination.projectRoot,
        report.publishPlan.destination.targetPath,
      )}`,
    );
  } else {
    console.log('- Published target: skipped');
  }
  console.log(`- Active bundle: ${report.sourceBundlePath}`);
  console.log(`- Active archive: ${report.archivePath ?? 'deleted'}`);

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

const taskCloseCommand = new Command('close')
  .description('Publish a task bundle and remove it from active task storage')
  .argument('[taskId]', 'task id to close')
  .option('--dry-run', 'build a close plan without writing files')
  .option('--dest <path>', 'main worktree destination path')
  .option('--archive', 'publish into docs archive tasks directory')
  .option('--no-publish', 'close without publishing into long-lived docs')
  .option('--delete-active', 'delete active task bundle instead of moving it to hidden archive')
  .option('--force', 'allow explicit force behavior for publish safety checks')
  .option('--json', 'print close plan/report as JSON')
  .option('--allow-stale', 'allow closing and publishing a stale task bundle')
  .option('--conflict <policy>', 'fail, rename, or overwrite', 'fail')
  .option('--include-artifacts <policy>', 'copy, manifest-only, or none', 'copy')
  .action(async (taskId: string | undefined, options: TaskCloseCommandOptions) => {
    const projectRoot = await getProjectRoot();
    const runtime = await createRuntime(projectRoot, { createIfMissing: false });
    const input = {
      taskId,
      dest: options.dest,
      archive: options.archive,
      publish: options.publish,
      deleteActive: options.deleteActive,
      force: options.force,
      allowStale: options.allowStale,
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
    const report = options.dryRun
      ? await runtime.prepareTaskClose({ ...input, dryRun: true })
      : await runtime.applyTaskClose({ ...input, dryRun: false });

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    formatCloseHuman(report);
  });

export default taskCloseCommand;
