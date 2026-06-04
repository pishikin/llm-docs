import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LlmDocsRuntime } from '../../runtime.js';
import { structuredResponse } from '../common.js';
import { taskPublishInputSchema, taskPublishPlanOutputSchema } from '../schemas.js';

export function registerPrepareTaskPublishTool(server: McpServer, runtime: LlmDocsRuntime): void {
  server.registerTool(
    'llmdocs.prepare_task_publish',
    {
      description:
        'Build a read-only task publish plan. It checks source task state, destination worktree, conflicts and planned writes without mutating files.',
      inputSchema: taskPublishInputSchema,
      outputSchema: taskPublishPlanOutputSchema,
    },
    async (input) =>
      structuredResponse(await runtime.prepareTaskPublish({ ...input, dryRun: true })),
  );
}
