import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LlmDocsRuntime } from '../../runtime.js';
import { structuredResponse } from '../common.js';
import { createTaskBundleInputSchema, createTaskBundleOutputSchema } from '../schemas.js';

export function registerCreateTaskBundleTool(server: McpServer, runtime: LlmDocsRuntime): void {
  server.registerTool(
    'llmdocs.create_task_bundle',
    {
      description: 'Create a task bundle with context, structured state, and registry entry.',
      inputSchema: createTaskBundleInputSchema,
      outputSchema: createTaskBundleOutputSchema,
    },
    async (input) => structuredResponse(await runtime.createTaskBundle(input)),
  );
}
