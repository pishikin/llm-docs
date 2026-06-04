import { describe, expect, it } from 'vitest';
import { evaluateRootDocQuality } from '../../src/core/docs-quality.js';
import type { FactPackRiskSignals } from '../../src/types/index.js';

const BASE_SIGNALS: FactPackRiskSignals = {
  tokenStorageLocalStorage: false,
  apiMockCoverageGaps: [],
  toolingDependencyGaps: [],
  strictTypeScriptFlags: [],
  notes: [],
};

function buildRootContent(extraWarnings = ''): string {
  return `# Root Guide
## Overview
Operational guide for contributors.
Use it before coding.

## Architecture Snapshot
Runtime starts at entrypoint and flows through modules.
Keep boundary contracts explicit and stable.

## Prerequisites
- Install dependencies with \`npm install\`.
- Confirm environment configuration before running commands.

## Key Commands
- npm run build
- npm run test
- npm run lint

## Task Runbook
1. Read docs.
2. Make focused changes.
3. Run quality gates.
4. Verify risky zones.

## Quality Gates
- Run lint before handoff.
- Run typecheck before handoff.
- Run tests before handoff.

## Risky Zones
- Auth/session behavior can regress quickly.
- API/mock gap can hide production failures.
- Tooling mismatch may fail local lint.
- TypeScript strict gates can block builds.

## Critical Warnings
- Do not commit secrets or API keys.
- Do not edit generated files manually.
- Document breaking changes and migration notes.
- Validate with lint/typecheck/test before handoff.
${extraWarnings}

## Detailed Docs
- .claude/docs/architecture.md
- .claude/docs/commands.md
- .claude/docs/coding-style.md
- .claude/docs/testing.md`;
}

describe('evaluateRootDocQuality', () => {
  it('passes a valid root document', () => {
    const issues = evaluateRootDocQuality({
      target: 'codex',
      rootContent: buildRootContent(),
      scripts: { build: 'tsup', test: 'vitest run', lint: 'biome check .' },
      generatedDetailedDocs: ['architecture.md', 'commands.md', 'coding-style.md', 'testing.md'],
      riskSignals: BASE_SIGNALS,
    });

    expect(issues).toHaveLength(0);
  });

  it('flags process-log style artifacts', () => {
    const issues = evaluateRootDocQuality({
      target: 'claude',
      rootContent: `${buildRootContent()}\n\nI’ll now summarize my reasoning.`,
      scripts: { build: 'tsup', test: 'vitest run' },
      generatedDetailedDocs: ['architecture.md', 'commands.md', 'coding-style.md', 'testing.md'],
      riskSignals: BASE_SIGNALS,
    });

    expect(issues.some((issue) => issue.code === 'disallowed-pattern')).toBe(true);
  });

  it('requires token warning when token localStorage signal is present', () => {
    const issues = evaluateRootDocQuality({
      target: 'codex',
      rootContent: buildRootContent(),
      scripts: { build: 'tsup', test: 'vitest run', lint: 'biome check .' },
      generatedDetailedDocs: ['architecture.md', 'commands.md', 'coding-style.md', 'testing.md'],
      riskSignals: {
        ...BASE_SIGNALS,
        tokenStorageLocalStorage: true,
      },
    });

    expect(issues.some((issue) => issue.code === 'missing-risk-signal')).toBe(true);
  });
});

it('requires install command inside prerequisites section', () => {
  const issues = evaluateRootDocQuality({
    target: 'codex',
    rootContent: buildRootContent().replace(
      '- Install dependencies with `npm install`.',
      '- Confirm dependencies are available.',
    ),
    scripts: { build: 'tsup', test: 'vitest run', lint: 'biome check .' },
    generatedDetailedDocs: ['architecture.md', 'commands.md', 'coding-style.md', 'testing.md'],
    riskSignals: BASE_SIGNALS,
  });

  expect(issues.some((issue) => issue.code === 'missing-prerequisite-step')).toBe(true);
});
