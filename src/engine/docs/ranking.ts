import path from 'node:path';
import { normalizeRelativePath } from '../../utils/fs.js';
import type { DiscoveredDoc, RankedDoc } from '../types.js';

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2),
  );
}

function categoryBoost(category: DiscoveredDoc['category']): number {
  if (category === 'rules') return 6;
  if (category === 'canonical') return 5;
  if (category === 'research') return 3;
  return 1;
}

export function rankDocsAgainstTask(
  rawText: string,
  taskTitle: string,
  fileHints: string[],
  docs: DiscoveredDoc[],
): RankedDoc[] {
  const taskTokens = new Set([...tokenize(rawText), ...tokenize(taskTitle)]);
  const hintTokens = new Set(
    fileHints.flatMap((hint) => [
      ...tokenize(normalizeRelativePath(hint)),
      ...tokenize(path.basename(normalizeRelativePath(hint))),
    ]),
  );

  return docs
    .map((doc) => {
      const pathTokens = tokenize(doc.path);
      const titleTokens = tokenize(doc.title ?? '');
      const pathOverlap = [...pathTokens].filter((token) => taskTokens.has(token)).length;
      const fileHintOverlap = [...pathTokens].filter((token) => hintTokens.has(token)).length;
      const titleOverlap = [...titleTokens].filter((token) => taskTokens.has(token)).length;
      const score =
        categoryBoost(doc.category) + pathOverlap * 2 + fileHintOverlap * 2 + titleOverlap;
      const reasons = [
        pathOverlap > 0 ? `path token overlap: ${pathOverlap}` : null,
        fileHintOverlap > 0 ? `file hint overlap: ${fileHintOverlap}` : null,
        titleOverlap > 0 ? `title overlap: ${titleOverlap}` : null,
        `category boost: ${doc.category}`,
      ].filter((value): value is string => value !== null);

      return {
        ...doc,
        score,
        reasons,
      };
    })
    .filter((doc) => doc.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
}
