import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LLMProvider } from '../types/index.js';
import { ProviderError } from '../utils/errors.js';
import * as logger from '../utils/logger.js';
import { execCommand } from '../utils/shell.js';

const DEFAULT_GENERATION_TIMEOUT = 180_000;
const STDIN_THRESHOLD = 50_000;
const DEFAULT_MAX_EMPTY_RETRIES = 1;

interface CodexAgentMessageItem {
  type: 'agent_message';
  text: string;
}

interface CodexJsonEvent {
  type?: string;
  item?: unknown;
  text?: unknown;
  usage?: unknown;
}

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
}

interface JsonExtractionState {
  messages: string[];
  usage?: CodexUsage;
  parsedJsonLines: number;
  nonEmptyLines: number;
}

interface ExtractedOutput {
  output: string;
  strategy: 'marker' | 'aggregate' | 'json-empty' | 'plain';
  agentMessageCount: number;
  usage?: CodexUsage;
  parsedJsonLines: number;
  nonEmptyLines: number;
}

export class CodexShellProvider implements LLMProvider {
  private model: string | undefined;
  private generationTimeoutMs: number;
  private maxEmptyRetries: number;
  private reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';

  constructor(
    model?: string,
    opts?: {
      timeoutMs?: number;
      maxEmptyRetries?: number;
      reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
    },
  ) {
    this.model = model;
    this.generationTimeoutMs = opts?.timeoutMs ?? DEFAULT_GENERATION_TIMEOUT;
    this.maxEmptyRetries = Math.max(
      0,
      Math.floor(opts?.maxEmptyRetries ?? DEFAULT_MAX_EMPTY_RETRIES),
    );
    this.reasoningEffort = opts?.reasoningEffort;
  }

  private getCombinedPrompt(prompt: string, systemPrompt: string): string {
    if (!systemPrompt.trim()) {
      return prompt;
    }

    if (prompt.includes('<system>') && prompt.includes('</system>')) {
      return prompt;
    }

    return `<system>\n${systemPrompt}\n</system>\n\n${prompt}`;
  }

  private isAgentMessageItem(value: unknown): value is CodexAgentMessageItem {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Record<string, unknown>;
    return candidate.type === 'agent_message' && typeof candidate.text === 'string';
  }

  private isUsage(value: unknown): value is CodexUsage {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Record<string, unknown>;
    const keys: Array<keyof CodexUsage> = ['input_tokens', 'cached_input_tokens', 'output_tokens'];
    return keys.some((key) => typeof candidate[key] === 'number');
  }

  private collectAgentMessagesFromJson(stdout: string): JsonExtractionState {
    const lines = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const messages: string[] = [];
    let usage: CodexUsage | undefined;
    let parsedJsonLines = 0;

    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as CodexJsonEvent;
      } catch {
        continue;
      }
      parsedJsonLines += 1;

      if (!parsed || typeof parsed !== 'object') continue;

      const event = parsed as CodexJsonEvent;
      if (event.type === 'item.completed' && this.isAgentMessageItem(event.item)) {
        const text = event.item.text.trim();
        if (text.length > 0) {
          messages.push(text);
        }
        continue;
      }

      if (event.type === 'agent_message' && typeof event.text === 'string') {
        const text = event.text.trim();
        if (text.length > 0) {
          messages.push(text);
        }
      }

      if (event.type === 'turn.completed' && this.isUsage(event.usage)) {
        usage = event.usage;
      }
    }

    return {
      messages,
      usage,
      parsedJsonLines,
      nonEmptyLines: lines.length,
    };
  }

  private countFileBlocks(text: string): number {
    const parts = text.split(/---FILE:\s*(.+?)---/);
    let count = 0;
    for (let i = 1; i < parts.length; i += 2) {
      const filePath = parts[i]?.trim() ?? '';
      const content = parts[i + 1]?.trim() ?? '';
      if (filePath.length > 0 && content.length > 0) {
        count += 1;
      }
    }
    return count;
  }

  private selectBestFileBlockMessage(messages: string[]): string {
    let bestText = '';
    let bestIndex = -1;
    let bestBlockCount = -1;
    let bestLength = -1;

    for (let index = 0; index < messages.length; index++) {
      const text = messages[index];
      const blockCount = this.countFileBlocks(text);
      if (blockCount === 0) continue;

      const textLength = text.length;
      const isBetter =
        index > bestIndex ||
        (index === bestIndex &&
          (blockCount > bestBlockCount ||
            (blockCount === bestBlockCount && textLength > bestLength)));

      if (isBetter) {
        bestText = text;
        bestIndex = index;
        bestBlockCount = blockCount;
        bestLength = textLength;
      }
    }

    return bestText;
  }

  private extractAgentMessageFromJson(stdout: string): ExtractedOutput {
    const state = this.collectAgentMessagesFromJson(stdout);
    const { messages, usage, parsedJsonLines, nonEmptyLines } = state;
    if (messages.length === 0) {
      return {
        output: '',
        strategy: 'json-empty',
        agentMessageCount: 0,
        usage,
        parsedJsonLines,
        nonEmptyLines,
      };
    }

    const markerCandidate = this.selectBestFileBlockMessage(messages);
    if (markerCandidate) {
      return {
        output: markerCandidate,
        strategy: 'marker',
        agentMessageCount: messages.length,
        usage,
        parsedJsonLines,
        nonEmptyLines,
      };
    }

    // Fallback: aggregate all agent messages for downstream parser/repair retry.
    return {
      output: messages.join('\n\n').trim(),
      strategy: 'aggregate',
      agentMessageCount: messages.length,
      usage,
      parsedJsonLines,
      nonEmptyLines,
    };
  }

  private extractOutput(stdout: string): ExtractedOutput {
    const extractedFromJson = this.extractAgentMessageFromJson(stdout);
    if (extractedFromJson.output) {
      return extractedFromJson;
    }

    const nonEmptyLines = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const looksLikeJsonEvents =
      nonEmptyLines.length > 0 &&
      nonEmptyLines.every((line) => line.startsWith('{') && line.endsWith('}'));

    if (looksLikeJsonEvents) {
      return extractedFromJson;
    }

    return {
      output: stdout.trim(),
      strategy: 'plain',
      agentMessageCount: extractedFromJson.agentMessageCount,
      usage: extractedFromJson.usage,
      parsedJsonLines: extractedFromJson.parsedJsonLines,
      nonEmptyLines: extractedFromJson.nonEmptyLines,
    };
  }

  private buildArgs(prompt: string, useStdin: boolean, outputLastMessagePath: string): string[] {
    const args = ['exec'];
    args.push(useStdin ? '-' : prompt);

    if (this.model) {
      args.push('--model', this.model);
    }

    if (this.reasoningEffort) {
      args.push('-c', `model_reasoning_effort="${this.reasoningEffort}"`);
    }

    args.push(
      '-s',
      'read-only',
      '--skip-git-repo-check',
      '--json',
      '--output-last-message',
      outputLastMessagePath,
    );
    return args;
  }

  private async readOutputLastMessage(outputPath: string): Promise<string> {
    try {
      const content = await fs.readFile(outputPath, 'utf-8');
      return content.trim();
    } catch {
      return '';
    }
  }

  private async cleanupOutputLastMessage(outputPath: string): Promise<void> {
    try {
      await fs.unlink(outputPath);
    } catch {
      // no-op
    }
  }

  private async runOnce(combinedPrompt: string): Promise<string> {
    const startedAt = Date.now();
    const useStdin = combinedPrompt.length > STDIN_THRESHOLD;
    const outputLastMessagePath = path.join(os.tmpdir(), `llmdocs-codex-last-${randomUUID()}.txt`);
    const args = this.buildArgs(combinedPrompt, useStdin, outputLastMessagePath);

    try {
      const result = await execCommand('codex', args, {
        timeout: this.generationTimeoutMs,
        stdin: useStdin ? combinedPrompt : undefined,
      });

      if (result.exitCode !== 0) {
        const msg = result.stderr.trim() || result.stdout.trim() || 'Unknown error';
        throw new ProviderError(`Codex CLI failed (exit ${result.exitCode}): ${msg}`);
      }

      const extracted = this.extractOutput(result.stdout);
      let output = extracted.output;
      let strategy: ExtractedOutput['strategy'] | 'last-message' = extracted.strategy;

      if (!output) {
        const lastMessage = await this.readOutputLastMessage(outputLastMessagePath);
        if (lastMessage) {
          output = lastMessage;
          strategy = 'last-message';
        }
      }

      const durationMs = Date.now() - startedAt;
      const usage = extracted.usage;
      const usageHint = usage
        ? `, usage={input:${usage.input_tokens ?? 0},cached:${usage.cached_input_tokens ?? 0},output:${usage.output_tokens ?? 0}}`
        : '';
      logger.debug(
        `[codex-cli] duration=${durationMs}ms, prompt_chars=${combinedPrompt.length}, stdin=${useStdin}, strategy=${strategy}, agent_messages=${extracted.agentMessageCount}, json_lines=${extracted.parsedJsonLines}/${extracted.nonEmptyLines}${usageHint}`,
      );

      if (!output) {
        const stderrHint = result.stderr.trim();
        const hint = stderrHint ? ` stderr: ${stderrHint}` : '';
        throw new ProviderError(`Codex CLI returned empty response.${hint}`);
      }

      return output;
    } finally {
      await this.cleanupOutputLastMessage(outputLastMessagePath);
    }
  }

  async generate(prompt: string, systemPrompt: string): Promise<string> {
    const combinedPrompt = this.getCombinedPrompt(prompt, systemPrompt);
    logger.debug(
      `[codex-cli] generate start, prompt_chars=${combinedPrompt.length}, max_empty_retries=${this.maxEmptyRetries}, reasoning_effort=${this.reasoningEffort ?? 'default'}`,
    );
    for (let attempt = 0; attempt <= this.maxEmptyRetries; attempt++) {
      try {
        return await this.runOnce(combinedPrompt);
      } catch (err) {
        if (err instanceof ProviderError) {
          const isRetryable = err.message.includes('empty response');
          if (isRetryable && attempt < this.maxEmptyRetries) {
            logger.debug(
              `[codex-cli] empty response, retrying (${attempt + 1}/${this.maxEmptyRetries})`,
            );
            continue;
          }
          throw err;
        }

        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('timed out')) {
          const timeoutSeconds = Math.round(this.generationTimeoutMs / 1000);
          throw new ProviderError(
            `Codex CLI timed out after ${timeoutSeconds}s. Try a smaller fact pack or different model.`,
          );
        }

        throw new ProviderError(`Codex CLI error: ${message}`);
      }
    }

    throw new ProviderError('Codex CLI returned empty response after retries');
  }
}
