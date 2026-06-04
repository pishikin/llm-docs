import path from 'node:path';
import type { GenerationResult } from '../types/index.js';
import { writeFileSafe } from '../utils/fs.js';

export interface CursorEmitterOptions {
  cursorRulesDir?: string;
}

export async function emitCursor(
  result: GenerationResult,
  projectRoot: string,
  options: CursorEmitterOptions = {},
): Promise<string[]> {
  const written: string[] = [];
  const cursorRulesDir = options.cursorRulesDir ?? '.cursor/rules';

  if (result.rootContent.trim().length > 0) {
    const rootPath = path.join(projectRoot, cursorRulesDir, 'project.mdc');
    await writeFileSafe(rootPath, result.rootContent);
    written.push(rootPath);
  }

  for (const doc of result.detailedDocs) {
    const docPath = path.join(projectRoot, cursorRulesDir, doc.filename);
    await writeFileSafe(docPath, doc.content);
    written.push(docPath);
  }

  return written;
}
