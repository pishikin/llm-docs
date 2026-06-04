import fs from 'node:fs/promises';
import path from 'node:path';
import { loadOrMigrateConfig } from './config/load.js';
import { buildGitFacts } from './git/status.js';
import { readActiveTaskFile } from './task/active.js';
import { applyActualizationState, prepareActualization } from './task/actualization.js';
import { archiveTask } from './task/archive.js';
import { attachArtifact } from './task/artifacts.js';
import { protectedBaseBranches, shouldAutoLinkBranch } from './task/branches.js';
import { createTaskBundle, loadTaskBundle } from './task/bundle.js';
import { appendChangelogEpoch } from './task/changelog.js';
import { saveContextCheckpoint } from './task/checkpoint.js';
import { applyTaskClose, prepareTaskClose } from './task/close.js';
import { prepareJiraDoc } from './task/jira-doc.js';
import { readTaskMeta } from './task/meta.js';
import { applyTaskPublish, prepareTaskPublish } from './task/publish.js';
import { buildTaskQualityReport } from './task/quality.js';
import { applyRebaselineState, prepareRebaseline } from './task/rebaseline.js';
import { listTasks, readTaskRegistry, resolveTaskByBranch } from './task/registry.js';
import { findRelatedTasks } from './task/related.js';
import {
  type CodexSessionBindingSource,
  bindCodexSessionToTask,
  clearCodexSessionBinding,
  readCodexSessionBinding,
} from './task/session-binding.js';
import type {
  ActiveResolutionPolicy,
  ActiveResolutionTraceStep,
  ActiveTaskResolution,
  ActiveTaskResolutionTrace,
  AttachArtifactInput,
  LoadOrMigrateConfigOptions,
  RelatedTasksQuery,
  WorkspaceStatusReport,
} from './types.js';
import {
  applyActiveTasksMigration,
  prepareActiveTasksMigration,
} from './workspace/active-task-migration.js';
import { buildDoctorReport, checkWorkspaceHealth } from './workspace/health.js';
import { resolveWorkspacePaths } from './workspace/paths.js';

const DEFAULT_ACTIVE_RESOLUTION_POLICY: Required<ActiveResolutionPolicy> = {
  includeExplicit: true,
  includeCodexSession: true,
  includeEnv: true,
  includeWorkspaceActive: true,
  includeRegistryActive: true,
  includeBranchName: true,
  includeBranchMapping: true,
  includeCwdBundle: true,
  includeFallbackBranchScan: true,
  bindCodexSession: false,
  protectedBranchBehavior: 'normal',
};

function normalizeActiveResolutionPolicy(
  policy: ActiveResolutionPolicy | undefined,
  bindCodexSession: boolean | undefined,
): Required<ActiveResolutionPolicy> {
  return {
    ...DEFAULT_ACTIVE_RESOLUTION_POLICY,
    ...policy,
    bindCodexSession: policy?.bindCodexSession ?? bindCodexSession ?? false,
  };
}

function shouldIgnoreWeakSourcesOnProtectedBranch(
  policy: Required<ActiveResolutionPolicy>,
  protectedBranch: boolean,
): boolean {
  return protectedBranch && policy.protectedBranchBehavior === 'session-or-explicit';
}

export async function createV2Runtime(
  projectRoot: string,
  options: LoadOrMigrateConfigOptions = {},
) {
  const configResult = await loadOrMigrateConfig(projectRoot, options);
  const config = configResult.config;
  const paths = resolveWorkspacePaths(projectRoot, config);

  async function resolveActiveTaskInternal(
    input: {
      taskId?: string | null;
      codexSessionId?: string | null;
      bindCodexSession?: boolean;
      branch?: string | null;
      cwd?: string | null;
      preferRegistryActive?: boolean;
      policy?: ActiveResolutionPolicy;
    },
    options: { collectTraceDetails?: boolean } = {},
  ): Promise<ActiveTaskResolutionTrace> {
    const steps: ActiveResolutionTraceStep[] = [];
    const policy = normalizeActiveResolutionPolicy(input.policy, input.bindCodexSession);
    const branch = input.branch ?? (await buildGitFacts(projectRoot, { config })).branch;
    const protectedBranch = !!branch && protectedBaseBranches(config).has(branch);
    const ignoreWeakSources = shouldIgnoreWeakSourcesOnProtectedBranch(policy, protectedBranch);
    const includeWorkspaceActive = policy.includeWorkspaceActive && !ignoreWeakSources;
    const includeRegistryActive =
      policy.includeRegistryActive && input.preferRegistryActive !== false && !ignoreWeakSources;
    const includeBranchName = policy.includeBranchName && !ignoreWeakSources;
    const includeBranchMapping = policy.includeBranchMapping && !ignoreWeakSources;
    const includeFallbackBranchScan = policy.includeFallbackBranchScan && !ignoreWeakSources;
    const canInferFromBranch = shouldAutoLinkBranch(branch, config);

    function step(stepInput: ActiveResolutionTraceStep): void {
      steps.push(stepInput);
    }

    function finish(resolution: ActiveTaskResolution | null): ActiveTaskResolutionTrace {
      return {
        branch,
        protectedBranch,
        policy,
        resolution,
        steps,
      };
    }

    async function resolveByTaskId(
      taskId: string,
      resolvedBy: ActiveTaskResolution['resolvedBy'],
    ): Promise<ActiveTaskResolution | null> {
      try {
        const meta = await readTaskMeta(paths, taskId);
        return { taskId: meta.task_id, resolvedBy, bundlePath: meta.bundle.path };
      } catch {
        return null;
      }
    }

    async function bindResolution(
      resolution: ActiveTaskResolution | null,
    ): Promise<ActiveTaskResolution | null> {
      if (!resolution || !input.codexSessionId || !policy.bindCodexSession) {
        return resolution;
      }

      const source: CodexSessionBindingSource =
        resolution.resolvedBy === 'explicit' ? 'explicit-user-intent' : resolution.resolvedBy;
      await bindCodexSessionToTask(paths, {
        sessionId: input.codexSessionId,
        taskId: resolution.taskId,
        source,
        bundlePath: resolution.bundlePath,
      });
      return resolution;
    }

    async function resolved(
      resolution: ActiveTaskResolution,
      message: string,
    ): Promise<ActiveTaskResolutionTrace> {
      step({
        source: resolution.resolvedBy,
        status: 'resolved',
        taskId: resolution.taskId,
        message,
      });
      return finish(await bindResolution(resolution));
    }

    async function resolveFromCwdBundle(): Promise<ActiveTaskResolutionTrace | null> {
      const cwd = path.resolve(input.cwd ?? process.cwd());
      const tasksRoot = `${paths.tasksDir}${path.sep}`;

      if (policy.includeCwdBundle && cwd.startsWith(tasksRoot)) {
        const taskId = cwd.slice(tasksRoot.length).split(path.sep)[0];
        if (taskId) {
          try {
            const meta = await readTaskMeta(paths, taskId);
            return resolved(
              { taskId: meta.task_id, resolvedBy: 'cwd-bundle', bundlePath: meta.bundle.path },
              'Resolved from current working directory inside a task bundle.',
            );
          } catch {
            step({
              source: 'cwd-bundle',
              status: 'invalid',
              taskId,
              message: 'Current working directory is inside a missing or invalid task bundle.',
            });
            return null;
          }
        }
      } else if (policy.includeCwdBundle) {
        step({
          source: 'cwd-bundle',
          status: 'missing',
          message: 'Current working directory is not inside a task bundle.',
        });
      } else {
        step({
          source: 'cwd-bundle',
          status: 'ignored',
          message: 'CWD bundle inference is disabled by active resolution policy.',
        });
      }

      return null;
    }

    if (protectedBranch && policy.protectedBranchBehavior === 'session-or-explicit') {
      step({
        source: 'protected-branch',
        status: 'ignored',
        message:
          'Protected branch is using session-or-explicit policy; workspace and branch fallbacks are disabled.',
      });
    }

    if (input.taskId) {
      if (!policy.includeExplicit) {
        step({
          source: 'explicit',
          status: 'ignored',
          taskId: input.taskId,
          message: 'Explicit task id is disabled by active resolution policy.',
        });
      } else {
        const explicitResolution = await resolveByTaskId(input.taskId, 'explicit');
        if (explicitResolution) {
          return resolved(explicitResolution, 'Resolved from explicit task id.');
        }
        step({
          source: 'explicit',
          status: 'invalid',
          taskId: input.taskId,
          message: 'Explicit task id did not resolve to a task bundle.',
        });
      }
    }

    if (input.codexSessionId) {
      if (!policy.includeCodexSession) {
        step({
          source: 'codex-session',
          status: 'ignored',
          message: 'Codex session binding is disabled by active resolution policy.',
        });
      } else {
        const binding = await readCodexSessionBinding(paths, input.codexSessionId);
        if (binding?.paused) {
          step({
            source: 'codex-session-paused',
            status: 'paused',
            taskId: null,
            message: 'Codex session is explicitly paused; no active task is resolved.',
          });
          return finish(null);
        }

        if (binding?.taskId) {
          const boundResolution = await resolveByTaskId(binding.taskId, 'codex-session');
          if (boundResolution) {
            const meta = await readTaskMeta(paths, boundResolution.taskId);
            if (!meta.history.archived && meta.status !== 'archived') {
              step({
                source: 'codex-session',
                status: 'resolved',
                taskId: boundResolution.taskId,
                message: 'Resolved from Codex session binding.',
              });
              return finish(boundResolution);
            }
          }
          await clearCodexSessionBinding(paths, input.codexSessionId);
          step({
            source: 'codex-session',
            status: 'invalid',
            taskId: binding.taskId,
            message: 'Codex session binding pointed to a missing or archived task and was cleared.',
          });
        } else {
          step({
            source: 'codex-session',
            status: 'missing',
            message: 'No Codex session binding found.',
          });
        }
      }
    }

    if (process.env.LLMDOCS_ACTIVE_TASK) {
      if (!policy.includeEnv) {
        step({
          source: 'env',
          status: 'ignored',
          taskId: process.env.LLMDOCS_ACTIVE_TASK,
          message: 'LLMDOCS_ACTIVE_TASK is disabled by active resolution policy.',
        });
      } else {
        const envResolved = await resolveByTaskId(process.env.LLMDOCS_ACTIVE_TASK, 'env');
        if (envResolved) {
          return resolved(envResolved, 'Resolved from LLMDOCS_ACTIVE_TASK.');
        }
        step({
          source: 'env',
          status: 'invalid',
          taskId: process.env.LLMDOCS_ACTIVE_TASK,
          message: 'LLMDOCS_ACTIVE_TASK did not resolve to a task bundle.',
        });
      }
    } else {
      step({ source: 'env', status: 'missing', message: 'LLMDOCS_ACTIVE_TASK is not set.' });
    }

    const cwdResolution = await resolveFromCwdBundle();
    if (cwdResolution) {
      return cwdResolution;
    }

    if (includeWorkspaceActive) {
      const activeFileTaskId = await readActiveTaskFile(paths);
      if (activeFileTaskId) {
        const activeFileResolved = await resolveByTaskId(activeFileTaskId, 'active-file');
        if (activeFileResolved) {
          return resolved(activeFileResolved, 'Resolved from workspace ACTIVE file.');
        }
        step({
          source: 'active-file',
          status: 'invalid',
          taskId: activeFileTaskId,
          message: 'Workspace ACTIVE file points to a missing task bundle.',
        });
      } else {
        step({
          source: 'active-file',
          status: 'missing',
          message: 'Workspace ACTIVE file is empty.',
        });
      }
    } else if (policy.includeWorkspaceActive) {
      const taskId = options.collectTraceDetails ? await readActiveTaskFile(paths) : null;
      step({
        source: 'active-file',
        status: 'ignored',
        taskId,
        message: protectedBranch
          ? 'Workspace ACTIVE file is ignored on protected branch by session-or-explicit policy.'
          : 'Workspace ACTIVE file is disabled by active resolution policy.',
      });
    }

    if (includeBranchName && canInferFromBranch && branch) {
      const branchNameResolved = await resolveByTaskId(branch, 'branch-name');
      if (branchNameResolved) {
        return resolved(branchNameResolved, 'Resolved from branch name matching a task id.');
      }
      step({
        source: 'branch-name',
        status: 'missing',
        taskId: branch,
        message: 'Current branch name does not match a task id.',
      });
    } else if (policy.includeBranchName) {
      step({
        source: 'branch-name',
        status: ignoreWeakSources ? 'ignored' : 'missing',
        taskId: branch,
        message: ignoreWeakSources
          ? 'Branch-name task inference is ignored on protected branch by session-or-explicit policy.'
          : 'Current branch is not eligible for automatic task inference.',
      });
    }

    if (includeBranchMapping && canInferFromBranch && branch) {
      const entry = await resolveTaskByBranch(paths, branch);
      if (entry) {
        return resolved(
          { taskId: entry.taskId, resolvedBy: 'branch-mapping', bundlePath: entry.bundlePath },
          'Resolved from branch-to-task mapping.',
        );
      }
      step({
        source: 'branch-mapping',
        status: 'missing',
        taskId: branch,
        message: 'No branch-to-task mapping found for current branch.',
      });
    } else if (policy.includeBranchMapping) {
      step({
        source: 'branch-mapping',
        status: ignoreWeakSources ? 'ignored' : 'missing',
        taskId: branch,
        message: ignoreWeakSources
          ? 'Branch mapping is ignored on protected branch by session-or-explicit policy.'
          : 'Current branch is not eligible for automatic task inference.',
      });
    }

    let registry = null as Awaited<ReturnType<typeof readTaskRegistry>> | null;
    if (includeRegistryActive) {
      registry = await readTaskRegistry(paths);
      if (registry.activeTaskId) {
        const entry = registry.tasks[registry.activeTaskId];
        if (entry) {
          return resolved(
            {
              taskId: entry.taskId,
              resolvedBy: 'registry-active',
              bundlePath: entry.bundlePath,
            },
            'Resolved from registry.activeTaskId.',
          );
        }
        step({
          source: 'registry-active',
          status: 'invalid',
          taskId: registry.activeTaskId,
          message: 'registry.activeTaskId points to a missing task entry.',
        });
      } else {
        step({
          source: 'registry-active',
          status: 'missing',
          message: 'registry.activeTaskId is not set.',
        });
      }
    } else if (policy.includeRegistryActive) {
      registry = options.collectTraceDetails ? await readTaskRegistry(paths) : null;
      step({
        source: 'registry-active',
        status: 'ignored',
        taskId: registry?.activeTaskId ?? null,
        message: protectedBranch
          ? 'registry.activeTaskId is ignored on protected branch by session-or-explicit policy.'
          : 'registry.activeTaskId is disabled by active resolution policy.',
      });
    }

    if (includeFallbackBranchScan && canInferFromBranch && branch) {
      try {
        const taskDirs = await fs.readdir(paths.tasksDir, { withFileTypes: true });
        for (const entry of taskDirs) {
          if (!entry.isDirectory()) {
            continue;
          }
          try {
            const meta = await readTaskMeta(paths, entry.name);
            if (meta.branch.current === branch) {
              return resolved(
                { taskId: meta.task_id, resolvedBy: 'branch-scan', bundlePath: meta.bundle.path },
                'Resolved by scanning task bundles for the current branch.',
              );
            }
          } catch {
            // Ignore invalid task directories during fallback resolution.
          }
        }
        step({
          source: 'branch-scan',
          status: 'missing',
          taskId: branch,
          message: 'No task bundle has current branch matching the current branch.',
        });
      } catch {
        step({
          source: 'branch-scan',
          status: 'missing',
          message: 'Task directory is not available for branch scan.',
        });
      }
    } else if (policy.includeFallbackBranchScan) {
      step({
        source: 'branch-scan',
        status: ignoreWeakSources ? 'ignored' : 'missing',
        taskId: branch,
        message: ignoreWeakSources
          ? 'Fallback branch scan is ignored on protected branch by session-or-explicit policy.'
          : 'Current branch is not eligible for fallback branch scan.',
      });
    }

    return finish(null);
  }

  async function resolveActiveTask(input: {
    taskId?: string | null;
    codexSessionId?: string | null;
    bindCodexSession?: boolean;
    branch?: string | null;
    cwd?: string | null;
    preferRegistryActive?: boolean;
    policy?: ActiveResolutionPolicy;
  }): Promise<ActiveTaskResolution | null> {
    return (await resolveActiveTaskInternal(input)).resolution;
  }

  async function traceActiveTaskResolution(
    input: {
      taskId?: string | null;
      codexSessionId?: string | null;
      bindCodexSession?: boolean;
      branch?: string | null;
      cwd?: string | null;
      preferRegistryActive?: boolean;
      policy?: ActiveResolutionPolicy;
    } = {},
  ): Promise<ActiveTaskResolutionTrace> {
    return resolveActiveTaskInternal(input, { collectTraceDetails: true });
  }

  async function workspaceStatus(): Promise<WorkspaceStatusReport> {
    const workspaceHealth = await checkWorkspaceHealth(projectRoot, config);
    return {
      projectRoot,
      configPath: paths.configPath,
      workspaceRoot: paths.workspaceRoot,
      activeTaskId: workspaceHealth.activeTaskId,
      registryHealthy: workspaceHealth.registryHealthy,
      hostHealth: workspaceHealth.hostHealth,
    };
  }

  return {
    projectRoot,
    config,
    configResult,
    paths,
    createTaskBundle: (input: Parameters<typeof createTaskBundle>[3]) =>
      createTaskBundle(projectRoot, config, paths, input),
    loadTaskBundle: (taskId: string, options?: Parameters<typeof loadTaskBundle>[2]) =>
      loadTaskBundle(paths, taskId, options),
    appendChangelogEpoch: (taskId: string, input: Parameters<typeof appendChangelogEpoch>[2]) =>
      appendChangelogEpoch(paths, taskId, input),
    saveContextCheckpoint: (taskId: string, input: Parameters<typeof saveContextCheckpoint>[4]) =>
      saveContextCheckpoint(projectRoot, config, paths, taskId, input),
    attachArtifact: (taskId: string, input: AttachArtifactInput) =>
      attachArtifact(projectRoot, config, paths, taskId, input),
    prepareActualization: (taskId: string, options?: Parameters<typeof prepareActualization>[4]) =>
      prepareActualization(projectRoot, config, paths, taskId, options),
    applyActualizationState: (
      taskId: string,
      input: Parameters<typeof applyActualizationState>[3],
    ) => applyActualizationState(config, paths, taskId, input),
    prepareRebaseline: (taskId: string, options?: Parameters<typeof prepareRebaseline>[4]) =>
      prepareRebaseline(projectRoot, config, paths, taskId, options),
    applyRebaselineState: (taskId: string, input: Parameters<typeof applyRebaselineState>[3]) =>
      applyRebaselineState(config, paths, taskId, input),
    prepareTaskPublish: (input: Parameters<typeof prepareTaskPublish>[3]) =>
      prepareTaskPublish(projectRoot, config, paths, input),
    buildTaskQualityReport: (taskId: string) =>
      buildTaskQualityReport({ projectRoot, config, paths, taskId }),
    applyTaskPublish: (input: Parameters<typeof applyTaskPublish>[3]) =>
      applyTaskPublish(projectRoot, config, paths, input),
    prepareTaskClose: (input: Parameters<typeof prepareTaskClose>[3]) =>
      prepareTaskClose(projectRoot, config, paths, input),
    applyTaskClose: (input: Parameters<typeof applyTaskClose>[3]) =>
      applyTaskClose(projectRoot, config, paths, input),
    prepareJiraDoc: (input: Parameters<typeof prepareJiraDoc>[2]) =>
      prepareJiraDoc(config, paths, input),
    prepareActiveTasksMigration: (input?: Parameters<typeof prepareActiveTasksMigration>[3]) =>
      prepareActiveTasksMigration(projectRoot, config, paths, input),
    applyActiveTasksMigration: (input?: Parameters<typeof applyActiveTasksMigration>[3]) =>
      applyActiveTasksMigration(projectRoot, config, paths, input),
    archiveTask: (taskId: string, reason: string) => archiveTask(paths, taskId, reason),
    findRelatedTasks: (query: RelatedTasksQuery) => findRelatedTasks(paths, query),
    listTasks: (filters?: Parameters<typeof listTasks>[1]) => listTasks(paths, filters),
    readTaskRegistry: () => readTaskRegistry(paths),
    readTaskMeta: (taskId: string) => readTaskMeta(paths, taskId),
    resolveActiveTask,
    traceActiveTaskResolution,
    workspaceStatus,
    doctorReport: (doctorOptions?: { includeLegacy?: boolean }) =>
      buildDoctorReport(projectRoot, doctorOptions),
  };
}

export type V2Runtime = Awaited<ReturnType<typeof createV2Runtime>>;
