import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LlmDocsRuntime } from '../../runtime.js';
import { structuredResponse } from '../common.js';
import { archiveTaskInputSchema, archiveTaskOutputSchema } from '../schemas.js';

export function registerArchiveTaskTool(server: McpServer, runtime: LlmDocsRuntime): void {
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
