import type { LLMProvider } from '../types/index.js';
import { ConfigError, ProviderError } from '../utils/errors.js';

interface OpenAIChatResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

export interface CustomProviderOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;

export class CustomProvider implements LLMProvider {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private timeoutMs: number;

  constructor(
    baseUrl: string,
    apiKeyEnvVar: string,
    model: string,
    options: CustomProviderOptions = {},
  ) {
    const apiKey = process.env[apiKeyEnvVar];
    if (!apiKey) {
      throw new ConfigError(
        `${apiKeyEnvVar} not set. Export it: export ${apiKeyEnvVar}=your-api-key`,
      );
    }

    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async generate(prompt: string, systemPrompt: string): Promise<string> {
    const url = `${this.baseUrl}/chat/completions`;

    const messages: Array<{ role: string; content: string }> = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: 4096,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new ProviderError(
          `Custom API error (${response.status}): ${body || response.statusText}`,
        );
      }

      const data = (await response.json()) as OpenAIChatResponse;

      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new ProviderError('Custom API returned empty or invalid response');
      }

      return content;
    } catch (err) {
      if (err instanceof ConfigError || err instanceof ProviderError) throw err;

      if (err instanceof Error && err.name === 'AbortError') {
        throw new ProviderError(
          `Custom API request timed out after ${Math.round(this.timeoutMs / 1000)}s`,
        );
      }

      throw new ProviderError(`Custom API error: ${err instanceof Error ? err.message : err}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
