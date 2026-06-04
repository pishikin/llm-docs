import type { Target } from '../types/index.js';

export interface RootDocContract {
  target: Target;
  rootFile: string;
  minNonEmptyLines: number;
  maxNonEmptyLines?: number;
  maxBytes?: number;
  minCommandMentions: number;
  requiredHeadings: string[];
  requiredWarningTopics: string[];
  disallowedPatterns: RegExp[];
  requiresCursorFrontmatter?: boolean;
}

const SHARED_ROOT_HEADINGS = [
  'Overview',
  'Architecture Snapshot',
  'Prerequisites',
  'Key Commands',
  'Task Runbook',
  'Quality Gates',
  'Risky Zones',
  'Critical Warnings',
  'Detailed Docs',
];

const CURSOR_ROOT_HEADINGS = [
  'Overview',
  'Key Commands',
  'Quality Gates',
  'Critical Warnings',
  'Detailed Docs',
];

const SHARED_WARNING_TOPICS = [
  'secrets',
  'generated files',
  'breaking changes',
  'validation before handoff',
];

const SHARED_DISALLOWED_PATTERNS = [
  /\bthread\.started\b/i,
  /\bturn\.started\b/i,
  /\bturn\.completed\b/i,
  /\bitem\.completed\b/i,
  /---RAW OUTPUT START---/i,
  /---RAW OUTPUT END---/i,
  /I(?:'|’)ll\b/i,
  /\bI will\b/i,
];

const ROOT_FILE_BY_TARGET: Record<Target, string> = {
  claude: 'CLAUDE.md',
  codex: 'AGENTS.md',
  cursor: '.cursor/rules/project.mdc',
};

const ROOT_HEADINGS_BY_TARGET: Record<Target, string[]> = {
  claude: SHARED_ROOT_HEADINGS,
  codex: SHARED_ROOT_HEADINGS,
  cursor: CURSOR_ROOT_HEADINGS,
};

const MIN_NON_EMPTY_LINES_BY_TARGET: Record<Target, number> = {
  claude: 34,
  codex: 34,
  cursor: 24,
};

const MAX_NON_EMPTY_LINES_BY_TARGET: Record<Target, number> = {
  claude: 500,
  codex: 500,
  cursor: 500,
};

const MAX_BYTES_BY_TARGET: Partial<Record<Target, number>> = {
  codex: 32 * 1024,
};

const MIN_COMMAND_MENTIONS_BY_TARGET: Record<Target, number> = {
  claude: 3,
  codex: 3,
  cursor: 2,
};

const DETAILED_DOC_FILENAMES_BY_TARGET: Record<Target, string[]> = {
  claude: ['architecture.md', 'commands.md', 'coding-style.md', 'testing.md'],
  codex: ['architecture.md', 'commands.md', 'coding-style.md', 'testing.md'],
  cursor: ['architecture.mdc', 'style.mdc', 'testing.mdc', 'guardrails.mdc'],
};

const DETAILED_DOC_LINKS_BY_TARGET: Record<Target, string[]> = {
  claude: [
    '.claude/docs/architecture.md',
    '.claude/docs/commands.md',
    '.claude/docs/coding-style.md',
    '.claude/docs/testing.md',
  ],
  codex: [
    '.claude/docs/architecture.md',
    '.claude/docs/commands.md',
    '.claude/docs/coding-style.md',
    '.claude/docs/testing.md',
  ],
  cursor: ['architecture.mdc', 'style.mdc', 'testing.mdc', 'guardrails.mdc'],
};

const CURSOR_CANONICAL_LINKS_BY_RULE: Record<string, string[]> = {
  'architecture.mdc': ['.claude/docs/architecture.md'],
  'style.mdc': ['.claude/docs/coding-style.md'],
  'testing.mdc': ['.claude/docs/testing.md'],
  // No dedicated guardrails markdown yet; commands doc is the closest shared operational source.
  'guardrails.mdc': ['.claude/docs/commands.md'],
  'project.mdc': [
    '.claude/docs/architecture.md',
    '.claude/docs/commands.md',
    '.claude/docs/coding-style.md',
    '.claude/docs/testing.md',
  ],
};

function getFileName(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const segments = normalizedPath.split('/');
  return segments[segments.length - 1] ?? filePath;
}

export function getRootFileForTarget(target: Target): string {
  return ROOT_FILE_BY_TARGET[target];
}

export function getRequiredDetailedDocs(target: Target): string[] {
  return DETAILED_DOC_FILENAMES_BY_TARGET[target];
}

export function getRequiredDetailedDocLinks(target: Target): string[] {
  return DETAILED_DOC_LINKS_BY_TARGET[target];
}

export function toDetailedDocLinkPath(target: Target, detailedDocPath: string): string {
  const fileName = getFileName(detailedDocPath);
  if (target === 'cursor') {
    return fileName;
  }
  return `.claude/docs/${fileName}`;
}

export function getCursorCanonicalDocLinks(ruleFilename: string): string[] {
  return CURSOR_CANONICAL_LINKS_BY_RULE[ruleFilename] ?? [];
}

export function getRootDocContract(target: Target): RootDocContract {
  return {
    target,
    rootFile: getRootFileForTarget(target),
    minNonEmptyLines: MIN_NON_EMPTY_LINES_BY_TARGET[target],
    maxNonEmptyLines: MAX_NON_EMPTY_LINES_BY_TARGET[target],
    maxBytes: MAX_BYTES_BY_TARGET[target],
    minCommandMentions: MIN_COMMAND_MENTIONS_BY_TARGET[target],
    requiredHeadings: ROOT_HEADINGS_BY_TARGET[target],
    requiredWarningTopics: SHARED_WARNING_TOPICS,
    disallowedPatterns: SHARED_DISALLOWED_PATTERNS,
    requiresCursorFrontmatter: target === 'cursor',
  };
}
