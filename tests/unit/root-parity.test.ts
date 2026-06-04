import { describe, expect, it } from 'vitest';
import {
  deriveCodexResultFromClaudeResult,
  deriveCodexRootFromClaudeRoot,
  getFirstDifferentParityLine,
  rootsMatchUnderParityRules,
} from '../../src/core/root-parity.js';
import type { GenerationResult } from '../../src/types/index.js';

const CLAUDE_ROOT = `# CLAUDE.md — sample

## Overview
Shared overview.

## Detailed Docs
- .claude/docs/architecture.md`;

describe('root-parity', () => {
  it('derives AGENTS root heading from CLAUDE root while preserving body', () => {
    const derived = deriveCodexRootFromClaudeRoot(CLAUDE_ROOT);
    expect(derived).toContain('# AGENTS.md — sample');
    expect(derived).toContain('## Overview');
    expect(derived).toContain('Shared overview.');
  });

  it('derives codex generation result from claude generation result', () => {
    const claudeResult: GenerationResult = {
      target: 'claude',
      rootContent: CLAUDE_ROOT,
      detailedDocs: [{ filename: 'architecture.md', content: '# Architecture' }],
    };

    const derived = deriveCodexResultFromClaudeResult(claudeResult);
    expect(derived.target).toBe('codex');
    expect(derived.rootContent).toContain('# AGENTS.md — sample');
    expect(derived.detailedDocs).toHaveLength(0);
  });

  it('treats roots as matching when codex root equals derived claude root', () => {
    const codexRoot = `# AGENTS.md — sample

## Overview
Shared overview.

## Detailed Docs
- .claude/docs/architecture.md`;

    expect(rootsMatchUnderParityRules(CLAUDE_ROOT, codexRoot)).toBe(true);
    expect(getFirstDifferentParityLine(CLAUDE_ROOT, codexRoot)).toBeNull();
  });

  it('reports the first differing line for parity mismatches', () => {
    const mismatchedCodexRoot = `# AGENTS.md — sample

## Overview
Different overview.

## Detailed Docs
- .claude/docs/architecture.md`;

    expect(rootsMatchUnderParityRules(CLAUDE_ROOT, mismatchedCodexRoot)).toBe(false);
    expect(getFirstDifferentParityLine(CLAUDE_ROOT, mismatchedCodexRoot)).toBe(4);
  });
});
