import fs from 'node:fs/promises';
import path from 'node:path';
import TOML from '@iarna/toml';
import { simpleGit } from 'simple-git';
import { fileExists, readFileSafe } from '../../utils/fs.js';
import { loadOrMigrateConfig } from '../config/load.js';
import { buildContextStatusReport } from '../context/status.js';
import { buildGitFacts } from '../git/status.js';
import { readActiveTaskFile, resolveActiveTaskFilePath } from '../task/active.js';
import { readArtifactIndex } from '../task/artifacts.js';
import { protectedBaseBranches, shouldAutoLinkBranch } from '../task/branches.js';
import { readTaskMeta } from '../task/meta.js';
import { readTaskRegistry, resolveTaskByBranch } from '../task/registry.js';
import { readTaskStateOrNull, taskHasSimpleState } from '../task/state.js';
import {
  AGENT_GUIDE_RECIPES_MAX_BYTES,
  AGENT_GUIDE_RECIPES_RELATIVE_PATH,
  AGENT_GUIDE_ROOT_ROUTER_MAX_BYTES,
  AGENT_GUIDE_SKILL_MAX_BYTES,
  AGENT_GUIDE_SKILL_RELATIVE_PATH,
  LEGACY_AGENT_GUIDE_SKILL_DIRS,
  renderAgentGuideSkillFiles,
} from '../templates/agent-guide.js';
import { renderAgentsRootDoc, renderClaudeRootDoc } from '../templates/root-docs.js';
import type {
  ActiveTaskResolution,
  DoctorCheck,
  DoctorReport,
  LlmDocsConfig,
  WorkspaceHealthReport,
  WorkspacePaths,
} from '../types.js';
import { findExistingLegacyAlias } from './aliases.js';
import { smokeTestCliLauncher } from './launcher.js';
import { resolveWorkspacePaths } from './paths.js';

function check(
  id: string,
  ok: boolean,
  severity: DoctorCheck['severity'],
  message: string,
): DoctorCheck {
  return { id, ok, severity, message };
}

function isTimestampAfter(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }

  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime > rightTime;
}

export async function checkRegistryHealth(paths: WorkspacePaths): Promise<DoctorCheck[]> {
  const registry = await readTaskRegistry(paths);
  const checks: DoctorCheck[] = [
    check('registry:parse', true, 'info', 'Task registry parsed successfully.'),
  ];

  for (const entry of Object.values(registry.tasks)) {
    const bundlePath = path.join(paths.projectRoot, entry.bundlePath);
    const bundleExists = await fileExists(bundlePath);
    checks.push(
      check(
        `registry:bundle:${entry.taskId}`,
        bundleExists,
        bundleExists ? 'info' : 'error',
        bundleExists
          ? `Bundle exists for ${entry.taskId}.`
          : `Missing bundle directory for ${entry.taskId}: ${entry.bundlePath}`,
      ),
    );

    if (!bundleExists) {
      continue;
    }

    try {
      const meta = await readTaskMeta(paths, entry.taskId);
      checks.push(
        check(
          `registry:meta:${entry.taskId}`,
          true,
          'info',
          `Task metadata parsed successfully for ${entry.taskId}.`,
        ),
      );

      if (meta.bundle.path !== entry.bundlePath) {
        checks.push(
          check(
            `registry:bundle-path:${entry.taskId}`,
            false,
            'warning',
            `Registry bundlePath differs from task.meta.yaml for ${entry.taskId}.`,
          ),
        );
      }

      const isSimpleTask = await taskHasSimpleState(paths, entry.taskId);
      const artifactIndexPath = path.join(paths.tasksDir, entry.taskId, meta.artifacts.index_path);
      const artifactIndexExists = await fileExists(artifactIndexPath);
      const artifactIndexOptional = isSimpleTask && meta.artifacts.count === 0;
      const artifactIndexOk = artifactIndexExists || artifactIndexOptional;
      let artifactIndexMessage = `Artifact index file is missing for ${entry.taskId}.`;

      if (artifactIndexExists) {
        artifactIndexMessage = `Artifact index file exists for ${entry.taskId}.`;
      } else if (artifactIndexOptional) {
        artifactIndexMessage = `Artifact index file is not created yet for simple task ${entry.taskId}.`;
      }

      checks.push(
        check(
          `registry:artifact-file:${entry.taskId}`,
          artifactIndexOk,
          artifactIndexOk ? 'info' : 'error',
          artifactIndexMessage,
        ),
      );
    } catch (error) {
      checks.push(
        check(
          `registry:meta:${entry.taskId}`,
          false,
          'error',
          error instanceof Error
            ? error.message
            : `Failed to read task metadata for ${entry.taskId}.`,
        ),
      );
    }

    try {
      await readArtifactIndex(paths, entry.taskId);
      checks.push(
        check(
          `registry:artifacts:${entry.taskId}`,
          true,
          'info',
          `Artifact index parsed successfully for ${entry.taskId}.`,
        ),
      );
    } catch (error) {
      checks.push(
        check(
          `registry:artifacts:${entry.taskId}`,
          false,
          'error',
          error instanceof Error
            ? error.message
            : `Failed to read artifact index for ${entry.taskId}.`,
        ),
      );
    }
  }

  return checks;
}

export async function checkActiveTaskHealth(paths: WorkspacePaths): Promise<DoctorCheck[]> {
  const activeFilePath = resolveActiveTaskFilePath(paths);
  const activeTaskId = await readActiveTaskFile(paths);

  if (!activeTaskId) {
    return [
      check(
        'active-task:file',
        true,
        'info',
        `No explicit active task file found at ${path.relative(paths.projectRoot, activeFilePath)}.`,
      ),
    ];
  }

  const checks: DoctorCheck[] = [];
  try {
    const meta = await readTaskMeta(paths, activeTaskId);
    const state = await readTaskStateOrNull(paths, activeTaskId);
    checks.push(
      check('active-task:file', true, 'info', `Explicit active task resolves to ${activeTaskId}.`),
    );

    const taskIsStale = !!(
      state?.staleness.needsActualization || meta.staleness.needs_actualization
    );
    if (taskIsStale) {
      const reasons = [...(state?.staleness.reasons ?? []), ...meta.staleness.reasons].filter(
        (reason, index, array) => array.indexOf(reason) === index,
      );
      checks.push(
        check(
          'active-task:stale',
          true,
          'warning',
          `Active task ${activeTaskId} needs actualization: ${reasons.join('; ') || 'unknown reason'}.`,
        ),
      );
    }

    if (state?.checkpoint.needsQualityCheckpoint || taskIsStale) {
      checks.push(
        check(
          'active-task:checkpoint',
          true,
          'warning',
          taskIsStale
            ? `Active task ${activeTaskId} is stale; refresh context.md/changelog.md before handoff.`
            : `Active task ${activeTaskId} needs a fresh context checkpoint.`,
        ),
      );
    } else {
      checks.push(
        check(
          'active-task:checkpoint',
          true,
          'info',
          `Active task ${meta.task_id} checkpoint state is current or not tracked yet.`,
        ),
      );
    }

    if (
      taskIsStale &&
      state &&
      isTimestampAfter(state.bundle.updatedAt, state.checkpoint.lastCheckpointAt)
    ) {
      checks.push(
        check(
          'active-task:narrative-stale',
          true,
          'warning',
          `Active task ${activeTaskId} state was touched after the latest checkpoint; state.json may be newer than the human docs.`,
        ),
      );
    }
  } catch (error) {
    checks.push(
      check(
        'active-task:file',
        false,
        'warning',
        error instanceof Error
          ? `Explicit active task is invalid: ${error.message}`
          : `Explicit active task is invalid: ${activeTaskId}`,
      ),
    );
  }

  return checks;
}

async function checkProtectedBranchActiveTaskNotice(
  projectRoot: string,
  config: LlmDocsConfig,
  paths: WorkspacePaths,
): Promise<DoctorCheck[]> {
  const branch = (await buildGitFacts(projectRoot, { config })).branch;
  if (!branch || !protectedBaseBranches(config).has(branch)) {
    return [];
  }

  const [activeFileTaskId, registry] = await Promise.all([
    readActiveTaskFile(paths),
    readTaskRegistry(paths),
  ]);
  const workspaceActiveTaskId = activeFileTaskId ?? registry.activeTaskId;
  if (!workspaceActiveTaskId) {
    return [];
  }

  return [
    check(
      'active-task:protected-branch-passive',
      true,
      'warning',
      `Current branch is protected: ${branch}. Workspace active task exists: ${workspaceActiveTaskId}. Codex hooks will ignore it unless the task is session-bound or explicit.`,
    ),
  ];
}

export async function checkCliLauncherHealth(paths: WorkspacePaths): Promise<DoctorCheck[]> {
  if (!(await fileExists(paths.cliLauncherPath))) {
    return [
      check(
        'launcher:smoke',
        false,
        'warning',
        `Generated launcher is missing: ${path.relative(paths.projectRoot, paths.cliLauncherPath)}. Run llm-docs setup.`,
      ),
    ];
  }

  const result = await smokeTestCliLauncher(paths, { timeoutMs: 4000 });
  return [
    check(
      'launcher:smoke',
      result.ok,
      result.ok ? 'info' : 'error',
      result.ok
        ? `Generated launcher executes successfully: ${path.relative(paths.projectRoot, paths.cliLauncherPath)}.`
        : `Generated launcher cannot execute llm-docs (${result.error ?? 'unknown error'}). stderr: ${result.stderr.trim() || 'n/a'}. Rerun llm-docs setup from a built checkout or set LLMDOCS_CLI_ENTRYPOINT.`,
    ),
  ];
}

export async function checkHostPackHealth(
  projectRoot: string,
  config: LlmDocsConfig,
  paths: WorkspacePaths,
): Promise<WorkspaceHealthReport['hostHealth']> {
  const claude =
    !config.hosts.claude.enabled ||
    ((await fileExists(paths.claudeSettingsPath)) && (await fileExists(paths.mcpConfigPath)));
  const codex =
    !config.hosts.codex.enabled ||
    ((await fileExists(paths.codexConfigPath)) && (await fileExists(paths.codexHooksPath)));
  const cursor =
    !config.hosts.cursor.enabled ||
    (await fileExists(path.join(projectRoot, '.cursor/rules/llm-docs.mdc')));

  return { claude, codex, cursor };
}

export async function checkLegacySubsystemHealth(
  projectRoot: string,
  config: LlmDocsConfig,
): Promise<DoctorCheck[]> {
  if (!config.legacyAgentDocs?.enabled) {
    return [];
  }

  return [
    check(
      'legacy:docsDir',
      await fileExists(path.join(projectRoot, config.legacyAgentDocs.docsDir)),
      (await fileExists(path.join(projectRoot, config.legacyAgentDocs.docsDir)))
        ? 'info'
        : 'warning',
      (await fileExists(path.join(projectRoot, config.legacyAgentDocs.docsDir)))
        ? `Legacy docs directory exists: ${config.legacyAgentDocs.docsDir}`
        : `Legacy docs directory missing: ${config.legacyAgentDocs.docsDir}`,
    ),
  ];
}

async function checkJsonFile(
  id: string,
  filePath: string,
  missingSeverity: DoctorCheck['severity'],
): Promise<{ checks: DoctorCheck[]; parsed: Record<string, unknown> | null }> {
  const content = await readFileSafe(filePath);

  if (content === null) {
    return {
      checks: [check(id, false, missingSeverity, `Missing required JSON file: ${filePath}`)],
      parsed: null,
    };
  }

  try {
    return {
      checks: [check(id, true, 'info', `Parsed JSON file: ${filePath}`)],
      parsed: JSON.parse(content) as Record<string, unknown>,
    };
  } catch (error) {
    return {
      checks: [
        check(
          id,
          false,
          'error',
          error instanceof Error
            ? `Invalid JSON in ${filePath}: ${error.message}`
            : `Invalid JSON in ${filePath}`,
        ),
      ],
      parsed: null,
    };
  }
}

async function checkTomlFile(
  id: string,
  filePath: string,
  missingSeverity: DoctorCheck['severity'],
): Promise<{ checks: DoctorCheck[]; parsed: Record<string, unknown> | null }> {
  const content = await readFileSafe(filePath);
  if (content === null) {
    return {
      checks: [check(id, false, missingSeverity, `Missing required TOML file: ${filePath}`)],
      parsed: null,
    };
  }

  try {
    return {
      checks: [check(id, true, 'info', `Parsed TOML file: ${filePath}`)],
      parsed: TOML.parse(content) as Record<string, unknown>,
    };
  } catch (error) {
    return {
      checks: [
        check(
          id,
          false,
          'error',
          error instanceof Error
            ? `Invalid TOML in ${filePath}: ${error.message}`
            : `Invalid TOML in ${filePath}`,
        ),
      ],
      parsed: null,
    };
  }
}

export async function checkHostConfigHealth(
  _projectRoot: string,
  config: LlmDocsConfig,
  paths: WorkspacePaths,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  if (config.hosts.claude.enabled) {
    const mcpConfig = await checkJsonFile('host:claude:mcp-json', paths.mcpConfigPath, 'warning');
    checks.push(...mcpConfig.checks);
    checks.push(
      check(
        'host:claude:mcp-server',
        !!(
          mcpConfig.parsed?.mcpServers &&
          typeof mcpConfig.parsed.mcpServers === 'object' &&
          typeof (mcpConfig.parsed.mcpServers as Record<string, unknown>).llmdocs === 'object'
        ),
        mcpConfig.parsed ? 'info' : 'warning',
        mcpConfig.parsed?.mcpServers &&
          typeof mcpConfig.parsed.mcpServers === 'object' &&
          typeof (mcpConfig.parsed.mcpServers as Record<string, unknown>).llmdocs === 'object'
          ? 'Claude MCP config includes llmdocs server.'
          : 'Claude MCP config is missing mcpServers.llmdocs.',
      ),
    );

    const claudeSettings = await checkJsonFile(
      'host:claude:settings-json',
      paths.claudeSettingsPath,
      'warning',
    );
    checks.push(...claudeSettings.checks);
    const claudeHooks = (claudeSettings.parsed?.hooks as Record<string, unknown> | undefined) ?? {};
    const hasClaudeHooks =
      'SessionStart' in claudeHooks &&
      'UserPromptSubmit' in claudeHooks &&
      'Stop' in claudeHooks &&
      'PreCompact' in claudeHooks;
    checks.push(
      check(
        'host:claude:hooks',
        hasClaudeHooks,
        claudeSettings.parsed ? 'info' : 'warning',
        hasClaudeHooks
          ? 'Claude settings include required hook groups.'
          : 'Claude settings are missing one or more required hook groups.',
      ),
    );
  }

  if (config.hosts.codex.enabled) {
    const codexConfig = await checkTomlFile(
      'host:codex:config-toml',
      paths.codexConfigPath,
      'warning',
    );
    checks.push(...codexConfig.checks);
    const mcpServers =
      (codexConfig.parsed?.mcp_servers as Record<string, unknown> | undefined) ?? {};
    checks.push(
      check(
        'host:codex:mcp-server',
        typeof mcpServers.llmdocs === 'object',
        codexConfig.parsed ? 'info' : 'warning',
        typeof mcpServers.llmdocs === 'object'
          ? 'Codex config includes llmdocs MCP server.'
          : 'Codex config is missing mcp_servers.llmdocs.',
      ),
    );

    const codexHooks = await checkJsonFile(
      'host:codex:hooks-json',
      paths.codexHooksPath,
      'warning',
    );
    checks.push(...codexHooks.checks);
    const hookGroups = (codexHooks.parsed?.hooks as Record<string, unknown> | undefined) ?? {};
    checks.push(
      check(
        'host:codex:hooks',
        'SessionStart' in hookGroups && 'UserPromptSubmit' in hookGroups && 'Stop' in hookGroups,
        codexHooks.parsed ? 'info' : 'warning',
        'SessionStart' in hookGroups && 'UserPromptSubmit' in hookGroups && 'Stop' in hookGroups
          ? 'Codex hooks include required hook groups.'
          : 'Codex hooks are missing one or more required hook groups.',
      ),
    );
  }

  if (config.hosts.cursor.enabled) {
    const cursorRulePath = path.join(paths.cursorRulesDir, 'llm-docs.mdc');
    const hasCursorRule = await fileExists(cursorRulePath);
    checks.push(
      check(
        'host:cursor:rules',
        hasCursorRule,
        hasCursorRule ? 'info' : 'warning',
        hasCursorRule ? 'Cursor rule pack exists.' : 'Cursor rule pack is missing.',
      ),
    );
  }

  return checks;
}

async function resolveGitHooksDir(projectRoot: string): Promise<string | null> {
  try {
    const rawHooksPath = (
      await simpleGit(projectRoot).raw(['rev-parse', '--git-path', 'hooks'])
    ).trim();
    return path.resolve(projectRoot, rawHooksPath);
  } catch {
    return null;
  }
}

export async function checkCandidateHealth(
  projectRoot: string,
  paths: WorkspacePaths,
): Promise<DoctorCheck[]> {
  const hooksDir = await resolveGitHooksDir(projectRoot);
  const candidatePaths = [
    path.join(projectRoot, 'CLAUDE.llmdocs.generated.md'),
    path.join(projectRoot, 'AGENTS.llmdocs.generated.md'),
    path.join(projectRoot, '.mcp.generated.json'),
    path.join(paths.workspaceRoot, 'settings.generated.json'),
    path.join(projectRoot, '.codex/config.generated.toml'),
    path.join(projectRoot, '.codex/hooks.generated.json'),
    ...(hooksDir
      ? ['prepare-commit-msg', 'post-commit', 'post-merge', 'pre-push'].map((hookName) =>
          path.join(hooksDir, `${hookName}.llmdocs.candidate`),
        )
      : []),
  ];
  const checks: DoctorCheck[] = [];

  for (const candidatePath of candidatePaths) {
    if (!(await fileExists(candidatePath))) {
      continue;
    }

    checks.push(
      check(
        `candidate:${path.relative(projectRoot, candidatePath)}`,
        true,
        'warning',
        `Unresolved llm-docs candidate exists: ${path.relative(projectRoot, candidatePath)}`,
      ),
    );
  }

  if (await fileExists(path.join(paths.workspaceRoot, 'candidates'))) {
    checks.push(
      check(
        'candidate:run-dir',
        true,
        'warning',
        `llm-docs candidate run directory exists: ${path.relative(
          projectRoot,
          path.join(paths.workspaceRoot, 'candidates'),
        )}`,
      ),
    );
  }

  return checks;
}

async function checkPublishedTaskIndex(indexPath: string, label: string): Promise<DoctorCheck[]> {
  const content = await readFileSafe(indexPath);
  if (content === null) {
    return [];
  }

  try {
    const parsed = JSON.parse(content) as { schemaVersion?: unknown; tasks?: unknown };
    const ok =
      parsed.schemaVersion === 1 && typeof parsed.tasks === 'object' && parsed.tasks !== null;
    return [
      check(
        `published-index:${label}`,
        ok,
        ok ? 'info' : 'error',
        ok
          ? `Published task index parsed successfully: ${indexPath}`
          : `Published task index has invalid shape: ${indexPath}`,
      ),
    ];
  } catch (error) {
    return [
      check(
        `published-index:${label}`,
        false,
        'error',
        error instanceof Error
          ? `Published task index JSON parse failed: ${error.message}`
          : 'Published task index JSON parse failed.',
      ),
    ];
  }
}

export async function checkPublishedDocsHealth(paths: WorkspacePaths): Promise<DoctorCheck[]> {
  return [
    ...(await checkPublishedTaskIndex(path.join(paths.docsDir, 'tasks/index.json'), 'docs')),
    ...(await checkPublishedTaskIndex(path.join(paths.archiveDir, 'tasks/index.json'), 'archive')),
  ];
}

async function listDirectoryNames(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith('.'))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf-8');
}

function countOccurrences(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

function extractLlmdocsManagedBlock(content: string): string | null {
  const start = '<!-- llm-docs:start -->';
  const end = '<!-- llm-docs:end -->';
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return null;
  }

  return content.slice(startIndex, endIndex + end.length);
}

async function checkAgentGuideSkillFiles(
  host: 'claude' | 'codex',
  skillsDir: string,
): Promise<DoctorCheck[]> {
  const expectedFiles = renderAgentGuideSkillFiles();
  const checks: DoctorCheck[] = [];

  for (const [relativePath, expected] of Object.entries(expectedFiles)) {
    const fullPath = path.join(skillsDir, relativePath);
    const existing = await readFileSafe(fullPath);
    const id = `agent-guide:${host}:${relativePath}`;

    if (existing === null) {
      checks.push(
        check(
          id,
          false,
          'warning',
          `Missing ${host} llm-docs agent guide file: ${path.relative(
            path.dirname(skillsDir),
            fullPath,
          )}. Run llm-docs setup.`,
        ),
      );
      continue;
    }

    checks.push(
      check(
        id,
        existing === expected,
        existing === expected ? 'info' : 'warning',
        existing === expected
          ? `${host} llm-docs agent guide file is current: ${relativePath}.`
          : `${host} llm-docs agent guide file is stale: ${relativePath}. Run llm-docs setup.`,
      ),
    );
  }

  const skillContent = await readFileSafe(path.join(skillsDir, AGENT_GUIDE_SKILL_RELATIVE_PATH));
  if (skillContent !== null) {
    const size = byteLength(skillContent);
    checks.push(
      check(
        `agent-guide:${host}:skill-size`,
        size <= AGENT_GUIDE_SKILL_MAX_BYTES,
        size <= AGENT_GUIDE_SKILL_MAX_BYTES ? 'info' : 'warning',
        `llm-docs skill size is ${size} bytes; budget is ${AGENT_GUIDE_SKILL_MAX_BYTES}.`,
      ),
    );
  }

  const recipesContent = await readFileSafe(
    path.join(skillsDir, AGENT_GUIDE_RECIPES_RELATIVE_PATH),
  );
  if (recipesContent !== null) {
    const size = byteLength(recipesContent);
    checks.push(
      check(
        `agent-guide:${host}:recipes-size`,
        size <= AGENT_GUIDE_RECIPES_MAX_BYTES,
        size <= AGENT_GUIDE_RECIPES_MAX_BYTES ? 'info' : 'warning',
        `llm-docs recipes reference size is ${size} bytes; budget is ${AGENT_GUIDE_RECIPES_MAX_BYTES}.`,
      ),
    );
  }

  const legacySkillDirs: string[] = [];
  for (const dirName of LEGACY_AGENT_GUIDE_SKILL_DIRS) {
    if (await fileExists(path.join(skillsDir, dirName))) {
      legacySkillDirs.push(dirName);
    }
  }

  if (legacySkillDirs.length > 0) {
    checks.push(
      check(
        `agent-guide:${host}:legacy-split-skills`,
        true,
        'warning',
        `Legacy split llm-docs skills are still installed for ${host}: ${legacySkillDirs.join(
          ', ',
        )}. The current host pack uses a single llm-docs skill; remove stale generated skill directories if the host loads duplicate workflows.`,
      ),
    );
  }

  return checks;
}

async function checkAgentGuideRootRouter(
  host: 'claude' | 'codex',
  rootDocPath: string,
  expectedRootDoc: string,
): Promise<DoctorCheck[]> {
  const existing = await readFileSafe(rootDocPath);
  const idPrefix = `agent-guide:${host}:root-router`;

  if (existing === null) {
    return [
      check(
        idPrefix,
        false,
        'warning',
        `Missing ${path.basename(rootDocPath)} llm-docs router block. Run llm-docs setup.`,
      ),
    ];
  }

  const block = extractLlmdocsManagedBlock(existing);
  if (block === null) {
    return [
      check(
        idPrefix,
        false,
        'warning',
        `${path.basename(rootDocPath)} does not contain the llm-docs managed router block. Review the generated candidate or rerun setup.`,
      ),
    ];
  }

  const expectedBlock = extractLlmdocsManagedBlock(expectedRootDoc);
  const blockCount = countOccurrences(existing, '<!-- llm-docs:start -->');
  const size = byteLength(block);

  return [
    check(
      idPrefix,
      expectedBlock !== null && block === expectedBlock,
      expectedBlock !== null && block === expectedBlock ? 'info' : 'warning',
      expectedBlock !== null && block === expectedBlock
        ? `${path.basename(rootDocPath)} llm-docs router block is current.`
        : `${path.basename(rootDocPath)} llm-docs router block is stale. Run llm-docs setup.`,
    ),
    check(
      `${idPrefix}:size`,
      size <= AGENT_GUIDE_ROOT_ROUTER_MAX_BYTES,
      size <= AGENT_GUIDE_ROOT_ROUTER_MAX_BYTES ? 'info' : 'warning',
      `${path.basename(rootDocPath)} llm-docs router block size is ${size} bytes; budget is ${AGENT_GUIDE_ROOT_ROUTER_MAX_BYTES}.`,
    ),
    check(
      `${idPrefix}:duplicates`,
      blockCount === 1,
      blockCount === 1 ? 'info' : 'warning',
      blockCount === 1
        ? `${path.basename(rootDocPath)} contains one llm-docs managed router block.`
        : `${path.basename(rootDocPath)} contains ${blockCount} llm-docs managed router blocks.`,
    ),
  ];
}

export async function checkAgentGuideHealth(
  projectRoot: string,
  config: LlmDocsConfig,
  paths: WorkspacePaths,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  if (config.hosts.codex.enabled) {
    checks.push(...(await checkAgentGuideSkillFiles('codex', paths.codexSkillsDir)));
    checks.push(
      ...(await checkAgentGuideRootRouter(
        'codex',
        path.join(projectRoot, 'AGENTS.md'),
        renderAgentsRootDoc(),
      )),
    );
  }

  if (config.hosts.claude.enabled) {
    checks.push(...(await checkAgentGuideSkillFiles('claude', paths.claudeSkillsDir)));
    checks.push(
      ...(await checkAgentGuideRootRouter(
        'claude',
        path.join(projectRoot, 'CLAUDE.md'),
        renderClaudeRootDoc(),
      )),
    );
  }

  return checks;
}

async function checkTaskStorageLayoutHealth(
  config: LlmDocsConfig,
  paths: WorkspacePaths,
): Promise<DoctorCheck[]> {
  const registry = await readTaskRegistry(paths);
  const checks: DoctorCheck[] = [];
  const legacyTasksDir = path.join(paths.workspaceRoot, 'tasks');
  const publishedTasksDir = path.join(paths.docsDir, 'tasks');
  const hiddenTasksDir = path.join(paths.workspaceRoot, '.llm-docs/tasks');
  const configuredLegacy = path.resolve(paths.tasksDir) === path.resolve(legacyTasksDir);
  const legacyTaskDirs = await listDirectoryNames(legacyTasksDir);
  const publishedTaskDirs = await listDirectoryNames(publishedTasksDir);

  if (configuredLegacy && legacyTaskDirs.length > 0 && publishedTaskDirs.length > 0) {
    checks.push(
      check(
        'layout:ambiguous-task-dirs',
        true,
        'warning',
        `Active tasks use visible ${path.relative(
          paths.projectRoot,
          legacyTasksDir,
        )} while published docs also use ${path.relative(
          paths.projectRoot,
          publishedTasksDir,
        )}. Run llm-docs workspace migrate-active-tasks.`,
      ),
    );
  }

  if (!configuredLegacy && (await fileExists(legacyTasksDir)) && legacyTaskDirs.length > 0) {
    checks.push(
      check(
        'layout:legacy-active-tasks-dir',
        true,
        'warning',
        `Legacy active task directory still exists at ${path.relative(
          paths.projectRoot,
          legacyTasksDir,
        )}; verify it only contains old manual notes before deleting.`,
      ),
    );
  }

  if (!(await fileExists(hiddenTasksDir))) {
    checks.push(
      check(
        'layout:hidden-active-tasks-dir',
        true,
        'info',
        `Hidden active task directory is not created yet: ${path.relative(
          paths.projectRoot,
          hiddenTasksDir,
        )}.`,
      ),
    );
  }

  for (const branch of protectedBaseBranches(config)) {
    const mappedTaskId = registry.branchToTask[branch];
    if (!mappedTaskId) {
      continue;
    }
    checks.push(
      check(
        `active-task:default-branch-mapping:${branch}`,
        true,
        'warning',
        `Default branch ${branch} is mapped to active task ${mappedTaskId}; close the task or remove the mapping to keep main docs clean.`,
      ),
    );
  }

  for (const taskId of Object.keys(registry.tasks)) {
    const publishedPath = path.join(publishedTasksDir, taskId);
    if (await fileExists(publishedPath)) {
      checks.push(
        check(
          `active-task:published-not-closed:${taskId}`,
          true,
          'warning',
          `Task ${taskId} exists in active storage and published docs; run llm-docs task close ${taskId} to clear active state.`,
        ),
      );
    }
  }

  const activeTaskId = (await readActiveTaskFile(paths)) ?? registry.activeTaskId;
  const activeEntry = activeTaskId ? registry.tasks[activeTaskId] : null;
  if (
    activeTaskId &&
    activeEntry &&
    activeEntry.currentBranch &&
    protectedBaseBranches(config).has(activeEntry.currentBranch) &&
    !(await fileExists(path.join(publishedTasksDir, activeTaskId)))
  ) {
    checks.push(
      check(
        'published-docs:active-bundle-not-published',
        true,
        'warning',
        `Active task ${activeTaskId} is attached to ${activeEntry.currentBranch} but is not published under docs/tasks yet.`,
      ),
    );
  }

  return checks;
}

function hasUnsafeSeedPattern(pattern: string): boolean {
  return (
    pattern.includes('.claude/docs/archive') ||
    pattern.includes('.claude/docs/archieve') ||
    pattern.includes('.claude/docs/tasks') ||
    pattern.includes('.claude/tasks') ||
    pattern.includes('.claude/.llm-docs') ||
    pattern.includes('*.har') ||
    pattern.includes('*.log')
  );
}

export async function checkWorktreeSeedHealth(paths: WorkspacePaths): Promise<DoctorCheck[]> {
  const seedManifestPath = path.join(paths.docsDir, 'seed.manifest.json');
  const content = await readFileSafe(seedManifestPath);

  if (content === null) {
    return [
      check(
        'worktree-seed:manifest',
        true,
        'info',
        'No custom seed manifest found; built-in worktree seed profiles will be used.',
      ),
    ];
  }

  let parsed: { schemaVersion?: unknown; profiles?: unknown };
  try {
    parsed = JSON.parse(content) as { schemaVersion?: unknown; profiles?: unknown };
  } catch (error) {
    return [
      check(
        'worktree-seed:manifest',
        false,
        'error',
        error instanceof Error
          ? `Invalid worktree seed manifest JSON: ${error.message}`
          : 'Invalid worktree seed manifest JSON.',
      ),
    ];
  }

  const validShape =
    parsed.schemaVersion === 1 && typeof parsed.profiles === 'object' && parsed.profiles !== null;
  const checks: DoctorCheck[] = [
    check(
      'worktree-seed:manifest',
      validShape,
      validShape ? 'info' : 'error',
      validShape
        ? 'Worktree seed manifest parsed successfully.'
        : 'Worktree seed manifest has invalid shape. Expected schemaVersion 1 and profiles.',
    ),
  ];

  if (!validShape) {
    return checks;
  }

  const profiles = parsed.profiles as Record<string, { include?: unknown }>;
  for (const [profileName, profile] of Object.entries(profiles)) {
    const include = Array.isArray(profile.include) ? profile.include : [];
    const unsafePatterns = include.filter(
      (item): item is string => typeof item === 'string' && hasUnsafeSeedPattern(item),
    );

    if (unsafePatterns.length > 0) {
      checks.push(
        check(
          `worktree-seed:unsafe-include:${profileName}`,
          true,
          'warning',
          `Seed profile ${profileName} includes paths blocked by safety excludes: ${unsafePatterns.join(
            ', ',
          )}`,
        ),
      );
    }
  }

  return checks;
}

async function resolveTaskIdForHealth(
  paths: WorkspacePaths,
  taskId: string,
  resolvedBy: ActiveTaskResolution['resolvedBy'],
): Promise<ActiveTaskResolution | null> {
  try {
    const meta = await readTaskMeta(paths, taskId);
    return {
      taskId: meta.task_id,
      resolvedBy,
      bundlePath: meta.bundle.path,
    };
  } catch {
    return null;
  }
}

async function resolveActiveTaskForHealth(
  projectRoot: string,
  config: LlmDocsConfig,
  paths: WorkspacePaths,
): Promise<ActiveTaskResolution | null> {
  const activeFileTaskId = await readActiveTaskFile(paths);
  if (activeFileTaskId) {
    const activeFileResolution = await resolveTaskIdForHealth(
      paths,
      activeFileTaskId,
      'active-file',
    );
    if (activeFileResolution) {
      return activeFileResolution;
    }
  }

  const registry = await readTaskRegistry(paths);
  if (registry.activeTaskId) {
    return {
      taskId: registry.activeTaskId,
      resolvedBy: 'registry-active',
      bundlePath: registry.tasks[registry.activeTaskId]?.bundlePath ?? '',
    };
  }

  const branch = (await buildGitFacts(projectRoot, { config })).branch;
  if (!shouldAutoLinkBranch(branch, config)) {
    return null;
  }

  const branchNameResolution = await resolveTaskIdForHealth(paths, branch, 'branch-name');
  if (branchNameResolution) {
    return branchNameResolution;
  }

  const entry = await resolveTaskByBranch(paths, branch);
  return entry
    ? {
        taskId: entry.taskId,
        resolvedBy: 'branch-mapping',
        bundlePath: entry.bundlePath,
      }
    : null;
}

export async function checkContextBudgetHealth(
  projectRoot: string,
  config: LlmDocsConfig,
  paths: WorkspacePaths,
): Promise<DoctorCheck[]> {
  const activeTask = await resolveActiveTaskForHealth(projectRoot, config, paths);

  if (!activeTask) {
    return [
      check('context-budget:active-task', true, 'info', 'No active task context to budget-check.'),
    ];
  }

  try {
    const report = await buildContextStatusReport({
      projectRoot: paths.projectRoot,
      config,
      paths,
      activeTask,
    });
    const checks = report.files
      .filter((file) => file.status === 'large')
      .map((file) =>
        check(
          `context-budget:${file.kind}:${file.path}`,
          true,
          'warning',
          `${file.path} exceeds context budget (${file.sizeBytes} > ${file.budgetBytes} bytes).`,
        ),
      );

    if (
      report.transcript.estimatedTokens !== null &&
      report.transcript.estimatedTokens >= report.transcript.riskTokens
    ) {
      checks.push(
        check(
          'context-budget:transcript',
          true,
          'warning',
          `Codex transcript estimate is above context budget (${report.transcript.estimatedTokens} >= ${report.transcript.riskTokens}).`,
        ),
      );
    }

    if (checks.length === 0) {
      checks.push(
        check(
          'context-budget:active-task',
          true,
          'info',
          `Active task ${activeTask.taskId} is within configured context budget.`,
        ),
      );
    }

    return checks;
  } catch (error) {
    return [
      check(
        'context-budget:active-task',
        false,
        'warning',
        error instanceof Error
          ? `Could not check active task context budget: ${error.message}`
          : 'Could not check active task context budget.',
      ),
    ];
  }
}

export async function checkWorkspaceHealth(
  projectRoot: string,
  config: LlmDocsConfig,
): Promise<WorkspaceHealthReport> {
  const paths = resolveWorkspacePaths(projectRoot, config);
  const registryChecks = await checkRegistryHealth(paths);
  const hostConfigChecks = await checkHostConfigHealth(projectRoot, config, paths);
  const launcherChecks = await checkCliLauncherHealth(paths);
  const candidateChecks = await checkCandidateHealth(projectRoot, paths);
  const activeTaskChecks = await checkActiveTaskHealth(paths);
  const protectedBranchActiveTaskChecks = await checkProtectedBranchActiveTaskNotice(
    projectRoot,
    config,
    paths,
  );
  const publishedChecks = await checkPublishedDocsHealth(paths);
  const taskStorageChecks = await checkTaskStorageLayoutHealth(config, paths);
  const seedChecks = await checkWorktreeSeedHealth(paths);
  const agentGuideChecks = await checkAgentGuideHealth(projectRoot, config, paths);
  const contextBudgetChecks = await checkContextBudgetHealth(projectRoot, config, paths);
  const aliasHits = await findExistingLegacyAlias(paths);
  const aliasChecks = aliasHits.map((hit) =>
    check(
      `alias:${hit.kind}`,
      true,
      'warning',
      `Legacy spelling alias detected: ${hit.aliasPath} -> prefer ${hit.canonicalPath}`,
    ),
  );
  const hostHealth = await checkHostPackHealth(projectRoot, config, paths);
  const registry = await readTaskRegistry(paths);

  return {
    checks: [
      check('workspace:config', true, 'info', 'Config loaded successfully.'),
      check(
        'workspace:root',
        await fileExists(paths.workspaceRoot),
        (await fileExists(paths.workspaceRoot)) ? 'info' : 'error',
        (await fileExists(paths.workspaceRoot))
          ? `Workspace root exists: ${paths.relative.workspaceRoot}`
          : `Workspace root missing: ${paths.relative.workspaceRoot}`,
      ),
      ...registryChecks,
      ...hostConfigChecks,
      ...launcherChecks,
      ...candidateChecks,
      ...activeTaskChecks,
      ...protectedBranchActiveTaskChecks,
      ...publishedChecks,
      ...taskStorageChecks,
      ...seedChecks,
      ...agentGuideChecks,
      ...contextBudgetChecks,
      ...aliasChecks,
    ],
    hostHealth,
    registryHealthy: registryChecks.every((item) => item.ok),
    activeTaskId: (await readActiveTaskFile(paths)) ?? registry.activeTaskId,
  };
}

export async function buildDoctorReport(
  projectRoot: string,
  options: { includeLegacy?: boolean } = {},
): Promise<DoctorReport> {
  const configResult = await loadOrMigrateConfig(projectRoot, {
    createIfMissing: false,
    dryRun: true,
  });
  const config = configResult.config;
  const workspaceHealth = await checkWorkspaceHealth(projectRoot, config);
  const legacyChecks = options.includeLegacy
    ? await checkLegacySubsystemHealth(projectRoot, config)
    : [];
  const hostChecks = Object.entries(workspaceHealth.hostHealth).map(([host, ok]) =>
    check(
      `host:${host}`,
      ok,
      ok ? 'info' : 'warning',
      ok ? `${host} host pack looks healthy.` : `${host} host pack is missing or incomplete.`,
    ),
  );
  const checks = [
    ...workspaceHealth.checks,
    ...hostChecks,
    ...legacyChecks,
    ...(configResult.status === 'migrated'
      ? [check('config:migration', true, 'warning', 'Legacy config can be migrated automatically.')]
      : []),
  ];

  return {
    projectRoot,
    ok: checks.every((entry) => entry.severity !== 'error'),
    checks,
  };
}
