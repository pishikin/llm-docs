import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildFactPack } from '../../src/core/fact-pack.js';
import { scanProject } from '../../src/core/scanner.js';

describe('buildFactPack', () => {
  it('builds fact pack from scan data', async () => {
    const projectRoot = path.resolve(import.meta.dirname, '../..');
    const scanData = await scanProject(projectRoot);
    const factPack = await buildFactPack(scanData);

    expect(factPack.projectName).toBe('llm-docs');
    expect(factPack.language).toBe('typescript');
    expect(factPack.packageManager).toBe('npm');
    expect(factPack.scripts).toHaveProperty('build');
    expect(factPack.scripts).toHaveProperty('test');
    expect(factPack.detectedTools.typeChecker).toBe('typescript');
    expect(factPack.detectedTools.bundler).toBe('tsup');
    expect(factPack.detectedTools.testRunner).toBe('vitest');
    expect(typeof factPack.riskSignals.tokenStorageLocalStorage).toBe('boolean');
    expect(Array.isArray(factPack.riskSignals.apiMockCoverageGaps)).toBe(true);
    expect(Array.isArray(factPack.riskSignals.toolingDependencyGaps)).toBe(true);
    expect(Array.isArray(factPack.riskSignals.strictTypeScriptFlags)).toBe(true);
    expect(Array.isArray(factPack.projectFacts.routePaths)).toBe(true);
    expect(Array.isArray(factPack.projectFacts.authApiFunctions)).toBe(true);
    expect(Array.isArray(factPack.projectFacts.tokenStorageWriteFiles)).toBe(true);
    expect(Array.isArray(factPack.projectFacts.anyTypeUsageFiles)).toBe(true);
    expect(Array.isArray(factPack.projectFacts.jsonServerScriptNames)).toBe(true);
    expect(typeof factPack.projectFacts.hasJsonServerDependency).toBe('boolean');
    expect(typeof factPack.projectFacts.eslintNoExplicitAnyRuleConfigured).toBe('boolean');
  });

  it('limits dependencies to 30', async () => {
    const scanData = await scanProject(path.resolve(import.meta.dirname, '../..'));
    const factPack = await buildFactPack(scanData);

    expect(factPack.dependencies.length).toBeLessThanOrEqual(30);
    expect(factPack.devDependencies.length).toBeLessThanOrEqual(20);
  });
});
