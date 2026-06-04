import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { V2Runtime } from '../../runtime.js';
import { structuredResponse } from '../common.js';
import { prepareRebaselineInputSchema, prepareRebaselineOutputSchema } from '../schemas.js';

export function registerPrepareRebaselineTool(server: McpServer, runtime: V2Runtime): void {
  server.registerTool(
    'llmdocs.prepare_rebaseline',
    {
      description: 'Compute a deterministic rebaseline report for the task bundle.',
      inputSchema: prepareRebaselineInputSchema,
      outputSchema: prepareRebaselineOutputSchema,
    },
    async (input) =>
      structuredResponse(
        await runtime.prepareRebaseline(input.taskId, { targetBranch: input.targetBranch }),
      ),
  );
}
