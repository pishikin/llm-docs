import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { V2Runtime } from '../../runtime.js';
import { structuredResponse } from '../common.js';
import { resolveActiveTaskInputSchema, resolveActiveTaskOutputSchema } from '../schemas.js';

export function registerResolveActiveTaskTool(server: McpServer, runtime: V2Runtime): void {
  server.registerTool(
    'llmdocs.resolve_active_task',
    {
      description:
        'Resolve the active task from explicit input, Codex session binding, branch mapping, registry state, or cwd.',
      inputSchema: resolveActiveTaskInputSchema,
      outputSchema: resolveActiveTaskOutputSchema,
    },
    async (input) => {
      const resolved = await runtime.resolveActiveTask(input);
      return structuredResponse(
        resolved ?? {
          taskId: null,
          resolvedBy: null,
          bundlePath: null,
        },
      );
    },
  );
}
