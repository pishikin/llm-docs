export const AGENT_GUIDE_SKILL_DIR = 'llm-docs';
export const AGENT_GUIDE_SKILL_RELATIVE_PATH = `${AGENT_GUIDE_SKILL_DIR}/SKILL.md`;
export const AGENT_GUIDE_RECIPES_RELATIVE_PATH = `${AGENT_GUIDE_SKILL_DIR}/references/recipes.md`;

export const AGENT_GUIDE_SKILL_MAX_BYTES = 8 * 1024;
export const AGENT_GUIDE_RECIPES_MAX_BYTES = 12 * 1024;
export const AGENT_GUIDE_ROOT_ROUTER_MAX_BYTES = 1536;

export const LEGACY_AGENT_GUIDE_SKILL_DIRS = [
  'llm-docs-task-bundle',
  'llm-docs-task-actualize',
  'llm-docs-task-artifact',
  'llm-docs-task-checkpoint',
  'llm-docs-task-publish',
  'llm-docs-task-rebaseline',
  'llm-docs-jira-doc',
] as const;

export function renderAgentGuideSkill(): string {
  return `---
name: llm-docs
description: "Use for llm-docs workflows: task bundle/таск бандл, Jira task pull/import, worktree/ворктри, checkpoint, actualize/актуализируй, handoff, task quality, publish, rebaseline. Distinguish commands-only requests from execute requests."
---

# llm-docs

Use this skill when the user mentions llm-docs, task bundles, таск бандл,
Jira task import/pull, worktree/ворктри, checkpoints, actualize/актуализируй,
handoff, task quality, publish, close, or rebaseline.

The CLI and MCP tools are the engine. This skill is only a compact workflow map:
do not create a second routing system, do not run extra diagnostics by default,
and do not load heavy task artifacts unless the request needs them.

## First classify the request

1. **Commands-only** — the user says "дай команды", "покажи команды",
   "show commands", or similar. Output commands only. Do not execute.
2. **Execute workflow** — the user says "сделай", "создай", "актуализируй",
   "подготовь", or similar. Run a cheap preflight, then execute.
3. **Inspect/report** — the user asks for status, quality, context, or current
   task state. Prefer read-only commands/tools.
4. **Publish/rebaseline/close** — high-risk lifecycle work. Prefer dry-run or
   prepare/preflight first, then apply only when intent is explicit.

## Speed rules

- Do not run \`llm-docs doctor\` before every operation.
- Do not run full repository scans unless a workflow explicitly needs them.
- Do not read published task docs, raw Jira JSON, large logs, screenshots, or
  artifacts unless the user asks or the current workflow requires evidence.
- Use \`--help\` only when exact flags are uncertain.
- Prefer one focused llm-docs command/tool over exploratory command chains.
- Keep root \`AGENTS.md\`/\`CLAUDE.md\` thin; task details belong in the bundle.

## Safety rules

- Start read-only when the workflow is ambiguous.
- For git/worktree writes, check current branch and \`git status --short\` first.
- For publish, close, and rebaseline, run dry-run/preflight first when available.
- For external writes such as Jira comments, require explicit user intent.
- Do not silently switch active task if a session is already bound to another
  task; report the conflict and ask only if execution cannot safely continue.
- Treat structured files such as \`state.json\`, registries, and artifact indexes
  as llm-docs engine-owned state. Update them through CLI/MCP operations.

## Prefer existing surfaces

- Prefer MCP tools when they are available for task-bundle operations.
- Use CLI for setup, git/worktree helpers, doctor, dry-runs, and commands not
  exposed through MCP.
- If exact syntax is uncertain, run the narrow help command, for example
  \`llm-docs task from-jira --help\` or \`llm-docs worktree create --help\`.

## Common workflows

### Jira pull/import commands only

For requests like "дай команды для пулла тасок из Jira по номерам 324, 356":

- Do not execute.
- Resolve the project prefix from visible config/context when obvious.
- If the prefix is unknown, use a placeholder and say what to replace.

Example:

\`\`\`bash
llm-docs task from-jira PROJ-324 --attachments
llm-docs task from-jira PROJ-356 --attachments
\`\`\`

### Create a task bundle and worktree

For requests like "сделай новый ворктри по таске 356, создай таск бандл":

1. Run cheap preflight: \`git status --short\`, \`git worktree list\`.
2. Import or create the task bundle, usually from Jira.
3. Create the worktree using project conventions or \`llm-docs worktree create\`.
4. Run setup/seed only if the new worktree lacks the host pack.
5. Bind the task only when requested or when the workflow convention requires it.
6. Report task id, bundle path, worktree path, branch, and next step.

### Actualize current task bundle

For "актуализируй таск бандл": resolve the active task, prepare actualization,
read the suggested source/docs, update narrative context/changelog as needed,
apply structured state, then run \`llm-docs task quality <task-id>\`.

### Handoff or checkpoint

For "сделай handoff" or "сохрани контекст": resolve the task, update the entry
point with source brief, current state, implementation map, verification, risks,
and next steps; save a checkpoint; append changelog for milestone/handoff work;
then run task quality when the task is non-trivial.

### Publish, close, or rebaseline

Use dry-run/preflight first. Final summaries should describe delivered behavior,
implementation map, verification, residual risks, and next steps. Do not treat
publish mechanics, CI/debug notes, or llm-docs internals as the task outcome.

## More recipes

Read \`references/recipes.md\` only when the compact workflows above are not
enough. Do not load that file for unrelated coding work.
`;
}

export function renderAgentGuideRecipes(): string {
  return `# llm-docs recipes

This reference is for coding agents. Use it only after the compact \`llm-docs\`
skill has matched a real llm-docs workflow. It is intentionally short and
workflow-oriented; exact flags should be confirmed with a narrow \`--help\` when
uncertain.

## Core distinction: commands-only vs execute

Commands-only requests:

- Russian examples: "дай команды", "покажи команды", "какие команды запустить".
- English examples: "show commands", "give me commands", "what should I run".
- Behavior: output commands and short notes only. Do not execute.

Execute requests:

- Russian examples: "сделай", "создай", "актуализируй", "подготовь".
- English examples: "do it", "create", "update", "prepare".
- Behavior: run cheap preflight, execute focused commands/tools, then report facts.

## Cheap preflight

Use only the checks needed for the workflow:

\`\`\`bash
git status --short
git branch --show-current
git worktree list
llm-docs task active --json
\`\`\`

Do not run \`llm-docs doctor\` unless the user asks for health/setup diagnosis or
a generated hook/launcher/config appears broken.

## Pull Jira issues into task bundles

When the user asks for commands only:

\`\`\`bash
llm-docs task from-jira PROJ-324 --attachments
llm-docs task from-jira PROJ-356 --attachments
\`\`\`

When the user asks to execute:

\`\`\`bash
llm-docs task from-jira PROJ-356 --attachments --use
\`\`\`

Use \`--session\` only when the task should be bound to the current Codex
session instead of the whole workspace. Use \`llm-docs task from-jira --help\` if
Jira profile, force-refresh, or session flags are uncertain.

## Create a worktree for a task

Preferred when the helper exists:

\`\`\`bash
llm-docs worktree create PROJ-356 --hosts claude,codex
\`\`\`

If the project uses a custom convention, use normal git worktree commands and
then run setup in the new worktree:

\`\`\`bash
git worktree add -b PROJ-356 ../<repo>-PROJ-356 main
cd ../<repo>-PROJ-356
llm-docs setup --hosts claude,codex
\`\`\`

Report the created target path, branch, copied seed files, and any candidates.

## Create or load a non-Jira task bundle

For prompt-based work, use the bundle creation surface exposed by MCP when
available. If using CLI, check \`llm-docs task --help\` because creation syntax
may differ by version. After creation, load the bundle before implementation.

Required initial narrative for meaningful bundles:

- original request / source brief;
- acceptance or done criteria;
- prepared plan;
- likely implementation areas;
- verification plan;
- risks and constraints.

## Actualize after code changes

Use this when code changed and the task bundle may be stale:

1. Resolve active task.
2. Prepare actualization.
3. Read only suggested source-of-truth paths and relevant docs.
4. Update narrative docs: \`context.md\`, \`changelog.md\`, and optional maps.
5. Apply structured actualization state through MCP/CLI.
6. Run quality diagnostics.

Avoid treating a checkpoint as actualization. A checkpoint is working memory;
actualization is semantic sync between task docs and code/git state.

## Save checkpoint or handoff

A good checkpoint is compact but semantic. Capture:

- current goal;
- completed work;
- user-facing behavior;
- implementation details grouped by area;
- active decisions and superseded decisions;
- touched files or implementation map;
- verification performed;
- validation gaps;
- risks;
- next steps.

For CLI checkpoint, prefer richer flags when available:

\`\`\`bash
llm-docs task checkpoint PROJ-356 \\
  --kind handoff \\
  --summary "Implemented the main feature slice." \\
  --behavior "Users can complete the new flow from the feature entry." \\
  --implementation-map "UI: src/...; tests: src/..." \\
  --verification "npm test -- <target>" \\
  --validation-gap "Staging-only provider check remains manual."
\`\`\`

For MCP, call \`llmdocs.save_context_checkpoint\` and include the same semantic
fields. For milestone/handoff work, append changelog as well.

## Quality check before handoff or publish

\`\`\`bash
llm-docs task quality PROJ-356
llm-docs task quality PROJ-356 --json
\`\`\`

Use quality output to fix stale changelog, missing verification, weak final
outcome, duplicate summary bullets, or source paths without a readable
implementation map.

## Publish, close, and rebaseline

Use dry-run or prepare first when available:

\`\`\`bash
llm-docs task publish PROJ-356 --dry-run
llm-docs task close PROJ-356 --dry-run
\`\`\`

Before applying, ensure the bundle is actualized, quality issues are understood,
and the summary describes product outcome rather than publish mechanics.

## Troubleshooting setup, hooks, or launcher

Run doctor only when setup/config/hook behavior looks broken:

\`\`\`bash
llm-docs doctor
llm-docs doctor --json
llm-docs setup --dry-run --hosts claude,codex
\`\`\`

Doctor is structural health. Task quality is handoff usefulness. Use the right
one to avoid slowing normal coding work.
`;
}

export function renderAgentGuideSkillFiles(): Record<string, string> {
  return {
    [AGENT_GUIDE_SKILL_RELATIVE_PATH]: renderAgentGuideSkill(),
    [AGENT_GUIDE_RECIPES_RELATIVE_PATH]: renderAgentGuideRecipes(),
  };
}
