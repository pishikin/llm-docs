import path from 'node:path';
import { Command } from 'commander';
import { createDocsAuditBundle } from '../core/docs-audit.js';
import { validateProject } from '../core/validator.js';
import type { ValidationScoreReport } from '../types/index.js';
import { getProjectRoot, readJsonSafe } from '../utils/fs.js';
import * as logger from '../utils/logger.js';

const CHECKLIST_STATUS_LABEL: Record<'pass' | 'fail' | 'unknown', string> = {
  pass: 'PASS',
  fail: 'FAIL',
  unknown: 'N/A',
};

function printScoreReport(score: ValidationScoreReport): void {
  logger.info(`Rubric score: ${score.overall}/10 (${score.band})`);

  for (const criterion of score.criteria) {
    logger.info(`  ${criterion.label}: ${criterion.score}/10 (weight ${criterion.weight}%)`);
  }

  const passCount = score.checklist.filter((item) => item.status === 'pass').length;
  const failCount = score.checklist.filter((item) => item.status === 'fail').length;
  const unknownCount = score.checklist.filter((item) => item.status === 'unknown').length;
  logger.info(`Checklist: pass=${passCount}, fail=${failCount}, n/a=${unknownCount}`);

  for (const item of score.checklist) {
    logger.info(`  [${CHECKLIST_STATUS_LABEL[item.status]}] ${item.label}`);
  }
}

const command = new Command('validate')
  .description('Validate generated documentation')
  .option('--strict', 'treat warnings as errors')
  .option('--json', 'output as JSON')
  .option('--score', 'print weighted quality rubric report')
  .option('--audit', 'write an extended validation audit bundle for debugging')
  .option('--audit-dir <path>', 'custom output directory for audit bundles (works with --audit)')
  .action(
    async (opts: {
      strict?: boolean;
      json?: boolean;
      score?: boolean;
      audit?: boolean;
      auditDir?: string;
    }) => {
      const projectRoot = await getProjectRoot();
      const pkg = await readJsonSafe<Record<string, unknown>>(
        path.join(projectRoot, 'package.json'),
      );
      const scripts = (pkg?.scripts as Record<string, string>) ?? {};

      const spin = logger.spinner('Validating documentation...').start();
      const result = await validateProject(projectRoot, scripts);
      spin.stop();

      const strict = Boolean(opts.strict);
      const errorCount = opts.strict
        ? result.errors.length + result.warnings.length
        : result.errors.length;
      let auditDir: string | null = null;

      if (opts.audit) {
        const auditSpin = logger.spinner('Building extended audit bundle...').start();
        const auditResult = await createDocsAuditBundle({
          projectRoot,
          scripts,
          validation: result,
          strict,
          auditDir: opts.auditDir,
        });
        auditSpin.succeed('Audit bundle created');
        auditDir = auditResult.directory;
      }

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              ...result,
              strict,
              errorCount,
              auditDir,
            },
            null,
            2,
          ),
        );
        process.exit(errorCount > 0 ? 1 : 0);
      }

      if (result.errors.length === 0 && result.warnings.length === 0) {
        logger.success('All documentation is valid.');
        if (auditDir) {
          logger.info(`Audit bundle: ${auditDir}`);
        }
        if (opts.score) {
          printScoreReport(result.score);
        }
        return;
      }

      for (const issue of result.errors) {
        logger.error(`${issue.file}:${issue.line} — ${issue.message} (${issue.reference})`);
      }
      for (const issue of result.warnings) {
        logger.warn(`${issue.file}:${issue.line} — ${issue.message} (${issue.reference})`);
      }

      const hasStaleManagedWarnings = result.warnings.some((issue) =>
        issue.reference.startsWith('stale-managed:'),
      );
      if (hasStaleManagedWarnings) {
        logger.info(
          'Stale managed docs were detected and kept intentionally (auto-prune is disabled).',
        );
        logger.info(
          'Review stale files and remove/archive manually only if they are no longer needed.',
        );
      }

      if (opts.score) {
        printScoreReport(result.score);
      }

      if (auditDir) {
        logger.info(`Audit bundle: ${auditDir}`);
      }

      if (errorCount > 0) {
        logger.error(`${errorCount} error(s) found.`);
        process.exit(1);
      }
    },
  );

export default command;
