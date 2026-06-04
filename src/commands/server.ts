import { Command } from 'commander';
import { startMcpServer } from '../engine/mcp/server.js';
import { createRuntime } from '../engine/runtime.js';
import { getProjectRoot } from '../utils/fs.js';

export interface ServerCommandOptions {
  transport: string;
}

export async function runServer(options: ServerCommandOptions, startDir?: string): Promise<void> {
  if (options.transport !== 'stdio') {
    throw new Error(`Unsupported transport: ${options.transport}. Only stdio is supported.`);
  }

  const projectRoot = await getProjectRoot(startDir);
  const runtime = await createRuntime(projectRoot, { createIfMissing: false });
  await startMcpServer(runtime);
}

const command = new Command('server')
  .description('Start the llm-docs MCP server')
  .option('--transport <transport>', 'transport to use', 'stdio')
  .action(async (options: ServerCommandOptions) => {
    await runServer(options);
  });

export default command;
