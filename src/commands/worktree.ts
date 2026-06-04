import { Command } from 'commander';
import worktreeCreateCommand from './worktree-create.js';
import worktreeSeedCommand from './worktree-seed.js';

const worktreeCommand = new Command('worktree').description(
  'Git worktree helpers for llm-docs context seeding',
);

worktreeCommand.addCommand(worktreeSeedCommand);
worktreeCommand.addCommand(worktreeCreateCommand);

export default worktreeCommand;
