import type { ProviderType } from '../types/index.js';

export interface AdaptedPrompt {
  systemPrompt?: string;
  userPrompt: string;
}

/**
 * Adapts system and user prompts for different provider capabilities.
 * - anthropic, claude-code, cursor-agent, custom: support separate system prompt
 * - codex-cli: merges system prompt into user prompt
 */
export function adaptPrompt(
  systemPrompt: string,
  userPrompt: string,
  providerType: ProviderType,
): AdaptedPrompt {
  switch (providerType) {
    case 'anthropic':
    case 'claude-code':
    case 'cursor-agent':
    case 'custom':
      return { systemPrompt, userPrompt };

    case 'codex-cli':
      return {
        userPrompt: `<system>\n${systemPrompt}\n</system>\n\n${userPrompt}`,
      };

    default: {
      const _exhaustive: never = providerType;
      return _exhaustive;
    }
  }
}
