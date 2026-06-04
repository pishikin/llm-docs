import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LlmDocsRuntime } from '../../runtime.js';
import { structuredResponse } from '../common.js';
import { listTasksInputSchema, listTasksOutputSchema } from '../schemas.js';

export function registerListTasksTool(server: McpServer, runtime: LlmDocsRuntime): void {
  server.registerTool(
    'llmdocs.list_tasks',
    {
      description: 'List tasks from the registry with filters.',
      inputSchema: listTasksInputSchema,
      outputSchema: listTasksOutputSchema,
    },
    async (input) => structuredResponse({ tasks: await runtime.listTasks(input) }),
  );
}
