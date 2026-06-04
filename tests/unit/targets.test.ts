import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/utils/errors.js';
import {
  SUPPORTED_TARGETS,
  normalizeTargets,
  parseTargetsOption,
} from '../../src/utils/targets.js';

describe('targets utils', () => {
  it('parses comma-separated targets and removes duplicates', () => {
    expect(parseTargetsOption('claude, codex,claude')).toEqual(['claude', 'codex']);
  });

  it('throws on empty target list', () => {
    expect(() => parseTargetsOption('   ')).toThrow(ConfigError);
  });

  it('throws on unsupported targets', () => {
    expect(() => parseTargetsOption('claude,unknown')).toThrow(
      `Supported targets: ${SUPPORTED_TARGETS.join(', ')}`,
    );
  });

  it('normalizes targets from config arrays', () => {
    expect(normalizeTargets([' cursor ', 'codex'], 'config')).toEqual(['cursor', 'codex']);
  });
});
