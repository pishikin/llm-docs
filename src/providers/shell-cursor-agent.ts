import type { CursorAgentTrustMode, LLMProvider } from '../types/index.js';
import { ProviderError } from '../utils/errors.js';
import * as logger from '../utils/logger.js';
import { execCommand, isCommandAvailable } from '../utils/shell.js';

const DEFAULT_GENERATION_TIMEOUT = 300_000;
const DEFAULT_MAX_EMPTY_RETRIES = 1;
const DEFAULT_TRUST_MODE: CursorAgentTrustMode = 'trust';
const STDIN_THRESHOLD = 50_000;

interface CursorJsonExtraction {
  messages: string[];
  parsedJsonLines: number;
  nonEmptyLines: number;
}

interface CursorExtractedOutput {
  output: string;
  strategy: 'marker' | 'aggregate' | 'json-empty' | 'plain';
  messageCount: number;
  parsedJsonLines: number;
  nonEmptyLines: number;
}

interface CursorCliInvocation {
  command: 'agent';
  label: string;
}

type CursorOutputFormat = 'stream-json' | 'json' | 'text' | 'default';
type CursorModelMode = 'configured' | 'auto' | 'none';

const OUTPUT_FORMAT_FALLBACKS: CursorOutputFormat[] = ['stream-json', 'json', 'text', 'default'];

function uniquePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function sanitizeMessage(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

function isJsonLikeLine(line: string): boolean {
  return line.startsWith('{') && line.endsWith('}');
}

export class CursorAgentShellProvider implements LLMProvider {
  private model?: string;
  private generationTimeoutMs: number;
  private maxEmptyRetries: number;
  private trustMode: CursorAgentTrustMode;
  private invocation: CursorCliInvocation | null = null;

  constructor(
    model?: string,
    opts?: { timeoutMs?: number; maxEmptyRetries?: number; trustMode?: CursorAgentTrustMode },
  ) {
    this.model = model;
    this.generationTimeoutMs = opts?.timeoutMs ?? DEFAULT_GENERATION_TIMEOUT;
    this.maxEmptyRetries = Math.max(
      0,
      Math.floor(opts?.maxEmptyRetries ?? DEFAULT_MAX_EMPTY_RETRIES),
    );
    this.trustMode = this.normalizeTrustMode(opts?.trustMode);
  }

  private normalizeTrustMode(value: unknown): CursorAgentTrustMode {
    switch (value) {
      case 'manual':
      case 'trust':
      case 'yolo':
      case 'force':
        return value;
      default:
        return DEFAULT_TRUST_MODE;
    }
  }

  private getTrustFlag(): '--trust' | '--yolo' | '-f' | null {
    switch (this.trustMode) {
      case 'trust':
        return '--trust';
      case 'yolo':
        return '--yolo';
      case 'force':
        return '-f';
      default:
        return null;
    }
  }

  private isWorkspaceTrustRequired(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
      normalized.includes('workspace trust required') ||
      normalized.includes('do you trust the contents of this directory') ||
      normalized.includes("run 'agent' interactively to decide") ||
      normalized.includes('pass --trust') ||
      normalized.includes('pass --yolo') ||
      normalized.includes('pass -f')
    );
  }

  private isNamedModelRestrictedByPlan(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
      normalized.includes('named models unavailable') ||
      normalized.includes('free plans can only use auto') ||
      normalized.includes('switch to auto')
    );
  }

  private getModelModeInitial(): CursorModelMode {
    return this.model?.trim() ? 'configured' : 'none';
  }

  private getWorkspaceTrustGuidance(): string {
    return [
      'Cursor Agent workspace trust is required for this directory.',
      'Run `agent` interactively in project root to approve trust, or set `provider.cursorAgent.trustMode` in `llmdocs.config.json` to one of: `trust`, `yolo`, `force`.',
      'Current mode: `manual`.',
    ].join(' ');
  }

  private getWorkspaceTrustFailedAfterRetry(trustFlag: string): string {
    return [
      `Cursor Agent workspace trust check failed even after retry with \`${trustFlag}\`.`,
      'Run `agent` interactively in project root and confirm trust, then retry generation.',
    ].join(' ');
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

  private buildArgs(
    combinedPrompt: string,
    format: CursorOutputFormat,
    useStdin: boolean,
    trustBypass: boolean,
    modelMode: CursorModelMode,
  ): string[] {
    const args = ['-p', useStdin ? '-' : combinedPrompt];

    if (trustBypass) {
      const trustFlag = this.getTrustFlag();
      if (trustFlag) {
        args.push(trustFlag);
      }
    }

    if (modelMode === 'configured' && this.model?.trim()) {
      args.push('--model', this.model);
    } else if (modelMode === 'auto') {
      args.push('--model', 'auto');
    }

    if (format !== 'default') {
      args.push('--output-format', format);
    }
    return args;
  }

  private async resolveInvocation(): Promise<CursorCliInvocation> {
    if (this.invocation) {
      return this.invocation;
    }

    if (await isCommandAvailable('agent', 1_000)) {
      this.invocation = {
        command: 'agent',
        label: 'agent',
      };
      return this.invocation;
    }

    if (await isCommandAvailable('cursor', 1_000)) {
      throw new ProviderError(
        'Cursor IDE CLI (`cursor`) detected, but Cursor Agent provider requires standalone `agent` CLI. Install Agent CLI and add `~/.local/bin` to PATH.',
      );
    }

    throw new ProviderError(
      'Cursor Agent CLI not found (`agent` command missing). Install Cursor Agent CLI and add `~/.local/bin` to PATH.',
    );
  }

  private isUnsupportedOutputFormatFailure(message: string): boolean {
    const normalized = message.toLowerCase();
    const mentionsOutputFormat =
      normalized.includes('output-format') ||
      normalized.includes('stream-json') ||
      normalized.includes('invalid format') ||
      normalized.includes('unsupported format');
    const mentionsUnsupportedState =
      normalized.includes('unknown option') ||
      normalized.includes('unknown argument') ||
      normalized.includes('unrecognized option') ||
      normalized.includes('invalid value') ||
      normalized.includes('must be one of') ||
      normalized.includes('unsupported');

    return mentionsOutputFormat && mentionsUnsupportedState;
  }

  private isStdinPromptUnsupported(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
      normalized.includes('stdin') ||
      normalized.includes('invalid value "-"') ||
      normalized.includes('prompt cannot be') ||
      normalized.includes('prompt is required') ||
      normalized.includes('expected prompt') ||
      normalized.includes('failed to read from')
    );
  }

  private extractNestedText(value: unknown, depth = 0): string[] {
    if (depth > 4 || value == null) return [];

    if (typeof value === 'string') {
      const normalized = sanitizeMessage(value);
      return normalized ? [normalized] : [];
    }

    if (Array.isArray(value)) {
      return value.flatMap((item) => this.extractNestedText(item, depth + 1));
    }

    if (typeof value !== 'object') return [];
    const candidate = value as Record<string, unknown>;
    const out: string[] = [];

    if (typeof candidate.text === 'string') {
      out.push(...this.extractNestedText(candidate.text, depth + 1));
    }
    if (typeof candidate.message === 'string') {
      out.push(...this.extractNestedText(candidate.message, depth + 1));
    }
    if (typeof candidate.delta === 'string') {
      out.push(...this.extractNestedText(candidate.delta, depth + 1));
    }
    if (typeof candidate.content === 'string') {
      out.push(...this.extractNestedText(candidate.content, depth + 1));
    }

    for (const key of [
      'content',
      'parts',
      'messages',
      'items',
      'item',
      'data',
      'result',
      'output',
    ]) {
      const nested = candidate[key];
      if (nested && typeof nested === 'object') {
        out.push(...this.extractNestedText(nested, depth + 1));
      }
    }

    return out;
  }

  private collectMessagesFromJson(stdout: string): CursorJsonExtraction {
    const lines = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const collected: string[] = [];
    let parsedJsonLines = 0;

    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      parsedJsonLines += 1;
      collected.push(...this.extractNestedText(parsed));
    }

    return {
      messages: uniquePreserveOrder(collected),
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

  private extractOutput(stdout: string): CursorExtractedOutput {
    const state = this.collectMessagesFromJson(stdout);
    const markerCandidate = this.selectBestFileBlockMessage(state.messages);
    if (markerCandidate) {
      return {
        output: markerCandidate,
        strategy: 'marker',
        messageCount: state.messages.length,
        parsedJsonLines: state.parsedJsonLines,
        nonEmptyLines: state.nonEmptyLines,
      };
    }

    if (state.messages.length > 0) {
      return {
        output: state.messages.join('\n\n').trim(),
        strategy: 'aggregate',
        messageCount: state.messages.length,
        parsedJsonLines: state.parsedJsonLines,
        nonEmptyLines: state.nonEmptyLines,
      };
    }

    const nonEmptyLines = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const looksLikeJsonEvents =
      nonEmptyLines.length > 0 && nonEmptyLines.every((line) => isJsonLikeLine(line));
    if (looksLikeJsonEvents && state.parsedJsonLines > 0) {
      return {
        output: '',
        strategy: 'json-empty',
        messageCount: 0,
        parsedJsonLines: state.parsedJsonLines,
        nonEmptyLines: state.nonEmptyLines,
      };
    }

    return {
      output: stdout.trim(),
      strategy: 'plain',
      messageCount: 0,
      parsedJsonLines: state.parsedJsonLines,
      nonEmptyLines: state.nonEmptyLines,
    };
  }

  private async runWithFormat(
    combinedPrompt: string,
    format: CursorOutputFormat,
    useStdin: boolean,
    invocation: CursorCliInvocation,
    trustBypass: boolean,
    modelMode: CursorModelMode,
  ): Promise<CursorExtractedOutput> {
    const args = this.buildArgs(combinedPrompt, format, useStdin, trustBypass, modelMode);
    const result = await execCommand(invocation.command, args, {
      timeout: this.generationTimeoutMs,
      stdin: useStdin ? combinedPrompt : undefined,
    });

    if (result.exitCode !== 0) {
      const message = result.stderr.trim() || result.stdout.trim() || 'Unknown error';
      throw new ProviderError(`Cursor Agent CLI failed (exit ${result.exitCode}): ${message}`);
    }

    return this.extractOutput(result.stdout);
  }

  private async runOnce(
    combinedPrompt: string,
    trustBypass = false,
    modelMode: CursorModelMode = this.getModelModeInitial(),
  ): Promise<string> {
    const startedAt = Date.now();
    const preferStdin = combinedPrompt.length > STDIN_THRESHOLD;
    const stdinModes = preferStdin ? [true, false] : [false];
    let lastJsonExtraction: CursorExtractedOutput | null = null;
    const invocation = await this.resolveInvocation();

    for (const format of OUTPUT_FORMAT_FALLBACKS) {
      for (const useStdin of stdinModes) {
        try {
          const extracted = await this.runWithFormat(
            combinedPrompt,
            format,
            useStdin,
            invocation,
            trustBypass,
            modelMode,
          );
          lastJsonExtraction = extracted;

          logger.debug(
            `[cursor-agent] cli=${invocation.label}, duration=${Date.now() - startedAt}ms, prompt_chars=${combinedPrompt.length}, stdin=${useStdin}, model_mode=${modelMode}, trust_mode=${this.trustMode}, trust_bypass=${trustBypass}, format=${format}, strategy=${extracted.strategy}, messages=${extracted.messageCount}, json_lines=${extracted.parsedJsonLines}/${extracted.nonEmptyLines}`,
          );

          if (extracted.output) {
            return extracted.output;
          }

          if (extracted.strategy === 'json-empty' && format !== 'text' && format !== 'default') {
            break;
          }
        } catch (err) {
          if (!(err instanceof ProviderError)) {
            throw err;
          }

          const normalized = err.message.toLowerCase();
          if (this.isNamedModelRestrictedByPlan(normalized) && modelMode !== 'auto') {
            logger.warn('[cursor-agent] plan restricted named model; retrying with --model auto');
            return this.runOnce(combinedPrompt, trustBypass, 'auto');
          }

          if (this.isWorkspaceTrustRequired(normalized)) {
            if (!trustBypass) {
              const trustFlag = this.getTrustFlag();
              if (trustFlag) {
                logger.warn(
                  `[cursor-agent] workspace trust required; retrying with ${trustFlag} (mode=${this.trustMode})`,
                );
                return this.runOnce(combinedPrompt, true, modelMode);
              }

              throw new ProviderError(this.getWorkspaceTrustGuidance());
            }

            const trustFlag = this.getTrustFlag() ?? '--trust';
            throw new ProviderError(this.getWorkspaceTrustFailedAfterRetry(trustFlag));
          }

          if (this.isUnsupportedOutputFormatFailure(normalized)) {
            break;
          }

          if (useStdin && this.isStdinPromptUnsupported(normalized)) {
            continue;
          }

          throw err;
        }
      }
    }

    if (lastJsonExtraction) {
      throw new ProviderError(
        `Cursor Agent CLI returned empty response (strategy=${lastJsonExtraction.strategy}, json_lines=${lastJsonExtraction.parsedJsonLines}/${lastJsonExtraction.nonEmptyLines}).`,
      );
    }

    throw new ProviderError('Cursor Agent CLI returned empty response');
  }

  async generate(prompt: string, systemPrompt: string): Promise<string> {
    const combinedPrompt = this.getCombinedPrompt(prompt, systemPrompt);
    logger.debug(
      `[cursor-agent] generate start, prompt_chars=${combinedPrompt.length}, max_empty_retries=${this.maxEmptyRetries}, model=${this.model ?? 'default'}, trust_mode=${this.trustMode}`,
    );

    for (let attempt = 0; attempt <= this.maxEmptyRetries; attempt++) {
      try {
        return await this.runOnce(combinedPrompt);
      } catch (err) {
        if (err instanceof ProviderError) {
          const isRetryable = err.message.includes('empty response');
          if (isRetryable && attempt < this.maxEmptyRetries) {
            logger.debug(
              `[cursor-agent] empty response, retrying (${attempt + 1}/${this.maxEmptyRetries})`,
            );
            continue;
          }
          throw err;
        }

        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('timed out')) {
          const timeoutSeconds = Math.round(this.generationTimeoutMs / 1000);
          throw new ProviderError(
            `Cursor Agent CLI timed out after ${timeoutSeconds}s. Try a smaller fact pack or different model.`,
          );
        }

        throw new ProviderError(`Cursor Agent CLI error: ${message}`);
      }
    }

    throw new ProviderError('Cursor Agent CLI returned empty response after retries');
  }
}
