import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { V2Runtime } from '../../runtime.js';
import { structuredResponse } from '../common.js';
import { emptyInputSchema, workspaceStatusOutputSchema } from '../schemas.js';

export const workspaceStatusInputSchema = emptyInputSchema;
export const workspaceStatusOutputToolSchema = workspaceStatusOutputSchema;

export function registerWorkspaceStatusTool(server: McpServer, runtime: V2Runtime): void {
  server.registerTool(
    'llmdocs.workspace_status',
    {
      description:
        'Return resolved config, workspace paths, active task state, registry health, and host health.',
      inputSchema: workspaceStatusInputSchema,
      outputSchema: workspaceStatusOutputToolSchema,
    },
    async () => structuredResponse(await runtime.workspaceStatus()),
  );
}
