import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider } from '../types/index.js';
import { ConfigError, ProviderError } from '../utils/errors.js';

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private model: string;

  constructor(model: string) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new ConfigError(
        'ANTHROPIC_API_KEY not set. Export it: export ANTHROPIC_API_KEY=sk-ant-...',
      );
    }
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async generate(prompt: string, systemPrompt: string): Promise<string> {
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
      });

      const block = response.content[0];
      if (block.type !== 'text') {
        throw new ProviderError('Unexpected response type from Anthropic');
      }
      return block.text;
    } catch (err) {
      if (err instanceof ConfigError || err instanceof ProviderError) throw err;
      throw new ProviderError(`Anthropic API error: ${err instanceof Error ? err.message : err}`);
    }
  }
}
