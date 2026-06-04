import { Command } from 'commander';
import { getProjectRoot } from '../utils/fs.js';
import { importJiraTaskBundle } from '../v2/integrations/jira/from-jira.js';
import type { JiraTaskImportResult } from '../v2/integrations/jira/types.js';
import { createV2Runtime } from '../v2/runtime.js';
import { setActiveTask } from '../v2/task/registry.js';
import {
  bindCodexSessionToTask,
  codexSessionBindingRelativePath,
  resolveCodexSessionIdFromEnv,
} from '../v2/task/session-binding.js';

interface TaskFromJiraOptions {
  attachments?: boolean;
  force?: boolean;
  use?: boolean;
  session?: boolean;
  sessionId?: string;
  profile?: string;
  json?: boolean;
}

async function activateImportedTask(
  runtime: Awaited<ReturnType<typeof createV2Runtime>>,
  result: JiraTaskImportResult,
  options: TaskFromJiraOptions,
): Promise<JiraTaskImportResult> {
  if (!options.use) {
    return result;
  }

  const sessionId = options.sessionId ?? resolveCodexSessionIdFromEnv();
  if (options.session || sessionId) {
    if (!sessionId) {
      throw new Error(
        'Cannot bind imported Jira task to a Codex session without --session-id <id>.',
      );
    }

    await bindCodexSessionToTask(runtime.paths, {
      sessionId,
      taskId: result.taskId,
      source: 'explicit-user-intent',
      bundlePath: result.bundlePath,
    });

    return {
      ...result,
      activeScope: 'codex-session',
      sessionId,
    };
  }

  await setActiveTask(runtime.paths, result.taskId);

  return {
    ...result,
    activeScope: 'workspace',
    sessionId: null,
  };
}

const taskFromJiraCommand = new Command('from-jira')
  .description('Create or refresh a task bundle from a Jira issue')
  .argument('<issueKey>', 'Jira issue key, for example PROJ-286')
  .option('--attachments', 'download Jira attachments and sync them into the task bundle')
  .option('--force', 're-download source files')
  .option('--use', 'make the imported task active')
  .option('--session', 'with --use, bind the task to the current Codex session only')
  .option('--session-id <id>', 'Codex session id to bind; implies --session when --use is set')
  .option('--profile <name>', 'Jira auth profile name')
  .option('--json', 'print JSON output')
  .action(async (issueKey: string, options: TaskFromJiraOptions) => {
    const projectRoot = await getProjectRoot();
    const runtime = await createV2Runtime(projectRoot, { createIfMissing: false });
    const imported = await importJiraTaskBundle(
      projectRoot,
      runtime.config,
      runtime.paths,
      issueKey,
      {
        attachments: options.attachments,
        force: options.force,
        profile: options.profile,
        createIfExists: true,
      },
    );
    const result = await activateImportedTask(runtime, imported, options);

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`${result.created ? 'Created' : 'Updated'} task: ${result.taskId}`);
    console.log(`Bundle: ${result.bundlePath}`);
    console.log(`Jira source: ${result.issuePath}`);
    console.log(`Artifacts: ${result.artifacts.length}`);
    if (result.activeScope === 'workspace') {
      console.log('Active scope: workspace');
    }
    if (result.activeScope === 'codex-session' && result.sessionId) {
      console.log('Active scope: codex-session');
      console.log(`Binding: ${codexSessionBindingRelativePath(runtime.paths, result.sessionId)}`);
    }
  });

export default taskFromJiraCommand;
