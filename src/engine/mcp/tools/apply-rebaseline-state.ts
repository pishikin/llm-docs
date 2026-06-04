import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LlmDocsRuntime } from '../../runtime.js';
import { structuredResponse } from '../common.js';
import { applyRebaselineStateInputSchema, applyRebaselineStateOutputSchema } from '../schemas.js';

export function registerApplyRebaselineStateTool(server: McpServer, runtime: LlmDocsRuntime): void {
  server.registerTool(
    'llmdocs.apply_rebaseline_state',
    {
      description: 'Apply a new baseline to metadata and registry state.',
      inputSchema: applyRebaselineStateInputSchema,
      outputSchema: applyRebaselineStateOutputSchema,
    },
    async (input) => structuredResponse(await runtime.applyRebaselineState(input.taskId, input)),
  );
}
