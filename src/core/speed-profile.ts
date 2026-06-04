import type { ProviderType, SpeedProfile } from '../types/index.js';

export interface SpeedProfileSettings {
  profile: SpeedProfile;
  codexTimeoutMs: number;
  claudeCodeTimeoutMs: number;
  cursorAgentTimeoutMs: number;
  customTimeoutMs: number;
  codexMaxEmptyRetries: number;
  codexReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  maxDirectoryTreeEntries: number;
  enableFormatRepair: boolean;
  enableQualityRepair: boolean;
  allowProviderFailureFallback: boolean;
  defaultTargetConcurrency: number;
}

const SPEED_PROFILE_SETTINGS: Record<SpeedProfile, SpeedProfileSettings> = {
  fast: {
    profile: 'fast',
    codexTimeoutMs: 120_000,
    claudeCodeTimeoutMs: 180_000,
    cursorAgentTimeoutMs: 180_000,
    customTimeoutMs: 120_000,
    codexMaxEmptyRetries: 0,
    codexReasoningEffort: 'low',
    maxDirectoryTreeEntries: 120,
    enableFormatRepair: false,
    enableQualityRepair: false,
    allowProviderFailureFallback: true,
    defaultTargetConcurrency: 2,
  },
  balanced: {
    profile: 'balanced',
    codexTimeoutMs: 180_000,
    claudeCodeTimeoutMs: 300_000,
    cursorAgentTimeoutMs: 300_000,
    customTimeoutMs: 180_000,
    codexMaxEmptyRetries: 1,
    codexReasoningEffort: 'medium',
    maxDirectoryTreeEntries: 220,
    enableFormatRepair: true,
    enableQualityRepair: true,
    allowProviderFailureFallback: false,
    defaultTargetConcurrency: 2,
  },
  'max-quality': {
    profile: 'max-quality',
    codexTimeoutMs: 300_000,
    claudeCodeTimeoutMs: 420_000,
    cursorAgentTimeoutMs: 420_000,
    customTimeoutMs: 300_000,
    codexMaxEmptyRetries: 2,
    codexReasoningEffort: 'high',
    maxDirectoryTreeEntries: 320,
    enableFormatRepair: true,
    enableQualityRepair: true,
    allowProviderFailureFallback: false,
    defaultTargetConcurrency: 1,
  },
};

export function parseSpeedProfile(value?: string): SpeedProfile {
  if (!value) return 'balanced';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'fast' || normalized === 'balanced' || normalized === 'max-quality') {
    return normalized;
  }
  return 'balanced';
}

export function getSpeedProfileSettings(profile: SpeedProfile): SpeedProfileSettings {
  return SPEED_PROFILE_SETTINGS[profile];
}

export function getProviderTimeoutMs(
  providerType: ProviderType,
  settings: SpeedProfileSettings,
): number | undefined {
  switch (providerType) {
    case 'codex-cli':
      return settings.codexTimeoutMs;
    case 'claude-code':
      return settings.claudeCodeTimeoutMs;
    case 'cursor-agent':
      return settings.cursorAgentTimeoutMs;
    case 'custom':
      return settings.customTimeoutMs;
    default:
      return undefined;
  }
}
