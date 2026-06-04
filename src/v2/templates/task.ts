export function renderTaskTemplate(
  taskId: string,
  title: string,
  relatedDocs: string[] = [],
): string {
  const relatedDocsLines =
    relatedDocs.length > 0 ? relatedDocs.map((doc) => `- ${doc}`).join('\n') : '- none yet';

  return `# Task Spec — ${taskId}

## Goal
${title}

## Source Brief
- Capture the user request, Jira summary, acceptance criteria, and key references in compact form.
- Keep full raw input in raw.md or artifacts; this file should stay readable as the stable spec.

## Background / Product Context
- Why this task exists.
- Who or what is affected.
- Important upstream constraints or design references.

## In Scope
- Define the implementation surface.

## Out of Scope
- Define explicit non-goals and unchanged legacy behavior.

## Acceptance / Done Criteria
- Observable end state.
- Required verification evidence.
- Non-regression constraints.

## Prepared Plan
- Implementation sequence.
- File/component/domain boundaries.
- Rollback or fallback path if relevant.

## Implementation Map
- Group source paths by purpose as work progresses.

## Decisions
- Active decisions.

## Superseded / Historical Notes
- Plan changes, rejected options, or decisions replaced by later evidence.

## Verification Plan
- Commands, manual checks, screenshots, artifacts, or review evidence required before handoff.

## Risks
- Known risks, assumptions, dependencies, or validation gaps.

## Open Questions
- Questions that still require user, design, backend, or product clarification.

## Related Docs
${relatedDocsLines}
`;
}
