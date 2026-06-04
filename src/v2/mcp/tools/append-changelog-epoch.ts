import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { V2Runtime } from '../../runtime.js';
import { structuredResponse } from '../common.js';
import { appendChangelogEpochInputSchema, appendChangelogEpochOutputSchema } from '../schemas.js';

export function registerAppendChangelogEpochTool(server: McpServer, runtime: V2Runtime): void {
  server.registerTool(
    'llmdocs.append_changelog_epoch',
    {
      description: 'Append a standardized changelog epoch to the task changelog.',
      inputSchema: appendChangelogEpochInputSchema,
      outputSchema: appendChangelogEpochOutputSchema,
    },
    async (input) => {
      const timestamp = new Date().toISOString();
      await runtime.appendChangelogEpoch(input.taskId, {
        ...input,
        timestamp,
      });
      return structuredResponse({
        taskId: input.taskId,
        label: input.label,
        timestamp,
      });
    },
  );
}
