import path from 'node:path';
import { fileExists, normalizeRelativePath, writeJsonAtomic } from '../../utils/fs.js';
import type { WorkspaceBootstrapOperation, WorkspacePaths } from '../types.js';

export interface WorkspaceManifest {
  schemaVersion: 1;
  workspaceRoot: string;
  updatedAt: string;
  generatedBy: {
    tool: 'llm-docs';
    version: string;
  };
  files: Record<
    string,
    {
      kind: WorkspaceBootstrapOperation['kind'];
      ownership?: string;
      lastAction: WorkspaceBootstrapOperation['action'];
      safe: boolean;
      candidatePath?: string;
      updatedAt: string;
    }
  >;
  candidates: Array<{
    targetPath: string;
    candidatePath: string;
    reason: string;
    createdAt: string;
  }>;
}

const PACKAGE_VERSION = '0.1.0';

export function resolveWorkspaceManifestPath(paths: WorkspacePaths): string {
  return path.join(paths.workspaceRoot, 'llm-docs.manifest.json');
}

export async function writeWorkspaceManifest(
  paths: WorkspacePaths,
  operations: WorkspaceBootstrapOperation[],
): Promise<'created' | 'updated'> {
  const manifestPath = resolveWorkspaceManifestPath(paths);
  const timestamp = new Date().toISOString();
  const appliedOperations = operations.filter(
    (operation) => operation.action !== 'skip' && operation.kind !== 'directory',
  );
  const manifest: WorkspaceManifest = {
    schemaVersion: 1,
    workspaceRoot: paths.relative.workspaceRoot,
    updatedAt: timestamp,
    generatedBy: {
      tool: 'llm-docs',
      version: PACKAGE_VERSION,
    },
    files: Object.fromEntries(
      appliedOperations.map((operation) => [
        normalizeRelativePath(operation.path),
        {
          kind: operation.kind,
          ownership: operation.ownership,
          lastAction: operation.action,
          safe: operation.safe,
          candidatePath: operation.candidatePath
            ? normalizeRelativePath(operation.candidatePath)
            : undefined,
          updatedAt: timestamp,
        },
      ]),
    ),
    candidates: appliedOperations
      .filter(
        (operation): operation is WorkspaceBootstrapOperation & { candidatePath: string } =>
          operation.action === 'write-candidate' && !!operation.candidatePath,
      )
      .map((operation) => ({
        targetPath: normalizeRelativePath(operation.path),
        candidatePath: normalizeRelativePath(operation.candidatePath),
        reason: operation.message,
        createdAt: timestamp,
      })),
  };
  const status = (await fileExists(manifestPath)) ? 'updated' : 'created';
  await writeJsonAtomic(manifestPath, manifest);
  return status;
}
