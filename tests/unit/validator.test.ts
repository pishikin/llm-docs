import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeDocsManifest } from '../../src/core/docs-manifest.js';
import { resolveOutputLayout } from '../../src/core/output-layout.js';
import { validateFile, validateProject } from '../../src/core/validator.js';
import { writeFileSafe } from '../../src/utils/fs.js';

function buildRootDoc(includeTokenWarning: boolean): string {
  const tokenWarning = includeTokenWarning
    ? '- Watch localStorage token handling to avoid auth leaks.'
    : '- Keep auth/session changes reviewed for risk.';
  return `# Root Guide
## Overview
Operational guide for repository work.
Read docs before making changes.

## Architecture Snapshot
Features are split by module boundaries.
Respect routing and service contracts.

## Prerequisites
- Install dependencies with \`npm install\`.
- Confirm environment setup before running commands.

## Key Commands
- npm run build
- npm run test
- npm run lint

## Task Runbook
1. Read docs.
2. Implement change.
3. Validate commands.

## Quality Gates
- Run lint before merge.
- Run typecheck before merge.
- Run tests before handoff.

## Risky Zones
- Auth flow changes can break sessions.
- API/mock gap can hide defects.
- Tooling mismatch can fail local checks.

## Critical Warnings
- Never commit secrets or API keys.
- Do not edit generated files manually.
- Record breaking changes and migrations.
- Run validate/lint/test before handoff.
${tokenWarning}

## Detailed Docs
- .claude/docs/architecture.md
- .claude/docs/commands.md
- .claude/docs/coding-style.md
- .claude/docs/testing.md`;
}

describe('validateFile', () => {
  const scripts = { build: 'tsup', test: 'vitest run', lint: 'biome check .' };

  it('detects missing commands', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-'));
    const filePath = path.join(tmpDir, 'test.md');
    await writeFileSafe(filePath, '```bash\nnpm run nonexistent\n```');

    const issues = await validateFile(filePath, tmpDir, scripts);
    expect(
      issues.some((i) => i.type === 'missing-command' && i.reference.includes('nonexistent')),
    ).toBe(true);
  });

  it('passes valid commands', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-'));
    const filePath = path.join(tmpDir, 'test.md');
    await writeFileSafe(filePath, '```bash\nnpm run build\n```');

    const issues = await validateFile(filePath, tmpDir, scripts);
    const commandIssues = issues.filter((i) => i.type === 'missing-command');
    expect(commandIssues).toHaveLength(0);
  });

  it('detects missing paths', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-'));
    const filePath = path.join(tmpDir, 'test.md');
    await writeFileSafe(filePath, 'See `./nonexistent/path.ts` for details.');

    const issues = await validateFile(filePath, tmpDir, scripts);
    expect(issues.some((i) => i.type === 'missing-path')).toBe(true);
  });
});

describe('validateProject', () => {
  const scripts = { build: 'tsup', test: 'vitest run', lint: 'biome check .' };

  it('ignores non-generated docs under .claude/docs', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-project-'));
    await writeFileSafe(
      path.join(tmpDir, '.claude', 'docs', 'IMPLEMENTATION_PLAN.md'),
      'See `./nonexistent/path.ts` for details.',
    );

    const result = await validateProject(tmpDir, scripts);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('still validates generated docs under .claude/docs', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-project-'));
    await writeFileSafe(
      path.join(tmpDir, '.claude', 'docs', 'architecture.md'),
      'See `./nonexistent/path.ts` for details.',
    );

    const result = await validateProject(tmpDir, scripts);
    expect(result.warnings.some((issue) => issue.type === 'missing-path')).toBe(true);
  });

  it('reports invalid root structure when process-log text is present', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-project-'));
    await writeFileSafe(path.join(tmpDir, 'CLAUDE.md'), 'I’ll now produce the final output.');

    const result = await validateProject(tmpDir, scripts);
    expect(result.errors.some((issue) => issue.type === 'invalid-root-structure')).toBe(true);
  });

  it('reports missing critical warnings section in root docs', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-project-'));
    await writeFileSafe(
      path.join(tmpDir, 'AGENTS.md'),
      `# Guide
## Overview
Short doc without warning section.
## Detailed Docs
- architecture.md`,
    );

    const result = await validateProject(tmpDir, scripts);
    expect(result.warnings.some((issue) => issue.type === 'missing-critical-warning')).toBe(true);
  });

  it('reports target inconsistency when required warning topics differ across roots', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-project-'));
    await writeFileSafe(path.join(tmpDir, 'CLAUDE.md'), buildRootDoc(true));
    await writeFileSafe(
      path.join(tmpDir, 'AGENTS.md'),
      buildRootDoc(false).replace(
        '- Never commit secrets or API keys.',
        '- Keep sensitive data protected.',
      ),
    );

    const result = await validateProject(tmpDir, scripts);
    expect(result.warnings.some((issue) => issue.type === 'target-inconsistency')).toBe(true);
  });

  it('reports root parity drift between CLAUDE.md and AGENTS.md', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-project-'));
    await writeFileSafe(path.join(tmpDir, 'CLAUDE.md'), buildRootDoc(true));
    await writeFileSafe(
      path.join(tmpDir, 'AGENTS.md'),
      buildRootDoc(true).replace(
        'Operational guide for repository work.',
        'Alternate overview text.',
      ),
    );

    const result = await validateProject(tmpDir, scripts);
    expect(result.warnings.some((issue) => issue.reference === 'root-parity')).toBe(true);
  });

  it('marks stale managed files from manifest without deleting them', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-project-'));
    await writeFileSafe(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'demo', scripts }),
    );
    await writeFileSafe(
      path.join(tmpDir, 'llmdocs.config.json'),
      JSON.stringify(
        {
          name: 'demo',
          targets: ['claude'],
          provider: { type: 'codex-cli' },
          excludeDirs: ['node_modules', '.git'],
          docsDir: '.claude/docs',
        },
        null,
        2,
      ),
    );
    await writeFileSafe(path.join(tmpDir, 'CLAUDE.md'), buildRootDoc(true));
    await writeFileSafe(path.join(tmpDir, 'AGENTS.md'), buildRootDoc(true));

    const layout = resolveOutputLayout({ docsDir: '.claude/docs' });
    await writeDocsManifest(tmpDir, {
      targets: ['claude', 'codex'],
      layout,
      managedFiles: ['CLAUDE.md', 'AGENTS.md', '.claude/docs/architecture.md'],
    });

    const result = await validateProject(tmpDir, scripts);
    expect(
      result.warnings.some(
        (issue) =>
          issue.type === 'stale-reference' && issue.reference === 'stale-managed:AGENTS.md',
      ),
    ).toBe(true);
  });
});

describe('validateFile markdown links', () => {
  const scripts = { build: 'tsup', test: 'vitest run', lint: 'biome check .' };

  it('reports missing frontmatter in cursor rule files', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-'));
    const filePath = path.join(tmpDir, '.cursor', 'rules', 'project.mdc');
    await writeFileSafe(filePath, '# Rule without frontmatter');

    const issues = await validateFile(filePath, tmpDir, scripts);
    expect(issues.some((issue) => issue.reference === 'cursor-frontmatter')).toBe(true);
  });

  it('accepts empty globs when project.mdc has alwaysApply=true', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-'));
    const filePath = path.join(tmpDir, '.cursor', 'rules', 'project.mdc');
    await writeFileSafe(
      filePath,
      `---
description: Project-wide rules
globs:
alwaysApply: true
---

## Overview
- Thin adapter.
## Key Commands
- npm run build
## Quality Gates
- Required: npm run build
## Critical Warnings
- Never commit secrets.
- Do not manually edit generated files.
- Document breaking changes.
- Validation before handoff.
## Detailed Docs
- architecture.mdc
- style.mdc
- testing.mdc
- guardrails.mdc`,
    );

    const issues = await validateFile(filePath, tmpDir, scripts);
    expect(issues.some((issue) => issue.reference === 'cursor-frontmatter:alwaysApply+globs')).toBe(
      false,
    );
  });

  it('detects missing markdown link paths', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-'));
    const filePath = path.join(tmpDir, 'test.md');
    await writeFileSafe(filePath, '[Architecture](./missing/architecture.md)');

    const issues = await validateFile(filePath, tmpDir, scripts);
    expect(issues.some((issue) => issue.type === 'missing-path')).toBe(true);
  });

  it('resolves markdown links relative to the current doc file', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-'));
    const docDir = path.join(tmpDir, '.cursor', 'rules');
    const filePath = path.join(docDir, 'project.mdc');
    await writeFileSafe(path.join(docDir, 'architecture.mdc'), '# Architecture');
    await writeFileSafe(
      filePath,
      `---
description: Project-wide rules
globs:
alwaysApply: true
---

[Architecture](architecture.mdc)`,
    );

    const issues = await validateFile(filePath, tmpDir, scripts);
    expect(issues.some((issue) => issue.type === 'missing-path')).toBe(false);
  });

  it('ignores API endpoint references in path validation', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-'));
    const filePath = path.join(tmpDir, 'test.md');
    await writeFileSafe(filePath, 'Endpoint: `/auth/profile`');

    const issues = await validateFile(filePath, tmpDir, scripts);
    expect(issues.some((issue) => issue.reference === '/auth/profile')).toBe(false);
  });

  it('reports missing canonical shared-doc links in cursor adapter rules', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-'));
    const filePath = path.join(tmpDir, '.cursor', 'rules', 'architecture.mdc');
    await writeFileSafe(
      filePath,
      `---
description: Architecture adapter
globs:
alwaysApply: false
---

# Cursor Architecture Adapter
## Cursor Focus
- Keep module boundaries stable.`,
    );

    const issues = await validateFile(filePath, tmpDir, scripts);
    expect(
      issues.some((issue) =>
        issue.reference.startsWith('cursor-adapter:canonical-link:architecture.mdc'),
      ),
    ).toBe(true);
  });

  it('does not report missing-path for cursor canonical refs in cursor-only mode', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-'));
    const filePath = path.join(tmpDir, '.cursor', 'rules', 'style.mdc');
    await writeFileSafe(
      filePath,
      `---
description: Style adapter
globs:
alwaysApply: false
---

## Canonical Source
- [.claude/docs/coding-style.md](.claude/docs/coding-style.md)

## Cursor Focus
- Keep edits minimal.

## Verify
- npm run lint`,
    );

    const issues = await validateFile(filePath, tmpDir, scripts);
    expect(
      issues.some(
        (issue) =>
          issue.type === 'missing-path' && issue.reference === '.claude/docs/coding-style.md',
      ),
    ).toBe(false);
  });

  it('keeps missing-path warning for cursor canonical refs when shared docs exist', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-'));
    await writeFileSafe(path.join(tmpDir, 'CLAUDE.md'), buildRootDoc(true));
    const filePath = path.join(tmpDir, '.cursor', 'rules', 'style.mdc');
    await writeFileSafe(
      filePath,
      `---
description: Style adapter
globs:
alwaysApply: false
---

## Canonical Source
- [.claude/docs/coding-style.md](.claude/docs/coding-style.md)

## Cursor Focus
- Keep edits minimal.

## Verify
- npm run lint`,
    );

    const issues = await validateFile(filePath, tmpDir, scripts);
    expect(
      issues.some(
        (issue) =>
          issue.type === 'missing-path' && issue.reference === '.claude/docs/coding-style.md',
      ),
    ).toBe(true);
  });

  it('reports duplicate frontmatter-like yaml blocks inside cursor rule body', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-'));
    const filePath = path.join(tmpDir, '.cursor', 'rules', 'architecture.mdc');
    await writeFileSafe(
      filePath,
      `---
description: Architecture adapter
globs:
alwaysApply: false
---

# Cursor Architecture Adapter
## Canonical Source
- [.claude/docs/architecture.md](.claude/docs/architecture.md)

\`\`\`yaml
description: duplicate
globs: "**/*"
alwaysApply: true
\`\`\``,
    );

    const issues = await validateFile(filePath, tmpDir, scripts);
    expect(
      issues.some((issue) =>
        issue.reference.startsWith('cursor-frontmatter:body-duplicate:architecture.mdc'),
      ),
    ).toBe(true);
  });

  it('reports unsupported headings in cursor root adapters', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-'));
    const filePath = path.join(tmpDir, '.cursor', 'rules', 'project.mdc');
    await writeFileSafe(
      filePath,
      `---
description: Project-wide rules
globs:
alwaysApply: true
---

## Overview
- Thin adapter intro.
## Architecture Snapshot
- This section should not be in cursor root adapters.
## Key Commands
- npm run build
## Quality Gates
- Required: npm run build
## Critical Warnings
- Never commit secrets.
- Do not edit generated files.
- Document breaking changes.
- Validation before handoff.
## Detailed Docs
- architecture.mdc
- style.mdc
- testing.mdc
- guardrails.mdc`,
    );

    const issues = await validateFile(filePath, tmpDir, scripts);
    expect(
      issues.some((issue) => issue.reference.startsWith('cursor-root:unsupported-heading:')),
    ).toBe(true);
  });

  it('reports oversized cursor adapter rules', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-'));
    const filePath = path.join(tmpDir, '.cursor', 'rules', 'testing.mdc');
    const longBody = Array.from({ length: 175 }, (_, index) => `- line ${index + 1}`).join('\n');
    await writeFileSafe(
      filePath,
      `---
description: Testing adapter
globs:
alwaysApply: false
---

# Cursor Testing Adapter
## Canonical Source
- [.claude/docs/testing.md](.claude/docs/testing.md)

## Cursor Focus
${longBody}`,
    );

    const issues = await validateFile(filePath, tmpDir, scripts);
    expect(issues.some((issue) => issue.reference === 'cursor-rule-size:testing.mdc')).toBe(true);
  });
});

describe('validateProject quality gate consistency', () => {
  const scripts = { build: 'tsup', test: 'vitest run', lint: 'biome check .' };

  it('reports inconsistent quality gate policy across root docs', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-project-'));

    const claudeRoot = buildRootDoc(true).replace(
      '## Quality Gates\n- Run lint before merge.\n- Run typecheck before merge.\n- Run tests before handoff.',
      '## Quality Gates\n- Run lint before merge.\n- Run npm run preview before handoff.',
    );
    const codexRoot = buildRootDoc(true).replace(
      '## Quality Gates\n- Run lint before merge.\n- Run typecheck before merge.\n- Run tests before handoff.',
      '## Quality Gates\n- Run lint before merge.\n- Run npm run preview (optional) when needed.',
    );

    await writeFileSafe(path.join(tmpDir, 'CLAUDE.md'), claudeRoot);
    await writeFileSafe(path.join(tmpDir, 'AGENTS.md'), codexRoot);

    const result = await validateProject(tmpDir, scripts);
    expect(result.warnings.some((issue) => issue.type === 'inconsistent-quality-gate')).toBe(true);
  });
});

describe('validateProject command parity checks', () => {
  const scripts = { build: 'tsup', test: 'vitest run', lint: 'biome check .' };

  it('reports command drift across root docs', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-command-parity-'));
    await writeFileSafe(path.join(tmpDir, 'CLAUDE.md'), buildRootDoc(true));
    await writeFileSafe(
      path.join(tmpDir, 'AGENTS.md'),
      buildRootDoc(true).replace('- npm run lint', '- lint command is documented elsewhere'),
    );

    const result = await validateProject(tmpDir, scripts);
    expect(
      result.warnings.some((issue) => issue.reference.startsWith('command-parity:lint:')),
    ).toBe(true);
  });
});

describe('validateProject factual consistency checks', () => {
  const scripts = { build: 'tsup', lint: 'biome check .' };

  it('reports docs claims that contradict detected project facts', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-facts-'));
    await writeFileSafe(
      path.join(tmpDir, 'package.json'),
      JSON.stringify(
        {
          name: 'facts-test',
          scripts,
          dependencies: {},
          devDependencies: {},
        },
        null,
        2,
      ),
    );

    await writeFileSafe(
      path.join(tmpDir, 'src', 'routes.ts'),
      `export const routes = [{ path: '/' }, { path: '/sign-in' }];`,
    );
    await writeFileSafe(
      path.join(tmpDir, 'src', 'api', 'auth.ts'),
      `export const login = async () => ({ ok: true });
export const getProfile = async () => ({ ok: true });`,
    );
    await writeFileSafe(
      path.join(tmpDir, 'src', 'components', 'login', 'login.tsx'),
      `export function Login() { localStorage.setItem('token', 'x'); return null; }`,
    );
    await writeFileSafe(
      path.join(tmpDir, 'src', 'mocks', 'handlers', 'auth.ts'),
      'export function mockAuth(payload: any) { return payload; }',
    );
    await writeFileSafe(path.join(tmpDir, 'eslint.config.js'), 'export default [{ rules: {} }];');
    await writeFileSafe(
      path.join(tmpDir, 'CLAUDE.md'),
      `# Root Guide
## Overview
Root instructions.
## Architecture Snapshot
- Route /auth/* handles login/register pages.
## Prerequisites
- Install dependencies with \`npm install\`.
## Key Commands
- npm run build
- npm run lint
## Task Runbook
- Registration flow relies on register endpoint.
## Quality Gates
- Run lint before merge.
- Run build before merge.
## Risky Zones
- localStorage token handling is in \`src/api/auth.ts\`.
## Critical Warnings
- Never commit secrets or API keys.
- Do not edit generated files manually.
- Document breaking changes.
- Run lint/test before handoff.
- any type is strictly prohibited.
- auth stack uses json-server.
## Detailed Docs
- .claude/docs/architecture.md
- .claude/docs/commands.md
- .claude/docs/coding-style.md
- .claude/docs/testing.md`,
    );

    const result = await validateProject(tmpDir, scripts);
    const factualIssues = result.warnings.filter((issue) => issue.type === 'target-inconsistency');

    expect(factualIssues.some((issue) => issue.reference === 'register')).toBe(true);
    expect(factualIssues.some((issue) => issue.reference.includes('/auth'))).toBe(true);
    expect(factualIssues.some((issue) => issue.reference === 'json-server')).toBe(true);
    expect(factualIssues.some((issue) => issue.reference === 'any-policy')).toBe(true);
    expect(factualIssues.some((issue) => issue.reference.includes('src/api/auth.ts'))).toBe(true);
  });

  it('reports heavy overlap between cursor adapters and canonical docs', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-overlap-'));
    await writeFileSafe(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'overlap', scripts, dependencies: {}, devDependencies: {} }, null, 2),
    );

    const canonicalArchitecture = `# Architecture
## Boundaries
- Keep command orchestration in command layer.
- Keep provider integrations isolated.
- Keep target shaping isolated from runtime orchestration.
- Re-run quality gates before handoff.
- Update docs when behavior changes.
- Avoid unrelated refactors.
- Keep module boundaries explicit.
- Prefer deterministic tests near changed code.
- Validate lint/typecheck/build before handoff.
- Never bypass guardrails in generated docs.
- Reference only existing project paths.
- Keep quality gate policy consistent.
- Keep warnings actionable and concise.
- Reconcile docs with project facts.
- Maintain canonical docs as source of truth.
- Keep adapters thin and scoped.
- Re-check affected modules before merge.
- Confirm risk signals are represented.
- Prefer minimal-surface changes.
- Document compatibility impact for breaking changes.
- Keep command references executable.
- Ensure detailed docs links remain valid.
- Avoid speculative claims about APIs.
- Keep architecture notes specific to repository.
- Track high-risk areas explicitly.`;

    await writeFileSafe(
      path.join(tmpDir, '.claude', 'docs', 'architecture.md'),
      canonicalArchitecture,
    );
    await writeFileSafe(
      path.join(tmpDir, '.cursor', 'rules', 'architecture.mdc'),
      `---
description: Architecture adapter
globs:
alwaysApply: false
---

## Canonical Source
- [.claude/docs/architecture.md](.claude/docs/architecture.md)

${canonicalArchitecture}`,
    );

    const result = await validateProject(tmpDir, scripts);
    expect(
      result.warnings.some((issue) =>
        issue.reference.startsWith('cross-target-overlap:architecture.mdc->'),
      ),
    ).toBe(true);
  });
});

describe('validateProject rubric score report', () => {
  const scripts = { build: 'tsup', test: 'vitest run', lint: 'biome check .' };

  it('returns rubric score and checklist breakdown', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-score-'));
    await writeFileSafe(
      path.join(tmpDir, '.claude', 'docs', 'commands.md'),
      '```bash\nnpm run nonexistent\n```',
    );

    const result = await validateProject(tmpDir, scripts);

    expect(result.score.overall).toBeGreaterThanOrEqual(0);
    expect(result.score.overall).toBeLessThanOrEqual(10);
    expect(result.score.criteria).toHaveLength(6);
    expect(result.score.checklist.length).toBeGreaterThanOrEqual(8);
    expect(result.score.checklist.some((item) => item.id === 'commands_exist')).toBe(true);
  });

  it('marks commands checklist as fail when missing-command issues exist', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-score-'));
    await writeFileSafe(
      path.join(tmpDir, '.claude', 'docs', 'commands.md'),
      '```bash\nnpm run nonexistent\n```',
    );

    const result = await validateProject(tmpDir, scripts);
    const commandsChecklist = result.score.checklist.find((item) => item.id === 'commands_exist');

    expect(commandsChecklist?.status).toBe('fail');
  });
});
