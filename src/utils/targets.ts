import type { Target } from '../types/index.js';
import { ConfigError } from './errors.js';

export const SUPPORTED_TARGETS: readonly Target[] = ['claude', 'codex', 'cursor'];

const SUPPORTED_TARGET_SET = new Set<string>(SUPPORTED_TARGETS);

function toSourceLabel(sourceLabel?: string): string {
  return sourceLabel && sourceLabel.trim().length > 0 ? sourceLabel : 'targets';
}

export function normalizeTargets(rawTargets: string[], sourceLabel?: string): Target[] {
  const label = toSourceLabel(sourceLabel);
  const normalized = rawTargets
    .map((target) => target.trim())
    .filter((target) => target.length > 0);

  if (normalized.length === 0) {
    throw new ConfigError(`No targets specified in ${label}.`);
  }

  const invalidTargets = normalized.filter((target) => !SUPPORTED_TARGET_SET.has(target));
  if (invalidTargets.length > 0) {
    throw new ConfigError(
      `Unsupported target(s) in ${label}: ${invalidTargets.join(', ')}. Supported targets: ${SUPPORTED_TARGETS.join(', ')}.`,
    );
  }

  return Array.from(new Set(normalized)) as Target[];
}

export function parseTargetsOption(rawValue: string, sourceLabel = '--targets'): Target[] {
  return normalizeTargets(rawValue.split(','), sourceLabel);
}
