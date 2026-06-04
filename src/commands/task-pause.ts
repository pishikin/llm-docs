import { Command } from 'commander';
import { getProjectRoot } from '../utils/fs.js';
import { createV2Runtime } from '../v2/runtime.js';
import { activeTaskFileRelativePath } from '../v2/task/active.js';
import { setActiveTask } from '../v2/task/registry.js';
import {
  codexSessionBindingRelativePath,
  pauseCodexSessionBinding,
  resolveCodexSessionIdFromEnv,
} from '../v2/task/session-binding.js';

export interface TaskPauseOptions {
  session?: boolean;
  workspace?: boolean;
  sessionId?: string;
  json?: boolean;
}

export interface TaskPauseResult {
  paused: true;
  scope: 'codex-session' | 'workspace';
  taskId: null;
  sessionId?: string;
  bindingPath?: string;
  activeFile?: string;
}

export async function pauseTaskContext(options: TaskPauseOptions): Promise<TaskPauseResult> {
  const projectRoot = await getProjectRoot();
  const runtime = await createV2Runtime(projectRoot);
  const sessionId = options.sessionId ?? resolveCodexSessionIdFromEnv();
  const useSessionScope =
    options.session || !!options.sessionId || (!options.workspace && !!sessionId);

  if (options.session && options.workspace) {
    throw new Error('Choose either --session or --workspace, not both.');
  }

  if (useSessionScope) {
    if (!sessionId) {
      throw new Error(
        'Cannot pause a Codex session because no session id is available. Pass --session-id <id>.',
      );
    }

    await pauseCodexSessionBinding(runtime.paths, { sessionId });
    return {
      paused: true,
      scope: 'codex-session',
      taskId: null,
      sessionId,
      bindingPath: codexSessionBindingRelativePath(runtime.paths, sessionId),
    };
  }

  await setActiveTask(runtime.paths, null);
  return {
    paused: true,
    scope: 'workspace',
    taskId: null,
    activeFile: activeTaskFileRelativePath(runtime.paths),
  };
}

export function printTaskPauseResult(result: TaskPauseResult, json?: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.scope === 'codex-session') {
    console.log('Codex session task context paused.');
    console.log(`Session: ${result.sessionId}`);
    console.log(`Binding: ${result.bindingPath}`);
    return;
  }

  console.log('Workspace active task cleared.');
  console.log(`Active file: ${result.activeFile}`);
}

const taskPauseCommand = new Command('pause')
  .description('Pause active llm-docs task context for this Codex session or workspace')
  .option('--session', 'pause task context for the current Codex session')
  .option('--workspace', 'clear the workspace active task')
  .option('--session-id <id>', 'Codex session id to pause; implies --session')
  .option('--json', 'print JSON output')
  .action(async (options: TaskPauseOptions) => {
    const result = await pauseTaskContext(options);
    printTaskPauseResult(result, options.json);
  });

export default taskPauseCommand;
