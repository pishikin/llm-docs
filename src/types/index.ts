export type Target = 'claude' | 'codex' | 'cursor';

export type ProviderType = 'anthropic' | 'claude-code' | 'codex-cli' | 'cursor-agent' | 'custom';
export type SpeedProfile = 'fast' | 'balanced' | 'max-quality';

export interface CustomProviderConfig {
  baseUrl: string;
  apiKeyEnvVar: string;
}

export type CursorAgentTrustMode = 'manual' | 'trust' | 'yolo' | 'force';

export interface CursorAgentProviderConfig {
  trustMode?: CursorAgentTrustMode;
}

export interface ProviderConfig {
  type: ProviderType;
  model?: string;
  custom?: CustomProviderConfig;
  cursorAgent?: CursorAgentProviderConfig;
}

export interface ProjectConfig {
  name: string;
  targets: Target[];
  provider: ProviderConfig;
  excludeDirs: string[];
  docsDir: string;
}

export interface DetectedTools {
  linter: string | null;
  formatter: string | null;
  bundler: string | null;
  testRunner: string | null;
  typeChecker: string | null;
}

export interface FactPack {
  projectName: string;
  language: string;
  packageManager: string;
  scripts: Record<string, string>;
  dependencies: string[];
  devDependencies: string[];
  directoryTree: string[];
  detectedTools: DetectedTools;
  entryPoints: string[];
  configFiles: string[];
  hasTests: boolean;
  testFramework: string | null;
  hasCI: boolean;
  ciPlatform: string | null;
  riskSignals: FactPackRiskSignals;
  projectFacts: FactPackProjectFacts;
}

export interface FactPackRiskSignals {
  tokenStorageLocalStorage: boolean;
  apiMockCoverageGaps: string[];
  toolingDependencyGaps: string[];
  strictTypeScriptFlags: string[];
  notes: string[];
}

export interface FactPackProjectFacts {
  routePaths: string[];
  authApiFunctions: string[];
  authApiEndpoints: string[];
  mockAuthEndpoints: string[];
  tokenStorageWriteFiles: string[];
  anyTypeUsageFiles: string[];
  hasJsonServerDependency: boolean;
  jsonServerScriptNames: string[];
  eslintNoExplicitAnyRuleConfigured: boolean;
}

export interface RawScanData {
  projectName: string;
  rootDir: string;
  packageJson: Record<string, unknown> | null;
  directoryTree: string[];
  configFiles: string[];
  entryPoints: string[];
  hasTests: boolean;
  testFiles: string[];
  hasCI: boolean;
  ciFiles: string[];
}

export interface GenerationResult {
  target: Target;
  rootContent: string;
  detailedDocs: DetailedDoc[];
}

export interface DetailedDoc {
  filename: string;
  content: string;
}

export interface ValidationResult {
  valid: boolean;
  warnings: ValidationIssue[];
  errors: ValidationIssue[];
  score: ValidationScoreReport;
}

export interface ValidationIssue {
  file: string;
  line: number;
  type:
    | 'missing-command'
    | 'missing-path'
    | 'stale-reference'
    | 'invalid-root-structure'
    | 'missing-critical-warning'
    | 'target-inconsistency'
    | 'inconsistent-quality-gate'
    | 'low-information-density';
  message: string;
  reference: string;
}

export type ValidationScoreCriterionKey =
  | 'accuracy'
  | 'actionability'
  | 'crossTargetConsistency'
  | 'safetyCoverage'
  | 'maintainability'
  | 'driftResistance';

export type ValidationScoreBand = 'fail' | 'acceptable' | 'good' | 'excellent';

export interface ValidationScoreCriterion {
  key: ValidationScoreCriterionKey;
  label: string;
  weight: number;
  score: number;
}

export type ValidationChecklistStatus = 'pass' | 'fail' | 'unknown';

export interface ValidationChecklistItem {
  id: string;
  label: string;
  status: ValidationChecklistStatus;
  details: string;
}

export interface ValidationScoreReport {
  overall: number;
  band: ValidationScoreBand;
  criteria: ValidationScoreCriterion[];
  checklist: ValidationChecklistItem[];
}

export interface DiffAnalysis {
  changedFiles: string[];
  impactedSections: string[];
  summary: string;
}

export interface LLMProvider {
  generate(prompt: string, systemPrompt: string): Promise<string>;
}
