import type { TaskBundleCreateInput } from '../types.js';

const MAX_SOURCE_BRIEF_CHARS = 3200;

function renderList(values: string[] | undefined, fallback = '- none yet'): string {
  if (!values || values.length === 0) {
    return fallback;
  }

  return values.map((value) => `- ${value}`).join('\n');
}

function escapeManagedMarkers(value: string): string {
  return value.replace(/<!--\s*llm-docs:/gi, '<!-- escaped llm-docs:');
}

function compactText(value: string | null | undefined): string {
  const normalized = escapeManagedMarkers(value?.trim().replace(/\n{3,}/g, '\n\n') ?? '');
  if (!normalized) {
    return '';
  }

  if (normalized.length <= MAX_SOURCE_BRIEF_CHARS) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_SOURCE_BRIEF_CHARS).trimEnd()}\n\n_Trimmed by llm-docs: full source remains in raw.md or attached artifacts._`;
}

function sourceRef(input: TaskBundleCreateInput): string {
  const parts = [input.source.type, input.source.ref, input.source.url]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(' · ') : 'manual input';
}

export function renderContextTemplate(
  taskId: string,
  input: TaskBundleCreateInput,
  facts: {
    branch: string | null;
    baseBranch: string;
    head: string | null;
    lastVerifiedCommit: string | null;
  },
): string {
  const sourceBrief = compactText(input.source.rawText);

  return `# Working Context — ${taskId}

## Entry Point
- purpose: current working state and navigation map for this task bundle
- source: ${sourceRef(input)}
- phase: implementation
- status: active
- default style: compact but narrative-rich; synthesize the work instead of copying raw transcripts

## Original Request / Source Brief
${sourceBrief || '- Source text was not captured. Add the initial user request, Jira summary, or acceptance criteria here.'}

## Acceptance / Done Criteria
- Observable task outcome is not defined yet.
- Verification surface is not defined yet.
- Non-regression constraints are not defined yet.

## Prepared Plan
- Normalize task spec.
- Build initial context.
- Record plan changes as superseded notes instead of overwriting history.

## Source of Truth
- task.md — stable task spec, scope, and done criteria
- context.md — current state, implementation story, and reload map
- changelog.md — chronological milestone log
- raw.md — imported or pasted source material

## Git Baseline
- current branch: ${facts.branch ?? 'n/a'}
- base branch: ${facts.baseBranch}
- HEAD: ${facts.head ?? 'n/a'}
- last verified commit: ${facts.lastVerifiedCommit ?? 'n/a'}

## Read First
- context.md
- task.md
- changelog.md

## Relevant Canonical Docs
${renderList(input.relatedDocs)}

## Current State
- shipped behavior: not summarized yet
- active blocker: none recorded
- next continuation point: define implementation sequence

## Implementation Notes
### User-Facing Behavior
- Describe visible behavior, API behavior, or operational behavior delivered by the task.

### Implementation Details
- Capture the code-level approach, important data flow, integration boundaries, and trade-offs.

### Source / Files Map
- Group touched files by area once implementation starts.

## Decisions
- none yet

## Superseded / Historical Notes
- none yet

## Verification
- not run yet

## Validation Gaps
- none recorded

## Risks / Constraints
- none recorded

## Evidence to Review
- none recorded

## Open Questions
- none recorded

## Next Steps
- Define the first implementation step.
`;
}
