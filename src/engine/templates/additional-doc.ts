export function renderAdditionalDocTemplate(params: {
  taskId: string;
  title: string;
  description?: string;
}): string {
  const description = params.description?.trim();

  return `# ${params.title}

Task: ${params.taskId}

${description ? `${description}\n\n` : ''}## Purpose
- Explain why this document exists and how it should be used from context.md.

## Source Material
- Link or summarize the prompt, Jira issue, design frame, log, artifact, or code area this document is based on.

## Findings / Details
- Capture durable details that are too deep for context.md but useful for a future coding agent.
- Prefer grouped bullets and concrete paths over transcript-style narration.

## Decisions / Implications
- Active decisions this document supports.
- Superseded or rejected paths, if any.

## Verification / Evidence
- Commands, screenshots, logs, manual checks, or artifacts connected to these findings.

## Follow-ups
- Open questions, risks, or next implementation steps.
`;
}
