import { Command } from 'commander';
import { getProjectRoot } from '../utils/fs.js';
import { startMcpServer } from '../v2/mcp/server.js';
import { createV2Runtime } from '../v2/runtime.js';

export interface ServerCommandOptions {
  transport: string;
}

export async function runServer(options: ServerCommandOptions, startDir?: string): Promise<void> {
  if (options.transport !== 'stdio') {
    throw new Error(
      `Unsupported transport: ${options.transport}. Only stdio is supported in v2.0.`,
    );
  }

  const projectRoot = await getProjectRoot(startDir);
  const runtime = await createV2Runtime(projectRoot, { createIfMissing: false });
  await startMcpServer(runtime);
}

const command = new Command('server')
  .description('Start the llm-docs MCP server')
  .option('--transport <transport>', 'transport to use', 'stdio')
  .action(async (options: ServerCommandOptions) => {
    await runServer(options);
  });

export default command;
