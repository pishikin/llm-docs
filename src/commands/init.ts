import path from 'node:path';
import { checkbox, confirm, input, select } from '@inquirer/prompts';
import { Command } from 'commander';
import { buildFactPack } from '../core/fact-pack.js';
import { detectProviders } from '../core/provider-detector.js';
import { scanProject } from '../core/scanner.js';
import type {
  CursorAgentProviderConfig,
  CursorAgentTrustMode,
  CustomProviderConfig,
  ProjectConfig,
  ProviderConfig,
  ProviderType,
  Target,
} from '../types/index.js';
import { ConfigError } from '../utils/errors.js';
import { fileExists, getProjectRoot, writeFileSafe } from '../utils/fs.js';
import * as logger from '../utils/logger.js';
import { parseTargetsOption } from '../utils/targets.js';

const DEFAULT_EXCLUDES = ['node_modules', 'dist', '.git', 'coverage', '.claude', '.cursor', 'tmp'];
const CONFIG_FILE = 'llmdocs.config.json';
const EVIDENCE_FILE = 'llmdocs.evidence.json';

const command = new Command('init')
  .description('Initialize llm-docs for your project')
  .option('-y, --yes', 'use defaults without prompts')
  .option('--targets <targets>', 'comma-separated targets (claude,codex,cursor)')
  .action(async (opts: { yes?: boolean; targets?: string }) => {
    const projectRoot = await getProjectRoot();
    const configPath = path.join(projectRoot, CONFIG_FILE);

    if (await fileExists(configPath)) {
      if (!opts.yes) {
        const overwrite = await confirm({ message: 'Config already exists. Overwrite?' });
        if (!overwrite) {
          logger.info('Aborted.');
          return;
        }
      }
    }

    let targets: Target[];
    if (opts.targets) {
      targets = parseTargetsOption(opts.targets);
    } else if (opts.yes) {
      targets = ['claude', 'codex', 'cursor'];
    } else {
      targets = await checkbox<Target>({
        message: 'Select targets:',
        choices: [
          { value: 'claude', name: 'Claude Code (CLAUDE.md)' },
          { value: 'codex', name: 'Codex CLI (AGENTS.md)' },
          { value: 'cursor', name: 'Cursor IDE (.cursor/rules/)' },
        ],
      });
      if (targets.length === 0) targets = ['claude'];
    }

    const detectSpin = logger.spinner('Detecting providers...').start();
    const availableProviders = await detectProviders();
    detectSpin.succeed('Provider detection complete');

    const selectableProviders = availableProviders.filter((provider) => provider.available);
    if (selectableProviders.length === 0) {
      throw new ConfigError(
        'No providers available. Install/login Claude or Codex CLI, install Cursor Agent CLI (`agent`) and run `agent login`, or set ANTHROPIC_API_KEY.',
      );
    }

    const fullyReadyProviders = selectableProviders.filter(
      (provider) => !provider.degraded && provider.type !== 'custom',
    );

    let selectedProvider: ProviderType;

    if (opts.yes) {
      const autoSelectCandidates = selectableProviders.filter((p) => p.type !== 'custom');
      const first = fullyReadyProviders[0] ?? autoSelectCandidates[0];
      if (!first) {
        throw new ConfigError(
          'No auto-selectable providers available. Run without --yes to configure a custom provider.',
        );
      }
      selectedProvider = first.type;
      logger.info(`Auto-selected provider: ${first.name}`);
      if (first.degraded) {
        logger.warn(`Selected provider is degraded: ${first.reason ?? 'health check incomplete'}`);
      }
    } else {
      const choices = availableProviders.map((p) => ({
        value: p.type,
        name: p.available
          ? p.type === 'custom'
            ? `${p.name} (configure your own LLM endpoint)`
            : p.type === 'cursor-agent'
              ? `${p.name} (uses local Agent CLI session: \`agent login\`)`
              : p.degraded
                ? `${p.name} (detected, degraded: ${p.reason ?? 'health check incomplete'})`
                : `${p.name} (detected, ready)`
          : `${p.name} (${p.reason})`,
        disabled: !p.available,
      }));

      selectedProvider = await select<ProviderType>({
        message: 'Select LLM provider:',
        choices,
      });
    }

    let customConfig: CustomProviderConfig | undefined;
    let customModel: string | undefined;
    let cursorAgentConfig: CursorAgentProviderConfig | undefined;

    if (selectedProvider === 'custom') {
      const baseUrl = await input({
        message: 'Base URL (OpenAI-compatible endpoint):',
        validate: (value) => {
          if (!value.trim()) return 'Base URL is required';
          try {
            new URL(value.trim());
            return true;
          } catch {
            return 'Please enter a valid URL';
          }
        },
      });

      const apiKeyEnvVar = await input({
        message: 'Environment variable name for API key:',
        default: 'CUSTOM_API_KEY',
        validate: (value) => {
          if (!value.trim()) return 'Environment variable name is required';
          if (!/^[A-Z_][A-Z0-9_]*$/.test(value.trim())) {
            return 'Use UPPER_SNAKE_CASE (e.g. CUSTOM_API_KEY)';
          }
          return true;
        },
      });

      customModel = await input({
        message: 'Model name:',
        validate: (value) => (value.trim() ? true : 'Model name is required'),
      });

      customConfig = { baseUrl: baseUrl.trim(), apiKeyEnvVar: apiKeyEnvVar.trim() };
      customModel = customModel.trim();
    }

    if (selectedProvider === 'cursor-agent') {
      const trustMode: CursorAgentTrustMode = opts.yes
        ? 'trust'
        : await select<CursorAgentTrustMode>({
            message: 'Cursor Agent workspace trust policy:',
            choices: [
              {
                value: 'trust',
                name: 'trust (recommended, retry with --trust)',
              },
              {
                value: 'manual',
                name: 'manual (fail with instructions, no auto-retry)',
              },
              {
                value: 'yolo',
                name: 'yolo (retry with --yolo)',
              },
              {
                value: 'force',
                name: 'force (retry with -f)',
              },
            ],
          });

      cursorAgentConfig = { trustMode };
    }

    const spin = logger.spinner('Scanning project...').start();
    const scanData = await scanProject(projectRoot, { excludeDirs: DEFAULT_EXCLUDES });
    const factPack = await buildFactPack(scanData);
    spin.succeed('Project scanned');

    const providerConfig: ProviderConfig = {
      type: selectedProvider,
      ...(customModel ? { model: customModel } : {}),
      ...(customConfig ? { custom: customConfig } : {}),
      ...(cursorAgentConfig ? { cursorAgent: cursorAgentConfig } : {}),
    };

    const config: ProjectConfig = {
      name: factPack.projectName,
      targets,
      provider: providerConfig,
      excludeDirs: DEFAULT_EXCLUDES,
      docsDir: '.claude/docs',
    };

    await writeFileSafe(configPath, JSON.stringify(config, null, 2));
    await writeFileSafe(path.join(projectRoot, EVIDENCE_FILE), JSON.stringify(factPack, null, 2));

    logger.success(`Config saved: ${CONFIG_FILE}`);
    logger.info(`Project: ${factPack.projectName}`);
    logger.info(`Language: ${factPack.language}`);
    logger.info(`Targets: ${targets.join(', ')}`);
    logger.info(`Provider: ${selectedProvider}`);
    logger.info(
      `Tools: ${
        Object.entries(factPack.detectedTools)
          .filter(([, v]) => v)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ') || 'none detected'
      }`,
    );
  });

export default command;
