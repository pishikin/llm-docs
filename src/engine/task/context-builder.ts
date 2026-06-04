import {
  findArchiveDocs,
  findCanonicalDocs,
  findResearchDocs,
  findRuleDocs,
} from '../docs/discovery.js';
import { rankDocsAgainstTask } from '../docs/ranking.js';
import { buildGitFacts } from '../git/status.js';
import type { GitFacts, LlmDocsConfig, RankedDoc, WorkspacePaths } from '../types.js';

export async function collectRelevantCanonicalDocs(
  projectRoot: string,
  paths: WorkspacePaths,
  rawText: string,
  taskTitle: string,
  fileHints: string[] = [],
): Promise<RankedDoc[]> {
  const [canonicalDocs, ruleDocs, researchDocs, archiveDocs] = await Promise.all([
    findCanonicalDocs(projectRoot, paths),
    findRuleDocs(projectRoot, paths),
    findResearchDocs(projectRoot, paths),
    findArchiveDocs(projectRoot, paths),
  ]);

  return rankDocsAgainstTask(rawText, taskTitle, fileHints, [
    ...canonicalDocs,
    ...ruleDocs,
    ...researchDocs,
    ...archiveDocs,
  ]);
}

export function collectSuggestedReadFirst(
  taskId: string,
  _rawText: string,
  gitFacts: GitFacts,
  rankedDocs: RankedDoc[] = [],
): string[] {
  return [
    'task.md',
    'context.md',
    ...gitFacts.changedFiles.slice(0, 5),
    ...rankedDocs.slice(0, 5).map((doc) => doc.path),
    taskId,
  ].filter((value, index, array) => value && array.indexOf(value) === index);
}

export async function buildInitialContextFacts(
  projectRoot: string,
  config: LlmDocsConfig,
  paths: WorkspacePaths,
  options: {
    taskId: string;
    rawText: string;
    title: string;
    fileHints?: string[];
  },
): Promise<{
  gitFacts: GitFacts;
  rankedDocs: RankedDoc[];
  readFirst: string[];
}> {
  const gitFacts = await buildGitFacts(projectRoot, { config });
  const rankedDocs = await collectRelevantCanonicalDocs(
    projectRoot,
    paths,
    options.rawText,
    options.title,
    options.fileHints ?? [],
  );

  return {
    gitFacts,
    rankedDocs,
    readFirst: collectSuggestedReadFirst(options.taskId, options.rawText, gitFacts, rankedDocs),
  };
}
