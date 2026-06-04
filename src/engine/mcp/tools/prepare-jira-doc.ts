import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LlmDocsRuntime } from '../../runtime.js';
import { structuredResponse } from '../common.js';
import { prepareJiraDocInputSchema, prepareJiraDocOutputSchema } from '../schemas.js';

export function registerPrepareJiraDocTool(server: McpServer, runtime: LlmDocsRuntime): void {
  server.registerTool(
    'llmdocs.prepare_jira_doc',
    {
      description:
        'Prepare compact facts from a published llm-docs task so an agent can write a short Jira update.',
      inputSchema: prepareJiraDocInputSchema,
      outputSchema: prepareJiraDocOutputSchema,
    },
    async (input) => structuredResponse(await runtime.prepareJiraDoc(input)),
  );
}
