export function renderCursorRule(): string {
  return `---
description: llm-docs task bundle guidance
alwaysApply: false
---

# llm-docs Task Context

- Start shared documentation lookup at \`.claude/docs/README.md\`.
- Use \`.claude/tasks/<task-id>\` for task-specific context and working state.
- Keep source-of-truth in the task bundle plus shared docs, not in one huge root rule.
- Do not dump archive or research content into active task context unless needed.
- Root rules are advisory. Narrative details belong in task bundle docs.
`;
}
