import fs from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { runSetup } from '../../src/commands/setup.js';
import {
  closeMcpClient,
  createMcpClient,
  initGitRepo,
  makeTempProject,
} from '../helpers/test-fixtures.js';

describe('MCP stdio server', () => {
  const transports: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(transports.splice(0).map(async (transport) => transport.close()));
  });

  it('starts over stdio and serves core tools/resources', async () => {
    const projectRoot = await makeTempProject();
    await initGitRepo(projectRoot);
    await runSetup({}, projectRoot);

    const { client, transport } = await createMcpClient(projectRoot);
    transports.push({ close: () => closeMcpClient(transport) });

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    expect(toolNames).toContain('llmdocs.workspace_status');
    expect(toolNames).toContain('llmdocs.create_task_bundle');
    expect(toolNames).toContain('llmdocs.save_context_checkpoint');
    expect(toolNames).toContain('llmdocs.prepare_actualization');
    expect(toolNames).toContain('llmdocs.prepare_jira_doc');
    expect(toolNames).toContain('llmdocs.prepare_task_publish');
    expect(toolNames).toContain('llmdocs.apply_task_publish');

    const workspaceStatus = await client.callTool({
      name: 'llmdocs.workspace_status',
      arguments: {},
    });
    expect(
      await fs.realpath((workspaceStatus.structuredContent as { projectRoot: string }).projectRoot),
    ).toBe(await fs.realpath(projectRoot));

    const createResult = await client.callTool({
      name: 'llmdocs.create_task_bundle',
      arguments: {
        taskId: 'ABC-123',
        title: 'MCP flow',
        source: {
          type: 'jira',
          ref: 'ABC-123',
          url: null,
          rawText: 'create via MCP',
        },
      },
    });
    expect((createResult.structuredContent as { taskId: string }).taskId).toBe('ABC-123');

    const bundle = await client.callTool({
      name: 'llmdocs.load_task_bundle',
      arguments: {
        taskId: 'ABC-123',
        includeContents: true,
        includeArtifacts: true,
      },
    });
    expect((bundle.structuredContent as { taskId: string }).taskId).toBe('ABC-123');

    const jiraDoc = await client.callTool({
      name: 'llmdocs.prepare_jira_doc',
      arguments: {
        taskId: 'ABC-123',
      },
    });
    expect((jiraDoc.structuredContent as { taskId: string }).taskId).toBe('ABC-123');
    expect((jiraDoc.structuredContent as { source: { kind: string } }).source.kind).toBe('active');

    const resource = await client.readResource({
      uri: 'llmdocs://task/ABC-123/bundle',
    });
    expect(resource.contents[0].text).toContain('"taskId": "ABC-123"');
  }, 15_000);
});
