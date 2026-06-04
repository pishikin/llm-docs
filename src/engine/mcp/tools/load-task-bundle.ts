import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LlmDocsRuntime } from '../../runtime.js';
import { structuredResponse } from '../common.js';
import { loadTaskBundleInputSchema, loadTaskBundleOutputSchema } from '../schemas.js';

export function registerLoadTaskBundleTool(server: McpServer, runtime: LlmDocsRuntime): void {
  server.registerTool(
    'llmdocs.load_task_bundle',
    {
      description: 'Load bundle metadata, registry summary, docs, and artifact index.',
      inputSchema: loadTaskBundleInputSchema,
      outputSchema: loadTaskBundleOutputSchema,
    },
    async (input) =>
      structuredResponse(
        await runtime.loadTaskBundle(input.taskId, {
          includeContents: input.includeContents,
          includeArtifacts: input.includeArtifacts,
        }),
      ),
  );
}
