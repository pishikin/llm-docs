import { z } from 'zod';
import {
  additionalDocSchema,
  artifactIndexSchema,
  doctorReportSchema,
  taskMetaSchema,
  taskRegistryEntrySchema,
  workspaceStatusReportSchema,
} from '../config/schema.js';
import {
  ADDITIONAL_DOC_STATUS_VALUES,
  ADDITIONAL_DOC_TYPE_VALUES,
  CHECKPOINT_KIND_VALUES,
  TASK_PHASE_VALUES,
  TASK_QUALITY_PROFILE_VALUES,
  TASK_SOURCE_TYPE_VALUES,
  TASK_STATUS_VALUES,
} from '../types.js';

export const emptyInputSchema = z.object({});
export const workspaceStatusOutputSchema = workspaceStatusReportSchema;

export const listTasksInputSchema = z.object({
  status: z.enum(TASK_STATUS_VALUES).optional(),
  limit: z.number().int().positive().optional(),
  includeArchived: z.boolean().optional(),
});
export const listTasksOutputSchema = z.object({
  tasks: z.array(taskRegistryEntrySchema),
});

export const resolveActiveTaskInputSchema = z.object({
  taskId: z.string().nullable().optional(),
  codexSessionId: z.string().nullable().optional(),
  bindCodexSession: z.boolean().optional(),
  branch: z.string().nullable().optional(),
  preferRegistryActive: z.boolean().optional(),
});
export const resolveActiveTaskOutputSchema = z.object({
  taskId: z.string().nullable(),
  resolvedBy: z
    .enum([
      'explicit',
      'codex-session',
      'env',
      'active-file',
      'branch-name',
      'branch-mapping',
      'registry-active',
      'cwd-bundle',
      'branch-scan',
    ])
    .nullable(),
  bundlePath: z.string().nullable(),
});

export const createTaskBundleInputSchema = z.object({
  taskId: z.string().nullable().optional(),
  title: z.string().min(1),
  source: z.object({
    type: z.enum(['jira', 'issue', 'prompt', 'imported', 'external-doc']),
    ref: z.string().nullable(),
    url: z.string().nullable(),
    rawText: z.string().nullable(),
  }),
  branch: z.string().nullable().optional(),
  baseBranch: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  relatedDocs: z.array(z.string()).optional(),
  createIfExists: z.boolean().optional(),
});
export const createTaskBundleOutputSchema = z.object({
  taskId: z.string(),
  bundlePath: z.string(),
  created: z.boolean(),
  files: z.object({
    meta: z.string().optional(),
    raw: z.string().optional(),
    task: z.string().optional(),
    context: z.string(),
    changelog: z.string().optional(),
    state: z.string().optional(),
  }),
  initialContextFacts: z.object({
    branch: z.string().nullable(),
    baseBranch: z.string(),
    head: z.string().nullable(),
  }),
});

export const loadTaskBundleInputSchema = z.object({
  taskId: z.string(),
  includeContents: z.boolean().optional(),
  includeArtifacts: z.boolean().optional(),
});
export const loadTaskBundleOutputSchema = z.object({
  taskId: z.string(),
  bundlePath: z.string(),
  meta: taskMetaSchema,
  registryEntry: taskRegistryEntrySchema.nullable(),
  primaryDocs: z.object({
    meta: z.string().optional(),
    state: z.string().optional(),
    raw: z.string().optional(),
    task: z.string().optional(),
    context: z.string().optional(),
    changelog: z.string().optional(),
  }),
  additionalDocs: z.array(additionalDocSchema),
  artifactIndex: artifactIndexSchema.nullable(),
});

export const prepareJiraDocInputSchema = z.object({
  taskId: z.string().min(1),
  maxLines: z.number().int().min(5).max(20).optional(),
});
export const prepareJiraDocOutputSchema = z.object({
  taskId: z.string(),
  requestedTaskId: z.string(),
  source: z.object({
    kind: z.enum(['published', 'active']),
    bundlePath: z.string(),
    publishedIndexPath: z.string().nullable(),
    manifestPath: z.string().nullable(),
  }),
  meta: z.object({
    title: z.string(),
    status: z.enum(TASK_STATUS_VALUES),
    phase: z.enum(TASK_PHASE_VALUES),
    sourceType: z.enum(TASK_SOURCE_TYPE_VALUES),
    sourceRef: z.string().nullable(),
    sourceUrl: z.string().nullable(),
  }),
  facts: z.object({
    summary: z.array(z.string()),
    completedWork: z.array(z.string()),
    decisions: z.array(z.string()),
    verification: z.array(z.string()),
    risks: z.array(z.string()),
    artifactSummaries: z.array(z.string()),
  }),
  sourcePaths: z.array(z.string()),
  warnings: z.array(z.string()),
  styleRules: z.array(z.string()),
});

export const appendChangelogEpochInputSchema = z.object({
  taskId: z.string(),
  label: z.string().min(1),
  summary: z.array(z.string()),
  structuredState: z
    .object({
      phase: z.enum(TASK_PHASE_VALUES).optional(),
      status: z.enum(TASK_STATUS_VALUES).optional(),
      branch: z.string().nullable().optional(),
    })
    .optional(),
  decisions: z.array(z.string()).optional(),
  nextSteps: z.array(z.string()).optional(),
});
export const appendChangelogEpochOutputSchema = z.object({
  taskId: z.string(),
  label: z.string(),
  timestamp: z.string(),
});

export const saveContextCheckpointInputSchema = z.object({
  taskId: z.string().nullable().optional(),
  codexSessionId: z.string().nullable().optional(),
  summary: z.array(z.string()).optional(),
  currentState: z.array(z.string()).optional(),
  requirements: z.array(z.string()).optional(),
  plan: z.array(z.string()).optional(),
  userFacingBehavior: z.array(z.string()).optional(),
  completedWork: z.array(z.string()).optional(),
  implementationDetails: z.array(z.string()).optional(),
  implementationMap: z.array(z.string()).optional(),
  decisions: z.array(z.string()).optional(),
  designConstraints: z.array(z.string()).optional(),
  superseded: z.array(z.string()).optional(),
  files: z.array(z.string()).optional(),
  verification: z.array(z.string()).optional(),
  validationGaps: z.array(z.string()).optional(),
  risks: z.array(z.string()).optional(),
  nextSteps: z.array(z.string()).optional(),
  notes: z.array(z.string()).optional(),
  lastCheckpointHead: z.string().nullable().optional(),
  checkpointKind: z.enum(CHECKPOINT_KIND_VALUES).optional(),
  appendChangelog: z.boolean().optional(),
  phaseLabel: z.string().nullable().optional(),
  qualityProfile: z.enum(TASK_QUALITY_PROFILE_VALUES).optional(),
});
export const saveContextCheckpointOutputSchema = z.object({
  taskId: z.string(),
  contextPath: z.string(),
  statePath: z.string(),
  lastCheckpointAt: z.string(),
  needsQualityCheckpoint: z.boolean(),
  warnings: z.array(z.string()),
  changelogAppended: z.boolean().optional(),
  changelogPath: z.string().nullable().optional(),
  resumeKind: z.enum(['checkpoint', 'actualization']).nullable().optional(),
  resumeOriginalPrompt: z.string().nullable().optional(),
  resumeGuidance: z.string().nullable().optional(),
});

export const attachArtifactInputSchema = z.object({
  taskId: z.string(),
  sourcePath: z.string(),
  filename: z.string().nullable().optional(),
  kind: z.enum(['log', 'har', 'doc', 'json', 'snapshot', 'image', 'other']),
  summary: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
});
export const attachArtifactOutputSchema = z.object({
  taskId: z.string(),
  artifactId: z.string(),
  relativePath: z.string(),
  storageMode: z.enum(['copy', 'hardlink', 'symlink']),
  warning: z.string().optional(),
});

export const prepareActualizationInputSchema = z.object({
  taskId: z.string(),
  fromCommit: z.string().nullable().optional(),
  includeRelatedTasks: z.boolean().optional(),
});
export const prepareActualizationOutputSchema = z.object({
  taskId: z.string(),
  bundlePath: z.string(),
  needsActualization: z.boolean(),
  reasons: z.array(z.string()),
  git: z.object({
    branch: z.string().nullable(),
    baseBranch: z.string(),
    head: z.string().nullable(),
    lastActualizedCommit: z.string().nullable(),
    changedFiles: z.array(z.string()),
    stagedFiles: z.array(z.string()),
    untrackedFiles: z.array(z.string()),
  }),
  impacts: z.object({
    changedTruthPaths: z.array(z.string()),
    changedRelatedDocs: z.array(z.string()),
    suggestUpdateTaskSpec: z.boolean(),
    suggestUpdateContext: z.boolean(),
    suggestAppendChangelog: z.boolean(),
    suggestPhaseDoc: z.string().nullable(),
    suggestTruthReview: z.boolean(),
  }),
  suggestions: z.object({
    sourceOfTruthCandidates: z.array(z.string()),
    readFirst: z.array(z.string()),
    relatedTasks: z.array(
      z.object({
        taskId: z.string(),
        score: z.number().int(),
        reasons: z.array(z.string()),
      }),
    ),
  }),
});

export const applyActualizationStateInputSchema = z.object({
  taskId: z.string(),
  clearStaleness: z.boolean().optional(),
  phase: z.enum(TASK_PHASE_VALUES).optional(),
  status: z.enum(TASK_STATUS_VALUES).optional(),
  lastActualizedCommit: z.string().nullable(),
  sourceOfTruthPaths: z.array(z.string()).optional(),
  truthNote: z.string().nullable().optional(),
  relatedDocs: z.array(z.string()).optional(),
  additionalDocs: z
    .array(
      z.object({
        id: z.string(),
        path: z.string(),
        docType: z.enum(ADDITIONAL_DOC_TYPE_VALUES),
        phase: z.enum(TASK_PHASE_VALUES),
        status: z.enum(ADDITIONAL_DOC_STATUS_VALUES),
        title: z.string(),
      }),
    )
    .optional(),
});
export const applyActualizationStateOutputSchema = taskMetaSchema;

export const prepareRebaselineInputSchema = z.object({
  taskId: z.string(),
  targetBranch: z.string().optional(),
});
export const prepareRebaselineOutputSchema = z.object({
  taskId: z.string(),
  bundlePath: z.string(),
  currentBranch: z.string().nullable(),
  head: z.string().nullable(),
  previousPhase: z.enum(TASK_PHASE_VALUES),
  suggestedPhase: z.enum(TASK_PHASE_VALUES),
  historicalDocs: z.array(z.string()),
  truthTransition: z.object({
    previousTruthPaths: z.array(z.string()),
    suggestedTruthPaths: z.array(z.string()),
    note: z.string(),
  }),
  suggestions: z.object({
    updateContext: z.boolean(),
    appendChangelog: z.boolean(),
    archiveTask: z.boolean(),
  }),
});

export const applyRebaselineStateInputSchema = z.object({
  taskId: z.string(),
  phase: z.enum(TASK_PHASE_VALUES),
  status: z.enum(TASK_STATUS_VALUES),
  currentBranch: z.string().nullable(),
  lastVerifiedCommit: z.string().nullable(),
  sourceOfTruthPaths: z.array(z.string()),
  historicalDocs: z.array(z.string()),
  archiveTask: z.boolean().optional(),
});
export const applyRebaselineStateOutputSchema = taskMetaSchema;

export const archiveTaskInputSchema = z.object({
  taskId: z.string(),
  reason: z.string(),
});
export const archiveTaskOutputSchema = taskMetaSchema;

export const taskPublishInputSchema = z.object({
  taskId: z.string().nullable().optional(),
  dest: z.string().nullable().optional(),
  archive: z.boolean().optional(),
  keepSource: z.boolean().optional(),
  deleteWorktree: z.boolean().optional(),
  force: z.boolean().optional(),
  allowStale: z.boolean().optional(),
  skipRebaselineCheck: z.boolean().optional(),
  conflictPolicy: z.enum(['fail', 'rename', 'overwrite']).optional(),
  includeArtifacts: z.enum(['copy', 'manifest-only', 'none']).optional(),
  dryRun: z.boolean().optional(),
});

export const taskPublishPlanOutputSchema = z
  .object({
    schemaVersion: z.literal(1),
    action: z.literal('task-publish'),
    dryRun: z.boolean(),
    taskId: z.string(),
    mode: z.enum(['docs', 'archive']),
    source: z.object({}).passthrough(),
    destination: z.object({}).passthrough(),
    checks: z.array(z.object({}).passthrough()),
    operations: z.array(z.object({}).passthrough()),
    conflicts: z.array(z.object({}).passthrough()),
    warnings: z.array(z.string()),
    files: z.array(z.object({}).passthrough()),
  })
  .passthrough();

export const taskPublishReportOutputSchema = taskPublishPlanOutputSchema.extend({
  applied: z.boolean(),
  manifestPath: z.string().nullable(),
  indexPath: z.string().nullable(),
  deletedWorktree: z.boolean(),
});

export const findRelatedTasksInputSchema = z.object({
  query: z.string(),
  paths: z.array(z.string()).optional(),
  limit: z.number().int().positive().optional(),
  includeArchived: z.boolean().optional(),
});
export const findRelatedTasksOutputSchema = z.object({
  tasks: z.array(
    z.object({
      taskId: z.string(),
      score: z.number().int(),
      reasons: z.array(z.string()),
    }),
  ),
});

export const doctorOutputSchema = doctorReportSchema;
