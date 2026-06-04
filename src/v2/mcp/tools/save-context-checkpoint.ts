import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { V2Runtime } from '../../runtime.js';
import { structuredResponse } from '../common.js';
import { saveContextCheckpointInputSchema, saveContextCheckpointOutputSchema } from '../schemas.js';

export function registerSaveContextCheckpointTool(server: McpServer, runtime: V2Runtime): void {
  server.registerTool(
    'llmdocs.save_context_checkpoint',
    {
      description:
        'Save or refresh the active task working context checkpoint in context.md and state.json.',
      inputSchema: saveContextCheckpointInputSchema,
      outputSchema: saveContextCheckpointOutputSchema,
    },
    async (input) => {
      const taskId =
        input.taskId ??
        (
          await runtime.resolveActiveTask({
            preferRegistryActive: true,
            codexSessionId: input.codexSessionId,
          })
        )?.taskId;
      if (!taskId) {
        throw new Error('Cannot save checkpoint because no active task is resolved.');
      }

      return structuredResponse(await runtime.saveContextCheckpoint(taskId, input));
    },
  );
}
