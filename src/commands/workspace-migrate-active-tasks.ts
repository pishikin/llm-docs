import { Command } from 'commander';
import { getProjectRoot } from '../utils/fs.js';
import { createV2Runtime } from '../v2/runtime.js';
import type { ActiveTasksMigrationReport } from '../v2/types.js';

interface WorkspaceMigrateActiveTasksOptions {
  dryRun?: boolean;
  json?: boolean;
}

function formatHuman(report: ActiveTasksMigrationReport): void {
  console.log(
    `${report.dryRun ? 'Migration plan' : 'Migrated'} active task storage: ${report.sourceTasksDir} -> ${report.targetTasksDir}`,
  );
  console.log(`- Tasks: ${report.tasks.length}`);

  if (report.operations.length > 0) {
    console.log('Operations:');
    for (const operation of report.operations) {
      if (operation.from && operation.to) {
        console.log(`- ${operation.op}: ${operation.from} -> ${operation.to}`);
      } else if (operation.path) {
        console.log(`- ${operation.op}: ${operation.path}`);
      } else if (operation.message) {
        console.log(`- ${operation.op}: ${operation.message}`);
      } else {
        console.log(`- ${operation.op}`);
      }
    }
  }

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

const workspaceMigrateActiveTasksCommand = new Command('migrate-active-tasks')
  .description(
    'Move active task bundles from visible .claude/tasks into hidden .claude/.llm-docs/tasks',
  )
  .option('--dry-run', 'build a migration plan without writing files')
  .option('--json', 'print migration plan/report as JSON')
  .action(async (options: WorkspaceMigrateActiveTasksOptions) => {
    const projectRoot = await getProjectRoot();
    const runtime = await createV2Runtime(projectRoot, { createIfMissing: false });
    const report = options.dryRun
      ? await runtime.prepareActiveTasksMigration({ dryRun: true })
      : await runtime.applyActiveTasksMigration({ dryRun: false });

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    formatHuman(report);
  });

export default workspaceMigrateActiveTasksCommand;
