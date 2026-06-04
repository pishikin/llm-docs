# llm-docs

Task memory for AI coding agents.

`llm-docs` keeps the working memory of a software task in your repo, outside the
chat window. Start from a Jira issue, a GitHub issue, a Linear ticket, a
markdown spec, an incident note, or a plain local task. The result is the same:
a durable task bundle that your coding agent can read, update, checkpoint, and
publish back into project documentation.

It is built for developers who use Claude Code, Codex, Cursor, or similar
agents on real implementation work where context matters.

## Why it exists

Coding agents are useful, but a chat thread is a weak place to keep the truth of
a task.

A real task usually has:

- source material: ticket text, acceptance criteria, comments, links, or a
  short local brief;
- implementation context: plans, decisions, changed files, tradeoffs, and
  validation gaps;
- verification: tests, build output, screenshots, logs, or manual checks;
- handoff state: what is done, what is risky, what should happen next;
- team value: the final implementation story should be reusable later, not lost
  in one agent session.

`llm-docs` turns that state into a local task bundle. The bundle lives next to
your code, can follow a worktree, and can be published into shared project docs
when the task is done.

## Jira is supported, not required

Jira is one of the main use cases because many teams already plan work there.
If your team uses Jira, `llm-docs` can pull an issue into a task bundle and keep
the implementation context tied to that issue.

But Jira is not required. You can use the same task bundle workflow for:

- GitHub issues or Linear tickets;
- markdown specs and design notes;
- refactors and cleanup tasks;
- incidents and debugging sessions;
- research tasks;
- personal local todos that still need durable context.

The core idea is not "Jira documentation". The core idea is "one work item, one
structured task memory".

## How it works

```text
Work item
  -> task bundle
  -> agent implementation
  -> checkpoints
  -> actualization against code and git
  -> publish, handoff, or Jira-ready summary
```

A typical flow:

1. Create a task bundle from Jira, another issue tracker, a prompt, or a local
   task brief.
2. Let the coding agent work with the bundle through MCP tools, host skills, and
   hooks.
3. Save compact checkpoints as the implementation changes.
4. Actualize the bundle before handoff so the docs match the current code and
   git state.
5. Publish the finished task docs into the main worktree if the context should
   become shared team knowledge.

## What llm-docs gives you

- **Task bundles**: one local folder per task with source text, current context,
  changelog, structured state, and artifacts.
- **Durable context**: the next agent can reload the task without reading the
  whole chat history.
- **Checkpoints**: compact progress notes with decisions, touched files,
  verification, risks, and next steps.
- **Actualization**: a separate step that syncs task docs with code and git
  facts before handoff.
- **Worktree-friendly flow**: task context can live in an isolated feature
  worktree and later be published into main project docs.
- **Agent integrations**: MCP tools and generated host skills for Claude Code,
  Codex, and Cursor.
- **Jira helpers**: optional auth, issue pull, and task bundle creation for
  teams that work from Jira.

## Use with Jira

```bash
llm-docs jira auth login
llm-docs jira doctor
llm-docs task from-jira ABC-123 --use
```

This creates or refreshes a task bundle from the Jira issue and marks it as the
current task. From there, the agent can load the bundle, work through the task,
save checkpoints, and prepare a concise Jira-ready implementation summary.

## Use without Jira

For non-Jira work, use the MCP tool exposed to your configured agent:
`llmdocs.create_task_bundle`.

Example prompt for the agent:

```text
Create an llm-docs task bundle for this work.

Title: Refactor checkout validation
Source type: prompt
Brief: The checkout validation is duplicated across the form and submit handler.
Done criteria:
- validation rules live in one place
- current UI behavior stays unchanged
- focused tests cover the shared rules
```

The bundle can be created from a prompt, imported note, external doc, or issue
reference. After that, the workflow is the same as with Jira: checkpoint,
actualize, verify, and publish or hand off.

## Worktrees and shared docs

`llm-docs` fits the workflow where each substantial task gets its own git
worktree.

```bash
llm-docs worktree create ABC-123
llm-docs worktree seed
```

Use the task worktree for implementation. Keep the active task bundle there
while the work is moving. When the task is ready, publish the task docs back into
the main worktree:

```bash
llm-docs task publish ABC-123 --dry-run
llm-docs task publish ABC-123
```

That gives the team a durable implementation history in the main repo, without
copying notes by hand.

## Install from source

An npm package is not published yet. For now, run the CLI from a checked-out
repository:

```bash
git clone https://github.com/pishikin/llm-docs.git
cd llm-docs
npm install
npm run build
```

In a project where you want to use `llm-docs`, run setup with the built CLI:

```bash
node /path/to/llm-docs/dist/index.js setup --hosts claude,codex --enable-git-hooks
node /path/to/llm-docs/dist/index.js doctor
```

Setup creates the workspace, local launcher, host packs, MCP config, skills, and
optional git hooks. Root agent files stay thin. Task-specific state belongs in
task bundles.

The examples above use `llm-docs` for readability. When running from source,
replace it with `node /path/to/llm-docs/dist/index.js` before setup, or with the
generated `node .claude/bin/llm-docs.mjs` inside a configured workspace.

## Everyday commands

Check which task is active:

```bash
llm-docs task active --trace
```

Save implementation context:

```bash
llm-docs task checkpoint ABC-123 \
  --summary "Implemented shared checkout validation rules." \
  --file "src/checkout/validation.ts" \
  --verification "npm test -- checkout"
```

Check bundle handoff quality:

```bash
llm-docs task quality ABC-123
llm-docs task quality ABC-123 --json
```

Check workspace health:

```bash
llm-docs doctor --strict
llm-docs context status
```

## Storage model

The default layout keeps active task memory separate from shared project docs:

```text
.claude/
  docs/
    README.md
    tasks/
      ABC-123/
        summary.md
        context.md
        changelog.md
        publish.manifest.json
  .llm-docs/
    tasks/
      ABC-123/
        task.meta.yaml
        raw.md
        task.md
        context.md
        changelog.md
        state.json
        artifacts/
          index.json
        docs/
  skills/
.agents/
  skills/
.codex/
  config.toml
  hooks.json
.mcp.json
```

Human-readable task docs such as `context.md`, `task.md`, and `changelog.md`
are meant for developers and host agents. Structured files such as `state.json`,
`task.meta.yaml`, registries, and artifact indexes are owned by `llm-docs` and
should be updated through the CLI or MCP tools.

## Agent integration

`llm-docs` uses three integration surfaces:

- MCP for deterministic task reads and mutations.
- Skills for workflows such as create, checkpoint, actualize, publish, close,
  and handoff.
- Hooks for small lifecycle nudges at session start, prompt submit, stop,
  commit, merge, and push boundaries.

On protected branches such as `main`, hooks stay passive unless a task is
explicitly selected. In task worktrees, hooks can surface stale context warnings
and checkpoint guidance without turning every prompt into a workflow detour.

Checkpoint and actualization are intentionally separate:

- A **checkpoint** saves compact working memory: current goal, completed work,
  decisions, touched files, verification, risks, and next steps.
- **Actualization** syncs task docs with code and git facts: source-of-truth
  paths, phase/status, last actualized commit, and staleness state.

## More docs

- [`docs/default-task-bundle-quality.md`](docs/default-task-bundle-quality.md)
  explains what a useful task bundle should contain.
- [`docs/long-task-quality.md`](docs/long-task-quality.md) covers long-running,
  UI-heavy, research-heavy, and incident/debug tasks.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) covers local development and verification.

## Development

Main verification commands:

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:e2e
npm run build
```

Full project verification:

```bash
npm run verify
```

## License

MIT
