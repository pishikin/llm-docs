import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { V2Runtime } from '../../runtime.js';
import { structuredResponse } from '../common.js';
import {
  applyActualizationStateInputSchema,
  applyActualizationStateOutputSchema,
} from '../schemas.js';

export function registerApplyActualizationStateTool(server: McpServer, runtime: V2Runtime): void {
  server.registerTool(
    'llmdocs.apply_actualization_state',
    {
      description: 'Update metadata and registry after narrative task docs were actualized.',
      inputSchema: applyActualizationStateInputSchema,
      outputSchema: applyActualizationStateOutputSchema,
    },
    async (input) => structuredResponse(await runtime.applyActualizationState(input.taskId, input)),
  );
}
