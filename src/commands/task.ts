import { Command } from 'commander';
import taskActiveCommand from './task-active.js';
import taskCheckpointCommand from './task-checkpoint.js';
import taskCloseCommand from './task-close.js';
import taskFromJiraCommand from './task-from-jira.js';
import taskPauseCommand from './task-pause.js';
import taskPublishCommand from './task-publish.js';
import taskQualityCommand from './task-quality.js';
import taskSimplifyCommand from './task-simplify.js';
import taskUseCommand from './task-use.js';

const taskCommand = new Command('task').description('Task bundle lifecycle operations');

taskCommand.addCommand(taskActiveCommand);
taskCommand.addCommand(taskUseCommand);
taskCommand.addCommand(taskPauseCommand);
taskCommand.addCommand(taskFromJiraCommand);
taskCommand.addCommand(taskCheckpointCommand);
taskCommand.addCommand(taskCloseCommand);
taskCommand.addCommand(taskSimplifyCommand);
taskCommand.addCommand(taskPublishCommand);
taskCommand.addCommand(taskQualityCommand);

export default taskCommand;
