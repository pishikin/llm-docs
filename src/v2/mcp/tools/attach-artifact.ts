import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { V2Runtime } from '../../runtime.js';
import { structuredResponse } from '../common.js';
import { attachArtifactInputSchema, attachArtifactOutputSchema } from '../schemas.js';

export function registerAttachArtifactTool(server: McpServer, runtime: V2Runtime): void {
  server.registerTool(
    'llmdocs.attach_artifact',
    {
      description: 'Attach an artifact into the task bundle and update artifact index.',
      inputSchema: attachArtifactInputSchema,
      outputSchema: attachArtifactOutputSchema,
    },
    async (input) => {
      const { taskId, ...attachInput } = input;
      return structuredResponse(await runtime.attachArtifact(taskId, attachInput));
    },
  );
}
