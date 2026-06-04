import path from 'node:path';
import type { GenerationResult } from '../types/index.js';
import { writeFileSafe } from '../utils/fs.js';

export interface CodexEmitterOptions {
  canonicalDocsDir?: string;
}

export async function emitCodex(
  result: GenerationResult,
  projectRoot: string,
  options: CodexEmitterOptions = {},
): Promise<string[]> {
  const written: string[] = [];
  const canonicalDocsDir = options.canonicalDocsDir ?? '.claude/docs';

  if (result.rootContent.trim().length > 0) {
    const rootPath = path.join(projectRoot, 'AGENTS.md');
    await writeFileSafe(rootPath, result.rootContent);
    written.push(rootPath);
  }

  for (const doc of result.detailedDocs) {
    const docPath = path.join(projectRoot, canonicalDocsDir, doc.filename);
    await writeFileSafe(docPath, doc.content);
    written.push(docPath);
  }

  return written;
}
