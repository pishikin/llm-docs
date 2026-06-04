import { Command } from 'commander';
import { getProjectRoot } from '../utils/fs.js';
import { createV2Runtime } from '../v2/runtime.js';
import { activeTaskFileRelativePath, writeActiveTaskFile } from '../v2/task/active.js';
import { normalizeTaskId } from '../v2/task/id.js';
import { setActiveTask } from '../v2/task/registry.js';
import {
  bindCodexSessionToTask,
  codexSessionBindingRelativePath,
  resolveCodexSessionIdFromEnv,
} from '../v2/task/session-binding.js';
import { pauseTaskContext, printTaskPauseResult } from './task-pause.js';

const taskUseCommand = new Command('use')
  .description('Set the explicit active llm-docs task for this workspace or Codex session')
  .argument('[taskId]', 'task id to mark active')
  .option('--session', 'bind this task to the current Codex session only')
  .option('--session-id <id>', 'Codex session id to bind; implies --session')
  .option('--none', 'clear or pause active task context instead of selecting a task')
  .option('--workspace', 'with --none, clear the workspace active task')
  .option('--json', 'print JSON output')
  .action(
    async (
      taskId: string | undefined,
      options: {
        session?: boolean;
        sessionId?: string;
        none?: boolean;
        workspace?: boolean;
        json?: boolean;
      },
    ) => {
      if (options.none) {
        const result = await pauseTaskContext({
          session: options.session,
          workspace: options.workspace,
          sessionId: options.sessionId,
        });
        printTaskPauseResult(result, options.json);
        return;
      }

      if (!taskId) {
        throw new Error('Missing task id. Pass a task id or use --none.');
      }

      const projectRoot = await getProjectRoot();
      const runtime = await createV2Runtime(projectRoot);
      const normalizedTaskId = normalizeTaskId(taskId);
      const resolved = await runtime.resolveActiveTask({ taskId: normalizedTaskId });

      if (!resolved) {
        throw new Error(`Task bundle not found: ${normalizedTaskId}`);
      }

      const sessionId = options.sessionId ?? resolveCodexSessionIdFromEnv();
      if (options.session || options.sessionId) {
        if (!sessionId) {
          throw new Error(
            'Cannot bind a Codex session because no session id is available. Pass --session-id <id>.',
          );
        }

        await bindCodexSessionToTask(runtime.paths, {
          sessionId,
          taskId: normalizedTaskId,
          source: 'explicit-user-intent',
          bundlePath: resolved.bundlePath,
        });

        const result = {
          taskId: normalizedTaskId,
          scope: 'codex-session',
          sessionId,
          bindingPath: codexSessionBindingRelativePath(runtime.paths, sessionId),
          bundlePath: resolved.bundlePath,
        };

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(`Codex session active task: ${normalizedTaskId}`);
        console.log(`Session: ${sessionId}`);
        console.log(`Binding: ${result.bindingPath}`);
        console.log(`Bundle: ${resolved.bundlePath}`);
        return;
      }

      await writeActiveTaskFile(runtime.paths, normalizedTaskId);
      try {
        await setActiveTask(runtime.paths, normalizedTaskId);
      } catch {
        // Simple and imported tasks may be usable even if the legacy registry is incomplete.
      }

      const result = {
        taskId: normalizedTaskId,
        scope: 'workspace',
        activeFile: activeTaskFileRelativePath(runtime.paths),
        bundlePath: resolved.bundlePath,
      };

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`Active task: ${normalizedTaskId}`);
      console.log(`Bundle: ${resolved.bundlePath}`);
    },
  );

export default taskUseCommand;
