import type { TaskBundleCreateInput } from '../types.js';

const MAX_SOURCE_BRIEF_CHARS = 2800;

function renderList(values: string[] | undefined, fallback = '- none yet'): string {
  if (!values || values.length === 0) {
    return fallback;
  }

  return values.map((value) => `- ${value}`).join('\n');
}

function escapeManagedMarkers(value: string): string {
  return value.replace(/<!--\s*llm-docs:/gi, '<!-- escaped llm-docs:');
}

function compactText(value: string | null | undefined, maxChars = MAX_SOURCE_BRIEF_CHARS): string {
  const normalized = escapeManagedMarkers(value?.trim().replace(/\n{3,}/g, '\n\n') ?? '');
  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars).trimEnd()}\n\n_Trimmed by llm-docs: source text is longer than ${maxChars} characters. Keep the full source in raw.md or an artifact._`;
}

function sourceRef(input: TaskBundleCreateInput): string {
  const parts = [input.source.type, input.source.ref, input.source.url]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(' · ') : 'manual input';
}

export function renderSimpleContextTemplate(
  taskId: string,
  input: TaskBundleCreateInput,
  facts: {
    branch: string | null;
    baseBranch: string;
    head: string | null;
  },
): string {
  const sourceBrief = compactText(input.source.rawText);

  return `# ${taskId}: ${input.title}

## Entry Point
- purpose: durable working context for this task bundle
- source: ${sourceRef(input)}
- branch: ${facts.branch ?? 'n/a'}
- base branch: ${facts.baseBranch}
- head: ${facts.head ?? 'n/a'}
- default style: compact but narrative-rich; prefer grouped bullets over raw transcript dumps

## Original Request / Source Brief
${sourceBrief || '- Source text was not captured. Add the user request, Jira summary, acceptance criteria, or prompt excerpt here before major implementation work.'}

## Acceptance / Done Criteria
- Define the observable end state.
- Name the verification command, screenshot, artifact, review, or manual check that proves completion.
- Capture constraints that must not regress.

## Prepared Plan
- Summarize the intended implementation strategy before coding.
- Keep plan bullets concrete: boundaries, affected areas, sequencing, fallback paths.
- Mark plan changes in **Superseded / Historical Notes** instead of silently deleting them.

## Current State
- phase: implementation
- status: active
- shipped behavior: not summarized yet
- active blocker: none recorded

## Implementation Notes
### User-Facing Behavior
- Describe what changed from a user/product perspective.

### Implementation Details
- Capture the main code-level approach, not a raw diff.
- Include important adapters, data flow, feature flags, route boundaries, or design-system overrides.

### Source / Files Map
- Group touched files by purpose when implementation starts.
- Prefer area-based grouping such as \`area: path, path\` over a long flat list.

## Decisions
- No decisions recorded yet

## Superseded / Historical Notes
- No superseded notes recorded yet

## Verification
- not run yet

## Validation Gaps
- none recorded

## Risks / Constraints
- none recorded

## Next Steps
- Define the first implementation step.

## Related Docs
${renderList(input.relatedDocs)}

## Bundle Files
- context.md — current state, implementation story, and reload map
- raw.md — original source material or imported task text
- changelog.md — chronological milestone log
- state.json — deterministic structured state for llm-docs

<!-- llm-docs:checkpoint:start -->
## Latest Checkpoint
No checkpoint saved yet.
<!-- llm-docs:checkpoint:end -->
`;
}
