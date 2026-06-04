import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LlmDocsRuntime } from '../../runtime.js';
import { structuredResponse } from '../common.js';
import { appendChangelogEpochInputSchema, appendChangelogEpochOutputSchema } from '../schemas.js';

export function registerAppendChangelogEpochTool(server: McpServer, runtime: LlmDocsRuntime): void {
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
