import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { generateDocs, parseGenerationOutput } from '../../src/core/generator.js';
import type { FactPack, LLMProvider, Target } from '../../src/types/index.js';

const FACT_PACK_FIXTURE: FactPack = {
  projectName: 'test-project',
  language: 'typescript',
  packageManager: 'npm',
  scripts: { build: 'tsup', test: 'vitest run' },
  dependencies: [],
  devDependencies: [],
  directoryTree: ['src/index.ts', 'package.json'],
  detectedTools: {
    linter: 'biome',
    formatter: 'biome',
    bundler: 'tsup',
    testRunner: 'vitest',
    typeChecker: 'typescript',
  },
  entryPoints: ['src/index.ts'],
  configFiles: ['package.json', 'tsconfig.json'],
  hasTests: true,
  testFramework: 'vitest',
  hasCI: false,
  ciPlatform: null,
  riskSignals: {
    tokenStorageLocalStorage: false,
    apiMockCoverageGaps: [],
    toolingDependencyGaps: [],
    strictTypeScriptFlags: [],
    notes: [],
  },
  projectFacts: {
    routePaths: [],
    authApiFunctions: [],
    authApiEndpoints: [],
    mockAuthEndpoints: [],
    tokenStorageWriteFiles: [],
    anyTypeUsageFiles: [],
    hasJsonServerDependency: false,
    jsonServerScriptNames: [],
    eslintNoExplicitAnyRuleConfigured: false,
  },
};

function buildValidRoot(target: Target): string {
  const docs =
    target === 'cursor'
      ? ['architecture.mdc', 'style.mdc', 'testing.mdc', 'guardrails.mdc']
      : [
          '.claude/docs/architecture.md',
          '.claude/docs/commands.md',
          '.claude/docs/coding-style.md',
          '.claude/docs/testing.md',
        ];

  return `# ${target.toUpperCase()} Guide
## Overview
This document provides operational instructions for working in this repository.
Use it as the first source of truth before making changes.

## Architecture Snapshot
The app is layered by feature modules and shared utilities.
Runtime flow starts at entry points and routes through service boundaries.
Keep module boundaries explicit when changing behavior.

## Prerequisites
- Install dependencies with \`npm install\`.
- Confirm environment configuration before running commands.

## Key Commands
| Command | Purpose | When to run |
| --- | --- | --- |
| \`npm run build\` | Build bundle | before release |
| \`npm run test\` | Run tests | before merge |

## Task Runbook
1. Read architecture and coding style docs first.
2. Implement changes in small, testable increments.
3. Validate behavior with project commands.
4. Record assumptions and risks in PR notes.

## Quality Gates
- Run \`npm run build\` after structural changes.
- Run \`npm run test\` before handoff.
- Validate diffs against expected project behavior.

## Risky Zones
- Auth/session changes are sensitive and can break flows.
- API/mock gap can cause false confidence in local checks.
- Tooling mismatch may require prerequisites before linting.

## Critical Warnings
- Do not commit secrets or API keys.
- Do not manually edit generated files.
- Document breaking changes and compatibility impact.
- Always run validation before handoff.

## Detailed Docs
- ${docs[0]}
- ${docs[1]}
- ${docs[2]}
- ${docs[3]}`;
}

describe('parseGenerationOutput', () => {
  it('parses multi-file output', () => {
    const raw = `---FILE: CLAUDE.md---
# Project
Some content
---FILE: .claude/docs/architecture.md---
# Architecture
Details here`;

    const files = parseGenerationOutput(raw);
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe('CLAUDE.md');
    expect(files[0].content).toContain('# Project');
    expect(files[1].path).toBe('.claude/docs/architecture.md');
  });

  it('handles empty input', () => {
    expect(parseGenerationOutput('')).toHaveLength(0);
  });

  it('removes generator artifact markers from parsed content', () => {
    const raw = `---FILE: CLAUDE.md---
# Project
<!-- source: package.json:scripts -->
Main content
<!-- detectedTools: linter=biome -->
detectedTools: linter=biome`;

    const files = parseGenerationOutput(raw);
    expect(files).toHaveLength(1);
    expect(files[0].content).toContain('# Project');
    expect(files[0].content).toContain('Main content');
    expect(files[0].content).not.toContain('source:');
    expect(files[0].content).not.toContain('detectedTools');
  });

  it('throws when provider output is missing root file marker', async () => {
    const provider: LLMProvider = {
      generate: vi
        .fn()
        .mockResolvedValue('---FILE: .claude/docs/architecture.md---\n# Architecture'),
    };

    await expect(
      generateDocs(FACT_PACK_FIXTURE, ['claude'], provider, 'anthropic'),
    ).rejects.toThrow('missing root file marker');
  });

  it('includes found paths in missing root marker error', async () => {
    const provider: LLMProvider = {
      generate: vi
        .fn()
        .mockResolvedValue('---FILE: .claude/docs/architecture.md---\n# Architecture'),
    };

    await expect(generateDocs(FACT_PACK_FIXTURE, ['codex'], provider, 'codex-cli')).rejects.toThrow(
      'Found paths: .claude/docs/architecture.md',
    );
  });

  it('passes empty system prompt to codex provider after adaptation', async () => {
    const provider: LLMProvider = {
      generate: vi.fn().mockResolvedValue(`---FILE: AGENTS.md---\n${buildValidRoot('codex')}`),
    };

    await generateDocs(FACT_PACK_FIXTURE, ['codex'], provider, 'codex-cli');

    const calls = vi.mocked(provider.generate).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe('');
  });

  it('includes target name in provider failure message', async () => {
    const provider: LLMProvider = {
      generate: vi.fn().mockRejectedValue(new Error('upstream failed')),
    };

    await expect(generateDocs(FACT_PACK_FIXTURE, ['codex'], provider, 'codex-cli')).rejects.toThrow(
      'target "codex"',
    );
  });

  it('retries once with format repair and succeeds when root file appears', async () => {
    const provider: LLMProvider = {
      generate: vi
        .fn()
        .mockResolvedValueOnce('Generated docs without markers')
        .mockResolvedValueOnce(`---FILE: AGENTS.md---\n${buildValidRoot('codex')}`),
    };

    const result = await generateDocs(FACT_PACK_FIXTURE, ['codex'], provider, 'codex-cli');

    expect(result).toHaveLength(1);
    expect(result[0].rootContent).toContain('## Overview');
    expect(vi.mocked(provider.generate)).toHaveBeenCalledTimes(2);
  });

  it('repairs low-quality root content with local fallback', async () => {
    const provider: LLMProvider = {
      generate: vi.fn().mockResolvedValueOnce('---FILE: AGENTS.md---\nI’ll now summarize quickly'),
    };

    const result = await generateDocs(FACT_PACK_FIXTURE, ['codex'], provider, 'codex-cli');

    expect(result).toHaveLength(1);
    expect(result[0].rootContent).toContain('## Task Runbook');
    expect(result[0].rootContent).toContain('## Risky Zones');
    expect(vi.mocked(provider.generate)).toHaveBeenCalledTimes(1);
  });

  it('falls back to deterministic root when generated root is low quality', async () => {
    const provider: LLMProvider = {
      generate: vi.fn().mockResolvedValue('---FILE: AGENTS.md---\nI will output short notes'),
    };

    const result = await generateDocs(FACT_PACK_FIXTURE, ['codex'], provider, 'codex-cli');
    expect(result).toHaveLength(1);
    expect(result[0].rootContent).toContain('## Critical Warnings');
  });

  it('keeps generation successful when only advisory root issues remain', async () => {
    const provider: LLMProvider = {
      generate: vi.fn().mockResolvedValue(`---FILE: AGENTS.md---\n${buildValidRoot('codex')}`),
    };
    const factPackWithSignals: FactPack = {
      ...FACT_PACK_FIXTURE,
      riskSignals: {
        tokenStorageLocalStorage: false,
        apiMockCoverageGaps: ['/auth/profile'],
        toolingDependencyGaps: ['eslint-plugin-react'],
        strictTypeScriptFlags: [],
        notes: [],
      },
    };

    const result = await generateDocs(factPackWithSignals, ['codex'], provider, 'codex-cli');
    expect(result).toHaveLength(1);
    expect(result[0].rootContent).toContain('## Critical Warnings');
  });

  it('truncates directory tree in prompt when it exceeds configured limit', async () => {
    const previousLimit = process.env.LLMDOCS_MAX_TREE_ENTRIES;
    process.env.LLMDOCS_MAX_TREE_ENTRIES = '20';

    try {
      const provider: LLMProvider = {
        generate: vi.fn().mockResolvedValue(`---FILE: AGENTS.md---\n${buildValidRoot('codex')}`),
      };
      const oversizedFactPack: FactPack = {
        ...FACT_PACK_FIXTURE,
        configFiles: ['package.json', 'tsconfig.json'],
        entryPoints: ['src/index.ts'],
        directoryTree: [
          'package.json',
          'tsconfig.json',
          'src',
          ...Array.from({ length: 40 }, (_, i) => `src/module-${i}.ts`),
        ],
      };

      await generateDocs(oversizedFactPack, ['codex'], provider, 'codex-cli');

      const prompt = vi.mocked(provider.generate).mock.calls[0][0];
      expect(prompt).toContain('Directory tree is truncated for performance: 20/43 entries.');
      expect(prompt).toContain('src/module-0.ts');
      expect(prompt).not.toContain('src/module-39.ts');
    } finally {
      if (previousLimit === undefined) {
        process.env.LLMDOCS_MAX_TREE_ENTRIES = undefined;
      } else {
        process.env.LLMDOCS_MAX_TREE_ENTRIES = previousLimit;
      }
    }
  });

  it('supports root-only generation mode for selected targets', async () => {
    const provider: LLMProvider = {
      generate: vi
        .fn()
        .mockResolvedValue(
          `---FILE: AGENTS.md---\n${buildValidRoot('codex')}\n\n---FILE: .claude/docs/commands.md---\n# Commands`,
        ),
    };

    const result = await generateDocs(FACT_PACK_FIXTURE, ['codex'], provider, 'codex-cli', {
      rootOnlyTargets: ['codex'],
    });

    expect(result).toHaveLength(1);
    expect(result[0].detailedDocs).toHaveLength(0);
    const prompt = vi.mocked(provider.generate).mock.calls[0][0];
    expect(prompt).toContain('Do NOT emit any detailed docs file blocks in this run.');
  });

  it('supports parallel target generation via targetConcurrency', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const provider: LLMProvider = {
      generate: vi.fn().mockImplementation(async (prompt: string) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;

        if (prompt.includes('Root file: CLAUDE.md')) {
          return `---FILE: CLAUDE.md---\n${buildValidRoot('claude')}`;
        }
        return `---FILE: AGENTS.md---\n${buildValidRoot('codex')}`;
      }),
    };

    const results = await generateDocs(
      FACT_PACK_FIXTURE,
      ['claude', 'codex'],
      provider,
      'anthropic',
      { targetConcurrency: 2 },
    );

    expect(results).toHaveLength(2);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('uses local fallback when root marker is missing and format repair is disabled', async () => {
    const provider: LLMProvider = {
      generate: vi.fn().mockResolvedValue('model returned plain text without markers'),
    };

    const result = await generateDocs(FACT_PACK_FIXTURE, ['codex'], provider, 'codex-cli', {
      enableFormatRepair: false,
      enableQualityRepair: false,
    });

    expect(result).toHaveLength(1);
    expect(result[0].rootContent).toContain('## Overview');
    expect(result[0].rootContent).toContain('## Critical Warnings');
  });

  it('uses local fallback for cursor-agent when root marker is still missing after format repair', async () => {
    const provider: LLMProvider = {
      generate: vi
        .fn()
        .mockResolvedValueOnce('model returned plain text without markers')
        .mockResolvedValueOnce('still no file markers after repair'),
    };

    const result = await generateDocs(FACT_PACK_FIXTURE, ['cursor'], provider, 'cursor-agent', {
      enableFormatRepair: true,
      enableQualityRepair: true,
    });

    expect(result).toHaveLength(1);
    expect(result[0].rootContent).toContain('## Overview');
    expect(result[0].rootContent).toContain('## Detailed Docs');
    expect(result[0].detailedDocs).toHaveLength(4);
    expect(result[0].detailedDocs.map((doc) => doc.filename).sort()).toEqual([
      'architecture.mdc',
      'guardrails.mdc',
      'style.mdc',
      'testing.mdc',
    ]);
    const architectureDoc = result[0].detailedDocs.find(
      (doc) => doc.filename === 'architecture.mdc',
    );
    expect(architectureDoc?.content).not.toContain('src/commands');
    expect(architectureDoc?.content).not.toContain('src/core');
    expect(
      result[0].detailedDocs.every((doc) => doc.content.toLowerCase().includes('.claude/docs/')),
    ).toBe(true);
    expect(vi.mocked(provider.generate)).toHaveBeenCalledTimes(2);
  });

  it('uses local fallback when provider fails in fast mode', async () => {
    const provider: LLMProvider = {
      generate: vi.fn().mockRejectedValue(new Error('Codex CLI timed out after 120s')),
    };

    const result = await generateDocs(FACT_PACK_FIXTURE, ['cursor'], provider, 'codex-cli', {
      enableFormatRepair: false,
      enableQualityRepair: false,
      allowProviderFailureFallback: true,
    });

    expect(result).toHaveLength(1);
    expect(result[0].rootContent).toContain('## Overview');
    expect(result[0].rootContent).toContain('## Detailed Docs');
  });

  it('adds cursor frontmatter to generated .mdc files when missing', async () => {
    const provider: LLMProvider = {
      generate: vi
        .fn()
        .mockResolvedValue(
          `---FILE: .cursor/rules/project.mdc---\n${buildValidRoot('cursor')}\n\n---FILE: architecture.mdc---\n# Architecture`,
        ),
    };

    const result = await generateDocs(FACT_PACK_FIXTURE, ['cursor'], provider, 'codex-cli');

    expect(result).toHaveLength(1);
    expect(result[0].rootContent.startsWith('---')).toBe(true);
    expect(result[0].rootContent).toContain('alwaysApply: true');
    expect(result[0].detailedDocs[0]?.content.startsWith('---')).toBe(true);
  });

  it('normalizes cursor root frontmatter when model returns invalid alwaysApply+globs', async () => {
    const provider: LLMProvider = {
      generate: vi.fn().mockResolvedValue(`---FILE: .cursor/rules/project.mdc---
---
description: Invalid root
globs: "**/*"
alwaysApply: true
---

${buildValidRoot('cursor')}`),
    };

    const result = await generateDocs(FACT_PACK_FIXTURE, ['cursor'], provider, 'cursor-agent');

    expect(result).toHaveLength(1);
    expect(result[0].rootContent).toContain('alwaysApply: true');
    expect(result[0].rootContent).toContain('globs: []');
    expect(result[0].rootContent).not.toContain('globs: "**/*"');
  });

  it('normalizes verbose cursor root docs into a thin adapter structure', async () => {
    const provider: LLMProvider = {
      generate: vi.fn().mockResolvedValue(`---FILE: .cursor/rules/project.mdc---
---
description: Project-wide Cursor rules
globs:
alwaysApply: true
---

# Cursor Rules
## Overview
- Overview.
## Architecture Snapshot
- Full architecture narrative duplicated from canonical docs.
## Prerequisites
- Install dependencies.
## Key Commands
- npm run build
## Task Runbook
1. Do many steps.
## Quality Gates
- Required: npm run build
## Risky Zones
- Extensive risk details.
## Critical Warnings
- Secrets warning.
## Detailed Docs
- architecture.mdc`),
    };

    const result = await generateDocs(FACT_PACK_FIXTURE, ['cursor'], provider, 'cursor-agent');
    const root = result[0].rootContent;

    expect(root).toContain('## Overview');
    expect(root).toContain('## Key Commands');
    expect(root).toContain('## Quality Gates');
    expect(root).toContain('## Critical Warnings');
    expect(root).toContain('## Detailed Docs');
    expect(root).not.toContain('## Architecture Snapshot');
    expect(root).not.toContain('## Prerequisites');
    expect(root).not.toContain('## Task Runbook');
    expect(root).not.toContain('## Risky Zones');
  });

  it('removes duplicate frontmatter-like yaml blocks from cursor adapters', async () => {
    const provider: LLMProvider = {
      generate: vi.fn().mockResolvedValue(`---FILE: .cursor/rules/project.mdc---
${buildValidRoot('cursor')}

---FILE: architecture.mdc---
---
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
\`\`\`

## Cursor Focus
- Keep module boundaries explicit.`),
    };

    const result = await generateDocs(FACT_PACK_FIXTURE, ['cursor'], provider, 'cursor-agent');
    const architectureDoc = result[0].detailedDocs.find(
      (doc) => doc.filename === 'architecture.mdc',
    );

    expect(architectureDoc).toBeDefined();
    expect(architectureDoc?.content).not.toContain('```yaml');
    expect(architectureDoc?.content).toContain('## Cursor Focus');
  });

  it('replaces verbose cursor adapters with thin fallback adapters when sections are unsupported', async () => {
    const provider: LLMProvider = {
      generate: vi.fn().mockResolvedValue(`---FILE: .cursor/rules/project.mdc---
${buildValidRoot('cursor')}

---FILE: style.mdc---
---
description: Style adapter
globs:
alwaysApply: false
---

# Style Rules
## Canonical Source
- [.claude/docs/coding-style.md](.claude/docs/coding-style.md)
## TypeScript Conventions
- Prefer explicit types.
## Naming Conventions
- Use PascalCase for components.`),
    };

    const result = await generateDocs(FACT_PACK_FIXTURE, ['cursor'], provider, 'cursor-agent');
    const styleDoc = result[0].detailedDocs.find((doc) => doc.filename === 'style.mdc');

    expect(styleDoc).toBeDefined();
    expect(styleDoc?.content).toContain('# Cursor Style Adapter');
    expect(styleDoc?.content).toContain('## Cursor Focus');
    expect(styleDoc?.content).not.toContain('## TypeScript Conventions');
  });

  it('applies local path grounding for missing file references when projectRoot is provided', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'llmdocs-path-grounding-'));
    try {
      await fs.mkdir(path.join(tmpDir, 'src', 'mocks', 'browser'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'src', 'mocks', 'browser', 'worker.ts'), 'export {};');

      const provider: LLMProvider = {
        generate: vi.fn().mockResolvedValue(`---FILE: .cursor/rules/project.mdc---
${buildValidRoot('cursor')}

---FILE: testing.mdc---
---
description: Testing adapter
globs:
alwaysApply: false
---

# Cursor Testing Adapter
## Canonical Source
- [.claude/docs/testing.md](.claude/docs/testing.md)

## Cursor Focus
- MSW setup file: \`src/mocks/browser/index.ts\`.`),
      };

      const result = await generateDocs(FACT_PACK_FIXTURE, ['cursor'], provider, 'cursor-agent', {
        projectRoot: tmpDir,
      });
      const testingDoc = result[0].detailedDocs.find((doc) => doc.filename === 'testing.mdc');

      expect(testingDoc).toBeDefined();
      expect(testingDoc?.content).toContain('src/mocks/browser/worker.ts');
      expect(testingDoc?.content).not.toContain('src/mocks/browser/index.ts');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('uses reduced prompt fact pack scope for cursor target', async () => {
    const provider: LLMProvider = {
      generate: vi.fn().mockResolvedValue(`---FILE: .cursor/rules/project.mdc---
${buildValidRoot('cursor')}`),
    };
    const oversizedFactPack: FactPack = {
      ...FACT_PACK_FIXTURE,
      directoryTree: [
        'package.json',
        'src',
        ...Array.from({ length: 180 }, (_, index) => `src/module-${index}.ts`),
      ],
      dependencies: Array.from({ length: 40 }, (_, index) => `dep-${index}`),
      devDependencies: Array.from({ length: 35 }, (_, index) => `devdep-${index}`),
    };

    await generateDocs(oversizedFactPack, ['cursor'], provider, 'cursor-agent');

    const prompt = vi.mocked(provider.generate).mock.calls[0][0];
    expect(prompt).toContain('src/module-0.ts');
    expect(prompt).not.toContain('src/module-179.ts');
    expect(prompt).not.toContain('devdep-34');
  });
});

it('normalizes codex detailed doc links to canonical paths', async () => {
  const provider: LLMProvider = {
    generate: vi
      .fn()
      .mockResolvedValue(
        `---FILE: AGENTS.md---\n${buildValidRoot('codex').replace(/\.claude\/docs\//g, 'claude/docs/')}`,
      ),
  };

  const result = await generateDocs(FACT_PACK_FIXTURE, ['codex'], provider, 'codex-cli');

  expect(result).toHaveLength(1);
  expect(result[0].rootContent).toContain('.claude/docs/architecture.md');
  expect(result[0].rootContent).not.toContain('- claude/docs/architecture.md');
});

it('canonicalizes shared detailed docs and fills missing required files', async () => {
  const provider: LLMProvider = {
    generate: vi.fn().mockResolvedValue(`---FILE: AGENTS.md---
${buildValidRoot('codex')}

---FILE: .claude/docs/architectands.md---
# Architecture Notes
## Runtime
- Keep boundaries explicit.`),
  };

  const result = await generateDocs(FACT_PACK_FIXTURE, ['codex'], provider, 'codex-cli');

  expect(result).toHaveLength(1);
  expect(result[0].detailedDocs.map((doc) => doc.filename)).toEqual([
    'architecture.md',
    'commands.md',
    'coding-style.md',
    'testing.md',
  ]);
});

it('sanitizes unsupported factual claims from generated docs', async () => {
  const provider: LLMProvider = {
    generate: vi.fn().mockResolvedValue(`---FILE: CLAUDE.md---
${buildValidRoot('claude')}

---FILE: .claude/docs/architecture.md---
# Architecture
## Runtime Overview
- Auth route: /auth/login
- Runtime mocks use json-server.
- Token storage path: src/api/auth.ts`),
  };

  const factPackWithTokenPath: FactPack = {
    ...FACT_PACK_FIXTURE,
    projectFacts: {
      ...FACT_PACK_FIXTURE.projectFacts,
      tokenStorageWriteFiles: ['src/components/login/login.tsx'],
      routePaths: [],
      jsonServerScriptNames: [],
      hasJsonServerDependency: false,
    },
  };

  const result = await generateDocs(factPackWithTokenPath, ['claude'], provider, 'anthropic');
  const architectureDoc = result[0].detailedDocs.find((doc) => doc.filename === 'architecture.md');

  expect(result[0].rootContent).not.toContain('/auth');
  expect(result[0].rootContent).not.toContain('json-server');
  expect(result[0].rootContent).not.toContain('src/api/auth.ts');

  expect(architectureDoc?.content).not.toContain('/auth');
  expect(architectureDoc?.content).not.toContain('json-server');
  expect(architectureDoc?.content).not.toContain('src/api/auth.ts');
  expect(architectureDoc?.content).toContain('src/components/login/login.tsx');
});

it('replaces cursor adapters when they link to unmapped canonical docs', async () => {
  const provider: LLMProvider = {
    generate: vi.fn().mockResolvedValue(`---FILE: .cursor/rules/project.mdc---
${buildValidRoot('cursor')}

---FILE: architecture.mdc---
---
description: Architecture adapter
globs:
alwaysApply: false
---

# Cursor Architecture Adapter
## Canonical Source
- [../../.claude/docs/system-boundaries.md](../../.claude/docs/system-boundaries.md)
- [.claude/docs/architecture.md](.claude/docs/architecture.md)

## Cursor Focus
- Keep module boundaries explicit.`),
  };

  const result = await generateDocs(FACT_PACK_FIXTURE, ['cursor'], provider, 'cursor-agent');
  const architectureDoc = result[0].detailedDocs.find((doc) => doc.filename === 'architecture.mdc');

  expect(architectureDoc?.content).toContain('.claude/docs/architecture.md');
  expect(architectureDoc?.content).not.toContain('system-boundaries.md');
});
