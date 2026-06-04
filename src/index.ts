import { Command } from 'commander';
import contextCommand from './commands/context.js';
import doctorCommand from './commands/doctor.js';
import generateCommand from './commands/generate.js';
import initCommand from './commands/init.js';
import internalCommandGroup from './commands/internal/index.js';
import jiraCommand from './commands/jira.js';
import researchCommand from './commands/research.js';
import serverCommand from './commands/server.js';
import setupCommand from './commands/setup.js';
import syncCommand from './commands/sync.js';
import taskCommand from './commands/task.js';
import validateCommand from './commands/validate.js';
import workspaceCommand from './commands/workspace.js';
import worktreeCommand from './commands/worktree.js';
import { setLogLevel } from './utils/logger.js';

const program = new Command();

program
  .name('llm-docs')
  .description(
    'Context operations layer for coding agents with task bundles, MCP, hooks, and legacy docs support',
  )
  .version('0.1.0')
  .option('--verbose', 'verbose output')
  .option('--quiet', 'suppress output')
  .hook('preAction', (cmd) => {
    const opts = cmd.optsWithGlobals<{ verbose?: boolean; quiet?: boolean }>();
    setLogLevel({ verbose: opts.verbose, quiet: opts.quiet });
  });

async function main() {
  program.addCommand(setupCommand);
  program.addCommand(serverCommand);
  program.addCommand(doctorCommand);
  program.addCommand(contextCommand);
  program.addCommand(taskCommand);
  program.addCommand(jiraCommand);
  program.addCommand(workspaceCommand);
  program.addCommand(worktreeCommand);
  program.addCommand(researchCommand);
  program.addCommand(internalCommandGroup, { hidden: true });
  program.addCommand(initCommand);
  program.addCommand(generateCommand);
  program.addCommand(syncCommand);
  program.addCommand(validateCommand);
  await program.parseAsync();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
