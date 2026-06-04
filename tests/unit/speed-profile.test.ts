import { describe, expect, it } from 'vitest';
import {
  getProviderTimeoutMs,
  getSpeedProfileSettings,
  parseSpeedProfile,
} from '../../src/core/speed-profile.js';

describe('speed-profile', () => {
  it('defaults to balanced for empty and invalid values', () => {
    expect(parseSpeedProfile(undefined)).toBe('balanced');
    expect(parseSpeedProfile('')).toBe('balanced');
    expect(parseSpeedProfile('unknown')).toBe('balanced');
  });

  it('parses known profiles', () => {
    expect(parseSpeedProfile('fast')).toBe('fast');
    expect(parseSpeedProfile('balanced')).toBe('balanced');
    expect(parseSpeedProfile('max-quality')).toBe('max-quality');
  });

  it('exposes expected settings for fast profile', () => {
    const settings = getSpeedProfileSettings('fast');
    expect(settings.codexMaxEmptyRetries).toBe(0);
    expect(settings.codexReasoningEffort).toBe('low');
    expect(settings.enableFormatRepair).toBe(false);
    expect(settings.enableQualityRepair).toBe(false);
    expect(settings.allowProviderFailureFallback).toBe(true);
    expect(settings.defaultTargetConcurrency).toBe(2);
    expect(settings.maxDirectoryTreeEntries).toBe(120);
  });

  it('keeps balanced defaults tuned for base generate', () => {
    const settings = getSpeedProfileSettings('balanced');
    expect(settings.defaultTargetConcurrency).toBe(2);
    expect(settings.codexReasoningEffort).toBe('medium');
    expect(settings.codexMaxEmptyRetries).toBe(1);
  });

  it('maps provider timeout by provider type', () => {
    const settings = getSpeedProfileSettings('max-quality');
    expect(getProviderTimeoutMs('codex-cli', settings)).toBe(300_000);
    expect(getProviderTimeoutMs('claude-code', settings)).toBe(420_000);
    expect(getProviderTimeoutMs('cursor-agent', settings)).toBe(420_000);
    expect(getProviderTimeoutMs('custom', settings)).toBe(300_000);
    expect(getProviderTimeoutMs('anthropic', settings)).toBeUndefined();
  });
});
