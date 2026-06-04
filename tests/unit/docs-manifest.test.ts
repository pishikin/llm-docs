import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildManagedFilesManifest,
  readDocsManifest,
  resolveDocsManifestPath,
  writeDocsManifest,
} from '../../src/core/docs-manifest.js';
import { resolveOutputLayout } from '../../src/core/output-layout.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llmdocs-manifest-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

describe('docs-manifest', () => {
  it('writes and reads manifest payload', async () => {
    const tmpDir = await makeTempDir();
    const layout = resolveOutputLayout();

    await writeDocsManifest(tmpDir, {
      targets: ['cursor'],
      layout,
      managedFiles: buildManagedFilesManifest(['cursor'], layout, {
        includeCanonicalForCursorOnly: true,
      }),
    });

    const parsed = await readDocsManifest(tmpDir);
    expect(parsed).not.toBeNull();
    expect(parsed?.schemaVersion).toBe(1);
    expect(parsed?.targets).toEqual(['cursor']);
    expect(parsed?.managedFiles).toContain('.cursor/rules/project.mdc');
    expect(parsed?.managedFiles).toContain('.claude/docs/architecture.md');
  });

  it('stores manifest under project root', async () => {
    const tmpDir = await makeTempDir();
    const manifestPath = resolveDocsManifestPath(tmpDir);
    expect(manifestPath.replace(/\\/g, '/')).toMatch(/llmdocs\.manifest\.json$/);
  });
});
