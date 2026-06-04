import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { V2Runtime } from '../runtime.js';
import { registerActiveTaskCardResource } from './resources/active-task-card.js';
import { registerRegistryResource } from './resources/registry.js';
import { registerTaskBundleResource } from './resources/task-bundle.js';
import { registerAppendChangelogEpochTool } from './tools/append-changelog-epoch.js';
import { registerApplyActualizationStateTool } from './tools/apply-actualization-state.js';
import { registerApplyRebaselineStateTool } from './tools/apply-rebaseline-state.js';
import { registerApplyTaskPublishTool } from './tools/apply-task-publish.js';
import { registerArchiveTaskTool } from './tools/archive-task.js';
import { registerAttachArtifactTool } from './tools/attach-artifact.js';
import { registerCreateTaskBundleTool } from './tools/create-task-bundle.js';
import { registerFindRelatedTasksTool } from './tools/find-related-tasks.js';
import { registerListTasksTool } from './tools/list-tasks.js';
import { registerLoadTaskBundleTool } from './tools/load-task-bundle.js';
import { registerPrepareActualizationTool } from './tools/prepare-actualization.js';
import { registerPrepareJiraDocTool } from './tools/prepare-jira-doc.js';
import { registerPrepareRebaselineTool } from './tools/prepare-rebaseline.js';
import { registerPrepareTaskPublishTool } from './tools/prepare-task-publish.js';
import { registerResolveActiveTaskTool } from './tools/resolve-active-task.js';
import { registerSaveContextCheckpointTool } from './tools/save-context-checkpoint.js';
import { registerWorkspaceStatusTool } from './tools/workspace-status.js';

export function createMcpServer(runtime: V2Runtime): McpServer {
  const server = new McpServer({
    name: 'llm-docs',
    version: '0.1.0',
  });

  registerWorkspaceStatusTool(server, runtime);
  registerListTasksTool(server, runtime);
  registerResolveActiveTaskTool(server, runtime);
  registerCreateTaskBundleTool(server, runtime);
  registerLoadTaskBundleTool(server, runtime);
  registerPrepareJiraDocTool(server, runtime);
  registerAppendChangelogEpochTool(server, runtime);
  registerSaveContextCheckpointTool(server, runtime);
  registerAttachArtifactTool(server, runtime);
  registerPrepareActualizationTool(server, runtime);
  registerApplyActualizationStateTool(server, runtime);
  registerPrepareRebaselineTool(server, runtime);
  registerApplyRebaselineStateTool(server, runtime);
  registerArchiveTaskTool(server, runtime);
  registerPrepareTaskPublishTool(server, runtime);
  registerApplyTaskPublishTool(server, runtime);
  registerFindRelatedTasksTool(server, runtime);

  registerRegistryResource(server, runtime);
  registerActiveTaskCardResource(server, runtime);
  registerTaskBundleResource(server, runtime);

  return server;
}

export async function startMcpServer(runtime: V2Runtime): Promise<void> {
  const server = createMcpServer(runtime);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
