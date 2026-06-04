import { describe, expect, it } from 'vitest';
import {
  getCursorCanonicalDocLinks,
  getRequiredDetailedDocLinks,
  getRootDocContract,
  toDetailedDocLinkPath,
} from '../../src/core/docs-contract.js';

describe('docs-contract', () => {
  it('requires prerequisites heading in root contract', () => {
    const contract = getRootDocContract('codex');
    expect(contract.requiredHeadings).toContain('Prerequisites');
  });

  it('returns canonical detailed doc links by target', () => {
    expect(getRequiredDetailedDocLinks('codex')).toEqual([
      '.claude/docs/architecture.md',
      '.claude/docs/commands.md',
      '.claude/docs/coding-style.md',
      '.claude/docs/testing.md',
    ]);
    expect(getRequiredDetailedDocLinks('cursor')).toEqual([
      'architecture.mdc',
      'style.mdc',
      'testing.mdc',
      'guardrails.mdc',
    ]);
  });

  it('maps detailed doc filenames to target-specific link paths', () => {
    expect(toDetailedDocLinkPath('codex', 'commands.md')).toBe('.claude/docs/commands.md');
    expect(toDetailedDocLinkPath('cursor', '.cursor/rules/testing.mdc')).toBe('testing.mdc');
  });

  it('returns canonical shared docs for cursor rules', () => {
    expect(getCursorCanonicalDocLinks('architecture.mdc')).toEqual([
      '.claude/docs/architecture.md',
    ]);
    expect(getCursorCanonicalDocLinks('style.mdc')).toEqual(['.claude/docs/coding-style.md']);
    expect(getCursorCanonicalDocLinks('testing.mdc')).toEqual(['.claude/docs/testing.md']);
    expect(getCursorCanonicalDocLinks('guardrails.mdc')).toEqual(['.claude/docs/commands.md']);
  });
});
