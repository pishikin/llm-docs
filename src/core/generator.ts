import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  FactPack,
  GenerationResult,
  LLMProvider,
  ProviderType,
  Target,
} from '../types/index.js';
import { ProviderError } from '../utils/errors.js';
import * as logger from '../utils/logger.js';
import {
  getCursorCanonicalDocLinks,
  getRequiredDetailedDocLinks,
  getRequiredDetailedDocs,
  getRootDocContract,
  getRootFileForTarget,
  toDetailedDocLinkPath,
} from './docs-contract.js';
import {
  type RootQualityIssue,
  evaluateRootDocQuality,
  getAdvisoryRootQualityIssues,
  getBlockingRootQualityIssues,
  getRequiredRiskSignalLabels,
  summarizeRootQualityIssues,
} from './docs-quality.js';
import { adaptPrompt } from './prompt-adapter.js';

const SYSTEM_PROMPT = `You are an expert technical writer for AI coding assistant documentation.
Rules:
- ONLY reference commands from the provided scripts
- ONLY reference paths from the provided directory tree
- Be concise and factual
- Use Progressive Disclosure: compact root file + detailed docs

Format output as multiple files separated by markers:
---FILE: <filepath>---
(content)`;

const FORMAT_REPAIR_SYSTEM_PROMPT = `You are a strict formatter.
Return ONLY file blocks in this exact format:
---FILE: <filepath>---
(content)
Do not add explanations or extra text.`;
const QUALITY_REPAIR_SYSTEM_PROMPT = `You are a strict technical documentation editor.
Fix the provided generated output so it satisfies the required documentation contract.
Output ONLY file blocks in this exact format:
---FILE: <filepath>---
(content)
Do not add explanations or any extra prose.`;
const DEFAULT_MAX_DIRECTORY_TREE_ENTRIES = 220;
const DEFAULT_PROMPT_PREVIEW_CHARS = 180;
const VERBOSE_PROMPT_BODY = process.env.LLMDOCS_VERBOSE_PROMPT_BODY === '1';

const TARGET_INSTRUCTIONS: Record<Target, { description: string }> = {
  claude: {
    description: 'Claude Code (Anthropic CLI agent)',
  },
  codex: {
    description: 'Codex CLI (OpenAI agent)',
  },
  cursor: {
    description: 'Cursor IDE rules',
  },
};

export interface GenerateDocsOptions {
  targetConcurrency?: number;
  maxDirectoryTreeEntries?: number;
  enableFormatRepair?: boolean;
  enableQualityRepair?: boolean;
  allowProviderFailureFallback?: boolean;
  rootOnlyTargets?: Target[];
  projectRoot?: string;
}

const INLINE_CODE_PATTERN = /`([^`]+)`/g;
const MARKDOWN_LINK_PATTERN = /\[[^\]]+\]\(([^)]+)\)/g;
const PATH_PATTERN = /(?:^|\s)(\.?\.?\/[\w./-]+|\w+\/[\w./-]+)/g;

function hashForDebug(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function toPreview(text: string, maxChars = DEFAULT_PROMPT_PREVIEW_CHARS): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

function logPromptDispatch(
  target: Target,
  stage: 'initial' | 'format-repair' | 'quality-repair',
  providerType: ProviderType,
  adaptedPrompt: { userPrompt: string; systemPrompt?: string },
): void {
  const userPrompt = adaptedPrompt.userPrompt ?? '';
  const systemPrompt = adaptedPrompt.systemPrompt ?? '';
  const userHash = hashForDebug(userPrompt);
  const systemHash = systemPrompt ? hashForDebug(systemPrompt) : 'none';
  const userPreview = toPreview(userPrompt);
  const systemPreview = systemPrompt ? toPreview(systemPrompt) : '';

  logger.debug(
    `[generate:${target}] dispatch stage=${stage}, provider=${providerType}, user_chars=${userPrompt.length}, system_chars=${systemPrompt.length}, user_hash=${userHash}, system_hash=${systemHash}, user_preview="${userPreview}"${
      systemPreview ? `, system_preview="${systemPreview}"` : ''
    }`,
  );

  if (VERBOSE_PROMPT_BODY) {
    logger.debug(`[generate:${target}] prompt stage=${stage} [user]\n${userPrompt}`);
    if (systemPrompt.trim().length > 0) {
      logger.debug(`[generate:${target}] prompt stage=${stage} [system]\n${systemPrompt}`);
    }
  }
}

function getFileName(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const segments = normalizedPath.split('/');
  return segments[segments.length - 1] ?? filePath;
}

function pushUnique(values: string[], seen: Set<string>, candidate: string): void {
  const value = candidate.trim();
  if (!value || seen.has(value)) return;
  seen.add(value);
  values.push(value);
}

function resolveMaxDirectoryTreeEntries(override?: number): number {
  if (Number.isFinite(override) && (override ?? 0) >= 20) {
    return Math.floor(override as number);
  }

  const raw = process.env.LLMDOCS_MAX_TREE_ENTRIES;
  if (!raw) return DEFAULT_MAX_DIRECTORY_TREE_ENTRIES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 20) {
    return DEFAULT_MAX_DIRECTORY_TREE_ENTRIES;
  }
  return parsed;
}

function selectDirectoryTreeEntries(
  tree: string[],
  configFiles: string[],
  entryPoints: string[],
  maxEntriesOverride?: number,
): { entries: string[]; originalCount: number; truncatedCount: number } {
  const maxEntries = resolveMaxDirectoryTreeEntries(maxEntriesOverride);
  if (tree.length <= maxEntries) {
    return {
      entries: tree,
      originalCount: tree.length,
      truncatedCount: 0,
    };
  }

  const selected: string[] = [];
  const seen = new Set<string>();

  // Keep explicit config/entry references first so instructions stay grounded.
  for (const file of configFiles) {
    pushUnique(selected, seen, file);
  }
  for (const file of entryPoints) {
    pushUnique(selected, seen, file);
  }

  for (const filePath of tree) {
    if (!filePath.includes('/')) {
      pushUnique(selected, seen, filePath);
    }
    if (selected.length >= maxEntries) break;
  }

  for (const filePath of tree) {
    if (
      filePath.startsWith('src/') ||
      filePath.startsWith('tests/') ||
      filePath.startsWith('__tests__/') ||
      filePath.startsWith('packages/') ||
      filePath.startsWith('apps/') ||
      filePath.startsWith('.claude/') ||
      filePath.startsWith('.cursor/')
    ) {
      pushUnique(selected, seen, filePath);
    }
    if (selected.length >= maxEntries) break;
  }

  for (const filePath of tree) {
    pushUnique(selected, seen, filePath);
    if (selected.length >= maxEntries) break;
  }

  return {
    entries: selected.slice(0, maxEntries),
    originalCount: tree.length,
    truncatedCount: Math.max(0, tree.length - maxEntries),
  };
}

function buildCursorPromptDirectoryTree(
  tree: string[],
  configFiles: string[],
  entryPoints: string[],
): string[] {
  const selected: string[] = [];
  const seen = new Set<string>();

  for (const file of configFiles) {
    pushUnique(selected, seen, file);
  }
  for (const file of entryPoints) {
    pushUnique(selected, seen, file);
  }

  for (const filePath of tree) {
    if (!filePath.includes('/')) {
      pushUnique(selected, seen, filePath);
    }
  }

  for (const filePath of tree) {
    if (
      filePath.startsWith('src/') ||
      filePath.startsWith('tests/') ||
      filePath.startsWith('api/')
    ) {
      pushUnique(selected, seen, filePath);
    }
    if (selected.length >= 48) break;
  }

  return selected.slice(0, 48);
}

function buildPromptFactPack(
  factPack: FactPack,
  target: Target,
  promptDirectoryTree: string[],
): FactPack {
  if (target !== 'cursor') {
    return {
      ...factPack,
      directoryTree: promptDirectoryTree,
    };
  }

  const cursorDirectoryTree = buildCursorPromptDirectoryTree(
    promptDirectoryTree,
    factPack.configFiles,
    factPack.entryPoints,
  );

  return {
    ...factPack,
    directoryTree: cursorDirectoryTree,
    dependencies: factPack.dependencies.slice(0, 12),
    devDependencies: factPack.devDependencies.slice(0, 8),
    projectFacts: {
      ...factPack.projectFacts,
      routePaths: factPack.projectFacts.routePaths.slice(0, 8),
      authApiFunctions: factPack.projectFacts.authApiFunctions.slice(0, 8),
      authApiEndpoints: factPack.projectFacts.authApiEndpoints.slice(0, 8),
      mockAuthEndpoints: factPack.projectFacts.mockAuthEndpoints.slice(0, 8),
      tokenStorageWriteFiles: factPack.projectFacts.tokenStorageWriteFiles.slice(0, 4),
      anyTypeUsageFiles: factPack.projectFacts.anyTypeUsageFiles.slice(0, 4),
    },
    riskSignals: {
      ...factPack.riskSignals,
      notes: factPack.riskSignals.notes.slice(0, 2),
      apiMockCoverageGaps: factPack.riskSignals.apiMockCoverageGaps.slice(0, 4),
      toolingDependencyGaps: factPack.riskSignals.toolingDependencyGaps.slice(0, 4),
      strictTypeScriptFlags: factPack.riskSignals.strictTypeScriptFlags.slice(0, 4),
    },
  };
}

function buildPrompt(
  factPack: FactPack,
  target: Target,
  maxDirectoryTreeEntries?: number,
  rootOnly = false,
): {
  prompt: string;
  promptTreeCount: number;
  originalTreeCount: number;
  truncatedTreeCount: number;
} {
  const { description } = TARGET_INSTRUCTIONS[target];
  const rootFile = getRootFileForTarget(target);
  const rootContract = getRootDocContract(target);
  const requiredDetailedDocLinks = getRequiredDetailedDocLinks(target);
  const requiredRiskSignals = getRequiredRiskSignalLabels(factPack.riskSignals);
  const prerequisiteHints = buildPrerequisiteGuidance(factPack)
    .map((line) => `- ${line}`)
    .join('\n');
  const qualityGatePolicyHints = buildQualityGatePolicyHints(factPack)
    .map((line) => `- ${line}`)
    .join('\n');
  const knownRoutes =
    factPack.projectFacts.routePaths.length > 0
      ? factPack.projectFacts.routePaths.map((route) => `- ${route}`).join('\n')
      : '- none detected';
  const knownAuthFunctions =
    factPack.projectFacts.authApiFunctions.length > 0
      ? factPack.projectFacts.authApiFunctions.map((fn) => `- ${fn}`).join('\n')
      : '- none detected';
  const knownAuthEndpoints =
    factPack.projectFacts.authApiEndpoints.length > 0
      ? factPack.projectFacts.authApiEndpoints.map((endpoint) => `- ${endpoint}`).join('\n')
      : '- none detected';
  const tokenWriteLocations =
    factPack.projectFacts.tokenStorageWriteFiles.length > 0
      ? factPack.projectFacts.tokenStorageWriteFiles.map((file) => `- ${file}`).join('\n')
      : '- none detected';
  const jsonServerEvidence =
    factPack.projectFacts.jsonServerScriptNames.length > 0
      ? `json-server scripts: ${factPack.projectFacts.jsonServerScriptNames.join(', ')}`
      : factPack.projectFacts.hasJsonServerDependency
        ? 'json-server dependency present, but no script evidence'
        : 'no json-server evidence';
  const anyUsageEvidence =
    factPack.projectFacts.anyTypeUsageFiles.length > 0
      ? factPack.projectFacts.anyTypeUsageFiles.map((file) => `- ${file}`).join('\n')
      : '- none detected';
  const {
    entries: promptDirectoryTree,
    originalCount: originalTreeCount,
    truncatedCount,
  } = selectDirectoryTreeEntries(
    factPack.directoryTree,
    factPack.configFiles,
    factPack.entryPoints,
    maxDirectoryTreeEntries,
  );
  const promptFactPack = buildPromptFactPack(factPack, target, promptDirectoryTree);

  const treeScopeNote =
    truncatedCount > 0
      ? `\nDirectory tree is truncated for performance: ${promptFactPack.directoryTree.length}/${originalTreeCount} entries.`
      : '';

  const detailedDocsHeader =
    target === 'cursor'
      ? '### Detailed docs (files under .cursor/rules/)'
      : '### Detailed docs (files under .claude/docs/)';
  const detailedDocsList = requiredDetailedDocLinks.map((doc) => `- ${doc}`).join('\n');
  const riskSignalHints =
    requiredRiskSignals.length > 0
      ? requiredRiskSignals.map((signal) => `- ${signal}`).join('\n')
      : '- no special risk signals detected';
  const requiredSections = rootContract.requiredHeadings
    .map((section) => `- ${section}`)
    .join('\n');
  const requiredWarningTopics = rootContract.requiredWarningTopics
    .map((topic) => `- ${topic}`)
    .join('\n');
  const maxRootLines = rootContract.maxNonEmptyLines ?? 500;
  const rootLineGuidance =
    target === 'cursor'
      ? `- Root file should stay concise (ideally 40-140 non-empty lines, hard max ${maxRootLines}).`
      : `- Root file should stay concise (ideally 90-260 non-empty lines, hard max ${maxRootLines}).`;
  const rootByteGuidance = rootContract.maxBytes
    ? `\n- Keep root file under ${rootContract.maxBytes} bytes to avoid ingestion truncation.`
    : '';
  const cursorFrontmatterGuidance =
    target === 'cursor'
      ? '\n- Root and detailed .mdc files MUST start with YAML frontmatter containing description, globs, alwaysApply.'
      : '';

  const rootRequirements =
    target === 'cursor'
      ? `### Root file: ${rootFile}
- Root file must be an operational adapter (not a full manual).
${rootLineGuidance}${rootByteGuidance}${cursorFrontmatterGuidance}
- Root file MUST include ONLY these markdown headings (no extra sections):
${requiredSections}
- Keep this root concise. Defer deep architecture/testing/style details to canonical docs under .claude/docs/.
- Key Commands section must include executable commands from project scripts only.
- Quality Gates section policy must be consistent:
${qualityGatePolicyHints}
- Critical Warnings section must include these warning topics:
${requiredWarningTopics}
- Detailed Docs section must link to canonical detailed-doc paths exactly:
${detailedDocsList}
- Never include process logs, reasoning traces, or first-person generation notes.`
      : `### Root file: ${rootFile}
- Root file must be operational and explicit (not a short summary).
${rootLineGuidance}${rootByteGuidance}${cursorFrontmatterGuidance}
- Root file MUST include these exact sections as markdown headings:
${requiredSections}
- Prerequisites section must include dependency install command and setup assumptions.
- Key Commands section must include executable commands from project scripts only.
- Quality Gates section policy must be consistent:
${qualityGatePolicyHints}
- Critical Warnings section must include these warning topics:
${requiredWarningTopics}
- Risky Zones section must include project-specific risk signals:
${riskSignalHints}
- Detailed Docs section must link to canonical detailed-doc paths exactly:
${detailedDocsList}
- Never include process logs, reasoning traces, or first-person generation notes.`;

  const factualConstraints = `### Verified code facts (authoritative)
- Routes detected in router files:
${knownRoutes}
- Auth API exported functions:
${knownAuthFunctions}
- Auth API endpoints:
${knownAuthEndpoints}
- Token storage write locations:
${tokenWriteLocations}
- json-server evidence: ${jsonServerEvidence}
- any-type usage evidence:
${anyUsageEvidence}
- ESLint no-explicit-any enforced: ${factPack.projectFacts.eslintNoExplicitAnyRuleConfigured ? 'yes' : 'no'}

### Non-negotiable factual constraints
- Do not mention routes that are not listed in the verified route list.
- Do not claim register/registration flows unless routes or auth API functions explicitly include register.
- If token storage files are known, reference those exact files; do not invent different locations.
- Do not claim runtime json-server integration unless script evidence exists.
- If any-type usage exists or no-explicit-any is not enforced, avoid absolute claims like "any is strictly prohibited".`;

  const factualRedFlags = `### Red flags (forbid unsupported claims)
- Do not hardcode dependency versions unless explicitly present in provided project facts.
- Do not invent production URLs, infra limits, or database table names not present in repository facts.
- Do not assert API behavior without clear repository evidence (code, mocks, or tests).`;

  const detailedScope = rootOnly
    ? `### Output scope
- Generate ONLY this root file block: ${rootFile}
- Do NOT emit any detailed docs file blocks in this run.
- Root must still link to canonical detailed docs:
${detailedDocsList}`
    : target === 'cursor'
      ? `${detailedDocsHeader}
${detailedDocsList}

### Detailed docs requirements
- Treat each .mdc file as a thin adapter, not a full duplicated manual.
- Each .mdc must include a "Canonical Source" section with links to shared docs under .claude/docs/.
- Keep adapter rules concise and scoped; prefer focused Cursor-specific directives only.
- Hard budget: keep each adapter under ~80 non-empty lines and avoid long prose sections.
- Allowed section headings for adapters: "Canonical Source", "Cursor Focus", and "Verify" (or "Handoff Checklist" for guardrails).
- Do not restate full architecture/style/testing narratives already present in canonical docs.
- Include Cursor-specific execution guidance (scope control, apply/verify order, safe edit boundaries).`
      : `${detailedDocsHeader}
${detailedDocsList}

### Detailed docs requirements
- architecture: runtime flow, module boundaries, integration points, high-risk zones, and error propagation paths.
- commands: full command map with purpose, defaults, provider-specific caveats, and recovery hints.
- coding-style: naming conventions, import ordering, error-class usage, anti-patterns to avoid, and quality gates.
- testing: current coverage reality, mock strategy, how to add tests for changed behavior, and confidence limits.
`;

  const prompt = `## Project Facts
${JSON.stringify(promptFactPack, null, 2)}${treeScopeNote}

## Task
Generate documentation for ${description}.

## Prerequisites guidance
${prerequisiteHints}

${rootRequirements}

${factualConstraints}

${factualRedFlags}

${detailedScope}`;

  return {
    prompt,
    promptTreeCount: promptFactPack.directoryTree.length,
    originalTreeCount,
    truncatedTreeCount: truncatedCount,
  };
}

export function parseGenerationOutput(raw: string): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];
  const parts = raw.split(/---FILE:\s*(.+?)---/);

  for (let i = 1; i < parts.length; i += 2) {
    const filePath = parts[i].trim();
    const content = sanitizeGeneratedFileContent(parts[i + 1] ?? '');
    if (filePath && content) {
      files.push({ path: filePath, content });
    }
  }
  return files;
}

function sanitizeGeneratedFileContent(content: string): string {
  const withoutComments = content.replace(/<!--\s*(?:source|detectedtools)\b[\s\S]*?-->/gi, '');
  const withoutArtifacts = withoutComments
    .split('\n')
    .filter((line) => !/^\s*detectedtools\s*:/i.test(line))
    .join('\n');

  return withoutArtifacts.replace(/\n{3,}/g, '\n\n').trim();
}

function findRootDoc(
  files: { path: string; content: string }[],
  rootFile: string,
): { path: string; content: string } | undefined {
  const rootFileName = getFileName(rootFile);
  return files.find((file) => file.path === rootFile || getFileName(file.path) === rootFileName);
}

function formatFoundPaths(files: { path: string; content: string }[]): string {
  const uniquePaths = Array.from(new Set(files.map((file) => file.path.trim()).filter(Boolean)));
  return uniquePaths.length > 0 ? uniquePaths.join(', ') : 'none';
}

function buildRepairPrompt(raw: string, target: Target, rootFile: string): string {
  return `Target: ${target}
Expected root file: ${rootFile}

Reformat the text below into strict file-block output.
Preserve content and paths where possible.
Output only file blocks.

---RAW OUTPUT START---
${raw}
---RAW OUTPUT END---`;
}

async function tryRepairFormatting(
  raw: string,
  target: Target,
  rootFile: string,
  provider: LLMProvider,
  providerType: ProviderType,
): Promise<{ path: string; content: string }[] | null> {
  const repairPrompt = buildRepairPrompt(raw, target, rootFile);
  const adaptedRepair = adaptPrompt(FORMAT_REPAIR_SYSTEM_PROMPT, repairPrompt, providerType);
  logPromptDispatch(target, 'format-repair', providerType, adaptedRepair);

  try {
    const repairedRaw = await provider.generate(
      adaptedRepair.userPrompt,
      adaptedRepair.systemPrompt ?? '',
    );
    const repairedFiles = parseGenerationOutput(repairedRaw);
    return repairedFiles.length > 0 ? repairedFiles : null;
  } catch {
    return null;
  }
}

function buildRawFromFiles(files: { path: string; content: string }[]): string {
  return files.map((file) => `---FILE: ${file.path}---\n${file.content}`).join('\n\n');
}

function isRecoverableProviderFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('timed out') ||
    normalized.includes('empty response') ||
    normalized.includes('json-empty')
  );
}

function isRootOnlyTarget(target: Target, options: GenerateDocsOptions): boolean {
  return options.rootOnlyTargets?.includes(target) ?? false;
}

function collectDetailedDocs(
  files: { path: string; content: string }[],
  rootDoc: { path: string; content: string },
  rootOnlyTarget: boolean,
): { filename: string; content: string }[] {
  if (rootOnlyTarget) {
    return [];
  }

  return files
    .filter((f) => f !== rootDoc)
    .map((f) => ({ filename: getFileName(f.path), content: f.content }))
    .filter((doc) => doc.filename.length > 0);
}

function normalizeDocFilename(filePath: string): string {
  return getFileName(filePath).toLowerCase();
}

function resolveCanonicalDetailedDocFilename(target: Target, filename: string): string | null {
  const normalized = normalizeDocFilename(filename);
  const requiredDocs = getRequiredDetailedDocs(target);
  if (requiredDocs.includes(normalized)) {
    return normalized;
  }

  const compact = normalized.replace(/[^a-z0-9]+/g, '');

  if (target === 'cursor') {
    if (
      compact.includes('architect') ||
      compact.includes('systemboundar') ||
      compact.includes('module')
    ) {
      return 'architecture.mdc';
    }
    if (
      compact.includes('style') ||
      compact.includes('coding') ||
      compact.includes('lint') ||
      compact.includes('format')
    ) {
      return 'style.mdc';
    }
    if (compact.includes('test') || compact.includes('validat') || compact.includes('spec')) {
      return 'testing.mdc';
    }
    if (
      compact.includes('guard') ||
      compact.includes('safety') ||
      compact.includes('policy') ||
      compact.includes('command')
    ) {
      return 'guardrails.mdc';
    }
    return null;
  }

  if (
    compact.includes('architect') ||
    compact.includes('systemboundar') ||
    compact.includes('module')
  ) {
    return 'architecture.md';
  }
  if (
    compact.includes('command') ||
    compact.includes('runbook') ||
    compact.includes('workflow') ||
    compact.includes('guard')
  ) {
    return 'commands.md';
  }
  if (
    compact.includes('style') ||
    compact.includes('coding') ||
    compact.includes('lint') ||
    compact.includes('format')
  ) {
    return 'coding-style.md';
  }
  if (compact.includes('test') || compact.includes('validat') || compact.includes('qa')) {
    return 'testing.md';
  }
  return null;
}

function buildArchitectureSnapshotLines(factPack: FactPack): string[] {
  const authRoutes = factPack.projectFacts.routePaths
    .filter((route) => route.startsWith('/auth'))
    .slice(0, 8);
  const tokenStoragePaths = factPack.projectFacts.tokenStorageWriteFiles.slice(0, 8);

  const authRoutesLine =
    authRoutes.length > 0
      ? `- Auth-prefixed routes detected: ${authRoutes.map((route) => `\`${route}\``).join(', ')}.`
      : '- Auth-prefixed routes detected: none.';

  const tokenStorageLine =
    tokenStoragePaths.length > 0
      ? `- Token storage write paths: ${tokenStoragePaths.map((file) => `\`${file}\``).join(', ')}.`
      : '- Token storage write paths: none detected.';

  const mockRuntimeLine =
    factPack.projectFacts.jsonServerScriptNames.length > 0
      ? `- Runtime mock server scripts: ${factPack.projectFacts.jsonServerScriptNames
          .map((name) => `\`${formatScriptCommand(factPack.packageManager, name)}\``)
          .join(', ')} (json-server).`
      : '- Runtime mock server scripts: none detected.';

  return [
    `- Project name: ${factPack.projectName}.`,
    `- Primary language: ${factPack.language}.`,
    `- Entry points: ${
      factPack.entryPoints.length > 0
        ? factPack.entryPoints.map((entry) => `\`${entry}\``).join(', ')
        : 'none detected'
    }.`,
    `- Main config files: ${
      factPack.configFiles.length > 0
        ? factPack.configFiles.map((file) => `\`${file}\``).join(', ')
        : 'none detected'
    }.`,
    authRoutesLine,
    tokenStorageLine,
    mockRuntimeLine,
  ];
}

function normalizeArchitectureSnapshotSection(rootContent: string, factPack: FactPack): string {
  const lines = buildArchitectureSnapshotLines(factPack);
  return replaceSectionBody(rootContent, 'Architecture Snapshot', lines);
}

function buildFallbackSharedDetailedDocContent(factPack: FactPack, filename: string): string {
  const qualityGateLines = buildFallbackQualityGateLines(factPack).slice(0, 6).join('\n');
  const architectureLines = buildArchitectureSnapshotLines(factPack).join('\n');

  switch (filename) {
    case 'architecture.md':
      return `# Architecture
## Runtime Overview
${architectureLines}

## Design Constraints
- Keep module boundaries explicit and minimize cross-layer coupling.
- Prefer small, verifiable changes over broad refactors.
- Validate high-risk behavior changes with focused checks before handoff.

## Verification
${qualityGateLines}`;

    case 'commands.md': {
      const scriptEntries = Object.entries(factPack.scripts).slice(0, 20);
      const commandLines =
        scriptEntries.length > 0
          ? scriptEntries.map(([name, command]) => {
              const invoke = formatScriptCommand(factPack.packageManager, name);
              return `- \`${invoke}\` — ${describeScriptForGuide(name, command)}`;
            })
          : [
              '- No package scripts detected. Add project commands before using command-based workflows.',
            ];
      return `# Commands
## Core Commands
${commandLines.join('\n')}

## Policy
- Use commands declared in package scripts only.
- Mark preview/dev/start checks as optional unless explicitly required.
- Run required quality gates before handoff.

## Verification
${qualityGateLines}`;
    }

    case 'coding-style.md': {
      const linter = factPack.detectedTools.linter ?? 'not detected';
      const formatter = factPack.detectedTools.formatter ?? 'not detected';
      const typeChecker = factPack.detectedTools.typeChecker ?? 'not detected';
      return `# Coding Style
## Tooling Baseline
- Linter: ${linter}.
- Formatter: ${formatter}.
- Type checker: ${typeChecker}.

## Style Rules
- Preserve existing repository conventions in touched files.
- Avoid unrelated style-only changes outside the task scope.
- Keep diffs reviewable and deterministic.

## Verification
${qualityGateLines}`;
    }

    case 'testing.md':
      return `# Testing
## Current Test Signals
- Tests detected: ${factPack.hasTests ? 'yes' : 'no'}.
- Primary test framework: ${factPack.testFramework ?? 'not detected'}.

## Strategy
- Add or update tests near behavior changes.
- Prioritize deterministic assertions and stable fixtures.
- Document confidence limits when production-only behavior cannot be reproduced locally.

## Verification
${qualityGateLines}`;

    default:
      return `# ${filename}
## Notes
- Keep this document aligned with repository facts and active workflows.
- Do not add unsupported commands or paths.`;
  }
}

export function buildCanonicalSharedDetailedDocs(factPack: FactPack): {
  filename: string;
  content: string;
}[] {
  return getRequiredDetailedDocs('claude').map((filename) => ({
    filename,
    content: buildFallbackSharedDetailedDocContent(factPack, filename),
  }));
}

function canonicalizeSharedDetailedDocs(
  target: Target,
  detailedDocs: { filename: string; content: string }[],
  factPack: FactPack,
): {
  detailedDocs: { filename: string; content: string }[];
  added: string[];
  dropped: string[];
  remapped: string[];
} {
  const requiredDocs = getRequiredDetailedDocs(target);
  const canonicalContent = new Map<string, string>();
  const added: string[] = [];
  const dropped: string[] = [];
  const remapped: string[] = [];

  for (const doc of detailedDocs) {
    const canonicalName = resolveCanonicalDetailedDocFilename(target, doc.filename);
    if (!canonicalName || !requiredDocs.includes(canonicalName)) {
      dropped.push(doc.filename);
      continue;
    }

    if (canonicalName !== normalizeDocFilename(doc.filename)) {
      remapped.push(`${doc.filename}->${canonicalName}`);
    }

    const existing = canonicalContent.get(canonicalName);
    if (!existing || doc.content.length > existing.length) {
      canonicalContent.set(canonicalName, doc.content);
    }
  }

  for (const filename of requiredDocs) {
    if (canonicalContent.has(filename)) continue;
    added.push(filename);
    canonicalContent.set(filename, buildFallbackSharedDetailedDocContent(factPack, filename));
  }

  return {
    detailedDocs: requiredDocs.map((filename) => ({
      filename,
      content:
        canonicalContent.get(filename) ?? buildFallbackSharedDetailedDocContent(factPack, filename),
    })),
    added,
    dropped,
    remapped,
  };
}

function canonicalizeCursorDetailedDocs(detailedDocs: { filename: string; content: string }[]): {
  detailedDocs: { filename: string; content: string }[];
  dropped: string[];
  remapped: string[];
} {
  const requiredDocs = getRequiredDetailedDocs('cursor');
  const canonicalContent = new Map<string, string>();
  const dropped: string[] = [];
  const remapped: string[] = [];

  for (const doc of detailedDocs) {
    const canonicalName = resolveCanonicalDetailedDocFilename('cursor', doc.filename);
    if (!canonicalName || !requiredDocs.includes(canonicalName)) {
      dropped.push(doc.filename);
      continue;
    }

    if (canonicalName !== normalizeDocFilename(doc.filename)) {
      remapped.push(`${doc.filename}->${canonicalName}`);
    }

    const existing = canonicalContent.get(canonicalName);
    if (!existing || doc.content.length > existing.length) {
      canonicalContent.set(canonicalName, doc.content);
    }
  }

  return {
    detailedDocs: requiredDocs
      .filter((filename) => canonicalContent.has(filename))
      .map((filename) => ({
        filename,
        content: canonicalContent.get(filename) ?? '',
      })),
    dropped,
    remapped,
  };
}

function hasRegisterEvidenceInFactPack(factPack: FactPack): boolean {
  return (
    factPack.projectFacts.routePaths.some((route) =>
      /\b(register|sign-up|signup)\b/i.test(route),
    ) ||
    factPack.projectFacts.authApiFunctions.some((fn) => /\b(register|signUp|signup)\b/i.test(fn))
  );
}

function stripDuplicateFrontmatterLikeBlocks(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  const leadingFrontmatterMatch = normalized.match(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/);
  const leadingFrontmatter = leadingFrontmatterMatch?.[0] ?? '';
  const body = leadingFrontmatterMatch
    ? normalized.slice(leadingFrontmatterMatch[0].length)
    : normalized;

  const withoutYamlFences = body.replace(/```ya?ml[\t ]*\n[\s\S]*?```/gi, (block) =>
    /\b(?:description|globs|alwaysApply)\s*:/i.test(block) ? '' : block,
  );

  const withoutInlineFrontmatter = withoutYamlFences.replace(
    /(?:^|\n)---\s*\n([\s\S]*?)\n---\s*(?=\n|$)/g,
    (fullMatch, captured) => {
      if (!/\b(?:description|globs|alwaysApply)\s*:/i.test(String(captured ?? ''))) {
        return fullMatch;
      }
      const hasLeadingNewline = fullMatch.startsWith('\n');
      return hasLeadingNewline ? '\n' : '';
    },
  );

  const cleanedBody = withoutInlineFrontmatter.replace(/\n{3,}/g, '\n\n').trim();

  if (!leadingFrontmatter) {
    return cleanedBody;
  }

  if (cleanedBody.length === 0) {
    return leadingFrontmatter.trim();
  }

  return `${leadingFrontmatter.trimEnd()}\n\n${cleanedBody}`.trim();
}

function sanitizeFactualClaimsInBody(content: string, factPack: FactPack): string {
  const hasAuthRouteEvidence = factPack.projectFacts.routePaths.some((route) =>
    route.startsWith('/auth'),
  );
  const hasRegisterEvidence = hasRegisterEvidenceInFactPack(factPack);
  const hasJsonServerScriptEvidence = factPack.projectFacts.jsonServerScriptNames.length > 0;
  const preferredTokenPath = factPack.projectFacts.tokenStorageWriteFiles[0] ?? null;

  const sanitizedLines: string[] = [];
  for (const line of content.split('\n')) {
    if (!hasRegisterEvidence && /\bregister(?:ed|ation)?\b/i.test(line)) {
      continue;
    }
    if (!hasAuthRouteEvidence && /\/auth(?:\/[a-z0-9_-]+|\b)/i.test(line)) {
      continue;
    }
    if (!hasJsonServerScriptEvidence && /\bjson-server\b/i.test(line)) {
      continue;
    }

    if (/src\/api\/auth\.ts/i.test(line)) {
      if (preferredTokenPath && preferredTokenPath !== 'src/api/auth.ts') {
        sanitizedLines.push(line.replace(/src\/api\/auth\.ts/gi, preferredTokenPath));
        continue;
      }
      if (!preferredTokenPath) {
        continue;
      }
    }

    sanitizedLines.push(line);
  }

  return sanitizedLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sanitizeGeneratedDocContent(content: string, factPack: FactPack): string {
  const normalized = stripDuplicateFrontmatterLikeBlocks(content.replace(/\r\n/g, '\n'));
  const frontmatterMatch = normalized.match(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/);
  if (!frontmatterMatch) {
    return sanitizeFactualClaimsInBody(normalized, factPack);
  }

  const frontmatter = frontmatterMatch[0].trimEnd();
  const body = normalized.slice(frontmatterMatch[0].length);
  const sanitizedBody = sanitizeFactualClaimsInBody(body, factPack);
  if (!sanitizedBody) {
    return frontmatter;
  }
  return `${frontmatter}\n\n${sanitizedBody}`.trim();
}

function normalizeLinkTarget(rawTarget: string): string {
  const trimmed = rawTarget.trim();
  const unwrapped =
    trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed;
  const firstToken = unwrapped.split(/\s+/)[0] ?? '';
  const withoutHash = firstToken.split('#')[0] ?? '';
  const withoutQuery = withoutHash.split('?')[0] ?? '';
  return withoutQuery.trim();
}

function normalizePathCandidate(rawPath: string): string {
  return rawPath.trim().replace(/^['"`]|['"`]$/g, '');
}

function isLikelyApiEndpointPath(refPath: string): boolean {
  if (!refPath.startsWith('/')) return false;
  if (refPath === '/') return false;
  if (
    refPath.startsWith('/Users/') ||
    refPath.startsWith('/home/') ||
    refPath.startsWith('/tmp/')
  ) {
    return false;
  }

  const normalized = refPath.replace(/\/+$/, '');
  const baseName = path.posix.basename(normalized);
  const hasExtension = /\.[A-Za-z0-9]+$/.test(baseName);
  if (hasExtension) {
    return false;
  }

  return true;
}

function isVirtualDocumentationPath(refPath: string): boolean {
  const normalized = refPath.replace(/^\.?\//, '');
  if (/^\.claude\/docs\/[a-z0-9._/-]+\.md$/i.test(normalized)) return true;
  if (/^\.cursor\/rules\/[a-z0-9._/-]+\.mdc$/i.test(normalized)) return true;
  if (/^[a-z0-9._-]+\.mdc$/i.test(normalized)) return true;
  return normalized === 'CLAUDE.md' || normalized === 'AGENTS.md';
}

async function fileExistsSafe(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function pathExistsFromDoc(
  projectRoot: string,
  docFile: string,
  refPath: string,
): Promise<boolean> {
  const normalized = normalizePathCandidate(refPath);
  const candidates = new Set<string>();
  const docDir = path.dirname(docFile);

  if (normalized.startsWith('/')) {
    candidates.add(path.join(projectRoot, normalized.slice(1)));
  }

  candidates.add(path.resolve(docDir, normalized));
  candidates.add(path.resolve(projectRoot, normalized));

  for (const candidate of candidates) {
    if (await fileExistsSafe(candidate)) {
      return true;
    }
  }

  return false;
}

async function suggestPathReplacement(
  projectRoot: string,
  docFile: string,
  refPath: string,
): Promise<string | null> {
  const normalized = normalizePathCandidate(refPath);
  if (!normalized.includes('/')) return null;
  if (isVirtualDocumentationPath(normalized)) return normalized;
  if (normalized.startsWith('http')) return null;

  const docDir = path.dirname(docFile);
  const absoluteCandidates = [
    path.resolve(docDir, normalized),
    path.resolve(projectRoot, normalized),
    normalized.startsWith('/') ? path.join(projectRoot, normalized.slice(1)) : '',
  ].filter((candidate) => candidate.length > 0);
  const candidateParentDirs = Array.from(
    new Set(absoluteCandidates.map((candidate) => path.dirname(candidate))),
  );

  let directoryEntries: string[] | null = null;
  for (const parentDir of candidateParentDirs) {
    try {
      directoryEntries = await fs.readdir(parentDir);
      break;
    } catch {}
  }

  if (!directoryEntries) {
    return null;
  }

  const preferredWorker = directoryEntries.find((entry) =>
    /^worker\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(entry),
  );
  if (preferredWorker) {
    const replacement = path.posix.join(
      path.posix.dirname(normalized.replace(/\\/g, '/')),
      preferredWorker,
    );
    if (await pathExistsFromDoc(projectRoot, docFile, replacement)) {
      return replacement;
    }
  }

  const originalBase = path.basename(normalized);
  const originalExt = path.extname(originalBase).toLowerCase();
  const fileCandidates = directoryEntries.filter((entry) => path.extname(entry).length > 0);

  const sameExt = fileCandidates.filter(
    (entry) => path.extname(entry).toLowerCase() === originalExt,
  );
  const deterministic =
    sameExt.length === 1 ? sameExt[0] : fileCandidates.length === 1 ? fileCandidates[0] : null;
  if (!deterministic) return null;

  const replacement = path.posix.join(
    path.posix.dirname(normalized.replace(/\\/g, '/')),
    deterministic,
  );
  if (!(await pathExistsFromDoc(projectRoot, docFile, replacement))) {
    return null;
  }
  return replacement;
}

function extractPathCandidatesFromLine(line: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  for (const codeMatch of line.matchAll(INLINE_CODE_PATTERN)) {
    const code = codeMatch[1] ?? '';
    for (const pathMatch of code.matchAll(PATH_PATTERN)) {
      const candidate = normalizePathCandidate(pathMatch[1] ?? '');
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      candidates.push(candidate);
    }
  }

  for (const linkMatch of line.matchAll(MARKDOWN_LINK_PATTERN)) {
    const candidate = normalizeLinkTarget(linkMatch[1] ?? '');
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    candidates.push(candidate);
  }

  return candidates;
}

async function applyPathGroundingToContent(
  projectRoot: string,
  docFile: string,
  content: string,
): Promise<{ content: string; droppedLines: number; rewrittenPaths: number }> {
  const lines = content.split('\n');
  const outputLines: string[] = [];
  let droppedLines = 0;
  let rewrittenPaths = 0;

  for (const line of lines) {
    const candidates = extractPathCandidatesFromLine(line);
    if (candidates.length === 0) {
      outputLines.push(line);
      continue;
    }

    let currentLine = line;
    let shouldDropLine = false;

    for (const candidate of candidates) {
      const normalized = normalizePathCandidate(candidate);
      if (
        !normalized ||
        normalized.startsWith('http') ||
        normalized.startsWith('#') ||
        normalized.startsWith('mailto:') ||
        isLikelyApiEndpointPath(normalized) ||
        isVirtualDocumentationPath(normalized)
      ) {
        continue;
      }

      if (await pathExistsFromDoc(projectRoot, docFile, normalized)) {
        continue;
      }

      const replacement = await suggestPathReplacement(projectRoot, docFile, normalized);
      if (replacement) {
        if (replacement !== normalized) {
          currentLine = currentLine.split(candidate).join(replacement);
          rewrittenPaths += 1;
        }
        continue;
      }

      shouldDropLine = true;
      break;
    }

    if (shouldDropLine) {
      droppedLines += 1;
      continue;
    }

    outputLines.push(currentLine);
  }

  const normalized = outputLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    content: normalized,
    droppedLines,
    rewrittenPaths,
  };
}

function buildDetailedDocFallbackContent(
  target: Target,
  factPack: FactPack,
  filename: string,
): string {
  if (target === 'cursor') {
    return buildFallbackCursorDetailedDocContent(factPack, filename);
  }
  return buildFallbackSharedDetailedDocContent(factPack, filename);
}

function sanitizeGeneratedDetailedDocs(
  target: Target,
  detailedDocs: { filename: string; content: string }[],
  factPack: FactPack,
): {
  detailedDocs: { filename: string; content: string }[];
  sanitized: string[];
  replaced: string[];
} {
  const sanitized: string[] = [];
  const replaced: string[] = [];
  const minLines = target === 'cursor' ? 5 : 8;

  const normalizedDocs = detailedDocs.map((doc) => {
    const sanitizedContent = sanitizeGeneratedDocContent(doc.content, factPack);
    if (sanitizedContent !== doc.content) {
      sanitized.push(doc.filename);
    }

    const nonEmptyLines = countNonEmptyLines(stripLeadingFrontmatter(sanitizedContent));
    if (nonEmptyLines >= minLines) {
      return {
        filename: doc.filename,
        content: sanitizedContent,
      };
    }

    replaced.push(doc.filename);
    return {
      filename: doc.filename,
      content: buildDetailedDocFallbackContent(target, factPack, doc.filename),
    };
  });

  return {
    detailedDocs: normalizedDocs,
    sanitized,
    replaced,
  };
}

function replaceRootDocFile(
  files: { path: string; content: string }[],
  rootFile: string,
  rootDoc: { path: string; content: string },
): { path: string; content: string }[] {
  return [
    rootDoc,
    ...files.filter(
      (file) => file.path !== rootFile && getFileName(file.path) !== getFileName(rootFile),
    ),
  ];
}

function getMissingRiskSignalIssues(issues: RootQualityIssue[]): RootQualityIssue[] {
  return issues.filter((issue) => issue.code === 'missing-risk-signal');
}

function appendCanonicalRiskSignalCoverage(
  rootContent: string,
  missingRiskIssues: RootQualityIssue[],
): string {
  if (missingRiskIssues.length === 0) return rootContent;

  const missingRefs = new Set(missingRiskIssues.map((issue) => issue.reference));
  const lines: string[] = [];

  if (missingRefs.has('localStorage token handling')) {
    lines.push(
      '- localStorage token handling risk: review auth token and session token storage/invalidation.',
    );
  }
  if (missingRefs.has('API/mock coverage gaps')) {
    lines.push(
      '- API/mock gap: verify endpoint coverage mismatch and mock coverage gap risks before handoff.',
    );
  }
  if (missingRefs.has('tooling dependency gaps')) {
    lines.push(
      '- Tooling mismatch/dependency gap: validate prerequisites and eslint config dependencies.',
    );
  }
  if (missingRefs.has('TypeScript strict gates')) {
    lines.push(
      '- TypeScript gate: run strict typecheck and compiler gate checks (including noUnused* flags).',
    );
  }

  if (lines.length === 0) return rootContent;

  return `${rootContent.trim()}\n\n## Risk Signals\n${lines.join('\n')}`;
}

function describeScriptForGuide(scriptName: string, scriptCmd: string): string {
  const cmd = scriptCmd.toLowerCase();
  if (scriptName === 'build' || cmd.includes('tsup') || cmd.includes('vite build')) {
    return 'Build artifacts and verify compile pipeline.';
  }
  if (scriptName.startsWith('test') || cmd.includes('vitest') || cmd.includes('jest')) {
    return 'Run tests and validate behavior.';
  }
  if (scriptName.startsWith('lint') || cmd.includes('biome') || cmd.includes('eslint')) {
    return 'Check lint and formatting constraints.';
  }
  if (scriptName.includes('type') || cmd.includes('tsc')) {
    return 'Run type-check gates before handoff.';
  }
  return `Execute project workflow step (${scriptName}).`;
}

function formatScriptCommand(packageManager: string, scriptName: string): string {
  switch (packageManager) {
    case 'pnpm':
      return `pnpm ${scriptName}`;
    case 'yarn':
      return `yarn ${scriptName}`;
    case 'bun':
      return `bun run ${scriptName}`;
    default:
      return `npm run ${scriptName}`;
  }
}

function formatInstallCommand(packageManager: string): string {
  switch (packageManager) {
    case 'pnpm':
      return 'pnpm install';
    case 'yarn':
      return 'yarn install';
    case 'bun':
      return 'bun install';
    default:
      return 'npm install';
  }
}

type QualityGateCategory = 'build' | 'lint' | 'typecheck' | 'test' | 'preview' | 'dev' | 'start';

const REQUIRED_GATE_CATEGORIES: QualityGateCategory[] = ['build', 'lint', 'typecheck', 'test'];
const OPTIONAL_GATE_CATEGORIES: QualityGateCategory[] = ['preview', 'dev', 'start'];

function classifyQualityGateCategory(
  scriptName: string,
  scriptCmd: string,
): QualityGateCategory | null {
  const name = scriptName.toLowerCase();
  const cmd = scriptCmd.toLowerCase();

  if (name === 'build' || cmd.includes('vite build') || cmd.includes('tsup')) return 'build';
  if (name.startsWith('lint') || cmd.includes('biome') || cmd.includes('eslint')) return 'lint';
  if (name.includes('type') || cmd.includes('tsc')) return 'typecheck';
  if (name.startsWith('test') || cmd.includes('vitest') || cmd.includes('jest')) return 'test';
  if (name.includes('preview') || cmd.includes('vite preview')) return 'preview';
  if (name === 'dev' || name.startsWith('dev:')) return 'dev';
  if (name === 'start' || name.startsWith('start:')) return 'start';

  return null;
}

function collectQualityGateCommands(factPack: FactPack): {
  required: Map<QualityGateCategory, string>;
  optional: Map<QualityGateCategory, string>;
} {
  const required = new Map<QualityGateCategory, string>();
  const optional = new Map<QualityGateCategory, string>();

  for (const [scriptName, scriptCmd] of Object.entries(factPack.scripts)) {
    const category = classifyQualityGateCategory(scriptName, scriptCmd);
    if (!category) continue;

    const command = formatScriptCommand(factPack.packageManager, scriptName);
    if (REQUIRED_GATE_CATEGORIES.includes(category)) {
      if (!required.has(category)) {
        required.set(category, command);
      }
      continue;
    }

    if (!optional.has(category)) {
      optional.set(category, command);
    }
  }

  return { required, optional };
}

function buildPrerequisiteGuidance(factPack: FactPack): string[] {
  const lines = [
    `Install dependencies with \`${formatInstallCommand(factPack.packageManager)}\`.`,
    'Confirm required environment variables/config files before running commands.',
  ];

  if (factPack.riskSignals.toolingDependencyGaps.length > 0) {
    lines.push(
      `Resolve tooling prerequisites before lint/build: ${factPack.riskSignals.toolingDependencyGaps.join(', ')}.`,
    );
  }

  return lines;
}

function buildQualityGatePolicyHints(factPack: FactPack): string[] {
  const { required, optional } = collectQualityGateCommands(factPack);
  const requiredCommands = REQUIRED_GATE_CATEGORIES.map((category) =>
    required.get(category),
  ).filter((value): value is string => Boolean(value));
  const optionalCommands = OPTIONAL_GATE_CATEGORIES.map((category) =>
    optional.get(category),
  ).filter((value): value is string => Boolean(value));

  const lines: string[] = [];
  if (requiredCommands.length > 0) {
    lines.push(
      `Required gates (must pass before handoff): ${requiredCommands.map((command) => `\`${command}\``).join(', ')}.`,
    );
  } else {
    lines.push('Required gates: list build/lint/typecheck/test commands only when scripts exist.');
  }

  if (optionalCommands.length > 0) {
    lines.push(
      `Optional smoke gates (explicitly mark as optional): ${optionalCommands.map((command) => `\`${command}\``).join(', ')}.`,
    );
  } else {
    lines.push('Optional smoke gates: preview/dev/start should be optional when present.');
  }

  return lines;
}

function buildFallbackQualityGateLines(factPack: FactPack): string[] {
  const { required, optional } = collectQualityGateCommands(factPack);
  const lines: string[] = [];

  const requiredDescriptions: Record<QualityGateCategory, string> = {
    build: 'compile/build gate',
    lint: 'lint/static-style gate',
    typecheck: 'type-safety gate',
    test: 'test validation gate',
    preview: 'preview smoke gate',
    dev: 'local dev smoke gate',
    start: 'runtime smoke gate',
  };

  for (const category of REQUIRED_GATE_CATEGORIES) {
    const command = required.get(category);
    if (!command) continue;
    lines.push(`- Required: \`${command}\` — ${requiredDescriptions[category]}.`);
  }

  if (lines.length === 0) {
    lines.push('- Required gates: run build/lint/typecheck/test commands when available.');
  }

  for (const category of OPTIONAL_GATE_CATEGORIES) {
    const command = optional.get(category);
    if (!command) continue;
    lines.push(
      `- Optional: \`${command}\` — smoke check only; do not block handoff unless explicitly requested.`,
    );
  }

  return lines;
}

function escapeRegExpForSection(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findSectionRange(
  content: string,
  heading: string,
): { headingStart: number; bodyStart: number; end: number } | null {
  const headingPattern = new RegExp(
    `^\\s*#{1,6}\\s*${escapeRegExpForSection(heading)}\\s*:?\\s*$`,
    'im',
  );
  const match = headingPattern.exec(content);
  if (!match || match.index === undefined) return null;

  const headingStart = match.index;
  const bodyStart = headingStart + match[0].length;
  const fromBody = content.slice(bodyStart);
  const nextHeading = /\n#{1,6}\s+/.exec(fromBody);
  const end = nextHeading ? bodyStart + nextHeading.index : content.length;

  return { headingStart, bodyStart, end };
}

function replaceSectionBody(content: string, heading: string, lines: string[]): string {
  const section = findSectionRange(content, heading);
  if (!section) return content;

  const prefix = content.slice(0, section.bodyStart).trimEnd();
  const suffix = content.slice(section.end).trimStart();
  const body = lines.join('\n');

  if (suffix.length === 0) {
    return `${prefix}\n${body}`;
  }

  return `${prefix}\n${body}\n\n${suffix}`;
}

function normalizeDetailedDocPathAliases(rootContent: string, target: Target): string {
  if (target === 'cursor') return rootContent;

  let normalized = rootContent;
  for (const docName of getRequiredDetailedDocs(target)) {
    const canonical = toDetailedDocLinkPath(target, docName);
    const variants = [
      `claude/docs/${docName}`,
      `./claude/docs/${docName}`,
      `docs/${docName}`,
      `./docs/${docName}`,
      `../.claude/docs/${docName}`,
    ];

    for (const variant of variants) {
      normalized = normalized.split(variant).join(canonical);
    }
  }

  return normalized;
}

function hasCursorFrontmatter(content: string): boolean {
  const normalized = content.replace(/\r\n/g, '\n').trimStart();
  return /^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/.test(normalized);
}

function buildCursorFrontmatterBlock(
  description: string,
  alwaysApply: boolean,
  globs = '',
): string {
  const normalizedGlobs = alwaysApply ? '[]' : globs;
  return `---
description: ${description}
globs: ${normalizedGlobs}
alwaysApply: ${alwaysApply ? 'true' : 'false'}
---`;
}

function stripLeadingFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n').trimStart();
  const match = normalized.match(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/);
  if (!match) {
    return content.trim();
  }
  return normalized.slice(match[0].length).trim();
}

function ensureCursorFrontmatter(
  content: string,
  options: { description: string; alwaysApply: boolean; globs?: string },
): string {
  const body = hasCursorFrontmatter(content) ? stripLeadingFrontmatter(content) : content.trim();
  const frontmatter = buildCursorFrontmatterBlock(
    options.description,
    options.alwaysApply,
    options.globs ?? '',
  );
  if (body.length === 0) {
    return frontmatter;
  }
  return `${frontmatter}\n\n${body}`;
}

function getCursorDetailedDocFrontmatter(filename: string): {
  description: string;
  alwaysApply: boolean;
  globs?: string;
} {
  switch (filename) {
    case 'testing.mdc':
      return {
        description: 'Testing rules for test and spec files',
        alwaysApply: false,
        globs: '**/*.{test,spec}.{ts,tsx,js,jsx}',
      };
    case 'style.mdc':
      return {
        description: 'Code style and formatting conventions',
        alwaysApply: false,
        globs: 'src/**/*.{ts,tsx,js,jsx}',
      };
    case 'architecture.mdc':
      return {
        description: 'Architecture boundaries and module responsibilities',
        alwaysApply: false,
        globs: '',
      };
    case 'guardrails.mdc':
      return {
        description: 'Safety guardrails and high-risk change boundaries',
        alwaysApply: false,
        globs: '',
      };
    default:
      return {
        description: 'Cursor rule',
        alwaysApply: false,
        globs: '',
      };
  }
}

function normalizeCursorDetailedDocs(
  detailedDocs: { filename: string; content: string }[],
): { filename: string; content: string }[] {
  return detailedDocs.map((doc) => {
    const frontmatter = getCursorDetailedDocFrontmatter(doc.filename);
    return {
      ...doc,
      content: ensureCursorFrontmatter(doc.content, frontmatter),
    };
  });
}

const CURSOR_RULE_MAX_NON_EMPTY_LINES = 90;
const CURSOR_ROOT_ADAPTER_MAX_NON_EMPTY_LINES = 90;
const CURSOR_CANONICAL_LINK_PATTERN = /\.claude\/docs\/[a-z0-9._/-]+\.md/i;
const CURSOR_CANONICAL_LINK_CAPTURE = /(?:\.\.\/)*\.claude\/docs\/[a-z0-9._/-]+\.md/gi;
const CURSOR_ALLOWED_ROOT_HEADINGS = new Set(
  getRootDocContract('cursor').requiredHeadings.map((heading) => normalizeHeadingLabel(heading)),
);
const CURSOR_ALLOWED_ADAPTER_HEADINGS: Record<string, Set<string>> = {
  'architecture.mdc': new Set(['canonical source', 'cursor focus', 'verify']),
  'style.mdc': new Set(['canonical source', 'cursor focus', 'verify']),
  'testing.mdc': new Set(['canonical source', 'cursor focus', 'verify']),
  'guardrails.mdc': new Set(['canonical source', 'cursor focus', 'handoff checklist']),
};

function countNonEmptyLines(content: string): number {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0).length;
}

function normalizeHeadingLabel(value: string): string {
  return value
    .replace(/[`*_]/g, '')
    .replace(/\s*:+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractHeadingsByLevel(content: string, level: number): string[] {
  const pattern = new RegExp(`^#{${level}}\\s+(.+)$`, 'gim');
  return Array.from(content.matchAll(pattern))
    .map((match) => match[1]?.trim() ?? '')
    .filter((value) => value.length > 0);
}

function hasOnlyAllowedCursorAdapterHeadings(content: string, filename: string): boolean {
  const allowedHeadings = CURSOR_ALLOWED_ADAPTER_HEADINGS[filename];
  if (!allowedHeadings) return true;

  const headings = extractHeadingsByLevel(stripLeadingFrontmatter(content), 2).map(
    normalizeHeadingLabel,
  );
  if (headings.length === 0) return false;

  return headings.every((heading) => allowedHeadings.has(heading));
}

function cursorRootHasUnsupportedHeadings(content: string): boolean {
  const headings = extractHeadingsByLevel(stripLeadingFrontmatter(content), 2).map(
    normalizeHeadingLabel,
  );
  if (headings.length === 0) return true;
  return headings.some((heading) => !CURSOR_ALLOWED_ROOT_HEADINGS.has(heading));
}

function hasCursorCanonicalSourceLink(content: string, filename: string): boolean {
  const body = stripLeadingFrontmatter(content);
  const canonicalLinks = getCursorCanonicalDocLinks(filename);
  if (canonicalLinks.length === 0) {
    return CURSOR_CANONICAL_LINK_PATTERN.test(body);
  }
  const normalizedBody = body.toLowerCase();
  return canonicalLinks.some((link) => normalizedBody.includes(link.toLowerCase()));
}

function normalizeCanonicalSharedDocLink(rawLink: string): string {
  const normalized = rawLink.replace(/\\/g, '/');
  const marker = normalized.toLowerCase().lastIndexOf('.claude/docs/');
  if (marker < 0) {
    return normalized.toLowerCase();
  }
  const withMarker = normalized.slice(marker);
  const [withoutQuery] = withMarker.split(/[?#]/);
  return withoutQuery.toLowerCase();
}

function extractCanonicalSharedDocLinks(content: string): string[] {
  const body = stripLeadingFrontmatter(content);
  return Array.from(body.matchAll(CURSOR_CANONICAL_LINK_CAPTURE))
    .map((match) => normalizeCanonicalSharedDocLink(match[0] ?? ''))
    .filter((value) => value.length > 0);
}

function hasOnlyMappedCursorCanonicalLinks(content: string, filename: string): boolean {
  const expectedLinks = new Set(
    getCursorCanonicalDocLinks(filename).map((link) => normalizeCanonicalSharedDocLink(link)),
  );
  const foundLinks = extractCanonicalSharedDocLinks(content);

  if (foundLinks.length === 0) {
    return expectedLinks.size === 0;
  }
  if (expectedLinks.size === 0) {
    return true;
  }

  return foundLinks.every((link) => expectedLinks.has(link));
}

function normalizeCursorDetailedDocAdapters(
  detailedDocs: { filename: string; content: string }[],
  factPack: FactPack,
): { detailedDocs: { filename: string; content: string }[]; replaced: string[] } {
  const requiredDocs = new Set(getRequiredDetailedDocs('cursor'));
  const replaced: string[] = [];
  const normalized = detailedDocs.map((doc) => {
    if (!requiredDocs.has(doc.filename)) {
      return doc;
    }

    const body = stripLeadingFrontmatter(doc.content);
    const nonEmptyLines = countNonEmptyLines(body);
    const hasCanonicalLink = hasCursorCanonicalSourceLink(doc.content, doc.filename);
    const hasOnlyMappedLinks = hasOnlyMappedCursorCanonicalLinks(doc.content, doc.filename);
    const hasOnlyAllowedHeadings = hasOnlyAllowedCursorAdapterHeadings(doc.content, doc.filename);
    const exceedsBudget = nonEmptyLines > CURSOR_RULE_MAX_NON_EMPTY_LINES;
    if (hasCanonicalLink && hasOnlyMappedLinks && hasOnlyAllowedHeadings && !exceedsBudget) {
      return doc;
    }

    replaced.push(doc.filename);
    return {
      ...doc,
      content: buildFallbackCursorDetailedDocContent(factPack, doc.filename),
    };
  });

  return { detailedDocs: normalized, replaced };
}

function normalizeCursorRootFrontmatter(rootContent: string): string {
  return ensureCursorFrontmatter(rootContent, {
    description: 'Project-wide Cursor rules',
    alwaysApply: true,
    globs: '[]',
  });
}

function normalizeCursorRootAsThinAdapter(rootContent: string, factPack: FactPack): string {
  const body = stripLeadingFrontmatter(rootContent);
  const nonEmptyLines = countNonEmptyLines(body);
  const hasUnsupportedHeadings = cursorRootHasUnsupportedHeadings(body);
  if (nonEmptyLines > CURSOR_ROOT_ADAPTER_MAX_NON_EMPTY_LINES || hasUnsupportedHeadings) {
    return buildFallbackCursorRootAdapterContent(factPack).trim();
  }
  return body.trim();
}

function normalizeDetailedDocsSection(rootContent: string, target: Target): string {
  const detailedDocLinks = getRequiredDetailedDocLinks(target);
  const lines = detailedDocLinks.map((linkPath) => `- ${linkPath}`);
  return replaceSectionBody(rootContent, 'Detailed Docs', lines);
}

function normalizePrerequisitesSection(rootContent: string, factPack: FactPack): string {
  const lines = buildPrerequisiteGuidance(factPack).map((line) => `- ${line}`);
  return replaceSectionBody(rootContent, 'Prerequisites', lines);
}

function normalizeQualityGatesSection(rootContent: string, factPack: FactPack): string {
  const lines = buildFallbackQualityGateLines(factPack);
  return replaceSectionBody(rootContent, 'Quality Gates', lines);
}

function buildFallbackCriticalWarningLines(factPack: FactPack): string[] {
  const lines = [
    '- Never commit secrets, API keys, or sensitive credentials.',
    '- Do not manually edit generated files; regenerate instead.',
    '- Document breaking changes and compatibility impact explicitly.',
  ];

  const requiredCommands = buildFallbackQualityGateLines(factPack)
    .filter((line) => line.startsWith('- Required:'))
    .map((line) => {
      const match = line.match(/`([^`]+)`/);
      return match?.[1] ?? null;
    })
    .filter((value): value is string => Boolean(value));

  if (requiredCommands.length > 0) {
    lines.push(
      `- Validation before handoff: run required quality gates (${requiredCommands.join(', ')}).`,
    );
  } else {
    lines.push('- Validation before handoff: run validate/lint/typecheck/test/build as available.');
  }

  return lines;
}

function buildFallbackRiskyZoneLines(factPack: FactPack): string[] {
  const lines = [
    '- Areas touching auth/session logic are high risk and require focused review.',
    '- API/mock gap may hide production-only behavior differences.',
    '- Tooling mismatch can break local lint/build if prerequisites are missing.',
    '- TypeScript compiler gates can fail on unused or implicit types.',
  ];

  if (factPack.riskSignals.tokenStorageLocalStorage) {
    lines.push('- localStorage token handling requires extra security review.');
  }
  if (factPack.riskSignals.apiMockCoverageGaps.length > 0) {
    lines.push(
      `- API/mock coverage gaps detected (${factPack.riskSignals.apiMockCoverageGaps.length} endpoints affected).`,
    );
  }
  if (factPack.riskSignals.toolingDependencyGaps.length > 0) {
    lines.push(
      `- Tooling mismatch/dependency gap detected: ${factPack.riskSignals.toolingDependencyGaps.join(', ')}.`,
    );
  }
  if (factPack.riskSignals.strictTypeScriptFlags.length > 0) {
    lines.push(
      `- TypeScript compiler gates enabled: ${factPack.riskSignals.strictTypeScriptFlags.join(', ')}.`,
    );
  }

  return lines;
}

function normalizeCriticalWarningsSection(rootContent: string, factPack: FactPack): string {
  const lines = buildFallbackCriticalWarningLines(factPack);
  return replaceSectionBody(rootContent, 'Critical Warnings', lines);
}

function normalizeRiskyZonesSection(rootContent: string, factPack: FactPack): string {
  const lines = buildFallbackRiskyZoneLines(factPack);
  return replaceSectionBody(rootContent, 'Risky Zones', lines);
}

function normalizeRootContent(rootContent: string, target: Target, factPack: FactPack): string {
  let normalized = normalizeDetailedDocPathAliases(rootContent, target);
  normalized = normalizeArchitectureSnapshotSection(normalized, factPack);
  normalized = normalizeDetailedDocsSection(normalized, target);
  normalized = normalizePrerequisitesSection(normalized, factPack);
  normalized = normalizeQualityGatesSection(normalized, factPack);
  normalized = normalizeCriticalWarningsSection(normalized, factPack);
  normalized = normalizeRiskyZonesSection(normalized, factPack);
  if (target === 'cursor') {
    normalized = normalizeCursorRootFrontmatter(normalized);
  }
  return normalized;
}

function applyRootNormalization(
  files: { path: string; content: string }[],
  rootFile: string,
  rootDoc: { path: string; content: string },
  target: Target,
  factPack: FactPack,
): { files: { path: string; content: string }[]; rootDoc: { path: string; content: string } } {
  const normalizedContent = normalizeRootContent(rootDoc.content, target, factPack);
  if (normalizedContent === rootDoc.content) {
    return { files, rootDoc };
  }

  const normalizedRootDoc = {
    path: rootFile,
    content: normalizedContent,
  };

  return {
    files: replaceRootDocFile(files, rootFile, normalizedRootDoc),
    rootDoc: normalizedRootDoc,
  };
}

function buildFallbackCursorRootAdapterContent(factPack: FactPack): string {
  const detailedDocLinks = getRequiredDetailedDocLinks('cursor');
  const scriptEntries = Object.entries(factPack.scripts).slice(0, 6);
  const commandLines =
    scriptEntries.length > 0
      ? scriptEntries.map(([name, cmd]) => {
          const command = formatScriptCommand(factPack.packageManager, name);
          const description = describeScriptForGuide(name, cmd);
          return `- \`${command}\` — ${description}`;
        })
      : [
          '- No package scripts detected. Use repository-specific workflows documented in canonical docs.',
        ];
  const qualityGateLines = buildFallbackQualityGateLines(factPack);
  const criticalWarningLines = buildFallbackCriticalWarningLines(factPack);

  return `# ${factPack.projectName} — Cursor Project Rules
## Overview
- Treat Cursor rules as thin execution adapters.
- Canonical project documentation lives under \`.claude/docs/\`; do not duplicate it here.
- Keep edits scoped, deterministic, and validated before handoff.

## Key Commands
${commandLines.join('\n')}

## Quality Gates
${qualityGateLines.join('\n')}

## Critical Warnings
${criticalWarningLines.join('\n')}

## Detailed Docs
${detailedDocLinks.map((name) => `- ${name}`).join('\n')}`;
}

function buildFallbackRootContent(factPack: FactPack, target: Target): string {
  if (target === 'cursor') {
    return buildFallbackCursorRootAdapterContent(factPack);
  }

  const rootFile = getRootFileForTarget(target);
  const detailedDocLinks = getRequiredDetailedDocLinks(target);
  const scriptEntries = Object.entries(factPack.scripts).slice(0, 8);

  const commandLines =
    scriptEntries.length > 0
      ? scriptEntries.map(([name, cmd]) => {
          const command = formatScriptCommand(factPack.packageManager, name);
          const description = describeScriptForGuide(name, cmd);
          return `- \`${command}\` — ${description}`;
        })
      : [
          '- No package scripts detected. Use repository-specific workflows documented in detailed docs.',
        ];

  const prerequisiteLines = buildPrerequisiteGuidance(factPack).map((line) => `- ${line}`);
  const qualityGateLines = buildFallbackQualityGateLines(factPack);

  const riskLines = buildFallbackRiskyZoneLines(factPack);
  const criticalWarningLines = buildFallbackCriticalWarningLines(factPack);

  return `# ${rootFile}
## Overview
This root guide is an operational entry point for AI agents working in this repository.
Start here before editing code, then use detailed docs for subsystem-level decisions.
Prefer verified project commands and repository-grounded paths only.

## Architecture Snapshot
Project name: ${factPack.projectName}.
Primary language: ${factPack.language}.
Entry points: ${factPack.entryPoints.join(', ') || 'not detected'}.
Main configs: ${factPack.configFiles.join(', ') || 'not detected'}.
Detected tools: ${
    Object.entries(factPack.detectedTools)
      .filter(([, value]) => value)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ') || 'none'
  }.

## Prerequisites
${prerequisiteLines.join('\n')}

## Key Commands
${commandLines.join('\n')}

## Task Runbook
1. Read this root file and relevant detailed docs first.
2. Identify impacted modules and risky zones before coding.
3. Implement focused changes with minimal surface area.
4. Run quality gates before handoff and document any assumptions.
5. If behavior changes, update documentation in the same change set.

## Quality Gates
${qualityGateLines.join('\n')}

## Risky Zones
${riskLines.join('\n')}

## Critical Warnings
${criticalWarningLines.join('\n')}

## Detailed Docs
${detailedDocLinks.map((name) => `- ${name}`).join('\n')}`;
}

function buildCursorCanonicalReferenceBlock(filename: string): string {
  const canonicalLinks = getCursorCanonicalDocLinks(filename);
  if (canonicalLinks.length === 0) {
    return '- No canonical shared document is mapped for this rule yet.';
  }
  return canonicalLinks.map((link) => `- [${link}](${link})`).join('\n');
}

function buildFallbackCursorDetailedDocContent(factPack: FactPack, filename: string): string {
  const configFiles = factPack.configFiles.join(', ') || 'not detected';
  const qualityGateLines = buildFallbackQualityGateLines(factPack).slice(0, 4).join('\n');
  const canonicalRefs = buildCursorCanonicalReferenceBlock(filename);

  switch (filename) {
    case 'architecture.mdc':
      return `# Cursor Architecture Adapter
## Canonical Source
${canonicalRefs}

## Cursor Focus
- Use this rule as a routing layer; treat canonical architecture docs as source of truth.
- Project configs to check first: ${configFiles}.
- Keep edits scoped to affected modules and verify boundaries before applying changes.

## Verify
${qualityGateLines}`;

    case 'style.mdc':
      return `# Cursor Style Adapter
## Canonical Source
${canonicalRefs}

## Cursor Focus
- Apply only repository-specific style constraints from canonical docs.
- Avoid style-only refactors outside the touched scope.
- Keep edits deterministic and reviewable.

## Verify
${qualityGateLines}`;

    case 'testing.mdc':
      return `# Cursor Testing Adapter
## Canonical Source
${canonicalRefs}

## Cursor Focus
- Follow canonical test strategy and keep tests near changed behavior.
- Prioritize deterministic checks for provider/command changes.
- Report confidence limits if tests cannot cover production-only behavior.

## Verify
${qualityGateLines}`;

    case 'guardrails.mdc':
      return `# Cursor Guardrails Adapter
## Canonical Source
${canonicalRefs}

## Cursor Focus
- Never invent paths or commands; verify before edits.
- Keep scope minimal and avoid unrelated directory changes.
- Document breaking changes and migration impact explicitly.

## Handoff Checklist
${qualityGateLines}`;

    default:
      return `# Cursor Rule Adapter
## Canonical Source
${canonicalRefs}

## Cursor Focus
- Keep this rule concise and defer full context to canonical shared docs.`;
  }
}

function ensureCursorDetailedDocs(
  detailedDocs: { filename: string; content: string }[],
  factPack: FactPack,
): { detailedDocs: { filename: string; content: string }[]; added: string[] } {
  const requiredDocs = getRequiredDetailedDocs('cursor');
  const existing = new Set(detailedDocs.map((doc) => doc.filename));
  const merged = [...detailedDocs];
  const added: string[] = [];

  for (const filename of requiredDocs) {
    if (existing.has(filename)) continue;
    merged.push({
      filename,
      content: buildFallbackCursorDetailedDocContent(factPack, filename),
    });
    added.push(filename);
  }

  return { detailedDocs: merged, added };
}

function buildQualityRepairPrompt(
  target: Target,
  raw: string,
  issuesSummary: string,
  riskSignals: string[],
): string {
  const rootContract = getRootDocContract(target);
  const requiredDetailedDocLinks = getRequiredDetailedDocLinks(target);
  const requiredSections = rootContract.requiredHeadings
    .map((section) => `- ${section}`)
    .join('\n');
  const requiredWarnings = rootContract.requiredWarningTopics
    .map((topic) => `- ${topic}`)
    .join('\n');
  const riskHints = riskSignals.length > 0 ? riskSignals.map((v) => `- ${v}`).join('\n') : '- none';
  return `Target: ${target}
Root file: ${rootContract.rootFile}

The previous output failed root quality checks.
Detected quality issues:
${issuesSummary}

Repair requirements:
- Output file blocks only, no commentary.
- Root file must include these sections exactly:
${requiredSections}
- Root must include explicit prerequisites (dependency install + setup assumptions).
- Root must include these warning topics:
${requiredWarnings}
- Root must mention these risk signals:
${riskHints}
- Root must include canonical links to detailed docs:
${requiredDetailedDocLinks.map((doc) => `- ${doc}`).join('\n')}
- Keep required quality gates mandatory and preview/dev/start clearly optional when present.
- Remove process-log/reasoning style text.
- Keep detailed docs useful and aligned with the root.

---RAW OUTPUT START---
${raw}
---RAW OUTPUT END---`;
}

async function tryRepairRootQuality(
  raw: string,
  target: Target,
  issueSummary: string,
  riskSignals: string[],
  provider: LLMProvider,
  providerType: ProviderType,
): Promise<{ path: string; content: string }[] | null> {
  const repairPrompt = buildQualityRepairPrompt(target, raw, issueSummary, riskSignals);
  const adaptedRepair = adaptPrompt(QUALITY_REPAIR_SYSTEM_PROMPT, repairPrompt, providerType);
  logPromptDispatch(target, 'quality-repair', providerType, adaptedRepair);

  try {
    const repairedRaw = await provider.generate(
      adaptedRepair.userPrompt,
      adaptedRepair.systemPrompt ?? '',
    );
    const repairedFiles = parseGenerationOutput(repairedRaw);
    return repairedFiles.length > 0 ? repairedFiles : null;
  } catch {
    return null;
  }
}

async function generateForTarget(
  factPack: FactPack,
  target: Target,
  provider: LLMProvider,
  providerType: ProviderType,
  options: GenerateDocsOptions,
): Promise<GenerationResult> {
  const startedAt = Date.now();
  const enableFormatRepair = options.enableFormatRepair ?? true;
  const enableQualityRepair = options.enableQualityRepair ?? true;
  const allowProviderFailureFallback = options.allowProviderFailureFallback ?? false;
  const rootOnlyTarget = isRootOnlyTarget(target, options);
  const { prompt, promptTreeCount, originalTreeCount, truncatedTreeCount } = buildPrompt(
    factPack,
    target,
    options.maxDirectoryTreeEntries,
    rootOnlyTarget,
  );
  logger.debug(
    `[generate:${target}] prompt_chars=${prompt.length}, directoryTree=${promptTreeCount}/${originalTreeCount}, truncated=${truncatedTreeCount}, root_only=${rootOnlyTarget}`,
  );

  const adapted = adaptPrompt(SYSTEM_PROMPT, prompt, providerType);
  logPromptDispatch(target, 'initial', providerType, adapted);
  let raw: string;
  try {
    raw = await provider.generate(adapted.userPrompt, adapted.systemPrompt ?? '');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (allowProviderFailureFallback && isRecoverableProviderFailure(message)) {
      logger.debug(
        `[generate:${target}] provider failure in speed mode (${message}), applying local fallback root`,
      );
      const durationMs = Date.now() - startedAt;
      const rootFile = getRootFileForTarget(target);
      const fallbackRoot = buildFallbackRootContent(factPack, target);
      logger.debug(
        `[generate:${target}] done in ${durationMs}ms, root=${rootFile}, detailed=0, repaired=true`,
      );
      return {
        target,
        rootContent: fallbackRoot,
        detailedDocs: [],
      };
    }
    throw new ProviderError(`Generation failed for target "${target}": ${message}`);
  }
  let files = parseGenerationOutput(raw);

  const rootFile = getRootFileForTarget(target);
  let rootDoc = findRootDoc(files, rootFile);
  let repaired = false;

  if ((!rootDoc || rootDoc.content.trim().length === 0) && enableFormatRepair) {
    const repairedFiles = await tryRepairFormatting(raw, target, rootFile, provider, providerType);
    if (repairedFiles) {
      repaired = true;
      files = repairedFiles;
      rootDoc = findRootDoc(files, rootFile);
    }
  } else if (!rootDoc || rootDoc.content.trim().length === 0) {
    logger.debug(`[generate:${target}] format repair disabled by speed profile`);
  }

  if (!rootDoc || rootDoc.content.trim().length === 0) {
    if (!enableFormatRepair || providerType === 'cursor-agent') {
      if (!enableFormatRepair) {
        logger.debug(
          `[generate:${target}] missing root marker with format repair disabled, applying local fallback root`,
        );
      } else {
        const foundPaths = formatFoundPaths(files);
        logger.warn(
          `[generate:${target}] cursor-agent output missing root marker (${rootFile}), applying local fallback root (found paths: ${foundPaths})`,
        );
      }
      logger.debug(`[generate:${target}] applying local fallback root due to missing root marker`);
      rootDoc = {
        path: rootFile,
        content: buildFallbackRootContent(factPack, target),
      };
      files = replaceRootDocFile(files, rootFile, rootDoc);
      repaired = true;
    } else {
      const foundPaths = formatFoundPaths(files);
      throw new ProviderError(
        `Provider output for target "${target}" is missing root file marker: ${rootFile}. Found paths: ${foundPaths}`,
      );
    }
  }

  ({ files, rootDoc } = applyRootNormalization(files, rootFile, rootDoc, target, factPack));

  let detailedDocs = collectDetailedDocs(files, rootDoc, rootOnlyTarget);
  let rootQualityIssues = evaluateRootDocQuality({
    target,
    rootContent: rootDoc.content,
    scripts: factPack.scripts,
    generatedDetailedDocs: detailedDocs.map((doc) => doc.filename),
    riskSignals: factPack.riskSignals,
  });
  let blockingRootIssues = getBlockingRootQualityIssues(rootQualityIssues);
  let advisoryRootIssues = getAdvisoryRootQualityIssues(rootQualityIssues);

  if (blockingRootIssues.length > 0) {
    const issueSummary = summarizeRootQualityIssues(blockingRootIssues);
    logger.debug(
      `[generate:${target}] root quality failed, applying local fallback: ${issueSummary}`,
    );

    rootDoc = {
      path: rootFile,
      content: buildFallbackRootContent(factPack, target),
    };

    files = replaceRootDocFile(files, rootFile, rootDoc);
    repaired = true;
    detailedDocs = collectDetailedDocs(files, rootDoc, rootOnlyTarget);
    rootQualityIssues = evaluateRootDocQuality({
      target,
      rootContent: rootDoc.content,
      scripts: factPack.scripts,
      generatedDetailedDocs: detailedDocs.map((doc) => doc.filename),
      riskSignals: factPack.riskSignals,
    });
    blockingRootIssues = getBlockingRootQualityIssues(rootQualityIssues);
    advisoryRootIssues = getAdvisoryRootQualityIssues(rootQualityIssues);
  }

  if (blockingRootIssues.length > 0 && enableQualityRepair) {
    const issueSummary = summarizeRootQualityIssues(blockingRootIssues);
    logger.debug(
      `[generate:${target}] local fallback still failing, trying quality repair: ${issueSummary}`,
    );

    const repairedFiles = await tryRepairRootQuality(
      buildRawFromFiles(files),
      target,
      issueSummary,
      getRequiredRiskSignalLabels(factPack.riskSignals),
      provider,
      providerType,
    );
    if (repairedFiles) {
      repaired = true;
      files = repairedFiles;
      rootDoc = findRootDoc(files, rootFile);
      if (!rootDoc || rootDoc.content.trim().length === 0) {
        const foundPaths = formatFoundPaths(files);
        throw new ProviderError(
          `Provider output for target "${target}" lost root file during quality repair: ${rootFile}. Found paths: ${foundPaths}`,
        );
      }
      ({ files, rootDoc } = applyRootNormalization(files, rootFile, rootDoc, target, factPack));
      detailedDocs = collectDetailedDocs(files, rootDoc, rootOnlyTarget);
      rootQualityIssues = evaluateRootDocQuality({
        target,
        rootContent: rootDoc.content,
        scripts: factPack.scripts,
        generatedDetailedDocs: detailedDocs.map((doc) => doc.filename),
        riskSignals: factPack.riskSignals,
      });
      blockingRootIssues = getBlockingRootQualityIssues(rootQualityIssues);
      advisoryRootIssues = getAdvisoryRootQualityIssues(rootQualityIssues);
    }
  } else if (blockingRootIssues.length > 0) {
    logger.debug(`[generate:${target}] quality repair disabled by speed profile`);
  }

  if (blockingRootIssues.length > 0) {
    throw new ProviderError(
      `Provider output for target "${target}" failed root quality checks: ${summarizeRootQualityIssues(blockingRootIssues)}`,
    );
  }

  const missingRiskSignalIssues = getMissingRiskSignalIssues(advisoryRootIssues);
  if (missingRiskSignalIssues.length > 0) {
    const patchedRootContent = appendCanonicalRiskSignalCoverage(
      rootDoc.content,
      missingRiskSignalIssues,
    );
    if (patchedRootContent !== rootDoc.content) {
      rootDoc = {
        path: rootFile,
        content: patchedRootContent,
      };
      files = replaceRootDocFile(files, rootFile, rootDoc);
      ({ files, rootDoc } = applyRootNormalization(files, rootFile, rootDoc, target, factPack));
      detailedDocs = collectDetailedDocs(files, rootDoc, rootOnlyTarget);
      rootQualityIssues = evaluateRootDocQuality({
        target,
        rootContent: rootDoc.content,
        scripts: factPack.scripts,
        generatedDetailedDocs: detailedDocs.map((doc) => doc.filename),
        riskSignals: factPack.riskSignals,
      });
      blockingRootIssues = getBlockingRootQualityIssues(rootQualityIssues);
      advisoryRootIssues = getAdvisoryRootQualityIssues(rootQualityIssues);
      if (blockingRootIssues.length > 0) {
        throw new ProviderError(
          `Provider output for target "${target}" failed root quality checks after risk-signal patch: ${summarizeRootQualityIssues(blockingRootIssues)}`,
        );
      }
    }
  }

  if (advisoryRootIssues.length > 0) {
    logger.debug(
      `[generate:${target}] root quality advisory: ${summarizeRootQualityIssues(advisoryRootIssues)}`,
    );
  }

  if (target !== 'cursor' && !rootOnlyTarget) {
    const canonicalized = canonicalizeSharedDetailedDocs(target, detailedDocs, factPack);
    if (canonicalized.remapped.length > 0) {
      logger.warn(
        `[generate:${target}] remapped detailed docs to canonical names: ${canonicalized.remapped.join(', ')}`,
      );
      repaired = true;
    }
    if (canonicalized.dropped.length > 0) {
      logger.warn(
        `[generate:${target}] dropped unexpected detailed docs: ${canonicalized.dropped.join(', ')}`,
      );
      repaired = true;
    }
    if (canonicalized.added.length > 0) {
      logger.warn(
        `[generate:${target}] output missing required detailed docs, applying local fallback docs: ${canonicalized.added.join(', ')}`,
      );
      repaired = true;
    }
    detailedDocs = canonicalized.detailedDocs;
  }

  if (target === 'cursor') {
    rootDoc = {
      ...rootDoc,
      content: normalizeCursorRootFrontmatter(rootDoc.content),
    };
    if (!rootOnlyTarget) {
      const canonicalized = canonicalizeCursorDetailedDocs(detailedDocs);
      if (canonicalized.remapped.length > 0) {
        logger.warn(
          `[generate:${target}] remapped cursor detailed docs to canonical names: ${canonicalized.remapped.join(', ')}`,
        );
        repaired = true;
      }
      if (canonicalized.dropped.length > 0) {
        logger.warn(
          `[generate:${target}] dropped unexpected cursor detailed docs: ${canonicalized.dropped.join(', ')}`,
        );
        repaired = true;
      }
      detailedDocs = canonicalized.detailedDocs;

      const withFallback = ensureCursorDetailedDocs(detailedDocs, factPack);
      if (withFallback.added.length > 0) {
        logger.warn(
          `[generate:${target}] output missing cursor detailed docs, applying local fallback docs: ${withFallback.added.join(', ')}`,
        );
        repaired = true;
      }
      detailedDocs = withFallback.detailedDocs;

      const adapterNormalization = normalizeCursorDetailedDocAdapters(detailedDocs, factPack);
      if (adapterNormalization.replaced.length > 0) {
        logger.warn(
          `[generate:${target}] cursor detailed docs were normalized to thin adapters: ${adapterNormalization.replaced.join(', ')}`,
        );
        repaired = true;
      }
      detailedDocs = adapterNormalization.detailedDocs;
    }
  }

  const sanitizedRootContent = sanitizeGeneratedDocContent(rootDoc.content, factPack);
  if (sanitizedRootContent !== rootDoc.content) {
    rootDoc = {
      ...rootDoc,
      content: sanitizedRootContent,
    };
    repaired = true;
  }

  if (!rootOnlyTarget) {
    const sanitizedDetailed = sanitizeGeneratedDetailedDocs(target, detailedDocs, factPack);
    if (sanitizedDetailed.sanitized.length > 0) {
      logger.warn(
        `[generate:${target}] sanitized factual drift in detailed docs: ${sanitizedDetailed.sanitized.join(', ')}`,
      );
      repaired = true;
    }
    if (sanitizedDetailed.replaced.length > 0) {
      logger.warn(
        `[generate:${target}] replaced low-signal detailed docs with local fallback: ${sanitizedDetailed.replaced.join(', ')}`,
      );
      repaired = true;
    }
    detailedDocs = sanitizedDetailed.detailedDocs;
  }

  if (target === 'cursor') {
    const thinRootContent = normalizeCursorRootAsThinAdapter(rootDoc.content, factPack);
    if (thinRootContent !== stripLeadingFrontmatter(rootDoc.content).trim()) {
      logger.warn(
        `[generate:${target}] normalized root to thin adapter format to avoid duplicated cross-target instructions`,
      );
      repaired = true;
    }
    rootDoc = {
      ...rootDoc,
      content: normalizeCursorRootFrontmatter(thinRootContent),
    };
    detailedDocs = normalizeCursorDetailedDocs(detailedDocs);
  }

  if (options.projectRoot) {
    const rootDocPath = path.join(options.projectRoot, rootFile);
    const groundedRoot = await applyPathGroundingToContent(
      options.projectRoot,
      rootDocPath,
      rootDoc.content,
    );
    if (groundedRoot.content !== rootDoc.content) {
      rootDoc = {
        ...rootDoc,
        content: groundedRoot.content,
      };
      repaired = true;
    }
    if (groundedRoot.rewrittenPaths > 0 || groundedRoot.droppedLines > 0) {
      logger.warn(
        `[generate:${target}] path-grounding adjusted root doc (rewritten=${groundedRoot.rewrittenPaths}, dropped_lines=${groundedRoot.droppedLines})`,
      );
    }

    if (!rootOnlyTarget) {
      const detailedDir = target === 'cursor' ? '.cursor/rules' : '.claude/docs';
      const groundedDetailedDocs: { filename: string; content: string }[] = [];
      let rewrittenPaths = 0;
      let droppedLines = 0;

      for (const doc of detailedDocs) {
        const docPath = path.join(options.projectRoot, detailedDir, doc.filename);
        const grounded = await applyPathGroundingToContent(
          options.projectRoot,
          docPath,
          doc.content,
        );
        groundedDetailedDocs.push({
          ...doc,
          content: grounded.content,
        });
        rewrittenPaths += grounded.rewrittenPaths;
        droppedLines += grounded.droppedLines;
      }

      if (rewrittenPaths > 0 || droppedLines > 0) {
        logger.warn(
          `[generate:${target}] path-grounding adjusted detailed docs (rewritten=${rewrittenPaths}, dropped_lines=${droppedLines})`,
        );
        repaired = true;
      }

      detailedDocs = groundedDetailedDocs;
    }
  }

  const durationMs = Date.now() - startedAt;
  logger.debug(
    `[generate:${target}] done in ${durationMs}ms, root=${rootFile}, detailed=${detailedDocs.length}, repaired=${repaired}`,
  );

  return {
    target,
    rootContent: rootDoc.content,
    detailedDocs,
  };
}

export async function generateDocs(
  factPack: FactPack,
  targets: Target[],
  provider: LLMProvider,
  providerType: ProviderType = 'anthropic',
  options: GenerateDocsOptions = {},
): Promise<GenerationResult[]> {
  if (targets.length === 0) {
    return [];
  }

  const requestedConcurrency = options.targetConcurrency ?? 1;
  const targetConcurrency = Math.min(
    targets.length,
    Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
      ? Math.floor(requestedConcurrency)
      : 1,
  );

  if (targetConcurrency <= 1) {
    const sequentialResults: GenerationResult[] = [];
    for (const target of targets) {
      sequentialResults.push(
        await generateForTarget(factPack, target, provider, providerType, options),
      );
    }
    return sequentialResults;
  }

  const results: GenerationResult[] = new Array(targets.length);
  let nextIndex = 0;
  let workerError: unknown = null;

  const workers = Array.from({ length: targetConcurrency }, async () => {
    while (true) {
      if (workerError) {
        return;
      }

      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= targets.length) {
        return;
      }

      const target = targets[currentIndex];
      try {
        results[currentIndex] = await generateForTarget(
          factPack,
          target,
          provider,
          providerType,
          options,
        );
      } catch (error) {
        if (!workerError) {
          workerError = error;
        }
        return;
      }
    }
  });

  await Promise.all(workers);
  if (workerError) {
    throw workerError;
  }
  return results;
}
