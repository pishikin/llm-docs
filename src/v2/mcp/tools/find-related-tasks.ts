import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { V2Runtime } from '../../runtime.js';
import { structuredResponse } from '../common.js';
import { findRelatedTasksInputSchema, findRelatedTasksOutputSchema } from '../schemas.js';

export function registerFindRelatedTasksTool(server: McpServer, runtime: V2Runtime): void {
  server.registerTool(
    'llmdocs.find_related_tasks',
    {
      description: 'Find related tasks by tokens, paths, and tags.',
      inputSchema: findRelatedTasksInputSchema,
      outputSchema: findRelatedTasksOutputSchema,
    },
    async (input) =>
      structuredResponse({
        tasks: await runtime.findRelatedTasks({
          query: input.query,
          paths: input.paths,
          limit: input.limit,
          includeArchived: input.includeArchived,
        }),
      }),
  );
}
