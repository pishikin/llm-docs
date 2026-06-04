import type { ProviderConfig, Target } from '../types/index.js';

export const TASK_STATUS_VALUES = ['draft', 'active', 'blocked', 'done', 'archived'] as const;
export const TASK_PHASE_VALUES = [
  'intake',
  'clarification',
  'ready',
  'implementation',
  'validation',
  'dev-fixes',
  'rollout',
  'merged',
  'archived',
] as const;
export const TASK_SOURCE_TYPE_VALUES = [
  'jira',
  'issue',
  'prompt',
  'imported',
  'external-doc',
] as const;
export const ADDITIONAL_DOC_TYPE_VALUES = [
  'context',
  'review',
  'analysis',
  'plan',
  'research',
] as const;
export const ADDITIONAL_DOC_STATUS_VALUES = ['active', 'historical', 'superseded'] as const;
export const ARTIFACT_KIND_VALUES = [
  'log',
  'har',
  'doc',
  'json',
  'snapshot',
  'image',
  'other',
] as const;
export const ARTIFACT_STORAGE_MODE_VALUES = ['copy', 'hardlink', 'symlink'] as const;
export const TASK_BUNDLE_LAYOUT_VALUES = ['simple', 'full', 'auto'] as const;
export const TASK_QUALITY_PROFILE_VALUES = [
  'compact',
  'normal',
  'long-running',
  'large-ui',
  'research-heavy',
] as const;
export const CHECKPOINT_KIND_VALUES = [
  'progress',
  'milestone',
  'handoff',
  'pause',
  'incident',
  'publish',
] as const;

export const DEFAULT_CONTEXT_BUDGET = {
  activeContextMaxBytes: 18000,
  researchDocMaxBytes: 24000,
  checkpointMaxBytes: 10000,
  checkpointMaxBullets: 55,
  transcriptRiskTokens: 50000,
} as const;

export type TaskStatus = (typeof TASK_STATUS_VALUES)[number];
export type TaskPhase = (typeof TASK_PHASE_VALUES)[number];
export type TaskSourceType = (typeof TASK_SOURCE_TYPE_VALUES)[number];
export type AdditionalDocType = (typeof ADDITIONAL_DOC_TYPE_VALUES)[number];
export type AdditionalDocStatus = (typeof ADDITIONAL_DOC_STATUS_VALUES)[number];
export type ArtifactKind = (typeof ARTIFACT_KIND_VALUES)[number];
export type ArtifactStorageMode = (typeof ARTIFACT_STORAGE_MODE_VALUES)[number];
export type TaskBundleLayout = (typeof TASK_BUNDLE_LAYOUT_VALUES)[number];
export type TaskQualityProfile = (typeof TASK_QUALITY_PROFILE_VALUES)[number];
export type CheckpointKind = (typeof CHECKPOINT_KIND_VALUES)[number];

export interface LlmDocsConfigV2 {
  schemaVersion: 2;
  projectName: string;
  mode: 'context-ops';
  contextBudget: {
    activeContextMaxBytes: number;
    researchDocMaxBytes: number;
    checkpointMaxBytes: number;
    checkpointMaxBullets: number;
    transcriptRiskTokens: number;
  };
  workspace: {
    rootDir: string;
    docsDir: string;
    tasksDir: string;
    archiveDir: string;
    researchDir: string;
    promptsDir: string;
    skillsDir: string;
  };
  taskBundles: {
    registryPath: string;
    layout: TaskBundleLayout;
    defaultBaseBranch: string;
    artifactStorageMode: ArtifactStorageMode;
    markStaleOnPostCommit: boolean;
    markStaleOnPostMerge: boolean;
    requireExplicitRebaseline: boolean;
    relatedTaskLimit: number;
    qualityProfile?: TaskQualityProfile;
  };
  hosts: {
    claude: {
      enabled: boolean;
      installHooks: boolean;
      installSkills: boolean;
    };
    codex: {
      enabled: boolean;
      installHooks: boolean;
      installSkills: boolean;
    };
    cursor: {
      enabled: boolean;
      installRules: boolean;
    };
  };
  integrations: {
    jira: {
      enabled: boolean;
      baseUrl: string | null;
      tokenEnvVar: string;
      projectKeys: string[];
    };
    github: {
      enabled: boolean;
    };
  };
  worktrees?: {
    mainWorktreePath?: string | null;
    mainBranch?: string | null;
    publish?: {
      docsTasksDir?: string;
      archiveTasksDir?: string;
      includeArtifacts?: TaskPublishArtifactPolicy;
      conflictPolicy?: TaskPublishConflictPolicy;
      requireCleanSource?: boolean;
      requireCleanDestination?: boolean;
      requireNoStaleTask?: boolean;
      requireMergedBeforeDelete?: boolean;
      writeManifest?: boolean;
    };
  };
  legacyAgentDocs?: {
    enabled: boolean;
    targets: Target[];
    provider: ProviderConfig;
    docsDir: string;
    excludeDirs: string[];
    extra?: Record<string, unknown>;
  };
}

export interface WorkspaceRelativePaths {
  configPath: string;
  workspaceRoot: string;
  workspaceBinDir: string;
  tasksDir: string;
  registryPath: string;
  docsDir: string;
  archiveDir: string;
  researchDir: string;
  promptsDir: string;
  cliLauncherPath: string;
  claudeSkillsDir: string;
  codexSkillsDir: string;
  cursorRulesDir: string;
  mcpConfigPath: string;
  claudeSettingsPath: string;
  codexConfigPath: string;
  codexHooksPath: string;
}

export interface WorkspacePaths {
  projectRoot: string;
  configPath: string;
  workspaceRoot: string;
  workspaceBinDir: string;
  tasksDir: string;
  registryPath: string;
  docsDir: string;
  archiveDir: string;
  researchDir: string;
  promptsDir: string;
  cliLauncherPath: string;
  claudeSkillsDir: string;
  codexSkillsDir: string;
  cursorRulesDir: string;
  mcpConfigPath: string;
  claudeSettingsPath: string;
  codexConfigPath: string;
  codexHooksPath: string;
  relative: WorkspaceRelativePaths;
}

export interface TaskMetaSource {
  type: TaskSourceType;
  ref: string | null;
  url: string | null;
}

export interface TaskMetaBundleInfo {
  path: string;
  created_at: string;
  updated_at: string;
  created_by: 'llm-docs';
  version: 1;
}

export interface TaskMetaBranchInfo {
  current: string | null;
  base: string;
  linked_branches: string[];
  last_verified_commit: string | null;
  last_actualized_commit: string | null;
}

export interface TaskMetaTruthInfo {
  source_of_truth_paths: string[];
  source_of_truth_docs: string[];
  current_truth_note: string | null;
}

export interface TaskMetaStalenessInfo {
  needs_actualization: boolean;
  reasons: string[];
  last_checked_at: string | null;
}

export interface TaskMetaRelatedInfo {
  docs: string[];
  tasks: string[];
  tags: string[];
}

export interface AdditionalDocRecord {
  id: string;
  path: string;
  doc_type: AdditionalDocType;
  phase: TaskPhase;
  status: AdditionalDocStatus;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface TaskMetaDocsInfo {
  primary: {
    raw: string;
    task: string;
    context: string;
    changelog: string;
  };
  additional: AdditionalDocRecord[];
}

export interface TaskMetaArtifactsInfo {
  index_path: string;
  count: number;
}

export interface TaskMetaHistoryInfo {
  archived: boolean;
  archived_at: string | null;
  archive_reason: string | null;
  published?: boolean;
  published_at?: string | null;
  publish_manifest_path?: string | null;
  publish_destination_path?: string | null;
  publish_destination_commit?: string | null;
}

export interface TaskMeta {
  schema_version: 1;
  task_id: string;
  title: string;
  status: TaskStatus;
  phase: TaskPhase;
  source: TaskMetaSource;
  bundle: TaskMetaBundleInfo;
  branch: TaskMetaBranchInfo;
  truth: TaskMetaTruthInfo;
  staleness: TaskMetaStalenessInfo;
  related: TaskMetaRelatedInfo;
  docs: TaskMetaDocsInfo;
  artifacts: TaskMetaArtifactsInfo;
  history: TaskMetaHistoryInfo;
}

export interface SimpleTaskState {
  schemaVersion: 1;
  taskId: string;
  title: string;
  status: TaskStatus;
  phase: TaskPhase;
  source: TaskMetaSource;
  bundle: {
    path: string;
    createdAt: string;
    updatedAt: string;
    createdBy: 'llm-docs';
    layout: 'simple';
  };
  branch: {
    current: string | null;
    base: string;
    linkedBranches: string[];
    lastVerifiedCommit: string | null;
    lastActualizedCommit: string | null;
  };
  staleness: {
    needsActualization: boolean;
    reasons: string[];
    lastCheckedAt: string | null;
  };
  related: {
    docs: string[];
    tasks: string[];
    tags: string[];
  };
  truth: {
    sourceOfTruthPaths: string[];
    sourceOfTruthDocs: string[];
    currentTruthNote: string | null;
  };
  docs: {
    context: string;
    additional: AdditionalDocRecord[];
  };
  artifacts: {
    indexPath: string;
    count: number;
  };
  qualityProfile?: TaskQualityProfile;
  checkpoint: {
    lastCheckpointAt: string | null;
    lastCheckpointHead: string | null;
    lastAutosaveAt: string | null;
    lastTranscriptOffset: number | null;
    estimatedTranscriptTokens: number | null;
    promptCountSinceCheckpoint: number;
    needsQualityCheckpoint: boolean;
    lastContextWarningKey: string | null;
    lastContextWarningAt: string | null;
  };
  history: TaskMetaHistoryInfo;
}

export interface TaskRegistryEntry {
  taskId: string;
  title: string;
  status: TaskStatus;
  phase: TaskPhase;
  bundlePath: string;
  sourceType: TaskSourceType;
  sourceRef: string | null;
  currentBranch: string | null;
  linkedBranches: string[];
  lastVerifiedCommit: string | null;
  lastActualizedCommit: string | null;
  needsActualization: boolean;
  archived: boolean;
  updatedAt: string;
}

export interface TaskRegistry {
  schemaVersion: 1;
  updatedAt: string;
  activeTaskId: string | null;
  tasks: Record<string, TaskRegistryEntry>;
  branchToTask: Record<string, string>;
}

export interface ArtifactRecord {
  id: string;
  filename: string;
  relativePath: string;
  kind: ArtifactKind;
  sourcePath: string;
  storageMode: ArtifactStorageMode;
  attachedAt: string;
  summary: string | null;
  tags: string[];
}

export interface ArtifactIndex {
  schemaVersion: 1;
  updatedAt: string;
  artifacts: ArtifactRecord[];
}

export interface PrepareJiraDocInput {
  taskId: string;
  maxLines?: number;
}

export interface PrepareJiraDocResult {
  taskId: string;
  requestedTaskId: string;
  source: {
    kind: 'published' | 'active';
    bundlePath: string;
    publishedIndexPath: string | null;
    manifestPath: string | null;
  };
  meta: {
    title: string;
    status: TaskStatus;
    phase: TaskPhase;
    sourceType: TaskSourceType;
    sourceRef: string | null;
    sourceUrl: string | null;
  };
  facts: {
    summary: string[];
    completedWork: string[];
    decisions: string[];
    verification: string[];
    risks: string[];
    artifactSummaries: string[];
  };
  sourcePaths: string[];
  warnings: string[];
  styleRules: string[];
}

export interface RelatedTaskSuggestion {
  taskId: string;
  score: number;
  reasons: string[];
}

export interface GitFacts {
  branch: string | null;
  baseBranch: string;
  head: string | null;
  mergeBase: string | null;
  changedFiles: string[];
  stagedFiles: string[];
  untrackedFiles: string[];
  ahead: number;
  behind: number;
}

export interface DiscoveredDoc {
  path: string;
  category: 'canonical' | 'rules' | 'research' | 'archive';
  title: string | null;
}

export interface RankedDoc extends DiscoveredDoc {
  score: number;
  reasons: string[];
}

export interface ActualizationReport {
  taskId: string;
  bundlePath: string;
  needsActualization: boolean;
  reasons: string[];
  git: {
    branch: string | null;
    baseBranch: string;
    head: string | null;
    lastActualizedCommit: string | null;
    changedFiles: string[];
    stagedFiles: string[];
    untrackedFiles: string[];
  };
  impacts: {
    changedTruthPaths: string[];
    changedRelatedDocs: string[];
    suggestUpdateTaskSpec: boolean;
    suggestUpdateContext: boolean;
    suggestAppendChangelog: boolean;
    suggestPhaseDoc: string | null;
    suggestTruthReview: boolean;
  };
  suggestions: {
    sourceOfTruthCandidates: string[];
    readFirst: string[];
    relatedTasks: RelatedTaskSuggestion[];
  };
}

export interface RebaselineReport {
  taskId: string;
  bundlePath: string;
  currentBranch: string | null;
  head: string | null;
  previousPhase: TaskPhase;
  suggestedPhase: TaskPhase;
  historicalDocs: string[];
  truthTransition: {
    previousTruthPaths: string[];
    suggestedTruthPaths: string[];
    note: string;
  };
  suggestions: {
    updateContext: boolean;
    appendChangelog: boolean;
    archiveTask: boolean;
  };
}

export interface WorkspaceStatusReport {
  projectRoot: string;
  configPath: string;
  workspaceRoot: string;
  activeTaskId: string | null;
  registryHealthy: boolean;
  hostHealth: {
    claude: boolean;
    codex: boolean;
    cursor: boolean;
  };
}

export interface DoctorCheck {
  id: string;
  ok: boolean;
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export interface DoctorReport {
  projectRoot: string;
  ok: boolean;
  checks: DoctorCheck[];
}

export type TaskPublishMode = 'docs' | 'archive';
export type TaskPublishConflictPolicy = 'fail' | 'rename' | 'overwrite';
export type TaskPublishArtifactPolicy = 'copy' | 'manifest-only' | 'none';

export interface TaskPublishPrepareInput {
  taskId?: string | null;
  dest?: string | null;
  archive?: boolean;
  keepSource?: boolean;
  deleteWorktree?: boolean;
  force?: boolean;
  allowStale?: boolean;
  skipRebaselineCheck?: boolean;
  conflictPolicy?: TaskPublishConflictPolicy;
  includeArtifacts?: TaskPublishArtifactPolicy;
  dryRun?: boolean;
}

export interface TaskPublishSourceInfo {
  projectRoot: string;
  bundlePath: string;
  branch: string | null;
  baseBranch: string;
  commit: string | null;
  gitCommonDir: string | null;
  clean: boolean;
  bundleHash: string | null;
}

export interface TaskPublishDestinationInfo {
  projectRoot: string;
  resolvedBy: 'flag' | 'config' | 'env' | 'git-worktree' | 'current-root';
  targetPath: string;
  branch: string | null;
  commitBefore: string | null;
  gitCommonDir: string | null;
  clean: boolean;
}

export interface TaskPublishFileEntry {
  path: string;
  size: number;
  sha256: string;
  generated?: boolean;
}

export interface TaskPublishOperation {
  op:
    | 'copy-tree'
    | 'write-manifest'
    | 'write-summary'
    | 'upsert-published-index'
    | 'mark-source-published'
    | 'delete-worktree'
    | 'idempotent-skip'
    | 'backup-existing'
    | 'rename-target';
  from?: string;
  to?: string;
  path?: string;
  files?: number;
}

export interface TaskPublishConflict {
  path: string;
  kind:
    | 'exists-without-manifest'
    | 'manifest-different'
    | 'destination-unsafe'
    | 'destination-ambiguous'
    | 'stale-task'
    | 'delete-worktree-unsafe';
  message: string;
}

export interface TaskPublishPlan {
  schemaVersion: 1;
  action: 'task-publish';
  dryRun: boolean;
  taskId: string;
  mode: TaskPublishMode;
  source: TaskPublishSourceInfo;
  destination: TaskPublishDestinationInfo;
  checks: DoctorCheck[];
  operations: TaskPublishOperation[];
  conflicts: TaskPublishConflict[];
  warnings: string[];
  files: TaskPublishFileEntry[];
}

export interface TaskPublishManifest {
  schemaVersion: 1;
  taskId: string;
  mode: TaskPublishMode;
  publishedAt: string;
  publishedBy: {
    tool: 'llm-docs';
    version: string;
  };
  source: TaskPublishSourceInfo & {
    taskMetaHash: string | null;
    artifactIndexHash: string | null;
  };
  destination: TaskPublishDestinationInfo & {
    commitAfter: string | null;
    bundleHash: string | null;
  };
  files: TaskPublishFileEntry[];
  checks: {
    stale: boolean;
    publishedWithStaleTask: boolean;
    sourceClean: boolean;
    destinationCleanBefore: boolean;
    sourceMergedIntoBase: boolean | null;
  };
  conflictPolicy: TaskPublishConflictPolicy;
  includeArtifacts: TaskPublishArtifactPolicy;
}

export interface PublishedTaskIndexEntry {
  taskId: string;
  title: string;
  status: TaskStatus;
  phase: TaskPhase;
  publishedAt: string;
  path: string;
  sourceBranch: string | null;
  sourceCommit: string | null;
  destinationCommit: string | null;
  bundleHash: string | null;
  manifestPath: string;
}

export interface PublishedTaskIndex {
  schemaVersion: 1;
  updatedAt: string;
  tasks: Record<string, PublishedTaskIndexEntry>;
}

export interface TaskPublishReport extends TaskPublishPlan {
  applied: boolean;
  manifestPath: string | null;
  indexPath: string | null;
  deletedWorktree: boolean;
}

export interface TaskCloseInput extends TaskPublishPrepareInput {
  publish?: boolean;
  deleteActive?: boolean;
}

export interface TaskCloseOperation {
  op:
    | 'publish-task'
    | 'archive-active-bundle'
    | 'delete-active-bundle'
    | 'remove-active-registry-entry';
  from?: string;
  to?: string;
  path?: string;
}

export interface TaskClosePlan {
  schemaVersion: 1;
  action: 'task-close';
  dryRun: boolean;
  taskId: string;
  publish: boolean;
  sourceBundlePath: string;
  archivePath: string | null;
  publishPlan: TaskPublishPlan | null;
  checks: DoctorCheck[];
  operations: TaskCloseOperation[];
  conflicts: TaskPublishConflict[];
  warnings: string[];
}

export interface TaskCloseReport extends TaskClosePlan {
  applied: boolean;
  publishReport: TaskPublishReport | null;
}

export interface ActiveTasksMigrationInput {
  dryRun?: boolean;
}

export interface ActiveTasksMigrationOperation {
  op:
    | 'move-task-bundle'
    | 'write-registry'
    | 'write-active-file'
    | 'write-config'
    | 'remove-legacy-file'
    | 'remove-empty-legacy-dir'
    | 'noop';
  taskId?: string;
  from?: string;
  to?: string;
  path?: string;
  message?: string;
}

export interface ActiveTasksMigrationReport {
  schemaVersion: 1;
  action: 'migrate-active-tasks';
  dryRun: boolean;
  sourceTasksDir: string;
  targetTasksDir: string;
  sourceRegistryPath: string;
  targetRegistryPath: string;
  alreadyMigrated: boolean;
  tasks: string[];
  operations: ActiveTasksMigrationOperation[];
  conflicts: TaskPublishConflict[];
  warnings: string[];
}

export type WorktreeSeedConflictPolicy = 'fail' | 'candidate' | 'overwrite-managed';

export interface WorktreeSeedProfile {
  include: string[];
  exclude?: string[];
}

export interface WorktreeSeedManifest {
  schemaVersion: 1;
  profiles: Record<string, WorktreeSeedProfile>;
}

export interface WorktreeSeedInput {
  sourceRoot: string;
  destinationRoot: string;
  profile?: string;
  conflictPolicy?: WorktreeSeedConflictPolicy;
  dryRun?: boolean;
}

export interface WorktreeSeedFileOperation {
  path: string;
  action: 'copy' | 'skip' | 'candidate' | 'conflict';
  size?: number;
  sha256?: string;
  candidatePath?: string;
  message?: string;
}

export interface WorktreeSeedReport {
  schemaVersion: 1;
  action: 'worktree-seed';
  dryRun: boolean;
  sourceRoot: string;
  destinationRoot: string;
  profile: string;
  conflictPolicy: WorktreeSeedConflictPolicy;
  manifestPath: string | null;
  files: WorktreeSeedFileOperation[];
  summary: {
    copied: number;
    skipped: number;
    candidates: number;
    conflicts: number;
  };
}

export interface WorktreeCreateInput {
  taskId: string;
  mainRoot: string;
  targetPath?: string | null;
  branch?: string | null;
  base?: string | null;
  hosts?: string;
  seedProfile?: string;
  conflictPolicy?: WorktreeSeedConflictPolicy;
  dryRun?: boolean;
}

export interface WorktreeCreateReport {
  schemaVersion: 1;
  action: 'worktree-create';
  dryRun: boolean;
  taskId: string;
  mainRoot: string;
  targetPath: string;
  branch: string;
  base: string;
  seed: WorktreeSeedReport;
  setup: WorkspaceBootstrapReport | null;
}

export interface WorkspaceHealthReport {
  checks: DoctorCheck[];
  hostHealth: WorkspaceStatusReport['hostHealth'];
  registryHealthy: boolean;
  activeTaskId: string | null;
}

export interface TaskSourceInput {
  type: TaskSourceType;
  ref: string | null;
  url: string | null;
  rawText: string | null;
}

export interface TaskBundleCreateInput {
  taskId?: string | null;
  title: string;
  source: TaskSourceInput;
  branch?: string | null;
  baseBranch?: string | null;
  tags?: string[];
  relatedDocs?: string[];
  createIfExists?: boolean;
  now?: Date;
}

export interface TaskBundleFiles {
  meta?: string;
  raw?: string;
  task?: string;
  context: string;
  changelog?: string;
  state?: string;
}

export interface TaskBundleCreateResult {
  taskId: string;
  bundlePath: string;
  created: boolean;
  files: TaskBundleFiles;
  initialContextFacts: {
    branch: string | null;
    baseBranch: string;
    head: string | null;
  };
}

export interface TaskBundleLoadOptions {
  includeContents?: boolean;
  includeArtifacts?: boolean;
}

export interface TaskBundleSnapshot {
  taskId: string;
  bundlePath: string;
  meta: TaskMeta;
  registryEntry: TaskRegistryEntry | null;
  primaryDocs: Partial<Record<keyof TaskBundleFiles, string>>;
  additionalDocs: AdditionalDocRecord[];
  artifactIndex: ArtifactIndex | null;
}

export interface ChangelogEpochInput {
  label: string;
  summary: string[];
  structuredState?: {
    phase?: TaskPhase;
    status?: TaskStatus;
    branch?: string | null;
  };
  decisions?: string[];
  nextSteps?: string[];
  timestamp?: string;
}

export interface ChangelogEpoch {
  timestamp: string;
  label: string;
  summary: string[];
  structuredState: string[];
  decisions: string[];
  nextSteps: string[];
}

export interface LoadOrMigrateConfigOptions {
  dryRun?: boolean;
  createIfMissing?: boolean;
}

export interface LoadOrMigrateConfigResult {
  config: LlmDocsConfigV2;
  configPath: string;
  status: 'loaded' | 'migrated' | 'created';
  wroteConfig: boolean;
  migrationSummary: string[];
}

export interface WorkspaceBootstrapOptions {
  dryRun?: boolean;
  installHosts?: Array<'claude' | 'codex' | 'cursor'>;
  enableGitHooks?: boolean;
  force?: boolean;
  writePolicy?: 'safe' | 'candidate' | 'managed-block';
  collectOperation?: (operation: WorkspaceBootstrapOperation) => void;
}

export interface WorkspaceBootstrapOperation {
  path: string;
  kind:
    | 'directory'
    | 'launcher'
    | 'root-doc'
    | 'host-config'
    | 'skill'
    | 'git-hook'
    | 'cursor-rule'
    | 'manifest';
  action:
    | 'create'
    | 'update'
    | 'merge-json'
    | 'merge-toml'
    | 'replace-managed-block'
    | 'write-candidate'
    | 'skip'
    | 'error';
  ownership?: string;
  candidatePath?: string;
  safe: boolean;
  message: string;
}

export interface WorkspaceBootstrapReport {
  projectRoot: string;
  dryRun: boolean;
  createdDirs: string[];
  existingDirs: string[];
  hostPackStatus: 'skipped' | 'installed';
  gitHookStatus: 'skipped' | 'installed';
  generatedFiles?: string[];
  operations?: WorkspaceBootstrapOperation[];
  summary?: {
    creates: number;
    updates: number;
    candidates: number;
    conflicts: number;
    errors: number;
  };
}

export interface WorkspaceLegacyAliasHit {
  kind: 'archive' | 'prompts';
  canonicalPath: string;
  aliasPath: string;
}

export interface AttachArtifactInput {
  sourcePath: string;
  filename?: string | null;
  kind: ArtifactKind;
  summary?: string | null;
  tags?: string[];
  storageMode?: ArtifactStorageMode;
}

export interface AttachArtifactResult {
  taskId: string;
  artifactId: string;
  relativePath: string;
  storageMode: ArtifactStorageMode;
  warning?: string;
}

export interface ActualizationApplyInput {
  taskId: string;
  clearStaleness?: boolean;
  phase?: TaskPhase;
  status?: TaskStatus;
  lastActualizedCommit: string | null;
  sourceOfTruthPaths?: string[];
  truthNote?: string | null;
  relatedDocs?: string[];
  additionalDocs?: Array<{
    id: string;
    path: string;
    docType: AdditionalDocType;
    phase: TaskPhase;
    status: AdditionalDocStatus;
    title: string;
  }>;
}

export interface RebaselineApplyInput {
  taskId: string;
  phase: TaskPhase;
  status: TaskStatus;
  currentBranch: string | null;
  lastVerifiedCommit: string | null;
  sourceOfTruthPaths: string[];
  historicalDocs: string[];
  archiveTask?: boolean;
}

export interface RelatedTasksQuery {
  query: string;
  paths?: string[];
  limit?: number;
  includeArchived?: boolean;
  excludeSelfTaskId?: string | null;
}

export interface ActiveTaskResolution {
  taskId: string;
  resolvedBy:
    | 'explicit'
    | 'codex-session'
    | 'env'
    | 'active-file'
    | 'branch-name'
    | 'branch-mapping'
    | 'registry-active'
    | 'cwd-bundle'
    | 'branch-scan';
  bundlePath: string;
}

export type ActiveTaskResolutionSource = ActiveTaskResolution['resolvedBy'];

export interface ActiveResolutionPolicy {
  includeExplicit?: boolean;
  includeCodexSession?: boolean;
  includeEnv?: boolean;
  includeWorkspaceActive?: boolean;
  includeRegistryActive?: boolean;
  includeBranchName?: boolean;
  includeBranchMapping?: boolean;
  includeCwdBundle?: boolean;
  includeFallbackBranchScan?: boolean;
  bindCodexSession?: boolean;
  protectedBranchBehavior?: 'normal' | 'session-or-explicit';
}

export type ActiveResolutionTraceStatus = 'resolved' | 'missing' | 'ignored' | 'invalid' | 'paused';

export interface ActiveResolutionTraceStep {
  source: ActiveTaskResolutionSource | 'codex-session-paused' | 'protected-branch';
  status: ActiveResolutionTraceStatus;
  taskId?: string | null;
  message: string;
}

export interface ActiveTaskResolutionTrace {
  branch: string | null;
  protectedBranch: boolean;
  policy: Required<ActiveResolutionPolicy>;
  resolution: ActiveTaskResolution | null;
  steps: ActiveResolutionTraceStep[];
}

export type TaskQualitySeverity = 'info' | 'warning' | 'error';
export type TaskQualityStatus = 'pass' | 'warn' | 'fail';

export interface TaskQualityFinding {
  id: string;
  severity: TaskQualitySeverity;
  message: string;
  evidence?: string[];
  suggestion?: string;
}

export interface TaskQualityReport {
  schemaVersion: 1;
  taskId: string;
  bundlePath: string;
  generatedAt: string;
  status: TaskQualityStatus;
  score: number;
  profile: {
    effective: TaskQualityProfile;
    configured: TaskQualityProfile | null;
    suggested: TaskQualityProfile;
    reasons: string[];
  };
  metrics: {
    contextBytes: number;
    changelogBytes: number;
    summaryBytes: number;
    additionalDocCount: number;
    sourceOfTruthPathCount: number;
    latestCheckpointAt: string | null;
    latestChangelogAt: string | null;
    activeTaskStale: boolean;
    estimatedTranscriptTokens: number | null;
  };
  findings: TaskQualityFinding[];
}

export interface SaveContextCheckpointInput {
  taskId?: string | null;
  summary?: string[];
  currentState?: string[];
  requirements?: string[];
  plan?: string[];
  userFacingBehavior?: string[];
  completedWork?: string[];
  implementationDetails?: string[];
  implementationMap?: string[];
  decisions?: string[];
  designConstraints?: string[];
  superseded?: string[];
  files?: string[];
  verification?: string[];
  validationGaps?: string[];
  risks?: string[];
  nextSteps?: string[];
  notes?: string[];
  lastCheckpointHead?: string | null;
  timestamp?: string;
  codexSessionId?: string | null;
  checkpointKind?: CheckpointKind;
  appendChangelog?: boolean;
  phaseLabel?: string | null;
  qualityProfile?: TaskQualityProfile;
}

export interface SaveContextCheckpointResult {
  taskId: string;
  contextPath: string;
  statePath: string;
  lastCheckpointAt: string;
  needsQualityCheckpoint: boolean;
  warnings: string[];
  changelogAppended?: boolean;
  changelogPath?: string | null;
  resumeKind?: 'checkpoint' | 'actualization' | null;
  resumeOriginalPrompt?: string | null;
  resumeGuidance?: string | null;
}

export interface TaskSimplifyInput {
  taskId: string;
  dryRun?: boolean;
  keepLegacy?: boolean;
}

export interface TaskSimplifyReport {
  schemaVersion: 1;
  action: 'task-simplify';
  dryRun: boolean;
  taskId: string;
  sourceLayout: 'full' | 'simple';
  targetLayout: 'simple';
  operations: Array<{
    op: 'write-context' | 'write-state' | 'move-legacy' | 'skip';
    path: string;
  }>;
  files: {
    context: string;
    state: string;
    legacyDir: string | null;
  };
}

export interface HostInstallOptions {
  dryRun?: boolean;
  force?: boolean;
  writePolicy?: WorkspaceBootstrapOptions['writePolicy'];
  collectOperation?: (operation: WorkspaceBootstrapOperation) => void;
}

export interface HostInstallReport {
  host: 'claude' | 'codex' | 'cursor';
  filesWritten: string[];
  filesCreated: string[];
  warnings: string[];
}
