import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LlmDocsRuntime } from '../../runtime.js';
import { structuredResponse } from '../common.js';
import { prepareActualizationInputSchema, prepareActualizationOutputSchema } from '../schemas.js';

export function registerPrepareActualizationTool(server: McpServer, runtime: LlmDocsRuntime): void {
  server.registerTool(
    'llmdocs.prepare_actualization',
    {
      description: 'Compute a deterministic actualization report for the task bundle.',
      inputSchema: prepareActualizationInputSchema,
      outputSchema: prepareActualizationOutputSchema,
    },
    async (input) =>
      structuredResponse(
        await runtime.prepareActualization(input.taskId, {
          fromCommit: input.fromCommit,
          includeRelatedTasks: input.includeRelatedTasks,
        }),
      ),
  );
}
