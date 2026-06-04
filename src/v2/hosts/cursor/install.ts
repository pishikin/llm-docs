import path from 'node:path';
import { renderCursorRule } from '../../templates/cursor-pack.js';
import type {
  HostInstallOptions,
  HostInstallReport,
  LlmDocsConfigV2,
  WorkspacePaths,
} from '../../types.js';
import { writeIfChanged } from '../shared.js';

export async function ensureCursorRules(
  paths: WorkspacePaths,
  options: HostInstallOptions,
): Promise<HostInstallReport['filesWritten']> {
  const targetPath = path.join(paths.cursorRulesDir, 'llm-docs.mdc');
  const status = await writeIfChanged(targetPath, renderCursorRule(), options, 'cursor-rule');
  return status === 'unchanged' ? [] : [path.relative(paths.projectRoot, targetPath)];
}

export async function installCursorPack(
  _projectRoot: string,
  _config: LlmDocsConfigV2,
  paths: WorkspacePaths,
  options: HostInstallOptions = {},
): Promise<HostInstallReport> {
  const filesWritten = await ensureCursorRules(paths, options);

  return {
    host: 'cursor',
    filesWritten,
    filesCreated: [...filesWritten],
    warnings: [],
  };
}
