import path from 'node:path';
import type {
  RelatedTaskSuggestion,
  RelatedTasksQuery,
  TaskMeta,
  TaskRegistryEntry,
  WorkspacePaths,
} from '../types.js';
import { readTaskMeta } from './meta.js';
import { listTasks } from './registry.js';

export function tokenizeForSimilarity(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function inferTopLevelArea(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (parts.length >= 2 && parts[0] === 'src') {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] || null;
}

function overlappingPathPrefixes(left: string[], right: string[]): string[] {
  const matches = new Set<string>();

  for (const leftPath of left) {
    for (const rightPath of right) {
      if (
        leftPath === rightPath ||
        leftPath.startsWith(`${rightPath}/`) ||
        rightPath.startsWith(`${leftPath}/`)
      ) {
        matches.add(leftPath.length <= rightPath.length ? leftPath : rightPath);
      }
    }
  }

  return [...matches];
}

export function scoreTaskSimilarity(
  candidate: { entry: TaskRegistryEntry; meta: TaskMeta },
  query: RelatedTasksQuery,
): RelatedTaskSuggestion {
  const queryTokens = new Set(tokenizeForSimilarity(query.query));
  const candidateTokens = new Set([
    ...tokenizeForSimilarity(candidate.entry.title),
    ...candidate.meta.related.tags.flatMap((tag) => tokenizeForSimilarity(tag)),
  ]);
  const tokenOverlap = [...queryTokens].filter((token) => candidateTokens.has(token));
  const pathOverlap = overlappingPathPrefixes(
    query.paths ?? [],
    candidate.meta.truth.source_of_truth_paths,
  );
  const relatedDocOverlap = [...(query.paths ?? [])].filter((queryPath) =>
    candidate.meta.related.docs.some((docPath) => docPath === queryPath),
  );
  const sharedArea = (query.paths ?? []).some((queryPath) => {
    const queryArea = inferTopLevelArea(queryPath);
    return (
      queryArea !== null &&
      candidate.meta.truth.source_of_truth_paths.some(
        (candidatePath) => inferTopLevelArea(candidatePath) === queryArea,
      )
    );
  });

  let score = pathOverlap.length * 3 + relatedDocOverlap.length * 2 + tokenOverlap.length;
  const reasons = [
    ...pathOverlap.map((match) => `shared path prefix: ${match}`),
    ...relatedDocOverlap.map((match) => `shared related doc: ${match}`),
    ...tokenOverlap.map((match) => `shared token: ${match}`),
  ];

  if (
    query.query.trim() === candidate.entry.taskId ||
    query.query.trim() === candidate.entry.sourceRef
  ) {
    score += 5;
    reasons.push('exact task/source reference match');
  }

  if (sharedArea) {
    score += 1;
    reasons.push('same top-level area');
  }

  if (query.excludeSelfTaskId && query.excludeSelfTaskId === candidate.entry.taskId) {
    score -= 2;
    reasons.push('self-match penalty');
  }

  return {
    taskId: candidate.entry.taskId,
    score,
    reasons,
  };
}

export async function findRelatedTasks(
  paths: WorkspacePaths,
  query: RelatedTasksQuery,
): Promise<RelatedTaskSuggestion[]> {
  const entries = await listTasks(paths, {
    includeArchived: query.includeArchived,
    limit: Number.POSITIVE_INFINITY,
  });
  const suggestions = await Promise.all(
    entries.map(async (entry) => ({
      entry,
      meta: await readTaskMeta(paths, entry.taskId),
    })),
  );

  return suggestions
    .map((candidate) => scoreTaskSimilarity(candidate, query))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      const leftEntry = entries.find((entry) => entry.taskId === left.taskId);
      const rightEntry = entries.find((entry) => entry.taskId === right.taskId);
      return (rightEntry?.updatedAt ?? '').localeCompare(leftEntry?.updatedAt ?? '');
    })
    .slice(0, query.limit ?? 10);
}
