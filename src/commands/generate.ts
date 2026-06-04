import path from 'node:path';
import { Command } from 'commander';
import {
  DOCS_MANIFEST_FILE,
  buildManagedFilesManifest,
  writeDocsManifest,
} from '../core/docs-manifest.js';
import { buildFactPack } from '../core/fact-pack.js';
import {
  buildGenerationCacheHash,
  isGenerationCacheHit,
  readGenerationCache,
  resolveGenerationCachePath,
  updateGenerationCacheEntry,
  writeGenerationCache,
} from '../core/generation-cache.js';
import { buildCanonicalSharedDetailedDocs, generateDocs } from '../core/generator.js';
import { createProvider } from '../core/llm-client.js';
import {
  getDetailedOutputDir,
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
import type { GenerationResult, ProjectConfig, Target } from '../types/index.js';
import { getProjectRoot, readFileSafe, readJsonSafe, writeFileSafe } from '../utils/fs.js';
import * as logger from '../utils/logger.js';
import { normalizeTargets, parseTargetsOption } from '../utils/targets.js';

const EMITTERS: Record<
  Target,
  (
    result: GenerationResult,
    root: string,
    options: { canonicalDocsDir: string; cursorRulesDir: string },
  ) => Promise<string[]>
> = {
  claude: emitClaude,
  codex: emitCodex,
  cursor: emitCursor,
};

function isCursorOnlyTargetSelection(targets: Target[]): boolean {
  return targets.length === 1 && targets[0] === 'cursor';
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

function formatTargetsForLog(targets: Target[]): string {
  return targets.join(', ');
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

function getCursorOnlyCanonicalDocPaths(
  projectRoot: string,
  canonicalDocsDir: string,
  factPack: import('../types/index.js').FactPack,
): { absolutePath: string; content: string }[] {
  return buildCanonicalSharedDetailedDocs(factPack).map((doc) => ({
    absolutePath: toAbsolutePath(projectRoot, `${canonicalDocsDir}/${doc.filename}`),
    content: doc.content,
  }));
}

const command = new Command('generate')
  .description('Generate documentation for all configured targets')
  .option('--dry-run', 'preview without writing files')
  .option('--targets <targets>', 'override targets (comma-separated)')
  .option('--speed-profile <profile>', 'generation profile: fast|balanced|max-quality')
  .option(
    '--target-concurrency <n>',
    'number of targets to generate in parallel (default: speed-profile value)',
  )
  .option('--no-cache', 'disable generation cache and force all selected targets')
  .action(
    async (opts: {
      dryRun?: boolean;
      targets?: string;
      speedProfile?: string;
      targetConcurrency?: string;
      cache?: boolean;
    }) => {
      const projectRoot = await getProjectRoot();
      const config = await readJsonSafe<ProjectConfig>(
        path.join(projectRoot, 'llmdocs.config.json'),
      );

      if (!config) {
        logger.error('No llmdocs.config.json found. Run `llm-docs init` first.');
        process.exit(1);
      }

      const configTargets = normalizeTargets(
        Array.isArray(config.targets) ? config.targets.map((target) => String(target)) : [],
        'llmdocs.config.json targets',
      );

      const targets: Target[] = opts.targets ? parseTargetsOption(opts.targets) : configTargets;
      const layout = resolveOutputLayout(config);
      const cursorOnlyMode = isCursorOnlyTargetSelection(targets);
      if (opts.targets) {
        logger.warn(
          `Targets override is active via --targets. Effective targets: ${formatTargetsForLog(targets)} (config targets: ${formatTargetsForLog(configTargets)}).`,
        );
      } else {
        logger.info(`Targets from config: ${formatTargetsForLog(configTargets)}.`);
      }
      if (cursorOnlyMode) {
        logger.info(
          `Cursor-only mode is enabled. Minimal canonical docs will also be maintained in "${layout.canonicalDocsDir}" so Cursor adapters can reference a shared source.`,
        );
      }
      const selectedProfile = parseSpeedProfile(opts.speedProfile);
      const speedSettings = getSpeedProfileSettings(selectedProfile);
      const requestedConcurrency = parseTargetConcurrency(opts.targetConcurrency);
      let targetConcurrency = requestedConcurrency ?? speedSettings.defaultTargetConcurrency;
      const rootOnlyTargets = getRootOnlyTargets(targets);
      const deriveCodexFromClaude = shouldDeriveCodexRoot(targets);
      const cacheEnabled = opts.cache ?? true;

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

      const spin = logger.spinner('Scanning project...').start();
      const scanData = await scanProject(projectRoot, { excludeDirs: config.excludeDirs });
      const factPack = await buildFactPack(scanData);
      spin.succeed('Project scanned');

      const providerTimeoutMs = getProviderTimeoutMs(config.provider.type, speedSettings);
      const provider = createProvider(config.provider, {
        shellTimeoutMs: providerTimeoutMs,
        customTimeoutMs: providerTimeoutMs,
        codexMaxEmptyRetries: speedSettings.codexMaxEmptyRetries,
        codexReasoningEffort: speedSettings.codexReasoningEffort,
      });

      logger.info(
        `Speed profile: ${speedSettings.profile} (tree=${speedSettings.maxDirectoryTreeEntries}, formatRepair=${speedSettings.enableFormatRepair ? 'on' : 'off'}, qualityRepair=${speedSettings.enableQualityRepair ? 'on' : 'off'}, providerFallback=${speedSettings.allowProviderFailureFallback ? 'on' : 'off'}, codexRetries=${speedSettings.codexMaxEmptyRetries}, codexReasoning=${speedSettings.codexReasoningEffort ?? 'default'})`,
      );
      if (providerTimeoutMs) {
        logger.info(`Provider timeout: ${Math.round(providerTimeoutMs / 1000)}s`);
      }
      if (!cacheEnabled) {
        logger.info('Generation cache is disabled for this run.');
      }

      if (targetConcurrency > 1) {
        logger.info(`Generating with target concurrency: ${targetConcurrency}`);
      }

      const inputHashes = new Map<Target, string>();
      const skippedTargets = new Set<Target>();
      let targetsToGenerate = [...targets];
      let cachePath: string | null = null;
      let cacheData: Awaited<ReturnType<typeof readGenerationCache>> | null = null;

      if (cacheEnabled) {
        cachePath = await resolveGenerationCachePath(projectRoot);
        cacheData = await readGenerationCache(cachePath);

        targetsToGenerate = [];
        for (const target of targets) {
          const inputHash = buildGenerationCacheHash({
            factPack,
            provider: config.provider,
            speedProfile: speedSettings.profile,
            target,
            maxDirectoryTreeEntries: speedSettings.maxDirectoryTreeEntries,
            enableFormatRepair: speedSettings.enableFormatRepair,
            enableQualityRepair: speedSettings.enableQualityRepair,
            rootOnly: rootOnlyTargets.includes(target),
            ensureCursorCanonicalDocs: cursorOnlyMode && target === 'cursor',
          });
          inputHashes.set(target, inputHash);

          if (await isGenerationCacheHit(projectRoot, cacheData, target, inputHash)) {
            skippedTargets.add(target);
            continue;
          }

          targetsToGenerate.push(target);
        }
      }

      const shouldRefreshDerivedCodex =
        deriveCodexFromClaude &&
        (!cacheEnabled ||
          targetsToGenerate.includes('claude') ||
          targetsToGenerate.includes('codex'));
      if (shouldRefreshDerivedCodex) {
        skippedTargets.delete('codex');
      }

      const providerTargetsToGenerate = deriveCodexFromClaude
        ? targetsToGenerate.filter((target) => target !== 'codex')
        : targetsToGenerate;

      let results: GenerationResult[] = [];
      if (targetsToGenerate.length > 0) {
        spin.start('Generating documentation...');

        const generationOptions = {
          targetConcurrency,
          maxDirectoryTreeEntries: speedSettings.maxDirectoryTreeEntries,
          enableFormatRepair: speedSettings.enableFormatRepair,
          enableQualityRepair: speedSettings.enableQualityRepair,
          allowProviderFailureFallback: speedSettings.allowProviderFailureFallback,
          rootOnlyTargets,
          projectRoot,
        };

        if (providerTargetsToGenerate.length > 0) {
          try {
            results = await generateDocs(
              factPack,
              providerTargetsToGenerate,
              provider,
              config.provider.type,
              generationOptions,
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const shouldFallbackSequential =
              targetConcurrency > 1 && isRecoverableParallelError(message);
            if (!shouldFallbackSequential) {
              spin.fail('Documentation generation failed');
              throw error;
            }

            logger.warn(
              `Parallel generation failed with a recoverable error (${message}). Retrying sequentially for stability.`,
            );
            results = await generateDocs(
              factPack,
              providerTargetsToGenerate,
              provider,
              config.provider.type,
              {
                ...generationOptions,
                targetConcurrency: 1,
              },
            );
          }
        }

        if (shouldRefreshDerivedCodex) {
          let claudeResult = results.find((result) => result.target === 'claude');
          if (!claudeResult) {
            const claudeRootPath = toAbsolutePath(projectRoot, getRootOutputPath('claude', layout));
            const claudeRootContent = await readFileSafe(claudeRootPath);
            if (!claudeRootContent || claudeRootContent.trim().length === 0) {
              spin.fail('Documentation generation failed');
              throw new Error(
                'Cannot derive AGENTS.md without CLAUDE.md. Regenerate CLAUDE.md first.',
              );
            }
            claudeResult = {
              target: 'claude',
              rootContent: claudeRootContent,
              detailedDocs: [],
            };
          }

          results = [
            ...results.filter((result) => result.target !== 'codex'),
            deriveCodexResultFromClaudeResult(claudeResult),
          ];
          logger.info('Codex root derived from CLAUDE.md (parity mode).');
        }

        results = orderResultsByTargetSelection(results, targets);

        spin.succeed(
          opts.dryRun ? 'Documentation draft generated (dry-run)' : 'Documentation generated',
        );
      } else {
        logger.success('Documentation is up to date (cache hit for all selected targets).');
      }

      if (skippedTargets.size > 0) {
        logger.info(`Skipped by cache: ${Array.from(skippedTargets).join(', ')}`);
      }

      if (opts.dryRun) {
        logger.warn('Dry run mode: no files were written.');
        logger.info(`Project root: ${projectRoot}`);
        for (const result of results) {
          const rootPath = getRootOutputPath(result.target, layout);
          const rootLines = result.rootContent.split('\n').length;
          logger.info(`[${result.target}] would write ${rootPath} (${rootLines} lines)`);
          const detailsDir = getDetailedOutputDir(result.target, layout);
          for (const doc of result.detailedDocs) {
            const detailLines = doc.content.split('\n').length;
            logger.info(`  would write ${detailsDir}/${doc.filename} (${detailLines} lines)`);
          }
        }
        if (cursorOnlyMode) {
          for (const doc of getCursorOnlyCanonicalDocPaths(
            projectRoot,
            layout.canonicalDocsDir,
            factPack,
          )) {
            const detailLines = doc.content.split('\n').length;
            logger.info(
              `  would write ${path.relative(projectRoot, doc.absolutePath)} (${detailLines} lines)`,
            );
          }
          logger.info(
            'Cursor-only note: canonical docs are written intentionally as shared references for Cursor adapters.',
          );
        }
        logger.info('Run generate again without --dry-run to write files.');
        return;
      }

      const allWritten: string[] = [];
      for (const result of results) {
        const emitter = EMITTERS[result.target];
        const written = await emitter(result, projectRoot, {
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
          logger.info(
            `Cursor-only mode: wrote ${canonicalDocs.length} shared canonical doc(s) to "${layout.canonicalDocsDir}".`,
          );
          logger.info(
            'This is expected behavior (not a generation error): Cursor adapters rely on these canonical references.',
          );
        }

        allWritten.push(...written);

        if (cacheEnabled && cachePath && cacheData) {
          const inputHash = inputHashes.get(result.target);
          if (inputHash) {
            updateGenerationCacheEntry(projectRoot, cacheData, result.target, inputHash, written);
          }
        }
      }

      if (results.length > 0) {
        await writeDocsManifest(projectRoot, {
          targets,
          layout,
          managedFiles: buildManagedFilesManifest(targets, layout, {
            includeCanonicalForCursorOnly: cursorOnlyMode,
          }),
        });
        allWritten.push(toAbsolutePath(projectRoot, DOCS_MANIFEST_FILE));
      }

      if (cacheEnabled && cachePath && cacheData && results.length > 0) {
        await writeGenerationCache(cachePath, cacheData);
      }

      logger.info(`Project root: ${projectRoot}`);
      if (allWritten.length === 0) {
        logger.success('No files written (cache hit for all selected targets).');
      } else {
        logger.success(`Written ${allWritten.length} files:`);
        for (const f of allWritten) {
          logger.info(`  ${path.relative(projectRoot, f)}`);
        }
      }
    },
  );

export default command;
