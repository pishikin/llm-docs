import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { V2Runtime } from '../../runtime.js';
import { structuredResponse } from '../common.js';
import { archiveTaskInputSchema, archiveTaskOutputSchema } from '../schemas.js';

export function registerArchiveTaskTool(server: McpServer, runtime: V2Runtime): void {
  server.registerTool(
    'llmdocs.archive_task',
    {
      description: 'Archive a task and remove it from active focus.',
      inputSchema: archiveTaskInputSchema,
      outputSchema: archiveTaskOutputSchema,
    },
    async (input) => structuredResponse(await runtime.archiveTask(input.taskId, input.reason)),
  );
}
