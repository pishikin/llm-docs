import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LlmDocsRuntime } from '../../runtime.js';
import { resourceResponse } from '../common.js';

export function registerRegistryResource(server: McpServer, runtime: LlmDocsRuntime): void {
  const uri = 'llmdocs://registry';
  server.registerResource(
    'llmdocs.registry',
    uri,
    {
      title: 'llm-docs registry',
      description: 'Read-only snapshot of the task registry.',
      mimeType: 'application/json',
    },
    async () => resourceResponse(uri, await runtime.readTaskRegistry()),
  );
}
