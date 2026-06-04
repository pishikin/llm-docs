import { Command } from 'commander';
import { createRuntime } from '../engine/runtime.js';
import {
  clearCodexSessionBinding,
  codexSessionBindingRelativePath,
  readCodexSessionBinding,
  resolveCodexSessionIdFromEnv,
} from '../engine/task/session-binding.js';
import type { ActiveResolutionPolicy, ActiveTaskResolutionTrace } from '../engine/types.js';
import { getProjectRoot } from '../utils/fs.js';

interface TaskActiveOptions {
  sessionId?: string;
  clearSession?: boolean;
  trace?: boolean;
  json?: boolean;
}

const TRACE_ACTIVE_RESOLUTION_POLICY: ActiveResolutionPolicy = {
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
  protectedBranchBehavior: 'session-or-explicit',
};

function printTrace(trace: ActiveTaskResolutionTrace, sessionId: string | null): void {
  console.log(`Current branch: ${trace.branch ?? 'n/a'}`);
  console.log(`Protected branch: ${trace.protectedBranch ? 'yes' : 'no'}`);
  if (sessionId) {
    console.log(`Codex session: ${sessionId}`);
  }
  console.log('');
  console.log('Checked:');
  for (const step of trace.steps) {
    const taskSuffix = step.taskId ? ` (${step.taskId})` : '';
    console.log(`- ${step.source}: ${step.status}${taskSuffix} — ${step.message}`);
  }
  console.log('');
  console.log('Result:');
  if (trace.resolution) {
    console.log(`Active task: ${trace.resolution.taskId}`);
    console.log(`Source: ${trace.resolution.resolvedBy}`);
    console.log(`Bundle: ${trace.resolution.bundlePath}`);
    return;
  }

  console.log('No active task in this session.');
}

const taskActiveCommand = new Command('active')
  .description('Show active task resolution and Codex session binding')
  .option('--session-id <id>', 'Codex session id to inspect or clear')
  .option('--clear-session', 'clear the Codex session binding')
  .option('--trace', 'explain active task resolution using Codex hook passive policy')
  .option('--json', 'print JSON output')
  .action(async (options: TaskActiveOptions) => {
    const projectRoot = await getProjectRoot();
    const runtime = await createRuntime(projectRoot);
    const sessionId = options.sessionId ?? resolveCodexSessionIdFromEnv();

    if (options.clearSession) {
      if (!sessionId) {
        throw new Error('Cannot clear Codex session binding without --session-id <id>.');
      }

      await clearCodexSessionBinding(runtime.paths, sessionId);
      const result = {
        cleared: true,
        sessionId,
        bindingPath: codexSessionBindingRelativePath(runtime.paths, sessionId),
      };

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`Cleared Codex session binding: ${result.bindingPath}`);
      return;
    }

    if (options.trace) {
      const trace = await runtime.traceActiveTaskResolution({
        preferRegistryActive: true,
        codexSessionId: sessionId,
        bindCodexSession: false,
        policy: TRACE_ACTIVE_RESOLUTION_POLICY,
      });
      const binding = sessionId ? await readCodexSessionBinding(runtime.paths, sessionId) : null;
      const result = {
        taskId: trace.resolution?.taskId ?? null,
        resolvedBy: trace.resolution?.resolvedBy ?? null,
        bundlePath: trace.resolution?.bundlePath ?? null,
        trace,
        codexSession: sessionId
          ? {
              sessionId,
              bindingPath: codexSessionBindingRelativePath(runtime.paths, sessionId),
              binding,
            }
          : null,
      };

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      printTrace(trace, sessionId ?? null);
      return;
    }

    const activeTask = await runtime.resolveActiveTask({
      preferRegistryActive: true,
      codexSessionId: sessionId,
      bindCodexSession: false,
    });
    const binding = sessionId ? await readCodexSessionBinding(runtime.paths, sessionId) : null;
    const result = {
      taskId: activeTask?.taskId ?? null,
      resolvedBy: activeTask?.resolvedBy ?? null,
      bundlePath: activeTask?.bundlePath ?? null,
      codexSession: sessionId
        ? {
            sessionId,
            bindingPath: codexSessionBindingRelativePath(runtime.paths, sessionId),
            binding,
          }
        : null,
    };

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`Active task: ${result.taskId ?? 'none'}`);
    if (result.resolvedBy) {
      console.log(`Resolved by: ${result.resolvedBy}`);
    }
    if (result.bundlePath) {
      console.log(`Bundle: ${result.bundlePath}`);
    }
    if (result.codexSession) {
      console.log(`Session: ${result.codexSession.sessionId}`);
      console.log(`Binding: ${result.codexSession.bindingPath}`);
      console.log(`Bound task: ${binding?.taskId ?? 'none'}`);
    }
  });

export default taskActiveCommand;
