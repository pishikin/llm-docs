import { Command } from 'commander';
import { createRuntime } from '../engine/runtime.js';
import type { TaskQualityFinding, TaskQualityReport } from '../engine/types.js';
import { getProjectRoot } from '../utils/fs.js';

interface TaskQualityOptions {
  json?: boolean;
}

function icon(severity: TaskQualityFinding['severity']): string {
  if (severity === 'error') {
    return 'error';
  }
  if (severity === 'warning') {
    return 'warn';
  }
  return 'info';
}

function printReport(report: TaskQualityReport): void {
  console.log(`Task quality: ${report.taskId}`);
  console.log(`Status: ${report.status} · score ${report.score}/100`);
  console.log(
    `Profile: ${report.profile.effective} (suggested: ${report.profile.suggested}${report.profile.configured ? `, configured: ${report.profile.configured}` : ''})`,
  );
  if (report.profile.reasons.length > 0) {
    console.log(`Profile reasons: ${report.profile.reasons.join('; ')}`);
  }
  console.log(`Bundle: ${report.bundlePath}`);
  console.log('Metrics:');
  console.log(`- context.md: ${report.metrics.contextBytes} bytes`);
  console.log(`- changelog.md: ${report.metrics.changelogBytes} bytes`);
  console.log(`- summary.md: ${report.metrics.summaryBytes} bytes`);
  console.log(`- source-of-truth paths: ${report.metrics.sourceOfTruthPathCount}`);
  console.log(`- active additional docs: ${report.metrics.additionalDocCount}`);
  console.log(`- latest checkpoint: ${report.metrics.latestCheckpointAt ?? 'n/a'}`);
  console.log(`- latest changelog: ${report.metrics.latestChangelogAt ?? 'n/a'}`);
  console.log(`- stale: ${report.metrics.activeTaskStale ? 'yes' : 'no'}`);

  if (report.findings.length === 0) {
    console.log('Findings: none');
    return;
  }

  console.log('Findings:');
  for (const finding of report.findings) {
    console.log(`- [${icon(finding.severity)}] ${finding.id}: ${finding.message}`);
    if (finding.evidence && finding.evidence.length > 0) {
      for (const evidence of finding.evidence) {
        console.log(`  evidence: ${evidence}`);
      }
    }
    if (finding.suggestion) {
      console.log(`  suggestion: ${finding.suggestion}`);
    }
  }
}

export async function runTaskQuality(
  taskId: string,
  options: TaskQualityOptions,
  startDir?: string,
): Promise<TaskQualityReport> {
  const projectRoot = await getProjectRoot(startDir);
  const runtime = await createRuntime(projectRoot);
  const report = await runtime.buildTaskQualityReport(taskId);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  return report;
}

const taskQualityCommand = new Command('quality')
  .description('Read-only task bundle handoff quality diagnostic')
  .argument('<taskId>', 'task id to inspect')
  .option('--json', 'print JSON output')
  .action(async (taskId: string, options: TaskQualityOptions) => {
    await runTaskQuality(taskId, options);
  });

export default taskQualityCommand;
