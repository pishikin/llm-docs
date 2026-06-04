import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { V2Runtime } from '../../runtime.js';
import { resourceResponse } from '../common.js';

export function registerTaskBundleResource(server: McpServer, runtime: V2Runtime): void {
  server.registerResource(
    'llmdocs.task-bundle',
    new ResourceTemplate('llmdocs://task/{taskId}/bundle', { list: undefined }),
    {
      title: 'Task bundle snapshot',
      description: 'Read-only bundle snapshot for a specific task.',
      mimeType: 'application/json',
    },
    async (uri, variables) =>
      resourceResponse(
        uri.toString(),
        await runtime.loadTaskBundle(String(variables.taskId), {
          includeContents: true,
          includeArtifacts: true,
        }),
      ),
  );
}
