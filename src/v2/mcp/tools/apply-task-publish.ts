import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { V2Runtime } from '../../runtime.js';
import { structuredResponse } from '../common.js';
import { taskPublishInputSchema, taskPublishReportOutputSchema } from '../schemas.js';

export function registerApplyTaskPublishTool(server: McpServer, runtime: V2Runtime): void {
  server.registerTool(
    'llmdocs.apply_task_publish',
    {
      description:
        'Publish a task bundle into long-lived docs. This mutates the destination worktree by copying task files, writing publish.manifest.json and updating the published task index.',
      inputSchema: taskPublishInputSchema,
      outputSchema: taskPublishReportOutputSchema,
    },
    async (input) =>
      structuredResponse(await runtime.applyTaskPublish({ ...input, dryRun: false })),
  );
}
