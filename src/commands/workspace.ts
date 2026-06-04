import { Command } from 'commander';
import workspaceMigrateActiveTasksCommand from './workspace-migrate-active-tasks.js';

const workspaceCommand = new Command('workspace').description('Workspace maintenance operations');

workspaceCommand.addCommand(workspaceMigrateActiveTasksCommand);

export default workspaceCommand;
