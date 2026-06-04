import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, fileExists, readFileSafe, writeTextAtomic } from '../../utils/fs.js';
import type { HostInstallOptions, WorkspaceBootstrapOperation } from '../types.js';

const MANAGED_BLOCK_START = '<!-- llm-docs:start -->';
const MANAGED_BLOCK_END = '<!-- llm-docs:end -->';

export function deepMerge<T>(left: T, right: Partial<T>): T {
  if (Array.isArray(left) || Array.isArray(right)) {
    return right as T;
  }

  if (
    left &&
    right &&
    typeof left === 'object' &&
    typeof right === 'object' &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const result: Record<string, unknown> = { ...(left as Record<string, unknown>) };
    for (const [key, value] of Object.entries(right)) {
      if (value === undefined) {
        continue;
      }

      const current = result[key];
      result[key] =
        current &&
        value &&
        typeof current === 'object' &&
        typeof value === 'object' &&
        !Array.isArray(current) &&
        !Array.isArray(value)
          ? deepMerge(current as Record<string, unknown>, value as Record<string, unknown>)
          : value;
    }

    return result as T;
  }

  return right as T;
}

export async function writeCandidateOrThrow(
  targetPath: string,
  candidatePath: string,
  content: string,
  message: string,
  options: HostInstallOptions,
): Promise<never> {
  if (!options.dryRun) {
    await ensureDir(path.dirname(candidatePath));
    await writeTextAtomic(candidatePath, content);
  }

  throw new Error(`${message} Generated candidate: ${path.basename(candidatePath)}`);
}

export async function writeIfChanged(
  filePath: string,
  content: string,
  options: HostInstallOptions,
  kind: WorkspaceBootstrapOperation['kind'] = 'host-config',
): Promise<'created' | 'updated' | 'unchanged'> {
  const existing = await readFileSafe(filePath);
  if (existing === content) {
    options.collectOperation?.({
      path: filePath,
      kind,
      action: 'skip',
      safe: true,
      message: `${path.basename(filePath)} is unchanged.`,
    });
    return 'unchanged';
  }

  if (!options.dryRun) {
    await ensureDir(path.dirname(filePath));
    await writeTextAtomic(filePath, content);
  }

  const status = existing === null ? 'created' : 'updated';
  options.collectOperation?.({
    path: filePath,
    kind,
    action: status === 'created' ? 'create' : 'update',
    ownership: existing === null ? 'absent' : 'managed-or-merge',
    safe: true,
    message:
      status === 'created'
        ? `Created ${path.basename(filePath)}.`
        : `Updated ${path.basename(filePath)}.`,
  });

  return status;
}

function extractManagedBlock(content: string): string | null {
  const startIndex = content.indexOf(MANAGED_BLOCK_START);
  const endIndex = content.indexOf(MANAGED_BLOCK_END);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return null;
  }

  return content.slice(startIndex, endIndex + MANAGED_BLOCK_END.length);
}

function replaceManagedBlock(existing: string, nextContent: string): string | null {
  const nextBlock = extractManagedBlock(nextContent);
  const startIndex = existing.indexOf(MANAGED_BLOCK_START);
  const endIndex = existing.indexOf(MANAGED_BLOCK_END);

  if (!nextBlock || startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return null;
  }

  return `${existing.slice(0, startIndex)}${nextBlock}${existing.slice(
    endIndex + MANAGED_BLOCK_END.length,
  )}`;
}

export async function writeManagedMarkdownFile(
  filePath: string,
  candidatePath: string,
  content: string,
  options: HostInstallOptions,
  isKnownManagedContent: (existing: string) => boolean,
): Promise<'created' | 'updated' | 'candidate' | 'unchanged'> {
  const existing = await readFileSafe(filePath);

  if (existing === content) {
    options.collectOperation?.({
      path: filePath,
      kind: 'root-doc',
      action: 'skip',
      ownership: 'llm-docs-managed-file',
      safe: true,
      message: `${path.basename(filePath)} is unchanged.`,
    });
    return 'unchanged';
  }

  if (existing === null || options.force || isKnownManagedContent(existing)) {
    if (!options.dryRun) {
      await ensureDir(path.dirname(filePath));
      await writeTextAtomic(filePath, content);
    }
    options.collectOperation?.({
      path: filePath,
      kind: 'root-doc',
      action: existing === null ? 'create' : 'update',
      ownership: existing === null ? 'absent' : 'legacy-generated',
      safe: true,
      message:
        existing === null
          ? `Created ${path.basename(filePath)}.`
          : `Updated llm-docs-owned ${path.basename(filePath)}.`,
    });
    return existing === null ? 'created' : 'updated';
  }

  const blockUpdated = replaceManagedBlock(existing, content);
  if (blockUpdated !== null) {
    if (blockUpdated === existing) {
      options.collectOperation?.({
        path: filePath,
        kind: 'root-doc',
        action: 'skip',
        ownership: 'llm-docs-managed-block',
        safe: true,
        message: `Managed block in ${path.basename(filePath)} is unchanged.`,
      });
      return 'unchanged';
    }

    if (!options.dryRun) {
      await writeTextAtomic(filePath, blockUpdated);
    }
    options.collectOperation?.({
      path: filePath,
      kind: 'root-doc',
      action: 'replace-managed-block',
      ownership: 'llm-docs-managed-block',
      safe: true,
      message: `Replaced managed block in ${path.basename(filePath)}.`,
    });
    return 'updated';
  }

  if (!options.dryRun) {
    await ensureDir(path.dirname(candidatePath));
    await writeTextAtomic(candidatePath, content);
  }
  options.collectOperation?.({
    path: filePath,
    kind: 'root-doc',
    action: 'write-candidate',
    ownership: 'user-owned',
    candidatePath,
    safe: true,
    message: `${path.basename(filePath)} is user-owned; wrote a candidate and left it unchanged.`,
  });
  return 'candidate';
}

export async function writeJsonMergedFile(
  filePath: string,
  managedBlock: Record<string, unknown>,
  options: HostInstallOptions,
  onInvalid: (candidateContent: string) => Promise<never>,
): Promise<'created' | 'updated' | 'unchanged'> {
  const existing = await readFileSafe(filePath);
  let nextValue = managedBlock;

  if (existing !== null) {
    try {
      const parsed = JSON.parse(existing) as Record<string, unknown>;
      nextValue = deepMerge(parsed, managedBlock);
    } catch {
      if (options.force) {
        nextValue = managedBlock;
      } else {
        await onInvalid(`${JSON.stringify(managedBlock, null, 2)}\n`);
      }
    }
  }

  return writeIfChanged(filePath, `${JSON.stringify(nextValue, null, 2)}\n`, options);
}

export async function ensureExecutable(filePath: string): Promise<void> {
  if (await fileExists(filePath)) {
    await fs.chmod(filePath, 0o755);
  }
}
