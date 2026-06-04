export function renderLegacyClaudeRootDoc(): string {
  return `# Claude Workspace Guide

This repository uses \`llm-docs\` as a local-first task bundle and context operations layer.

- Start project documentation lookup at \`.claude/docs/README.md\`.
- Use \`.claude/skills/llm-docs-*\` for task lifecycle work.
- Keep task-specific state in \`.claude/tasks/<task-id>\`.
- Keep root instructions short; do not dump task history into \`CLAUDE.md\`.
- Load \`archive/\` and \`research/\` only when directly relevant.
`;
}

export function renderClaudeRootDoc(): string {
  return `# Claude Workspace Guide

<!-- llm-docs:start -->
This repository uses \`llm-docs\` as a task bundle and context operations layer for coding agents.

- When the user mentions llm-docs, task bundle/таск бандл, Jira task, worktree/ворктри, checkpoint, actualize/актуализируй, handoff, publish, close, or rebaseline, use the \`llm-docs\` skill before guessing commands.
- If the user asks "дай команды" / "show commands", output commands only; if the user asks "сделай" / "do it", run a cheap preflight and execute the focused workflow.
- Prefer existing llm-docs MCP tools for task-bundle operations and CLI for setup, git/worktree, doctor, and dry-runs; use narrow \`--help\` only when exact flags are uncertain.
- Keep root instructions thin; task-specific state belongs in \`.claude/.llm-docs/tasks/<task-id>\` and published task docs belong in \`.claude/docs/tasks/<task-id>\`.
- Do not bulk-load archive, research, raw Jira JSON, logs, screenshots, or artifacts unless the request needs that evidence.
<!-- llm-docs:end -->
`;
}

export function renderLegacyAgentsRootDoc(): string {
  return `# Codex Workspace Guide

This repository uses \`llm-docs\` as a task bundle and context operations layer for coding agents.

- Start project documentation lookup at \`.claude/docs/README.md\`.
- Use \`.agents/skills/llm-docs-*\` for create/actualize/rebaseline/artifact flows.
- Keep task-specific state in \`.claude/tasks/<task-id>\`.
- Keep \`AGENTS.md\` thin; put active task details into the bundle.
- Do not bulk-load \`archive/\` or \`research/\` unless the task requires it.
`;
}

export function renderAgentsRootDoc(): string {
  return `# Codex Workspace Guide

<!-- llm-docs:start -->
This repository uses \`llm-docs\` as a task bundle and context operations layer for coding agents.

- When the user mentions llm-docs, task bundle/таск бандл, Jira task, worktree/ворктри, checkpoint, actualize/актуализируй, handoff, publish, close, or rebaseline, use the \`llm-docs\` skill before guessing commands.
- If the user asks "дай команды" / "show commands", output commands only; if the user asks "сделай" / "do it", run a cheap preflight and execute the focused workflow.
- Prefer existing llm-docs MCP tools for task-bundle operations and CLI for setup, git/worktree, doctor, and dry-runs; use narrow \`--help\` only when exact flags are uncertain.
- Keep root instructions thin; task-specific state belongs in \`.claude/.llm-docs/tasks/<task-id>\` and published task docs belong in \`.claude/docs/tasks/<task-id>\`.
- Do not bulk-load archive, research, raw Jira JSON, logs, screenshots, or artifacts unless the request needs that evidence.
<!-- llm-docs:end -->
`;
}
