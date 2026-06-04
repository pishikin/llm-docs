import { Command } from 'commander';
import { getProjectRoot } from '../utils/fs.js';
import {
  type ResearchFileResult,
  checkpointResearchFile,
  compactResearchFile,
  startResearchFile,
} from '../v2/research/single-file.js';
import { createV2Runtime } from '../v2/runtime.js';

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

async function resolveTaskId(taskId: string | undefined, startDir?: string) {
  const projectRoot = await getProjectRoot(startDir);
  const runtime = await createV2Runtime(projectRoot, { createIfMissing: false });
  const resolvedTaskId =
    taskId ?? (await runtime.resolveActiveTask({ preferRegistryActive: true }))?.taskId;

  if (!resolvedTaskId) {
    throw new Error('Cannot resolve research task because no active task is resolved.');
  }

  return { runtime, taskId: resolvedTaskId };
}

function printResult(result: ResearchFileResult): void {
  console.log(`${result.created ? 'Created' : 'Updated'} research file for ${result.taskId}`);
  console.log(`Path: ${result.path}`);
}

export async function runResearchStart(
  slug: string,
  options: { taskId?: string; title?: string; json?: boolean },
  startDir?: string,
): Promise<ResearchFileResult> {
  const { runtime, taskId } = await resolveTaskId(options.taskId, startDir);
  return startResearchFile(runtime.paths, { taskId, slug, title: options.title });
}

export async function runResearchCheckpoint(
  slug: string,
  options: {
    taskId?: string;
    source?: string[];
    finding?: string[];
    decision?: string[];
    nextStep?: string[];
    json?: boolean;
  },
  startDir?: string,
): Promise<ResearchFileResult> {
  const { runtime, taskId } = await resolveTaskId(options.taskId, startDir);
  return checkpointResearchFile(runtime.paths, {
    taskId,
    slug,
    sources: options.source,
    findings: options.finding,
    decisions: options.decision,
    nextSteps: options.nextStep,
  });
}

export async function runResearchCompact(
  slug: string,
  options: { taskId?: string; json?: boolean },
  startDir?: string,
): Promise<ResearchFileResult> {
  const { runtime, taskId } = await resolveTaskId(options.taskId, startDir);
  return compactResearchFile(runtime.paths, { taskId, slug });
}

const researchCommand = new Command('research').description(
  'Maintain compact single-file research notes',
);

researchCommand
  .command('start')
  .description('Create a single-file research note for the active task')
  .argument('<slug>', 'research slug')
  .option('--task-id <taskId>', 'task id; defaults to the resolved active task')
  .option('--title <title>', 'research title')
  .option('--json', 'print JSON output')
  .action(async (slug: string, options: { taskId?: string; title?: string; json?: boolean }) => {
    const result = await runResearchStart(slug, options);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    printResult(result);
  });

researchCommand
  .command('checkpoint')
  .description('Append concise source findings to a research note')
  .argument('<slug>', 'research slug')
  .option('--task-id <taskId>', 'task id; defaults to the resolved active task')
  .option('--source <item>', 'source URL or citation note', collect, [])
  .option('--finding <item>', 'finding item', collect, [])
  .option('--decision <item>', 'decision item', collect, [])
  .option('--next-step <item>', 'next step item', collect, [])
  .option('--json', 'print JSON output')
  .action(
    async (
      slug: string,
      options: {
        taskId?: string;
        source?: string[];
        finding?: string[];
        decision?: string[];
        nextStep?: string[];
        json?: boolean;
      },
    ) => {
      const result = await runResearchCheckpoint(slug, options);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printResult(result);
    },
  );

researchCommand
  .command('compact')
  .description('Refresh the Brief section from current research notes')
  .argument('<slug>', 'research slug')
  .option('--task-id <taskId>', 'task id; defaults to the resolved active task')
  .option('--json', 'print JSON output')
  .action(async (slug: string, options: { taskId?: string; json?: boolean }) => {
    const result = await runResearchCompact(slug, options);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    printResult(result);
  });

export default researchCommand;
