import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { V2Runtime } from '../../runtime.js';
import { structuredResponse } from '../common.js';
import { prepareJiraDocInputSchema, prepareJiraDocOutputSchema } from '../schemas.js';

export function registerPrepareJiraDocTool(server: McpServer, runtime: V2Runtime): void {
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
