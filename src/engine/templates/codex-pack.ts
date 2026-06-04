import { renderAgentGuideSkillFiles } from './agent-guide.js';

export function renderCodexConfigManagedBlock(cliLauncherPath: string): Record<string, unknown> {
  return {
    features: {
      hooks: true,
    },
    mcp_servers: {
      llmdocs: {
        command: 'node',
        args: [cliLauncherPath, 'server', '--transport', 'stdio'],
        enabled: true,
        required: false,
      },
    },
  };
}

export function renderCodexHooksManagedBlock(
  buildCommand: (...args: string[]) => string,
): Record<string, unknown> {
  const buildHookCommand = (...args: string[]) => `env NODE_NO_WARNINGS=1 ${buildCommand(...args)}`;

  return {
    hooks: {
      SessionStart: [
        {
          matcher: 'startup|resume',
          hooks: [
            { type: 'command', command: buildHookCommand('internal', 'codex-session-start') },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            { type: 'command', command: buildHookCommand('internal', 'codex-user-prompt-submit') },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            { type: 'command', command: buildHookCommand('internal', 'codex-stop'), timeout: 10 },
          ],
        },
      ],
    },
  };
}

export function renderCodexSkillFiles(): Record<string, string> {
  return renderAgentGuideSkillFiles();
}
