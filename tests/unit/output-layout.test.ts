import { describe, expect, it } from 'vitest';
import { buildManagedFilesForTargets, resolveOutputLayout } from '../../src/core/output-layout.js';

describe('output-layout', () => {
  it('resolves default layout when config is missing', () => {
    const layout = resolveOutputLayout();
    expect(layout.canonicalDocsDir).toBe('.claude/docs');
    expect(layout.cursorRulesDir).toBe('.cursor/rules');
  });

  it('normalizes docsDir from config', () => {
    const layout = resolveOutputLayout({ docsDir: './docs/agents/' });
    expect(layout.canonicalDocsDir).toBe('docs/agents');
  });

  it('builds cursor-only managed files without canonical docs by default', () => {
    const layout = resolveOutputLayout();
    const managed = buildManagedFilesForTargets(['cursor'], layout);
    expect(managed).toContain('.cursor/rules/project.mdc');
    expect(managed).toContain('.cursor/rules/architecture.mdc');
    expect(managed).toContain('.cursor/rules/style.mdc');
    expect(managed).toContain('.cursor/rules/testing.mdc');
    expect(managed).toContain('.cursor/rules/guardrails.mdc');
    expect(managed.some((filePath) => filePath.startsWith('.claude/docs/'))).toBe(false);
  });

  it('builds cursor-only managed files with canonical docs when policy is enabled', () => {
    const layout = resolveOutputLayout();
    const managed = buildManagedFilesForTargets(['cursor'], layout, {
      includeCanonicalForCursorOnly: true,
    });
    expect(managed).toContain('.cursor/rules/project.mdc');
    expect(managed).toContain('.claude/docs/architecture.md');
    expect(managed).toContain('.claude/docs/commands.md');
    expect(managed).toContain('.claude/docs/coding-style.md');
    expect(managed).toContain('.claude/docs/testing.md');
  });
});
