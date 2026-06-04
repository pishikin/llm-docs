import type { GenerationResult } from '../types/index.js';

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

function normalizeForParity(content: string): string {
  return normalizeLineEndings(content)
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

function replaceRootHeadingFilename(
  content: string,
  nextRootFilename: 'CLAUDE.md' | 'AGENTS.md',
): string {
  const lines = normalizeLineEndings(content).split('\n');
  const firstNonEmptyIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstNonEmptyIndex < 0) return content.trim();

  const heading = lines[firstNonEmptyIndex];
  lines[firstNonEmptyIndex] = heading
    .replace(/^(\s*#\s*)(CLAUDE\.md|AGENTS\.md)\b/i, `$1${nextRootFilename}`)
    .replace(/^(\s*#\s*)AGENTS\.md\b/i, `$1${nextRootFilename}`)
    .replace(/^(\s*#\s*)CLAUDE\.md\b/i, `$1${nextRootFilename}`);

  return lines.join('\n').trim();
}

export function deriveCodexRootFromClaudeRoot(claudeRootContent: string): string {
  return replaceRootHeadingFilename(claudeRootContent, 'AGENTS.md');
}

export function deriveCodexResultFromClaudeResult(
  claudeResult: GenerationResult,
): GenerationResult {
  return {
    target: 'codex',
    rootContent: deriveCodexRootFromClaudeRoot(claudeResult.rootContent),
    detailedDocs: [],
  };
}

export function rootsMatchUnderParityRules(
  claudeRootContent: string,
  codexRootContent: string,
): boolean {
  const expectedCodexRoot = normalizeForParity(deriveCodexRootFromClaudeRoot(claudeRootContent));
  const actualCodexRoot = normalizeForParity(codexRootContent);
  return expectedCodexRoot === actualCodexRoot;
}

export function getFirstDifferentParityLine(
  claudeRootContent: string,
  codexRootContent: string,
): number | null {
  const expectedLines = normalizeForParity(deriveCodexRootFromClaudeRoot(claudeRootContent)).split(
    '\n',
  );
  const actualLines = normalizeForParity(codexRootContent).split('\n');
  const maxLength = Math.max(expectedLines.length, actualLines.length);

  for (let i = 0; i < maxLength; i++) {
    if ((expectedLines[i] ?? '') !== (actualLines[i] ?? '')) {
      return i + 1;
    }
  }

  return null;
}
