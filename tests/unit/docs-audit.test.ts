import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDocsAuditBundle } from '../../src/core/docs-audit.js';
import type { ValidationResult } from '../../src/types/index.js';
import { readFileSafe, writeFileSafe } from '../../src/utils/fs.js';

const SCORE_FIXTURE: ValidationResult['score'] = {
  overall: 7.8,
  band: 'good',
  criteria: [
    { key: 'accuracy', label: 'Accuracy', weight: 25, score: 7.1 },
    { key: 'actionability', label: 'Actionability', weight: 20, score: 8.4 },
    { key: 'crossTargetConsistency', label: 'Cross-target consistency', weight: 15, score: 7.9 },
    { key: 'safetyCoverage', label: 'Safety coverage', weight: 15, score: 7.5 },
    { key: 'maintainability', label: 'Maintainability', weight: 15, score: 8.1 },
    { key: 'driftResistance', label: 'Drift resistance', weight: 10, score: 7.2 },
  ],
  checklist: [
    {
      id: 'commands_exist',
      label: 'All documented commands exist in package scripts',
      status: 'pass',
      details: 'Based on missing-command validation issues.',
    },
  ],
};

function buildValidationFixture(projectRoot: string): ValidationResult {
  return {
    valid: false,
    errors: [
      {
        file: path.join(projectRoot, '.cursor', 'rules', 'project.mdc'),
        line: 1,
        type: 'invalid-root-structure',
        message: 'Cursor rule with alwaysApply=true must keep globs empty.',
        reference: 'cursor-frontmatter:alwaysApply+globs',
      },
    ],
    warnings: [
      {
        file: path.join(projectRoot, '.claude', 'docs', 'architecture.md'),
        line: 4,
        type: 'missing-path',
        message: 'Path "src/core" does not exist',
        reference: 'src/core',
      },
    ],
    score: SCORE_FIXTURE,
  };
}

async function seedDocs(projectRoot: string): Promise<void> {
  await writeFileSafe(
    path.join(projectRoot, 'CLAUDE.md'),
    `# CLAUDE.md
## Overview
Guide.

## Key Commands
- \`npm run build\`
- \`npm run test\`

## Quality Gates
- Run \`npm run test\` before handoff.

## Critical Warnings
- Never commit secrets.

## Detailed Docs
- .claude/docs/architecture.md`,
  );

  await writeFileSafe(
    path.join(projectRoot, 'AGENTS.md'),
    `# AGENTS.md
## Overview
Guide mirror.

## Key Commands
- \`npm run build\`

## Quality Gates
- Run \`npm run build\`.

## Critical Warnings
- Never commit secrets.

## Detailed Docs
- .claude/docs/architecture.md`,
  );

  await writeFileSafe(
    path.join(projectRoot, '.cursor', 'rules', 'project.mdc'),
    `---
description: Project-wide Cursor rules
globs:
alwaysApply: true
---

# project.mdc
## Overview
Rules.`,
  );

  await writeFileSafe(
    path.join(projectRoot, '.claude', 'docs', 'architecture.md'),
    '# Architecture\nSee `src/core`.',
  );
}

describe('createDocsAuditBundle', () => {
  it('creates extended audit files and doc snapshots', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'docs-audit-'));
    await seedDocs(projectRoot);

    const audit = await createDocsAuditBundle({
      projectRoot,
      scripts: {
        build: 'tsup',
        test: 'vitest run',
        lint: 'biome check .',
      },
      validation: buildValidationFixture(projectRoot),
      strict: true,
    });

    expect(audit.directory).toContain(
      toPosix(path.join(projectRoot, '.claude', 'docs', 'archieve', 'tmp', 'audit')),
    );
    expect(audit.files.length).toBeGreaterThan(8);

    const validateJson = await readFileSafe(path.join(audit.directory, 'validate.json'));
    expect(validateJson).not.toBeNull();
    const parsed = JSON.parse(validateJson ?? '{}') as { strict: boolean; errorCount: number };
    expect(parsed.strict).toBe(true);
    expect(parsed.errorCount).toBe(2);

    const missingCommands = await readFileSafe(
      path.join(audit.directory, 'commands.missing-in-docs.txt'),
    );
    expect(missingCommands).toContain('lint');

    const sectionHashes = await readFileSafe(path.join(audit.directory, 'section-hashes.txt'));
    expect(sectionHashes).toContain('path\tsection\thash\tchars');

    const overlap = await readFileSafe(path.join(audit.directory, 'cross-target-overlap.txt'));
    expect(overlap).toContain('cursor_rule\tcanonical_doc\toverlap_ratio');

    const snapshot = await readFileSafe(
      path.join(audit.directory, 'docs', '.claude', 'docs', 'architecture.md'),
    );
    expect(snapshot).toContain('# Architecture');
  });

  it('uses custom audit directory when provided', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'docs-audit-custom-'));
    await seedDocs(projectRoot);

    const audit = await createDocsAuditBundle({
      projectRoot,
      scripts: { build: 'tsup' },
      validation: buildValidationFixture(projectRoot),
      strict: false,
      auditDir: 'tmp/custom-audit',
    });

    expect(toPosix(audit.directory)).toContain('/tmp/custom-audit/llmdocs-audit-');
  });
});

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}
