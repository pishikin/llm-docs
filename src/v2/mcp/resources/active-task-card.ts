import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { V2Runtime } from '../../runtime.js';
import { resourceResponse } from '../common.js';

async function buildActiveTaskCard(runtime: V2Runtime): Promise<string> {
  const resolved = await runtime.resolveActiveTask({ preferRegistryActive: true });
  if (!resolved) {
    return '# Active Task Card\n\nNo active task.\n';
  }

  const bundle = await runtime.loadTaskBundle(resolved.taskId, {
    includeContents: false,
    includeArtifacts: false,
  });
  const reasons =
    bundle.meta.staleness.reasons.length > 0
      ? bundle.meta.staleness.reasons.map((reason) => `- ${reason}`).join('\n')
      : '- none';

  return `# Active Task Card

- taskId: ${bundle.taskId}
- title: ${bundle.meta.title}
- status: ${bundle.meta.status}
- phase: ${bundle.meta.phase}
- branch: ${bundle.meta.branch.current ?? 'n/a'}
- stale: ${bundle.meta.staleness.needs_actualization ? 'yes' : 'no'}

## Staleness Reasons
${reasons}
`;
}

export function registerActiveTaskCardResource(server: McpServer, runtime: V2Runtime): void {
  const uri = 'llmdocs://active-task/card';
  server.registerResource(
    'llmdocs.active-task-card',
    uri,
    {
      title: 'Active task card',
      description: 'Short markdown card for task reinjection.',
      mimeType: 'text/markdown',
    },
    async () => resourceResponse(uri, await buildActiveTaskCard(runtime), 'text/markdown'),
  );
}
