import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanProject } from '../../src/core/scanner.js';

describe('scanProject', () => {
  it('scans the current project correctly', async () => {
    const projectRoot = path.resolve(import.meta.dirname, '../..');
    const result = await scanProject(projectRoot);

    expect(result.projectName).toBe('llm-docs');
    expect(result.packageJson).not.toBeNull();
    expect(result.directoryTree).toContain('src');
    expect(result.directoryTree).toContain('package.json');
    expect(result.configFiles.length).toBeGreaterThan(0);
    expect(result.entryPoints).toContain('src/index.ts');
  });

  it('excludes node_modules and dist', async () => {
    const projectRoot = path.resolve(import.meta.dirname, '../..');
    const result = await scanProject(projectRoot);

    expect(result.directoryTree).not.toContain('node_modules');
    expect(result.directoryTree).not.toContain('dist');
  });

  it('applies custom excludeDirs from scan options', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llmdocs-scan-'));

    try {
      await fs.mkdir(path.join(tmpRoot, 'vendor'), { recursive: true });
      await fs.mkdir(path.join(tmpRoot, 'src'), { recursive: true });
      await fs.writeFile(path.join(tmpRoot, 'package.json'), '{"name":"tmp"}');
      await fs.writeFile(path.join(tmpRoot, 'vendor', 'hidden.ts'), 'export {};');
      await fs.writeFile(path.join(tmpRoot, 'src', 'index.ts'), 'export {};');

      const result = await scanProject(tmpRoot, { excludeDirs: ['vendor'] });

      expect(result.directoryTree).toContain('src');
      expect(result.directoryTree).not.toContain('vendor');
      expect(result.directoryTree.some((entry) => entry.startsWith('vendor/'))).toBe(false);
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
