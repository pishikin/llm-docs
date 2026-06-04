import fs from 'node:fs/promises';
import path from 'node:path';
import type { ValidationIssue, ValidationResult } from '../types/index.js';
import { fileExists, readFileSafe, writeFileSafe } from '../utils/fs.js';
import { getCursorCanonicalDocLinks, getRequiredDetailedDocs } from './docs-contract.js';

const ROOT_DOC_PATHS = ['CLAUDE.md', 'AGENTS.md', '.cursor/rules/project.mdc'] as const;
const ROOT_SECTION_NAMES = [
  'Overview',
  'Architecture Snapshot',
  'Prerequisites',
  'Key Commands',
  'Task Runbook',
  'Quality Gates',
  'Risky Zones',
  'Critical Warnings',
  'Detailed Docs',
] as const;
const AUDIT_PREFIX = 'llmdocs-audit';
const DEFAULT_AUDIT_BASE_DIR = path.join('.claude', 'docs', 'archieve', 'tmp', 'audit');
const DOC_COMMAND_PATTERN = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([A-Za-z0-9:_-]+)\b/g;
const DOC_COMMAND_IGNORE = new Set(['install', 'i', 'init', 'create', 'exec', 'dlx', 'add']);
const HEADING_PATTERN = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/;
const CURSOR_OVERLAP_RULES = ['architecture.mdc', 'style.mdc', 'testing.mdc', 'guardrails.mdc'];

interface DocSnapshot {
  path: string;
  content: string;
}

interface DocCommandOccurrence {
  docPath: string;
  line: number;
  command: string;
  scriptName: string;
}

export interface DocsAuditBundleResult {
  directory: string;
  files: string[];
}

export interface CreateDocsAuditBundleOptions {
  projectRoot: string;
  scripts: Record<string, string>;
  validation: ValidationResult;
  strict: boolean;
  auditDir?: string;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatTimestampForPath(date: Date): string {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(
    date.getHours(),
  )}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.split(/\r?\n/).length;
}

function getSectionContent(content: string, heading: string): string | null {
  const match = new RegExp(`^#{1,6}\\s*${heading}\\s*:?\\s*$`, 'im').exec(content);
  if (!match || match.index === undefined) return null;
  const fromHeading = content.slice(match.index + match[0].length);
  const nextHeadingIndex = fromHeading.search(/\n#{1,6}\s+/);
  if (nextHeadingIndex < 0) return fromHeading.trim();
  return fromHeading.slice(0, nextHeadingIndex).trim();
}

function renderValidationText(result: ValidationResult, strict: boolean): string {
  const lines: string[] = [];
  const strictErrorCount = strict
    ? result.errors.length + result.warnings.length
    : result.errors.length;
  lines.push('Validating documentation...');
  lines.push('');
  for (const issue of result.errors) {
    lines.push(
      `ERROR ${toPosix(issue.file)}:${issue.line} — ${issue.message} (${issue.reference}) [${issue.type}]`,
    );
  }
  for (const issue of result.warnings) {
    lines.push(
      `WARN  ${toPosix(issue.file)}:${issue.line} — ${issue.message} (${issue.reference}) [${issue.type}]`,
    );
  }
  lines.push('');
  lines.push(`strict=${strict ? 'true' : 'false'}`);
  lines.push(`errors=${result.errors.length}`);
  lines.push(`warnings=${result.warnings.length}`);
  lines.push(`errorCount=${strictErrorCount}`);
  lines.push(`score=${result.score.overall}/10 (${result.score.band})`);
  return lines.join('\n');
}

function buildIssueByTypeReport(issues: ValidationIssue[]): string {
  if (issues.length === 0) {
    return 'No issues found.';
  }

  const byType = new Map<string, ValidationIssue[]>();
  for (const issue of issues) {
    const bucket = byType.get(issue.type) ?? [];
    bucket.push(issue);
    byType.set(issue.type, bucket);
  }

  const lines: string[] = [];
  for (const [type, bucket] of Array.from(byType.entries()).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    lines.push(`## ${type} (${bucket.length})`);
    for (const issue of bucket) {
      lines.push(`- ${toPosix(issue.file)}:${issue.line} — ${issue.message} (${issue.reference})`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function extractHeadings(content: string): Array<{ line: number; depth: number; title: string }> {
  const lines = content.split(/\r?\n/);
  const headings: Array<{ line: number; depth: number; title: string }> = [];
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index]?.match(HEADING_PATTERN);
    if (!match) continue;
    headings.push({
      line: index + 1,
      depth: match[1].length,
      title: match[2].trim(),
    });
  }
  return headings;
}

function hashSectionContent(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function normalizeLineForOverlap(value: string): string {
  return value
    .replace(/\[[^\]]+\]\(([^)]+)\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[-*]\s+/, '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function stripFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/);
  if (!match) return normalized;
  return normalized.slice(match[0].length);
}

function buildComparableLineSet(content: string): Set<string> {
  const body = stripFrontmatter(content);
  const lines = body
    .split('\n')
    .map(normalizeLineForOverlap)
    .filter((line) => line.length >= 14);
  return new Set(lines);
}

function extractDocCommands(docPath: string, content: string): DocCommandOccurrence[] {
  const occurrences: DocCommandOccurrence[] = [];
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    DOC_COMMAND_PATTERN.lastIndex = 0;
    let match = DOC_COMMAND_PATTERN.exec(line);
    while (match) {
      const scriptName = (match[1] ?? '').trim();
      if (scriptName && !DOC_COMMAND_IGNORE.has(scriptName)) {
        const command = match[0].trim().replace(/\s+/g, ' ');
        occurrences.push({
          docPath,
          line: index + 1,
          command,
          scriptName,
        });
      }
      match = DOC_COMMAND_PATTERN.exec(line);
    }
  }

  return occurrences;
}

async function listDocsInDirectory(
  projectRoot: string,
  relativeDir: string,
  extension: '.md' | '.mdc',
): Promise<string[]> {
  const dirPath = path.join(projectRoot, relativeDir);
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
      .map((entry) => toPosix(path.join(relativeDir, entry.name)))
      .sort();
  } catch {
    return [];
  }
}

function getExpectedDocPaths(): string[] {
  const expected = new Set<string>();
  for (const root of ROOT_DOC_PATHS) {
    expected.add(root);
  }
  for (const filename of getRequiredDetailedDocs('claude')) {
    expected.add(toPosix(path.join('.claude', 'docs', filename)));
  }
  for (const filename of getRequiredDetailedDocs('cursor')) {
    expected.add(toPosix(path.join('.cursor', 'rules', filename)));
  }
  return Array.from(expected).sort();
}

async function getAuditDocPaths(projectRoot: string): Promise<string[]> {
  const expected = getExpectedDocPaths();
  const discovered = new Set<string>(expected);

  const claudeDocs = await listDocsInDirectory(
    projectRoot,
    toPosix(path.join('.claude', 'docs')),
    '.md',
  );
  const cursorDocs = await listDocsInDirectory(
    projectRoot,
    toPosix(path.join('.cursor', 'rules')),
    '.mdc',
  );
  for (const relativePath of [...claudeDocs, ...cursorDocs]) {
    discovered.add(relativePath);
  }

  return Array.from(discovered).sort();
}

async function collectDocSnapshots(
  projectRoot: string,
  docPaths: string[],
): Promise<DocSnapshot[]> {
  const snapshots: DocSnapshot[] = [];
  for (const relativePath of docPaths) {
    const fullPath = path.join(projectRoot, relativePath);
    const content = await readFileSafe(fullPath);
    if (content === null) continue;
    snapshots.push({
      path: relativePath,
      content,
    });
  }
  return snapshots;
}

function resolveAuditBaseDir(projectRoot: string, customAuditDir?: string): string {
  if (!customAuditDir || customAuditDir.trim().length === 0) {
    return path.join(projectRoot, DEFAULT_AUDIT_BASE_DIR);
  }
  if (path.isAbsolute(customAuditDir)) {
    return customAuditDir;
  }
  return path.resolve(projectRoot, customAuditDir);
}

async function resolveUniqueBundleDir(baseDir: string, timestamp: string): Promise<string> {
  const baseName = `${AUDIT_PREFIX}-${timestamp}`;
  const preferred = path.join(baseDir, baseName);
  if (!(await fileExists(preferred))) {
    return preferred;
  }

  for (let suffix = 1; suffix <= 999; suffix++) {
    const candidate = path.join(baseDir, `${baseName}-${suffix}`);
    if (!(await fileExists(candidate))) {
      return candidate;
    }
  }
  return path.join(baseDir, `${baseName}-${Date.now()}`);
}

function buildFilesCheckReport(docPaths: string[], snapshots: DocSnapshot[]): string {
  const byPath = new Map<string, DocSnapshot>();
  for (const snapshot of snapshots) {
    byPath.set(snapshot.path, snapshot);
  }

  const lines = ['status\tpath\tlines\tbytes'];
  for (const relativePath of docPaths) {
    const snapshot = byPath.get(relativePath);
    if (!snapshot) {
      lines.push(`missing\t${relativePath}\t0\t0`);
      continue;
    }
    lines.push(
      `exists\t${relativePath}\t${countLines(snapshot.content)}\t${Buffer.byteLength(
        snapshot.content,
        'utf8',
      )}`,
    );
  }
  return lines.join('\n');
}

function buildLineCountReport(snapshots: DocSnapshot[]): string {
  const rows = snapshots
    .map((snapshot) => ({
      path: snapshot.path,
      lines: countLines(snapshot.content),
      bytes: Buffer.byteLength(snapshot.content, 'utf8'),
    }))
    .sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));

  const lines = ['path\tlines\tbytes'];
  for (const row of rows) {
    lines.push(`${row.path}\t${row.lines}\t${row.bytes}`);
  }
  return lines.join('\n');
}

function buildHeadingReport(snapshots: DocSnapshot[]): string {
  const lines: string[] = [];
  const sorted = [...snapshots].sort((a, b) => a.path.localeCompare(b.path));
  for (const snapshot of sorted) {
    lines.push(`=== ${snapshot.path} ===`);
    const headings = extractHeadings(snapshot.content);
    if (headings.length === 0) {
      lines.push('(no headings)');
      lines.push('');
      continue;
    }
    for (const heading of headings) {
      lines.push(`${heading.line}\t${'#'.repeat(heading.depth)} ${heading.title}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function buildKeySectionsReport(snapshots: DocSnapshot[]): string {
  const rootSnapshotMap = new Map<string, DocSnapshot>(
    snapshots
      .filter((snapshot) =>
        ROOT_DOC_PATHS.includes(snapshot.path as (typeof ROOT_DOC_PATHS)[number]),
      )
      .map((snapshot) => [snapshot.path, snapshot]),
  );
  const lines: string[] = [];
  for (const rootPath of ROOT_DOC_PATHS) {
    lines.push(`=== ${rootPath} ===`);
    const snapshot = rootSnapshotMap.get(rootPath);
    if (!snapshot) {
      lines.push('(missing)');
      lines.push('');
      continue;
    }

    for (const sectionName of ROOT_SECTION_NAMES) {
      lines.push(`## ${sectionName}`);
      const sectionContent = getSectionContent(snapshot.content, sectionName);
      if (!sectionContent) {
        lines.push('(missing)');
      } else {
        lines.push(sectionContent);
      }
      lines.push('');
    }
  }
  return lines.join('\n').trimEnd();
}

function buildSectionHashesReport(snapshots: DocSnapshot[]): string {
  const lines: string[] = ['path\tsection\thash\tchars'];
  const sorted = [...snapshots].sort((a, b) => a.path.localeCompare(b.path));

  for (const snapshot of sorted) {
    const headings = extractHeadings(snapshot.content);
    if (headings.length === 0) {
      const normalized = stripFrontmatter(snapshot.content).trim();
      lines.push(
        `${snapshot.path}\t(full-document)\t${hashSectionContent(normalized)}\t${normalized.length}`,
      );
      continue;
    }

    for (const heading of headings) {
      const sectionContent = getSectionContent(snapshot.content, heading.title) ?? '';
      const normalized = sectionContent.trim();
      lines.push(
        `${snapshot.path}\t${heading.title}\t${hashSectionContent(normalized)}\t${normalized.length}`,
      );
    }
  }

  return lines.join('\n');
}

function buildCrossTargetOverlapReport(snapshots: DocSnapshot[], projectRoot: string): string {
  const byPath = new Map<string, DocSnapshot>(
    snapshots.map((snapshot) => [snapshot.path, snapshot]),
  );
  const lines: string[] = ['cursor_rule\tcanonical_doc\toverlap_ratio\tshared_lines\tcursor_lines'];

  for (const ruleFilename of CURSOR_OVERLAP_RULES) {
    const rulePath = toPosix(path.join('.cursor', 'rules', ruleFilename));
    const ruleSnapshot = byPath.get(rulePath);
    if (!ruleSnapshot) continue;

    const ruleLineSet = buildComparableLineSet(ruleSnapshot.content);
    if (ruleLineSet.size === 0) continue;

    const canonicalLinks = getCursorCanonicalDocLinks(ruleFilename);
    if (canonicalLinks.length === 0) continue;

    for (const canonicalLink of canonicalLinks) {
      const canonicalPath = toPosix(canonicalLink);
      const canonicalSnapshot = byPath.get(canonicalPath);
      if (!canonicalSnapshot) continue;

      const canonicalLineSet = buildComparableLineSet(canonicalSnapshot.content);
      if (canonicalLineSet.size === 0) continue;

      let shared = 0;
      for (const line of ruleLineSet) {
        if (canonicalLineSet.has(line)) {
          shared += 1;
        }
      }

      const ratio = shared / ruleLineSet.size;
      lines.push(
        `${toPosix(path.join(projectRoot, rulePath))}\t${toPosix(
          path.join(projectRoot, canonicalPath),
        )}\t${ratio.toFixed(3)}\t${shared}\t${ruleLineSet.size}`,
      );
    }
  }

  if (lines.length === 1) {
    lines.push('(no comparable cursor/canonical pairs found)');
  }
  return lines.join('\n');
}

function buildScriptsCommandReport(scripts: Record<string, string>): string {
  const scriptEntries = Object.entries(scripts).sort(([a], [b]) => a.localeCompare(b));
  const lines = ['script\tinvoke\tcommand'];
  for (const [name, command] of scriptEntries) {
    lines.push(`${name}\tnpm run ${name}\t${command}`);
  }
  return lines.join('\n');
}

function buildDocCommandReport(
  occurrences: DocCommandOccurrence[],
  scripts: Record<string, string>,
): string {
  if (occurrences.length === 0) {
    return 'docPath\tline\tcommand\tscript\tinPackageScripts\n(no command mentions found)';
  }
  const lines = ['docPath\tline\tcommand\tscript\tinPackageScripts'];
  const sorted = [...occurrences].sort((a, b) => {
    if (a.docPath !== b.docPath) return a.docPath.localeCompare(b.docPath);
    if (a.line !== b.line) return a.line - b.line;
    return a.command.localeCompare(b.command);
  });
  for (const item of sorted) {
    lines.push(
      `${item.docPath}\t${item.line}\t${item.command}\t${item.scriptName}\t${
        scripts[item.scriptName] ? 'yes' : 'no'
      }`,
    );
  }
  return lines.join('\n');
}

function buildCommandDiffReports(
  occurrences: DocCommandOccurrence[],
  scripts: Record<string, string>,
): {
  onlyInDocs: string;
  missingInDocs: string;
} {
  const mentionedScripts = new Set(occurrences.map((item) => item.scriptName));
  const availableScripts = Object.keys(scripts);

  const onlyInDocs = Array.from(mentionedScripts)
    .filter((script) => !scripts[script])
    .sort();
  const missingInDocs = availableScripts.filter((script) => !mentionedScripts.has(script)).sort();

  return {
    onlyInDocs:
      onlyInDocs.length > 0 ? onlyInDocs.join('\n') : '(all documented commands map to scripts)',
    missingInDocs:
      missingInDocs.length > 0 ? missingInDocs.join('\n') : '(all scripts are mentioned in docs)',
  };
}

function buildAuditReadme(params: {
  createdAt: Date;
  strict: boolean;
  projectRoot: string;
  validation: ValidationResult;
  docPaths: string[];
  snapshots: DocSnapshot[];
}): string {
  const strictErrorCount = params.strict
    ? params.validation.errors.length + params.validation.warnings.length
    : params.validation.errors.length;
  return `# llm-docs Audit Bundle

Generated at: ${params.createdAt.toISOString()}
Project root: ${params.projectRoot}
Strict mode: ${params.strict ? 'on' : 'off'}

## Validation Summary
- Errors: ${params.validation.errors.length}
- Warnings: ${params.validation.warnings.length}
- Strict error count: ${strictErrorCount}
- Score: ${params.validation.score.overall}/10 (${params.validation.score.band})

## Coverage Summary
- Expected+discovered doc paths tracked: ${params.docPaths.length}
- Existing doc files captured: ${params.snapshots.length}

## Key Files
- validate.json: raw validation result with strict/errorCount.
- validate.strict.txt: human-readable validation report.
- files.check.txt: expected/discovered doc file presence and size.
- line-counts.txt: line/byte counts for existing docs.
- headings.txt: heading inventory by file.
- key-sections.txt: extracted root sections for comparison.
- section-hashes.txt: stable hashes per section to detect semantic drift.
- scripts.commands.txt: package scripts inventory.
- docs.commands.txt: command mentions found in docs.
- commands.only-in-docs.txt: commands referenced in docs but missing in scripts.
- commands.missing-in-docs.txt: scripts not mentioned in docs.
- issues.by-type.txt: validation issues grouped by type.
- cross-target-overlap.txt: overlap ratios between cursor adapters and canonical shared docs.
- docs/: snapshot copies of all captured documentation files.`;
}

export async function createDocsAuditBundle(
  options: CreateDocsAuditBundleOptions,
): Promise<DocsAuditBundleResult> {
  const createdAt = new Date();
  const timestamp = formatTimestampForPath(createdAt);
  const baseDir = resolveAuditBaseDir(options.projectRoot, options.auditDir);
  const bundleDir = await resolveUniqueBundleDir(baseDir, timestamp);
  const strictErrorCount = options.strict
    ? options.validation.errors.length + options.validation.warnings.length
    : options.validation.errors.length;

  const docPaths = await getAuditDocPaths(options.projectRoot);
  const snapshots = await collectDocSnapshots(options.projectRoot, docPaths);
  const docCommands = snapshots.flatMap((snapshot) =>
    extractDocCommands(snapshot.path, snapshot.content),
  );
  const commandDiff = buildCommandDiffReports(docCommands, options.scripts);
  const issuesByTypeReport = buildIssueByTypeReport([
    ...options.validation.errors,
    ...options.validation.warnings,
  ]);

  const metadata = {
    generatedAt: createdAt.toISOString(),
    projectRoot: options.projectRoot,
    strict: options.strict,
    strictErrorCount,
    scriptsCount: Object.keys(options.scripts).length,
    trackedDocPaths: docPaths.length,
    capturedDocFiles: snapshots.length,
    validation: {
      valid: options.validation.valid,
      errors: options.validation.errors.length,
      warnings: options.validation.warnings.length,
      score: options.validation.score,
    },
  };

  const writtenFiles: string[] = [];
  const addWrittenFile = async (relativePath: string, content: string): Promise<void> => {
    const fullPath = path.join(bundleDir, relativePath);
    await writeFileSafe(fullPath, content);
    writtenFiles.push(fullPath);
  };

  await addWrittenFile(
    'README.md',
    buildAuditReadme({
      createdAt,
      strict: options.strict,
      projectRoot: options.projectRoot,
      validation: options.validation,
      docPaths,
      snapshots,
    }),
  );
  await addWrittenFile('metadata.json', JSON.stringify(metadata, null, 2));
  await addWrittenFile(
    'validate.json',
    JSON.stringify(
      {
        ...options.validation,
        strict: options.strict,
        errorCount: strictErrorCount,
      },
      null,
      2,
    ),
  );
  await addWrittenFile(
    'validate.strict.txt',
    renderValidationText(options.validation, options.strict),
  );
  await addWrittenFile('files.check.txt', buildFilesCheckReport(docPaths, snapshots));
  await addWrittenFile('line-counts.txt', buildLineCountReport(snapshots));
  await addWrittenFile('headings.txt', buildHeadingReport(snapshots));
  await addWrittenFile('key-sections.txt', buildKeySectionsReport(snapshots));
  await addWrittenFile('section-hashes.txt', buildSectionHashesReport(snapshots));
  await addWrittenFile('scripts.commands.txt', buildScriptsCommandReport(options.scripts));
  await addWrittenFile('docs.commands.txt', buildDocCommandReport(docCommands, options.scripts));
  await addWrittenFile('commands.only-in-docs.txt', commandDiff.onlyInDocs);
  await addWrittenFile('commands.missing-in-docs.txt', commandDiff.missingInDocs);
  await addWrittenFile('issues.by-type.txt', issuesByTypeReport);
  await addWrittenFile(
    'cross-target-overlap.txt',
    buildCrossTargetOverlapReport(snapshots, options.projectRoot),
  );

  for (const snapshot of snapshots) {
    const relativeSnapshotPath = path.join('docs', snapshot.path);
    await addWrittenFile(relativeSnapshotPath, snapshot.content);
  }

  return {
    directory: bundleDir,
    files: writtenFiles.sort(),
  };
}
