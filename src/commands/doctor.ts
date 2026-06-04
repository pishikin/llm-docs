import { Command } from 'commander';
import { getProjectRoot } from '../utils/fs.js';
import type { DoctorCheck, DoctorReport } from '../v2/types.js';
import { buildDoctorReport } from '../v2/workspace/health.js';

export interface DoctorCommandOptions {
  json?: boolean;
  strict?: boolean;
  includeLegacy?: boolean;
}

export interface DoctorCommandResult {
  report: DoctorReport;
  exitCode: 0 | 1 | 2;
}

function calculateDoctorExitCode(
  report: DoctorReport,
  strict: boolean | undefined,
): DoctorCommandResult['exitCode'] {
  if (!report.ok) {
    return 1;
  }

  if (strict && report.checks.some((check) => check.severity === 'warning')) {
    return 2;
  }

  return 0;
}

function summarizeChecks(checks: DoctorCheck[]): Record<DoctorCheck['severity'], number> {
  return checks.reduce<Record<DoctorCheck['severity'], number>>(
    (summary, check) => {
      summary[check.severity] += 1;
      return summary;
    },
    { info: 0, warning: 0, error: 0 },
  );
}

function printDoctorReport(report: DoctorReport): void {
  const counts = summarizeChecks(report.checks);
  console.log(`Project root: ${report.projectRoot}`);
  console.log(`Summary: ${counts.info} info, ${counts.warning} warnings, ${counts.error} errors`);

  for (const check of report.checks) {
    console.log(`[${check.severity}] ${check.id} ${check.message}`);
  }
}

export async function runDoctor(
  options: DoctorCommandOptions,
  startDir?: string,
): Promise<DoctorCommandResult> {
  const projectRoot = await getProjectRoot(startDir);
  const report = await buildDoctorReport(projectRoot, { includeLegacy: options.includeLegacy });
  const exitCode = calculateDoctorExitCode(report, options.strict);

  return {
    report,
    exitCode,
  };
}

const command = new Command('doctor')
  .description('Validate llm-docs v2 config, workspace, registry, and host health')
  .option('--json', 'print the report as JSON')
  .option('--strict', 'treat warnings as non-zero exit status')
  .option('--include-legacy', 'include legacy v1 compatibility checks')
  .action(async (options: DoctorCommandOptions) => {
    const result = await runDoctor(options);
    if (options.json) {
      console.log(JSON.stringify(result.report, null, 2));
    } else {
      printDoctorReport(result.report);
    }

    process.exitCode = result.exitCode;
  });

export default command;
