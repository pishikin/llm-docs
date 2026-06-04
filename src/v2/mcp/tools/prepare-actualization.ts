import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { V2Runtime } from '../../runtime.js';
import { structuredResponse } from '../common.js';
import { prepareActualizationInputSchema, prepareActualizationOutputSchema } from '../schemas.js';

export function registerPrepareActualizationTool(server: McpServer, runtime: V2Runtime): void {
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
