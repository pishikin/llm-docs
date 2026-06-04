import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, fileExists, readFileSafe, writeTextAtomic } from '../../utils/fs.js';
import { ensureExecutable } from '../hosts/shared.js';
import type { WorkspaceBootstrapOperation } from '../types.js';

export type GitHookOwnership =
  | 'absent'
  | 'llm-docs-managed-block'
  | 'legacy-llm-docs-hook'
  | 'user-owned'
  | 'binary-or-unsafe';

export interface GitHookSpec {
  hookName: string;
  command: string;
}

export interface GitHookInstallOperation extends WorkspaceBootstrapOperation {
  kind: 'git-hook';
  ownership: GitHookOwnership;
}

const BLOCK_START_PREFIX = '# llm-docs:start';
const BLOCK_END = '# llm-docs:end';

function renderManagedHookBlock(spec: GitHookSpec): string {
  return `${BLOCK_START_PREFIX} hook=${spec.hookName} schema=1
${spec.command} "$@"
${BLOCK_END}`;
}

function renderHookScript(spec: GitHookSpec): string {
  return `#!/bin/sh

${renderManagedHookBlock(spec)}
`;
}

function renderLegacyHookScript(spec: GitHookSpec): string {
  return `#!/bin/sh
${spec.command} "$@"
`;
}

function replaceManagedHookBlock(existing: string, spec: GitHookSpec): string | null {
  const startIndex = existing.indexOf(BLOCK_START_PREFIX);
  const endIndex = existing.indexOf(BLOCK_END);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return null;
  }

  return `${existing.slice(0, startIndex)}${renderManagedHookBlock(spec)}${existing.slice(
    endIndex + BLOCK_END.length,
  )}`;
}

async function isBinaryOrUnsafe(filePath: string): Promise<boolean> {
  try {
    const buffer = await fs.readFile(filePath);
    return buffer.includes(0);
  } catch {
    return true;
  }
}

async function chmodExecutableIfPresent(
  filePath: string,
  dryRun: boolean | undefined,
): Promise<void> {
  if (!dryRun && (await fileExists(filePath))) {
    await ensureExecutable(filePath);
  }
}

export async function installManagedGitHook(
  projectRoot: string,
  hooksDir: string,
  spec: GitHookSpec,
  options: { dryRun?: boolean } = {},
): Promise<GitHookInstallOperation> {
  const hookPath = path.join(hooksDir, spec.hookName);
  const candidatePath = path.join(hooksDir, `${spec.hookName}.llmdocs.candidate`);
  const relativeHookPath = path.relative(projectRoot, hookPath);
  const relativeCandidatePath = path.relative(projectRoot, candidatePath);
  const desiredScript = renderHookScript(spec);
  const existing = await readFileSafe(hookPath);

  if (existing === null) {
    if (!options.dryRun) {
      await ensureDir(path.dirname(hookPath));
      await writeTextAtomic(hookPath, desiredScript);
      await ensureExecutable(hookPath);
    }

    return {
      path: relativeHookPath,
      kind: 'git-hook',
      action: 'create',
      ownership: 'absent',
      safe: true,
      message: `Created llm-docs git hook ${spec.hookName}.`,
    };
  }

  if (await isBinaryOrUnsafe(hookPath)) {
    return {
      path: relativeHookPath,
      kind: 'git-hook',
      action: 'error',
      ownership: 'binary-or-unsafe',
      safe: false,
      message: `Existing git hook ${spec.hookName} is binary or unsafe; leaving it unchanged.`,
    };
  }

  const managedReplacement = replaceManagedHookBlock(existing, spec);
  if (managedReplacement !== null) {
    if (managedReplacement !== existing && !options.dryRun) {
      await writeTextAtomic(hookPath, managedReplacement);
    }
    await chmodExecutableIfPresent(hookPath, options.dryRun);

    return {
      path: relativeHookPath,
      kind: 'git-hook',
      action: managedReplacement === existing ? 'skip' : 'replace-managed-block',
      ownership: 'llm-docs-managed-block',
      safe: true,
      message:
        managedReplacement === existing
          ? `Managed llm-docs git hook ${spec.hookName} is unchanged.`
          : `Replaced managed llm-docs block in git hook ${spec.hookName}.`,
    };
  }

  if (existing.trim() === renderLegacyHookScript(spec).trim()) {
    if (!options.dryRun) {
      await writeTextAtomic(hookPath, desiredScript);
      await ensureExecutable(hookPath);
    }

    return {
      path: relativeHookPath,
      kind: 'git-hook',
      action: 'replace-managed-block',
      ownership: 'legacy-llm-docs-hook',
      safe: true,
      message: `Upgraded legacy llm-docs git hook ${spec.hookName} to a managed block.`,
    };
  }

  if (!options.dryRun) {
    await writeTextAtomic(candidatePath, desiredScript);
    await ensureExecutable(candidatePath);
  }

  return {
    path: relativeHookPath,
    kind: 'git-hook',
    action: 'write-candidate',
    ownership: 'user-owned',
    candidatePath: relativeCandidatePath,
    safe: true,
    message: `Existing git hook ${spec.hookName} has no llm-docs marker; wrote a candidate and left it unchanged.`,
  };
}

export async function installManagedGitHooks(
  projectRoot: string,
  hooksDir: string,
  specs: readonly GitHookSpec[],
  options: { dryRun?: boolean } = {},
): Promise<GitHookInstallOperation[]> {
  const operations: GitHookInstallOperation[] = [];

  for (const spec of specs) {
    operations.push(await installManagedGitHook(projectRoot, hooksDir, spec, options));
  }

  return operations;
}
