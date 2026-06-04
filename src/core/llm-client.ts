import { AnthropicProvider } from '../providers/api-anthropic.js';
import { CustomProvider } from '../providers/api-custom.js';
import { ClaudeCodeShellProvider } from '../providers/shell-claude-code.js';
import { CodexShellProvider } from '../providers/shell-codex.js';
import { CursorAgentShellProvider } from '../providers/shell-cursor-agent.js';
import type { LLMProvider, ProviderConfig } from '../types/index.js';
import { ConfigError } from '../utils/errors.js';

export interface CreateProviderOptions {
  shellTimeoutMs?: number;
  customTimeoutMs?: number;
  codexMaxEmptyRetries?: number;
  codexReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
}

export function createProvider(
  config: ProviderConfig,
  options: CreateProviderOptions = {},
): LLMProvider {
  switch (config.type) {
    case 'anthropic':
      return new AnthropicProvider(config.model ?? 'claude-sonnet-4-5-20250514');
    case 'claude-code':
      return new ClaudeCodeShellProvider(config.model, { timeoutMs: options.shellTimeoutMs });
    case 'codex-cli':
      return new CodexShellProvider(config.model, {
        timeoutMs: options.shellTimeoutMs,
        maxEmptyRetries: options.codexMaxEmptyRetries,
        reasoningEffort: options.codexReasoningEffort,
      });
    case 'cursor-agent':
      return new CursorAgentShellProvider(config.model, {
        timeoutMs: options.shellTimeoutMs,
        trustMode: config.cursorAgent?.trustMode,
      });
    case 'custom': {
      if (!config.custom) {
        throw new ConfigError(
          'Custom provider requires "custom" config with baseUrl and apiKeyEnvVar.',
        );
      }
      if (!config.model) {
        throw new ConfigError('Custom provider requires a model name.');
      }
      return new CustomProvider(config.custom.baseUrl, config.custom.apiKeyEnvVar, config.model, {
        timeoutMs: options.customTimeoutMs,
      });
    }
    default: {
      const _exhaustive: never = config.type;
      throw new ConfigError(`Unknown provider: ${_exhaustive}`);
    }
  }
}
