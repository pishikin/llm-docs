import { Command } from 'commander';
import { getProjectRoot } from '../utils/fs.js';
import { type ContextStatusReport, buildContextStatusReport } from '../v2/context/status.js';
import { createV2Runtime } from '../v2/runtime.js';
import { resolveCodexSessionIdFromEnv } from '../v2/task/session-binding.js';

export interface ContextStatusCommandOptions {
  json?: boolean;
  sessionId?: string;
}

function formatBytes(sizeBytes: number | null): string {
  if (sizeBytes === null) {
    return 'missing';
  }

  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  return `${(sizeBytes / 1024).toFixed(1)} KB`;
}

function printContextStatus(report: ContextStatusReport): void {
  console.log(`Active task: ${report.activeTaskId ?? 'none'}`);
  if (report.resolvedBy) {
    console.log(`Resolved by: ${report.resolvedBy}`);
  }
  console.log(`Risk: ${report.risk}`);
  console.log(`Recommendation: ${report.recommendation}`);

  if (report.reasons.length > 0) {
    console.log('');
    console.log('Reasons:');
    for (const reason of report.reasons) {
      console.log(`- ${reason}`);
    }
  }

  if (report.reloadFiles.length > 0) {
    console.log('');
    console.log('Refresh from:');
    for (const file of report.reloadFiles) {
      console.log(`- ${file}`);
    }
    console.log('- changelog.md is optional unless decisions or verification are unclear.');
  }

  if (report.warnings.length > 0) {
    console.log('');
    console.log('Warnings:');
    for (const warning of report.warnings) {
      console.log(`- ${warning}`);
    }
  }

  if (report.files.length > 0) {
    console.log('');
    console.log('Files:');
    for (const file of report.files) {
      const budget = file.budgetBytes === null ? '' : ` / ${formatBytes(file.budgetBytes)}`;
      console.log(
        `${file.kind.padEnd(9)} ${file.status.padEnd(7)} ${formatBytes(file.sizeBytes)}${budget} ${file.path}`,
      );
    }
  }

  console.log('');
  console.log(
    `Transcript: ${report.transcript.estimatedTokens ?? 'unknown'} / ${report.transcript.riskTokens}`,
  );
}

export async function runContextStatus(
  _options: ContextStatusCommandOptions,
  startDir?: string,
): Promise<ContextStatusReport> {
  const projectRoot = await getProjectRoot(startDir);
  const runtime = await createV2Runtime(projectRoot, { createIfMissing: false });
  const sessionId = _options.sessionId ?? resolveCodexSessionIdFromEnv();
  const activeTask = await runtime.resolveActiveTask({
    preferRegistryActive: true,
    codexSessionId: sessionId,
  });

  return buildContextStatusReport({
    projectRoot,
    config: runtime.config,
    paths: runtime.paths,
    activeTask,
  });
}

const contextCommand = new Command('context').description('Inspect active context size and risk');

contextCommand
  .command('status')
  .description('Show active task context budget status')
  .option('--session-id <id>', 'resolve active task through a Codex session binding')
  .option('--json', 'print JSON output')
  .action(async (options: ContextStatusCommandOptions) => {
    const report = await runContextStatus(options);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    printContextStatus(report);
  });

export default contextCommand;
