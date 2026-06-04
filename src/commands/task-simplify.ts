import { Command } from 'commander';
import { getProjectRoot } from '../utils/fs.js';
import { createV2Runtime } from '../v2/runtime.js';
import { normalizeTaskId } from '../v2/task/id.js';
import { simplifyTaskBundle } from '../v2/task/simplify.js';

const taskSimplifyCommand = new Command('simplify')
  .description('Convert a full task bundle to the simple context.md/state.json layout')
  .argument('<taskId>', 'task id to simplify')
  .option('--dry-run', 'show planned changes without writing', false)
  .option('--keep-legacy', 'keep legacy full-layout files in place')
  .option('--json', 'print JSON output')
  .action(
    async (taskId: string, options: { dryRun?: boolean; keepLegacy?: boolean; json?: boolean }) => {
      const projectRoot = await getProjectRoot();
      const runtime = await createV2Runtime(projectRoot);
      const report = await simplifyTaskBundle(runtime.paths, {
        taskId: normalizeTaskId(taskId),
        dryRun: options.dryRun,
        keepLegacy: options.keepLegacy,
      });

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      console.log(`${report.dryRun ? 'Planned' : 'Applied'} task simplify: ${report.taskId}`);
      for (const operation of report.operations) {
        console.log(`- ${operation.op}: ${operation.path}`);
      }
    },
  );

export default taskSimplifyCommand;
