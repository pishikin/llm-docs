import path from 'node:path';
import { confirm } from '@inquirer/prompts';
import { Command } from 'commander';
import { analyzeDiff } from '../core/differ.js';
import { getRootDocContract } from '../core/docs-contract.js';
import {
  DOCS_MANIFEST_FILE,
  buildManagedFilesManifest,
  writeDocsManifest,
} from '../core/docs-manifest.js';
import { buildFactPack } from '../core/fact-pack.js';
import { buildCanonicalSharedDetailedDocs, generateDocs } from '../core/generator.js';
import { createProvider } from '../core/llm-client.js';
import {
  buildManagedFilesForTargets,
  getRootOutputPath,
  resolveOutputLayout,
  toAbsolutePath,
} from '../core/output-layout.js';
import { deriveCodexResultFromClaudeResult } from '../core/root-parity.js';
import { scanProject } from '../core/scanner.js';
import {
  getProviderTimeoutMs,
  getSpeedProfileSettings,
  parseSpeedProfile,
} from '../core/speed-profile.js';
import { emitClaude } from '../emitters/claude.js';
import { emitCodex } from '../emitters/codex.js';
import { emitCursor } from '../emitters/cursor.js';
import type { DiffAnalysis, GenerationResult, ProjectConfig, Target } from '../types/index.js';
import {
  fileExists,
  getProjectRoot,
  readFileSafe,
  readJsonSafe,
  writeFileSafe,
} from '../utils/fs.js';
import * as logger from '../utils/logger.js';
import { normalizeTargets } from '../utils/targets.js';

const EMITTERS: Record<
  Target,
  (
    result: import('../types/index.js').GenerationResult,
    root: string,
    options: { canonicalDocsDir: string; cursorRulesDir: string },
  ) => Promise<string[]>
> = {
  claude: emitClaude,
  codex: emitCodex,
  cursor: emitCursor,
};

const ROOT_IMPACT_SECTIONS = new Set(['architecture.md', 'commands.md', 'coding-style.md']);

function normalizeSection(section: string): string {
  const normalized = section.replace(/\\/g, '/');
  const segments = normalized.split('/');
  return segments[segments.length - 1] ?? normalized;
}

function shouldUpdateRoot(impactedSections: string[]): boolean {
  return impactedSections.some((section) => ROOT_IMPACT_SECTIONS.has(normalizeSection(section)));
}

function getImpactedDocNames(target: Target, impactedSections: string[]): Set<string> {
  const names = impactedSections.map(normalizeSection);
  if (target === 'cursor') {
    return new Set(names.map((name) => (name.endsWith('.md') ? `${name.slice(0, -3)}.mdc` : name)));
  }
  return new Set(names);
}

function filterResultByImpact(
  result: GenerationResult,
  impactedSections: string[],
  updateRoot: boolean,
): GenerationResult {
  const impactedDocNames = getImpactedDocNames(result.target, impactedSections);
  return {
    ...result,
    rootContent: updateRoot ? result.rootContent : '',
    detailedDocs: result.detailedDocs.filter((doc) => impactedDocNames.has(doc.filename)),
  };
}

function parseTargetConcurrency(rawValue?: string): number | undefined {
  if (!rawValue) return undefined;
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(value) || value < 1) {
    return undefined;
  }
  return value;
}

function getRootOnlyTargets(targets: Target[]): Target[] {
  if (targets.includes('claude') && targets.includes('codex')) {
    return ['codex'];
  }
  return [];
}

function shouldDeriveCodexRoot(targets: Target[]): boolean {
  return targets.includes('claude') && targets.includes('codex');
}

function orderResultsByTargetSelection(
  results: GenerationResult[],
  selectedTargets: Target[],
): GenerationResult[] {
  const byTarget = new Map<Target, GenerationResult>(
    results.map((result) => [result.target, result]),
  );
  return selectedTargets
    .map((target) => byTarget.get(target))
    .filter((result): result is GenerationResult => Boolean(result));
}

function isRecoverableParallelError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('timed out') ||
    normalized.includes('empty response') ||
    normalized.includes('json-empty') ||
    normalized.includes('missing root file marker')
  );
}

function isCursorOnlyTargetSelection(targets: Target[]): boolean {
  return targets.length === 1 && targets[0] === 'cursor';
}

function hasRequiredHeading(content: string, heading: string): boolean {
  const pattern = new RegExp(
    `^\\s*#{1,6}\\s*${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:?\\s*$`,
    'im',
  );
  return pattern.test(content);
}

function stripLeadingFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/);
  if (!match) {
    return normalized;
  }
  return normalized.slice(match[0].length);
}

function extractCursorFrontmatterField(frontmatter: string, fieldName: string): string | null {
  const fieldPattern = new RegExp(
    `^\\s*${fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:(.*)$`,
    'i',
  );
  for (const line of frontmatter.split('\n')) {
    const match = line.match(fieldPattern);
    if (!match) continue;
    return (match[1] ?? '').trim();
  }
  return null;
}

function hasNonEmptyGlob(globsValue: string | null): boolean {
  if (!globsValue) return false;
  const normalized = globsValue.replace(/['"`]/g, '').trim();
  if (!normalized || normalized === '[]') return false;
  return true;
}

interface SyncStructureIssue {
  path: string;
  message: string;
}

async function inspectManagedStructure(
  projectRoot: string,
  targets: Target[],
  layout: { canonicalDocsDir: string; cursorRulesDir: string },
  includeCanonicalForCursorOnly: boolean,
): Promise<{ missing: SyncStructureIssue[]; invalid: SyncStructureIssue[] }> {
  const managedFiles = buildManagedFilesForTargets(targets, layout, {
    includeCanonicalForCursorOnly,
  });
  const missing: SyncStructureIssue[] = [];
  const invalid: SyncStructureIssue[] = [];

  for (const relativePath of managedFiles) {
    const fullPath = toAbsolutePath(projectRoot, relativePath);
    if (!(await fileExists(fullPath))) {
      missing.push({
        path: relativePath,
        message: 'Managed documentation file is missing.',
      });
    }
  }

  for (const target of targets) {
    const rootRelativePath = getRootOutputPath(target, layout);
    const rootFullPath = toAbsolutePath(projectRoot, rootRelativePath);
    const content = await readFileSafe(rootFullPath);
    if (!content) {
      continue;
    }

    const contract = getRootDocContract(target);
    const rootBody = target === 'cursor' ? stripLeadingFrontmatter(content) : content;
    for (const heading of contract.requiredHeadings) {
      if (!hasRequiredHeading(rootBody, heading)) {
        invalid.push({
          path: rootRelativePath,
          message: `Missing required heading "${heading}" in managed root doc.`,
        });
      }
    }

    if (target !== 'cursor') {
      continue;
    }

    const frontmatterMatch = content
      .replace(/\r\n/g, '\n')
      .match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
    if (!frontmatterMatch) {
      invalid.push({
        path: rootRelativePath,
        message: 'Cursor managed root doc is missing YAML frontmatter.',
      });
      continue;
    }

    const frontmatter = frontmatterMatch[1] ?? '';
    const alwaysApply = extractCursorFrontmatterField(frontmatter, 'alwaysApply');
    const globs = extractCursorFrontmatterField(frontmatter, 'globs');
    if (alwaysApply?.toLowerCase() !== 'true') {
      invalid.push({
        path: rootRelativePath,
        message: 'Cursor managed root doc must keep "alwaysApply: true".',
      });
    }
    if (hasNonEmptyGlob(globs)) {
      invalid.push({
        path: rootRelativePath,
        message: 'Cursor managed root doc must keep empty "globs" with alwaysApply=true.',
      });
    }
  }

  return { missing, invalid };
}

function printSyncGuide(
  layout: { canonicalDocsDir: string; cursorRulesDir: string },
  includeCanonicalForCursorOnly: boolean,
): void {
  logger.info('Sync safety guide:');
  logger.info('1. Custom files/folders are preserved and ignored by sync readiness checks.');
  logger.info(
    `2. Sync validates only managed docs generated by llm-docs (${layout.canonicalDocsDir} and ${layout.cursorRulesDir} managed set).`,
  );
  logger.info('3. If managed structure is heavily drifted, sync stops to avoid mixed output.');
  logger.info('4. Recovery steps:');
  logger.info('   - Run `node dist/index.js validate --score` to inspect issues.');
  logger.info(
    '   - Restore managed root docs to expected format (or run a full `node dist/index.js generate`).',
  );
  logger.info('   - Re-run `node dist/index.js sync --from <ref>`.');
  if (includeCanonicalForCursorOnly) {
    logger.info(
      `Cursor-only note: canonical docs in "${layout.canonicalDocsDir}" are intentionally generated and are not a tool error.`,
    );
  }
}

function getCursorOnlyCanonicalDocPaths(
  projectRoot: string,
  canonicalDocsDir: string,
  factPack: import('../types/index.js').FactPack,
): { absolutePath: string; filename: string; content: string }[] {
  return buildCanonicalSharedDetailedDocs(factPack).map((doc) => ({
    absolutePath: toAbsolutePath(projectRoot, `${canonicalDocsDir}/${doc.filename}`),
    filename: doc.filename,
    content: doc.content,
  }));
}

const command = new Command('sync')
  .description('Incrementally update documentation based on git diff')
  .option('--from <ref>', 'git ref to diff from', 'HEAD~1')
  .option('--dry-run', 'preview changes without writing')
  .option('--speed-profile <profile>', 'generation profile: fast|balanced|max-quality')
  .option(
    '--target-concurrency <n>',
    'number of targets to generate in parallel (default: speed-profile value)',
  )
  .option('--guide', 'print sync safety and recovery guide')
  .option('-y, --yes', 'apply changes without confirmation')
  .action(
    async (opts: {
      from: string;
      dryRun?: boolean;
      yes?: boolean;
      guide?: boolean;
      targetConcurrency?: string;
      speedProfile?: string;
    }) => {
      const requestedTargetConcurrency = parseTargetConcurrency(opts.targetConcurrency);
      const projectRoot = await getProjectRoot();
      const config = await readJsonSafe<ProjectConfig>(
        path.join(projectRoot, 'llmdocs.config.json'),
      );

      if (!config) {
        logger.error('No llmdocs.config.json found. Run `llm-docs init` first.');
        process.exit(1);
      }
      const targets = normalizeTargets(
        Array.isArray(config.targets) ? config.targets.map((target) => String(target)) : [],
        'llmdocs.config.json targets',
      );
      const layout = resolveOutputLayout(config);
      const cursorOnlyMode = isCursorOnlyTargetSelection(targets);
      const includeCanonicalForCursorOnly = cursorOnlyMode;

      if (opts.guide) {
        printSyncGuide(layout, includeCanonicalForCursorOnly);
        return;
      }

      const spin = logger.spinner('Analyzing changes...').start();

      let diff: DiffAnalysis;
      try {
        diff = await analyzeDiff(projectRoot, opts.from);
      } catch {
        spin.fail('Not a git repository or no commits found.');
        process.exit(1);
      }

      if (diff.changedFiles.length === 0) {
        spin.succeed('Documentation is up to date.');
        return;
      }

      spin.text = `${diff.changedFiles.length} files changed, ${diff.impactedSections.length} sections impacted`;
      spin.succeed();

      logger.info(`Impacted sections: ${diff.impactedSections.join(', ')}`);
      logger.info(
        `Sync readiness checks ignore custom docs and inspect only managed generated structure for targets: ${targets.join(', ')}`,
      );
      if (cursorOnlyMode) {
        logger.info(
          `Cursor-only mode: canonical docs in "${layout.canonicalDocsDir}" are intentionally maintained and synced.`,
        );
      }

      const managedStructure = await inspectManagedStructure(
        projectRoot,
        targets,
        layout,
        includeCanonicalForCursorOnly,
      );
      if (managedStructure.missing.length > 0 || managedStructure.invalid.length > 0) {
        logger.error(
          'Managed documentation structure is drifted. Sync is blocked to avoid mixed/unsafe output.',
        );
        for (const issue of managedStructure.missing) {
          logger.error(`  missing: ${issue.path} — ${issue.message}`);
        }
        for (const issue of managedStructure.invalid) {
          logger.error(`  invalid: ${issue.path} — ${issue.message}`);
        }
        logger.info('How to recover safely:');
        logger.info('1. Keep your custom docs as-is (they are not deleted by sync).');
        logger.info('2. Restore managed docs format or run `node dist/index.js generate`.');
        logger.info('3. Re-run `node dist/index.js sync --from <ref>`.');
        logger.info('Tip: run `node dist/index.js sync --guide` for full guidance.');
        process.exit(1);
      }

      const scanData = await scanProject(projectRoot, { excludeDirs: config.excludeDirs });
      const factPack = await buildFactPack(scanData);
      const speedSettings = getSpeedProfileSettings(parseSpeedProfile(opts.speedProfile));
      let targetConcurrency = requestedTargetConcurrency ?? speedSettings.defaultTargetConcurrency;
      const providerTimeoutMs = getProviderTimeoutMs(config.provider.type, speedSettings);
      const provider = createProvider(config.provider, {
        shellTimeoutMs: providerTimeoutMs,
        customTimeoutMs: providerTimeoutMs,
        codexMaxEmptyRetries: speedSettings.codexMaxEmptyRetries,
        codexReasoningEffort: speedSettings.codexReasoningEffort,
      });

      if (
        (config.provider.type === 'claude-code' || config.provider.type === 'cursor-agent') &&
        targetConcurrency > 1
      ) {
        const providerName =
          config.provider.type === 'cursor-agent' ? 'Cursor Agent' : 'Claude Code';
        logger.warn(
          `${providerName} provider uses sequential target generation to avoid rate limiting.`,
        );
        targetConcurrency = 1;
      }

      logger.info(
        `Speed profile: ${speedSettings.profile} (tree=${speedSettings.maxDirectoryTreeEntries}, formatRepair=${speedSettings.enableFormatRepair ? 'on' : 'off'}, qualityRepair=${speedSettings.enableQualityRepair ? 'on' : 'off'}, providerFallback=${speedSettings.allowProviderFailureFallback ? 'on' : 'off'}, codexRetries=${speedSettings.codexMaxEmptyRetries}, codexReasoning=${speedSettings.codexReasoningEffort ?? 'default'})`,
      );
      if (providerTimeoutMs) {
        logger.info(`Provider timeout: ${Math.round(providerTimeoutMs / 1000)}s`);
      }

      if (targetConcurrency > 1) {
        logger.info(`Generating with target concurrency: ${targetConcurrency}`);
      }

      const rootOnlyTargets = getRootOnlyTargets(targets);
      const deriveCodexFromClaude = shouldDeriveCodexRoot(targets);
      const providerTargets = deriveCodexFromClaude
        ? targets.filter((target) => target !== 'codex')
        : targets;

      spin.start('Regenerating impacted documentation...');
      let results: GenerationResult[];
      const generationOptions = {
        targetConcurrency,
        maxDirectoryTreeEntries: speedSettings.maxDirectoryTreeEntries,
        enableFormatRepair: speedSettings.enableFormatRepair,
        enableQualityRepair: speedSettings.enableQualityRepair,
        allowProviderFailureFallback: speedSettings.allowProviderFailureFallback,
        rootOnlyTargets,
        projectRoot,
      };

      try {
        results = await generateDocs(
          factPack,
          providerTargets,
          provider,
          config.provider.type,
          generationOptions,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const shouldFallbackSequential =
          targetConcurrency > 1 && isRecoverableParallelError(message);
        if (!shouldFallbackSequential) {
          spin.fail('Documentation regeneration failed');
          throw error;
        }

        logger.warn(
          `Parallel regeneration failed with a recoverable error (${message}). Retrying sequentially for stability.`,
        );
        results = await generateDocs(factPack, providerTargets, provider, config.provider.type, {
          ...generationOptions,
          targetConcurrency: 1,
        });
      }

      if (deriveCodexFromClaude) {
        const claudeResult = results.find((result) => result.target === 'claude');
        if (!claudeResult) {
          spin.fail('Documentation regeneration failed');
          throw new Error('Cannot derive AGENTS.md without regenerated CLAUDE.md output.');
        }

        results = [
          ...results.filter((result) => result.target !== 'codex'),
          deriveCodexResultFromClaudeResult(claudeResult),
        ];
        logger.info('Codex root derived from CLAUDE.md (parity mode).');
      }

      results = orderResultsByTargetSelection(results, targets);
      spin.succeed('Documentation regenerated');

      const updateRoot = shouldUpdateRoot(diff.impactedSections);
      const filteredResults = results
        .map((result) => filterResultByImpact(result, diff.impactedSections, updateRoot))
        .filter((result) => result.rootContent.trim().length > 0 || result.detailedDocs.length > 0);

      if (filteredResults.length === 0) {
        logger.info('No mapped documentation files require updates for these changes.');
        return;
      }

      if (opts.dryRun) {
        for (const result of filteredResults) {
          let fileCount =
            (result.rootContent.trim().length > 0 ? 1 : 0) + result.detailedDocs.length;
          if (cursorOnlyMode && result.target === 'cursor') {
            fileCount += buildCanonicalSharedDetailedDocs(factPack).length;
          }
          logger.info(`[${result.target}] ${fileCount} files would be updated`);
        }
        return;
      }

      if (!opts.yes) {
        const totalUpdates = filteredResults.reduce(
          (count, result) =>
            count +
            (result.rootContent.trim().length > 0 ? 1 : 0) +
            result.detailedDocs.length +
            (cursorOnlyMode && result.target === 'cursor'
              ? buildCanonicalSharedDetailedDocs(factPack).length
              : 0),
          0,
        );
        const approved = await confirm({
          message: `Apply ${totalUpdates} documentation update(s)?`,
        });
        if (!approved) {
          logger.info('Aborted.');
          return;
        }
      }

      const allWritten: string[] = [];
      for (const result of filteredResults) {
        const written = await EMITTERS[result.target](result, projectRoot, {
          canonicalDocsDir: layout.canonicalDocsDir,
          cursorRulesDir: layout.cursorRulesDir,
        });
        if (cursorOnlyMode && result.target === 'cursor') {
          const canonicalDocs = getCursorOnlyCanonicalDocPaths(
            projectRoot,
            layout.canonicalDocsDir,
            factPack,
          );
          for (const canonicalDoc of canonicalDocs) {
            await writeFileSafe(canonicalDoc.absolutePath, canonicalDoc.content);
            written.push(canonicalDoc.absolutePath);
          }
          if (canonicalDocs.length > 0) {
            logger.info(
              `Cursor-only mode: synced ${canonicalDocs.length} canonical doc(s) in "${layout.canonicalDocsDir}".`,
            );
          }
        }
        allWritten.push(...written);
      }

      await writeFileSafe(
        path.join(projectRoot, 'llmdocs.evidence.json'),
        JSON.stringify(factPack, null, 2),
      );
      await writeDocsManifest(projectRoot, {
        targets,
        layout,
        managedFiles: buildManagedFilesManifest(targets, layout, {
          includeCanonicalForCursorOnly,
        }),
      });
      allWritten.push(toAbsolutePath(projectRoot, DOCS_MANIFEST_FILE));

      logger.success(`Updated ${allWritten.length} files.`);
    },
  );

export default command;
