import { Command } from 'commander';
import { registerGitHookCommands } from './git.js';
import { registerHostHookCommands } from './hooks.js';

const command = new Command('internal')
  .description('Internal llm-docs commands for hooks and automation')
  .allowExcessArguments(true);

registerHostHookCommands(command);
registerGitHookCommands(command);

export default command;
