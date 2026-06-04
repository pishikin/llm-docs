import { renderAgentGuideSkillFiles } from './agent-guide.js';

export function renderClaudeSettingsManagedBlock(
  buildCommand: (...args: string[]) => string,
): Record<string, unknown> {
  return {
    hooks: {
      SessionStart: [
        {
          matcher: 'startup|resume|compact',
          hooks: [{ type: 'command', command: buildCommand('internal', 'claude-session-start') }],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            { type: 'command', command: buildCommand('internal', 'claude-user-prompt-submit') },
          ],
        },
      ],
      Stop: [
        {
          hooks: [{ type: 'command', command: buildCommand('internal', 'claude-stop') }],
        },
      ],
      PreCompact: [
        {
          hooks: [{ type: 'command', command: buildCommand('internal', 'claude-pre-compact') }],
        },
      ],
    },
  };
}

export function renderClaudeSkillFiles(): Record<string, string> {
  return renderAgentGuideSkillFiles();
}

export function renderMcpJsonManagedBlock(cliLauncherPath: string): Record<string, unknown> {
  return {
    mcpServers: {
      llmdocs: {
        command: 'node',
        args: [cliLauncherPath, 'server', '--transport', 'stdio'],
      },
    },
  };
}
