import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createV2Runtime } from '../../src/v2/runtime.js';
import { setActiveTask } from '../../src/v2/task/registry.js';
import {
  bindCodexSessionToTask,
  pauseCodexSessionBinding,
} from '../../src/v2/task/session-binding.js';
import type { ActiveResolutionPolicy } from '../../src/v2/types.js';
import { bootstrapWorkspace } from '../../src/v2/workspace/bootstrap.js';
import { initGitRepo, makeTempProject, prepareV2Workspace } from './v2-test-helpers.js';

const HOOK_POLICY: ActiveResolutionPolicy = {
  includeExplicit: true,
  includeCodexSession: true,
  includeEnv: true,
  includeWorkspaceActive: true,
  includeRegistryActive: true,
  includeBranchName: true,
  includeBranchMapping: true,
  includeCwdBundle: true,
  includeFallbackBranchScan: true,
  bindCodexSession: true,
  protectedBranchBehavior: 'session-or-explicit',
};

describe('active task resolution policy', () => {
  it('ignores workspace ACTIVE and registry active on protected branches with hook policy', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot, 'main');
    const { config } = await prepareV2Workspace(projectRoot);
    await bootstrapWorkspace(projectRoot, config);
    const runtime = await createV2Runtime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Protected passive task',
      source: { type: 'prompt', ref: null, url: null, rawText: 'protected passive' },
    });

    const resolved = await runtime.resolveActiveTask({
      codexSessionId: 'main-passive',
      preferRegistryActive: true,
      policy: HOOK_POLICY,
    });
    const trace = await runtime.traceActiveTaskResolution({
      codexSessionId: 'main-passive',
      preferRegistryActive: true,
      policy: HOOK_POLICY,
    });

    expect(resolved).toBeNull();
    expect(trace.protectedBranch).toBe(true);
    expect(trace.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'active-file', status: 'ignored', taskId: 'ABC-123' }),
        expect.objectContaining({
          source: 'registry-active',
          status: 'ignored',
          taskId: 'ABC-123',
        }),
      ]),
    );
  });

  it('still resolves strong task signals on protected branches', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot, 'main');
    const { config } = await prepareV2Workspace(projectRoot);
    await bootstrapWorkspace(projectRoot, config);
    const runtime = await createV2Runtime(projectRoot);
    const previousEnv = process.env.LLMDOCS_ACTIVE_TASK;

    try {
      await runtime.createTaskBundle({
        taskId: 'ABC-123',
        title: 'Strong protected signal',
        source: { type: 'prompt', ref: null, url: null, rawText: 'strong signal' },
      });
      await bindCodexSessionToTask(runtime.paths, {
        sessionId: 'bound-main-session',
        taskId: 'ABC-123',
        source: 'explicit-user-intent',
      });

      const fromSession = await runtime.resolveActiveTask({
        codexSessionId: 'bound-main-session',
        policy: HOOK_POLICY,
      });
      process.env.LLMDOCS_ACTIVE_TASK = 'ABC-123';
      const fromEnv = await runtime.resolveActiveTask({ policy: HOOK_POLICY });
      Reflect.deleteProperty(process.env, 'LLMDOCS_ACTIVE_TASK');
      const fromCwd = await runtime.resolveActiveTask({
        cwd: path.join(projectRoot, fromSession?.bundlePath ?? '', 'docs'),
        policy: HOOK_POLICY,
      });

      expect(fromSession).toMatchObject({ taskId: 'ABC-123', resolvedBy: 'codex-session' });
      expect(fromEnv).toMatchObject({ taskId: 'ABC-123', resolvedBy: 'env' });
      expect(fromCwd).toMatchObject({ taskId: 'ABC-123', resolvedBy: 'cwd-bundle' });
    } finally {
      if (previousEnv === undefined) {
        Reflect.deleteProperty(process.env, 'LLMDOCS_ACTIVE_TASK');
      } else {
        process.env.LLMDOCS_ACTIVE_TASK = previousEnv;
      }
    }
  });

  it('prefers cwd task bundles over weak workspace and branch fallbacks', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot, 'feature/ABC-123');
    const { config } = await prepareV2Workspace(projectRoot);
    await bootstrapWorkspace(projectRoot, config);
    const runtime = await createV2Runtime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Workspace task',
      source: { type: 'prompt', ref: null, url: null, rawText: 'workspace task' },
    });
    await runtime.createTaskBundle({
      taskId: 'DEF-456',
      title: 'CWD task',
      source: { type: 'prompt', ref: null, url: null, rawText: 'cwd task' },
    });
    await setActiveTask(runtime.paths, 'ABC-123');

    const cwdTask = await runtime.resolveActiveTask({ taskId: 'DEF-456' });
    const resolved = await runtime.resolveActiveTask({
      cwd: path.join(projectRoot, cwdTask?.bundlePath ?? '', 'docs'),
      preferRegistryActive: true,
      policy: HOOK_POLICY,
    });

    expect(resolved).toMatchObject({ taskId: 'DEF-456', resolvedBy: 'cwd-bundle' });
  });

  it('uses branch mapping on feature branches after workspace active is cleared', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot, 'feature/ABC-123');
    const { config } = await prepareV2Workspace(projectRoot);
    await bootstrapWorkspace(projectRoot, config);
    const runtime = await createV2Runtime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Feature branch task',
      source: { type: 'prompt', ref: null, url: null, rawText: 'feature branch' },
    });
    await setActiveTask(runtime.paths, null);

    const resolved = await runtime.resolveActiveTask({
      codexSessionId: 'feature-session',
      bindCodexSession: true,
      preferRegistryActive: true,
      policy: HOOK_POLICY,
    });

    expect(resolved).toMatchObject({ taskId: 'ABC-123', resolvedBy: 'branch-mapping' });
  });

  it('lets paused sessions shadow workspace active state unless task id is explicit', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot, 'feature/ABC-123');
    const { config } = await prepareV2Workspace(projectRoot);
    await bootstrapWorkspace(projectRoot, config);
    const runtime = await createV2Runtime(projectRoot);

    await runtime.createTaskBundle({
      taskId: 'ABC-123',
      title: 'Paused session task',
      source: { type: 'prompt', ref: null, url: null, rawText: 'paused session' },
    });
    await pauseCodexSessionBinding(runtime.paths, { sessionId: 'paused-session' });

    const paused = await runtime.resolveActiveTask({
      codexSessionId: 'paused-session',
      preferRegistryActive: true,
      policy: HOOK_POLICY,
    });
    const explicit = await runtime.resolveActiveTask({
      taskId: 'ABC-123',
      codexSessionId: 'paused-session',
      preferRegistryActive: true,
      policy: HOOK_POLICY,
    });

    expect(paused).toBeNull();
    expect(explicit).toMatchObject({ taskId: 'ABC-123', resolvedBy: 'explicit' });
  });
});
