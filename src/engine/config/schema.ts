import { z } from 'zod';
import type {
  ActualizationReport,
  ArtifactIndex,
  DoctorReport,
  LlmDocsConfig,
  RebaselineReport,
  SimpleTaskState,
  TaskMeta,
  TaskRegistry,
  WorkspaceStatusReport,
} from '../types.js';
import {
  ADDITIONAL_DOC_STATUS_VALUES,
  ADDITIONAL_DOC_TYPE_VALUES,
  ARTIFACT_KIND_VALUES,
  ARTIFACT_STORAGE_MODE_VALUES,
  DEFAULT_CONTEXT_BUDGET,
  TASK_BUNDLE_LAYOUT_VALUES,
  TASK_PHASE_VALUES,
  TASK_QUALITY_PROFILE_VALUES,
  TASK_SOURCE_TYPE_VALUES,
  TASK_STATUS_VALUES,
} from '../types.js';

const isoDateTimeSchema = z.string().datetime({ offset: true });
const nonEmptyStringSchema = z.string().min(1);
const nullableStringSchema = z.string().min(1).nullable();
const providerTypeSchema = z.enum([
  'anthropic',
  'claude-code',
  'codex-cli',
  'cursor-agent',
  'custom',
]);
const targetSchema = z.enum(['claude', 'codex', 'cursor']);

const providerConfigSchema = z.object({
  type: providerTypeSchema,
  model: z.string().min(1).optional(),
  custom: z
    .object({
      baseUrl: z.string().url(),
      apiKeyEnvVar: nonEmptyStringSchema,
    })
    .optional(),
  cursorAgent: z
    .object({
      trustMode: z.enum(['manual', 'trust', 'yolo', 'force']).optional(),
    })
    .optional(),
});

export const configSchema: z.ZodType<LlmDocsConfig> = z.object({
  schemaVersion: z.literal(2),
  projectName: nonEmptyStringSchema,
  mode: z.literal('context-ops'),
  contextBudget: z
    .object({
      activeContextMaxBytes: z.number().int().positive(),
      researchDocMaxBytes: z.number().int().positive(),
      checkpointMaxBytes: z.number().int().positive(),
      checkpointMaxBullets: z.number().int().positive(),
      transcriptRiskTokens: z.number().int().positive(),
    })
    .default(DEFAULT_CONTEXT_BUDGET),
  workspace: z.object({
    rootDir: nonEmptyStringSchema,
    docsDir: nonEmptyStringSchema,
    tasksDir: nonEmptyStringSchema,
    archiveDir: nonEmptyStringSchema,
    researchDir: nonEmptyStringSchema,
    promptsDir: nonEmptyStringSchema,
    skillsDir: nonEmptyStringSchema,
  }),
  taskBundles: z.object({
    registryPath: nonEmptyStringSchema,
    layout: z.enum(TASK_BUNDLE_LAYOUT_VALUES).default('auto'),
    defaultBaseBranch: nonEmptyStringSchema,
    artifactStorageMode: z.enum(ARTIFACT_STORAGE_MODE_VALUES),
    markStaleOnPostCommit: z.boolean(),
    markStaleOnPostMerge: z.boolean(),
    requireExplicitRebaseline: z.boolean(),
    relatedTaskLimit: z.number().int().positive(),
    qualityProfile: z.enum(TASK_QUALITY_PROFILE_VALUES).optional(),
  }),
  hosts: z.object({
    claude: z.object({
      enabled: z.boolean(),
      installHooks: z.boolean(),
      installSkills: z.boolean(),
    }),
    codex: z.object({
      enabled: z.boolean(),
      installHooks: z.boolean(),
      installSkills: z.boolean(),
    }),
    cursor: z.object({
      enabled: z.boolean(),
      installRules: z.boolean(),
    }),
  }),
  integrations: z.object({
    jira: z.object({
      enabled: z.boolean(),
      baseUrl: z.string().url().nullable(),
      tokenEnvVar: nonEmptyStringSchema.default('JIRA_TOKEN'),
      projectKeys: z.array(nonEmptyStringSchema),
    }),
    github: z.object({
      enabled: z.boolean(),
    }),
  }),
  worktrees: z
    .object({
      mainWorktreePath: z.string().min(1).nullable().optional(),
      mainBranch: z.string().min(1).nullable().optional(),
      publish: z
        .object({
          docsTasksDir: nonEmptyStringSchema.optional(),
          archiveTasksDir: nonEmptyStringSchema.optional(),
          includeArtifacts: z.enum(['copy', 'manifest-only', 'none']).optional(),
          conflictPolicy: z.enum(['fail', 'rename', 'overwrite']).optional(),
          requireCleanSource: z.boolean().optional(),
          requireCleanDestination: z.boolean().optional(),
          requireNoStaleTask: z.boolean().optional(),
          requireMergedBeforeDelete: z.boolean().optional(),
          writeManifest: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  legacyAgentDocs: z
    .object({
      enabled: z.boolean(),
      targets: z.array(targetSchema),
      provider: providerConfigSchema,
      docsDir: nonEmptyStringSchema,
      excludeDirs: z.array(nonEmptyStringSchema),
      extra: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

export const additionalDocSchema = z.object({
  id: nonEmptyStringSchema,
  path: nonEmptyStringSchema,
  doc_type: z.enum(ADDITIONAL_DOC_TYPE_VALUES),
  phase: z.enum(TASK_PHASE_VALUES),
  status: z.enum(ADDITIONAL_DOC_STATUS_VALUES),
  title: nonEmptyStringSchema,
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
});

export const taskMetaSchema: z.ZodType<TaskMeta> = z.object({
  schema_version: z.literal(1),
  task_id: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  status: z.enum(TASK_STATUS_VALUES),
  phase: z.enum(TASK_PHASE_VALUES),
  source: z.object({
    type: z.enum(TASK_SOURCE_TYPE_VALUES),
    ref: nullableStringSchema,
    url: z.string().url().nullable(),
  }),
  bundle: z.object({
    path: nonEmptyStringSchema,
    created_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
    created_by: z.literal('llm-docs'),
    version: z.literal(1),
  }),
  branch: z.object({
    current: nullableStringSchema,
    base: nonEmptyStringSchema,
    linked_branches: z.array(nonEmptyStringSchema),
    last_verified_commit: nullableStringSchema,
    last_actualized_commit: nullableStringSchema,
  }),
  truth: z.object({
    source_of_truth_paths: z.array(nonEmptyStringSchema),
    source_of_truth_docs: z.array(nonEmptyStringSchema),
    current_truth_note: nullableStringSchema,
  }),
  staleness: z.object({
    needs_actualization: z.boolean(),
    reasons: z.array(nonEmptyStringSchema),
    last_checked_at: isoDateTimeSchema.nullable(),
  }),
  related: z.object({
    docs: z.array(nonEmptyStringSchema),
    tasks: z.array(nonEmptyStringSchema),
    tags: z.array(nonEmptyStringSchema),
  }),
  docs: z.object({
    primary: z.object({
      raw: nonEmptyStringSchema,
      task: nonEmptyStringSchema,
      context: nonEmptyStringSchema,
      changelog: nonEmptyStringSchema,
    }),
    additional: z.array(additionalDocSchema),
  }),
  artifacts: z.object({
    index_path: nonEmptyStringSchema,
    count: z.number().int().nonnegative(),
  }),
  history: z.object({
    archived: z.boolean(),
    archived_at: isoDateTimeSchema.nullable(),
    archive_reason: nullableStringSchema,
    published: z.boolean().optional(),
    published_at: isoDateTimeSchema.nullable().optional(),
    publish_manifest_path: nullableStringSchema.optional(),
    publish_destination_path: nullableStringSchema.optional(),
    publish_destination_commit: nullableStringSchema.optional(),
  }),
});

export const simpleTaskStateSchema: z.ZodType<SimpleTaskState> = z.object({
  schemaVersion: z.literal(1),
  taskId: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  status: z.enum(TASK_STATUS_VALUES),
  phase: z.enum(TASK_PHASE_VALUES),
  source: z.object({
    type: z.enum(TASK_SOURCE_TYPE_VALUES),
    ref: nullableStringSchema,
    url: z.string().url().nullable(),
  }),
  bundle: z.object({
    path: nonEmptyStringSchema,
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    createdBy: z.literal('llm-docs'),
    layout: z.literal('simple'),
  }),
  branch: z.object({
    current: nullableStringSchema,
    base: nonEmptyStringSchema,
    linkedBranches: z.array(nonEmptyStringSchema),
    lastVerifiedCommit: nullableStringSchema,
    lastActualizedCommit: nullableStringSchema,
  }),
  staleness: z.object({
    needsActualization: z.boolean(),
    reasons: z.array(nonEmptyStringSchema),
    lastCheckedAt: isoDateTimeSchema.nullable(),
  }),
  related: z.object({
    docs: z.array(nonEmptyStringSchema),
    tasks: z.array(nonEmptyStringSchema),
    tags: z.array(nonEmptyStringSchema),
  }),
  truth: z.object({
    sourceOfTruthPaths: z.array(nonEmptyStringSchema),
    sourceOfTruthDocs: z.array(nonEmptyStringSchema),
    currentTruthNote: nullableStringSchema,
  }),
  docs: z.object({
    context: nonEmptyStringSchema,
    additional: z.array(additionalDocSchema),
  }),
  artifacts: z.object({
    indexPath: nonEmptyStringSchema,
    count: z.number().int().nonnegative(),
  }),
  qualityProfile: z.enum(TASK_QUALITY_PROFILE_VALUES).optional(),
  checkpoint: z.object({
    lastCheckpointAt: isoDateTimeSchema.nullable(),
    lastCheckpointHead: nullableStringSchema,
    lastAutosaveAt: isoDateTimeSchema.nullable(),
    lastTranscriptOffset: z.number().int().nonnegative().nullable(),
    estimatedTranscriptTokens: z.number().int().nonnegative().nullable(),
    promptCountSinceCheckpoint: z.number().int().nonnegative(),
    needsQualityCheckpoint: z.boolean(),
    lastContextWarningKey: nullableStringSchema.default(null),
    lastContextWarningAt: isoDateTimeSchema.nullable().default(null),
  }),
  history: z.object({
    archived: z.boolean(),
    archived_at: isoDateTimeSchema.nullable(),
    archive_reason: nullableStringSchema,
    published: z.boolean().optional(),
    published_at: isoDateTimeSchema.nullable().optional(),
    publish_manifest_path: nullableStringSchema.optional(),
    publish_destination_path: nullableStringSchema.optional(),
    publish_destination_commit: nullableStringSchema.optional(),
  }),
});

export const taskRegistryEntrySchema = z.object({
  taskId: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  status: z.enum(TASK_STATUS_VALUES),
  phase: z.enum(TASK_PHASE_VALUES),
  bundlePath: nonEmptyStringSchema,
  sourceType: z.enum(TASK_SOURCE_TYPE_VALUES),
  sourceRef: nullableStringSchema,
  currentBranch: nullableStringSchema,
  linkedBranches: z.array(nonEmptyStringSchema),
  lastVerifiedCommit: nullableStringSchema,
  lastActualizedCommit: nullableStringSchema,
  needsActualization: z.boolean(),
  archived: z.boolean(),
  updatedAt: isoDateTimeSchema,
});

export const taskRegistrySchema: z.ZodType<TaskRegistry> = z
  .object({
    schemaVersion: z.literal(1),
    updatedAt: isoDateTimeSchema,
    activeTaskId: nullableStringSchema,
    tasks: z.record(z.string(), taskRegistryEntrySchema),
    branchToTask: z.record(z.string(), z.string()),
  })
  .superRefine((value, ctx) => {
    if (value.activeTaskId && !value.tasks[value.activeTaskId]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `activeTaskId points to missing task: ${value.activeTaskId}`,
      });
    }

    for (const [taskId, entry] of Object.entries(value.tasks)) {
      if (!entry.bundlePath) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `task ${taskId} has empty bundlePath`,
        });
      }
    }

    for (const [branch, taskId] of Object.entries(value.branchToTask)) {
      if (!value.tasks[taskId]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `branch mapping for ${branch} points to missing task ${taskId}`,
        });
      }
    }
  });

const artifactRecordSchema = z.object({
  id: nonEmptyStringSchema,
  filename: nonEmptyStringSchema,
  relativePath: nonEmptyStringSchema,
  kind: z.enum(ARTIFACT_KIND_VALUES),
  sourcePath: nonEmptyStringSchema,
  storageMode: z.enum(ARTIFACT_STORAGE_MODE_VALUES),
  attachedAt: isoDateTimeSchema,
  summary: nullableStringSchema,
  tags: z.array(nonEmptyStringSchema),
});

export const artifactIndexSchema: z.ZodType<ArtifactIndex> = z.object({
  schemaVersion: z.literal(1),
  updatedAt: isoDateTimeSchema,
  artifacts: z.array(artifactRecordSchema),
});

export const actualizationReportSchema: z.ZodType<ActualizationReport> = z.object({
  taskId: nonEmptyStringSchema,
  bundlePath: nonEmptyStringSchema,
  needsActualization: z.boolean(),
  reasons: z.array(nonEmptyStringSchema),
  git: z.object({
    branch: nullableStringSchema,
    baseBranch: nonEmptyStringSchema,
    head: nullableStringSchema,
    lastActualizedCommit: nullableStringSchema,
    changedFiles: z.array(nonEmptyStringSchema),
    stagedFiles: z.array(nonEmptyStringSchema),
    untrackedFiles: z.array(nonEmptyStringSchema),
  }),
  impacts: z.object({
    changedTruthPaths: z.array(nonEmptyStringSchema),
    changedRelatedDocs: z.array(nonEmptyStringSchema),
    suggestUpdateTaskSpec: z.boolean(),
    suggestUpdateContext: z.boolean(),
    suggestAppendChangelog: z.boolean(),
    suggestPhaseDoc: nullableStringSchema,
    suggestTruthReview: z.boolean(),
  }),
  suggestions: z.object({
    sourceOfTruthCandidates: z.array(nonEmptyStringSchema),
    readFirst: z.array(nonEmptyStringSchema),
    relatedTasks: z.array(
      z.object({
        taskId: nonEmptyStringSchema,
        score: z.number().int(),
        reasons: z.array(nonEmptyStringSchema),
      }),
    ),
  }),
});

export const rebaselineReportSchema: z.ZodType<RebaselineReport> = z.object({
  taskId: nonEmptyStringSchema,
  bundlePath: nonEmptyStringSchema,
  currentBranch: nullableStringSchema,
  head: nullableStringSchema,
  previousPhase: z.enum(TASK_PHASE_VALUES),
  suggestedPhase: z.enum(TASK_PHASE_VALUES),
  historicalDocs: z.array(nonEmptyStringSchema),
  truthTransition: z.object({
    previousTruthPaths: z.array(nonEmptyStringSchema),
    suggestedTruthPaths: z.array(nonEmptyStringSchema),
    note: nonEmptyStringSchema,
  }),
  suggestions: z.object({
    updateContext: z.boolean(),
    appendChangelog: z.boolean(),
    archiveTask: z.boolean(),
  }),
});

export const workspaceStatusReportSchema: z.ZodType<WorkspaceStatusReport> = z.object({
  projectRoot: nonEmptyStringSchema,
  configPath: nonEmptyStringSchema,
  workspaceRoot: nonEmptyStringSchema,
  activeTaskId: nullableStringSchema,
  registryHealthy: z.boolean(),
  hostHealth: z.object({
    claude: z.boolean(),
    codex: z.boolean(),
    cursor: z.boolean(),
  }),
});

export const doctorReportSchema: z.ZodType<DoctorReport> = z.object({
  projectRoot: nonEmptyStringSchema,
  ok: z.boolean(),
  checks: z.array(
    z.object({
      id: nonEmptyStringSchema,
      ok: z.boolean(),
      severity: z.enum(['info', 'warning', 'error']),
      message: nonEmptyStringSchema,
    }),
  ),
});
