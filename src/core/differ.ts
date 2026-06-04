import path from 'node:path';
import { simpleGit } from 'simple-git';
import type { DiffAnalysis } from '../types/index.js';

type Category = 'config' | 'source' | 'tests' | 'ci' | 'deps';

const SECTION_MAP: Record<Category, string[]> = {
  config: ['architecture.md', 'commands.md'],
  source: ['architecture.md', 'coding-style.md'],
  tests: ['testing.md'],
  ci: ['commands.md'],
  deps: ['architecture.md'],
};

function classifyFile(filePath: string): Category {
  const base = path.basename(filePath);
  if (base.includes('lock') || base === 'package.json') return 'deps';
  if (filePath.includes('.github/') || filePath.includes('.gitlab')) return 'ci';
  if (filePath.includes('test') || filePath.includes('spec')) return 'tests';
  if (
    base.endsWith('.json') ||
    base.endsWith('.yaml') ||
    base.endsWith('.yml') ||
    base.endsWith('.toml') ||
    base.startsWith('.')
  )
    return 'config';
  return 'source';
}

export async function analyzeDiff(rootDir: string, fromRef = 'HEAD~1'): Promise<DiffAnalysis> {
  const git = simpleGit(rootDir);
  const diff = await git.diffSummary([fromRef]);
  const changedFiles = diff.files.map((f: { file: string }) => f.file);

  if (changedFiles.length === 0) {
    return { changedFiles: [], impactedSections: [], summary: 'No changes detected.' };
  }

  const categories = new Set<Category>();
  for (const file of changedFiles) {
    categories.add(classifyFile(file));
  }

  const impactedSections = [...new Set([...categories].flatMap((c) => SECTION_MAP[c]))];

  const summary = `Changed ${changedFiles.length} files: ${[...categories].join(', ')} areas affected.`;

  return { changedFiles, impactedSections, summary };
}
