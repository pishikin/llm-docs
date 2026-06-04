import type { LLMProvider } from '../types/index.js';
import { ProviderError } from '../utils/errors.js';
import * as logger from '../utils/logger.js';
import { execCommand } from '../utils/shell.js';

const DEFAULT_GENERATION_TIMEOUT = 180_000;

export class ClaudeCodeShellProvider implements LLMProvider {
  private model?: string;
  private generationTimeoutMs: number;

  constructor(model?: string, opts?: { timeoutMs?: number }) {
    this.model = model;
    this.generationTimeoutMs = opts?.timeoutMs ?? DEFAULT_GENERATION_TIMEOUT;
  }

  async generate(prompt: string, systemPrompt: string): Promise<string> {
    const useStdin = true;
    const startedAt = Date.now();
    const args = ['-p'];
    args.push('--system-prompt', systemPrompt);
    if (this.model) {
      args.push('--model', this.model);
    }
    args.push(
      '--output-format',
      'text',
      '--max-turns',
      '1',
      '--no-session-persistence',
      '--tools',
      '',
      '--strict-mcp-config',
      '--permission-mode',
      'dontAsk',
    );

    logger.debug(
      `[claude-code] generate start, prompt_chars=${prompt.length}, stdin=${useStdin}, timeout_ms=${this.generationTimeoutMs}, model=${this.model ?? 'default'}`,
    );

    try {
      const result = await execCommand('claude', args, {
        timeout: this.generationTimeoutMs,
        stdin: prompt,
      });
      logger.debug(
        `[claude-code] duration=${Date.now() - startedAt}ms, exit=${result.exitCode}, stdout_chars=${result.stdout.length}, stderr_chars=${result.stderr.length}`,
      );

      if (result.exitCode !== 0) {
        const msg = result.stderr.trim() || result.stdout.trim() || 'Unknown error';
        throw new ProviderError(`Claude Code CLI failed (exit ${result.exitCode}): ${msg}`);
      }

      const output = result.stdout.trim();
      if (!output) {
        throw new ProviderError('Claude Code CLI returned empty response');
      }

      return output;
    } catch (err) {
      if (err instanceof ProviderError) throw err;

      const message = err instanceof Error ? err.message : String(err);

      if (message.includes('timed out')) {
        const timeoutSeconds = Math.round(this.generationTimeoutMs / 1000);
        logger.debug(`[claude-code] timed out after ${Date.now() - startedAt}ms`);
        throw new ProviderError(
          `Claude Code CLI timed out after ${timeoutSeconds}s. Try a smaller fact pack or different model.`,
        );
      }

      throw new ProviderError(`Claude Code CLI error: ${message}`);
    }
  }
}
