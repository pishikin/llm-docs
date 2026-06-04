import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectProjectFacts } from '../../src/core/project-facts.js';
import { readJsonSafe } from '../../src/utils/fs.js';

describe('collectProjectFacts', () => {
  it('collects structured project facts from repository', async () => {
    const projectRoot = path.resolve(import.meta.dirname, '../..');
    const pkg = await readJsonSafe<Record<string, unknown>>(path.join(projectRoot, 'package.json'));
    const facts = await collectProjectFacts(projectRoot, pkg);

    expect(Array.isArray(facts.routePaths)).toBe(true);
    expect(Array.isArray(facts.authApiFunctions)).toBe(true);
    expect(Array.isArray(facts.authApiEndpoints)).toBe(true);
    expect(Array.isArray(facts.mockAuthEndpoints)).toBe(true);
    expect(Array.isArray(facts.tokenStorageWriteFiles)).toBe(true);
    expect(Array.isArray(facts.anyTypeUsageFiles)).toBe(true);
    expect(Array.isArray(facts.jsonServerScriptNames)).toBe(true);
    expect(typeof facts.hasJsonServerDependency).toBe('boolean');
    expect(typeof facts.eslintNoExplicitAnyRuleConfigured).toBe('boolean');
  });
});
