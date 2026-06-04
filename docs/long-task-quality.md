# Long task quality workflow

`llm-docs` now uses a balanced `normal` bundle by default: source brief, prepared plan, implementation story, verification, and compact navigation are captured without transcript dumps. Long UI, research-heavy, and incident/debug tasks still need a stronger handoff contract. Use this workflow when a task runs across many sessions, touches many source paths, or mixes implementation, design research, CI/debug work, and publication.

## Quality profiles

Supported profiles:

- `compact`: minimal profile for deliberately tiny fixes.
- `normal`: default balanced bundle with richer source brief, plan, implementation, and verification sections.
- `long-running`: larger checkpoint budgets and stronger changelog expectations.
- `large-ui`: long-running UI task profile; useful for design extraction, route isolation, reusable components, visual QA, and wizard/dialog work.
- `research-heavy`: larger task-memory budget for tasks with important research artifacts and decisions.

A profile can come from `llmdocs.config.json`, task state, or an explicit checkpoint option.

```json
{
  "taskBundles": {
    "qualityProfile": "large-ui"
  }
}
```

## Checkpoint with changelog integration

For compact and normal tasks, `save_context_checkpoint` still updates `context.md` and structured state unless changelog append is requested. For `long-running`, `large-ui`, and `research-heavy` profiles, milestone/handoff/incident/publish checkpoints append a compact changelog epoch by default.

CLI examples:

```bash
llm-docs task checkpoint TASK-123 \
  --kind milestone \
  --profile large-ui \
  --append-changelog \
  --phase-label "alpha home and wizard shipped" \
  --summary "Alpha home page, alpha components, wizard modal, assets, fonts, and tests are implemented." \
  --completed "Implemented AlphaHomePage route and page-local constants" \
  --completed "Implemented AlphaAgentWizardModal with local step state" \
  --verification "Ran focused unit tests and local frontend build"

llm-docs task checkpoint TASK-123 \
  --kind handoff \
  --profile large-ui \
  --phase-label "final handoff" \
  --append-changelog
```

MCP tool input example:

```json
{
  "taskId": "TASK-123",
  "checkpointKind": "milestone",
  "qualityProfile": "large-ui",
  "appendChangelog": true,
  "phaseLabel": "alpha wizard implementation",
  "summary": "Alpha home and wizard are implemented; CI OOM remains the only open risk.",
  "completed": ["Grouped alpha UI components", "Added wizard dialog steps"],
  "verification": ["Focused tests passed", "Local build passed"]
}
```

## Read-only bundle quality diagnostic

Run quality before handoff, publish, or when a long task feels shallow:

```bash
llm-docs task quality TASK-123
llm-docs task quality TASK-123 --json
```

The diagnostic is read-only. It checks whether the bundle is useful as future agent context, including:

- latest checkpoint newer than `changelog.md`;
- missing or weak final outcome;
- summary dominated by publish, CI, or debug mechanics;
- duplicate summary bullets;
- context saying something is no-op/out of scope while source-of-truth paths show implementation;
- source-of-truth paths without a readable implementation map;
- missing verification evidence;
- active task stale at handoff/publish time;
- active additional docs not surfaced from the entry point;
- structured `currentTruthNote` not synthesized into human docs;
- missing optional long-task docs.

Severity is intentionally advisory first. `doctor` checks structural health; `task quality` checks handoff usefulness.

## Recommended long-task docs

The default bundle keeps the first three surfaces available. These extra files are optional for compact/normal tasks, but useful when the profile is long-running, large-ui, or research-heavy:

```text
context.md                 current state, final outcome, and navigation map
changelog.md               compact milestone timeline
implementation-journal.md  cumulative implementation story
implementation-map.md      source paths grouped by purpose
verification.md            checks run, evidence, gaps, and CI status
decisions.md               active decisions and superseded plans
summary.md                 final publish/handoff entry point
```

Keep root agent docs thin. Long-task depth should live in the task bundle, not in `AGENTS.md`, `CLAUDE.md`, or global host rules.

## Publish summary rules

Publish summary generation now prefers durable task facts over the latest checkpoint alone. It favors:

1. final implementation/current-truth notes;
2. source-of-truth paths grouped by purpose;
3. active additional docs and verification evidence;
4. changelog milestones;
5. latest checkpoint only when it represents implementation state.

This prevents late CI/OOM, publish mechanics, or packaging checkpoints from becoming the apparent final outcome of a week-long task.

## Codex Stop hook launcher health

Consumer repositories should not depend on a global `llm-docs` binary or an invalid `<consumer-repo>/dist/index.js` fallback. The generated `.claude/bin/llm-docs.mjs` launcher resolves the CLI in this order:

1. `LLMDOCS_CLI_ENTRYPOINT`;
2. setup-time absolute CLI entrypoint;
3. workspace `node_modules/.bin/llm-docs`;
4. global `llm-docs` on `PATH`;
5. local `dist/index.js` only when the workspace itself is the `llm-docs` source repo.

`doctor` smoke-tests the generated launcher, and `setup --dry-run` reports a repair when an unchanged launcher exists but cannot execute.

Repair options:

```bash
npm run build
node dist/index.js setup --hosts codex

LLMDOCS_CLI_ENTRYPOINT=/absolute/path/to/llm-docs/dist/index.js \
  node .claude/bin/llm-docs.mjs --version
```

## Checkpoint severity and resume semantics

Checkpoint pressure is not all the same. The intended contract is:

- stale actualization and required checkpoint cases can block a Codex stop hook;
- Codex `UserPromptSubmit` should stay passive for these cases: persist enough resume context, but do not replace the current user request with a hook instruction block;
- transcript growth and compaction-risk pressure remain advisory unless there are real blocking reasons;
- advisory pressure should surface through context status or pre-compact guidance, not by replacing the current user task;
- when a checkpoint is required, the agent should save it, reload the bundle, and resume the interrupted request if it is still safe.

This keeps long-running sessions hygienic without turning every large transcript into a workflow detour.

## Non-goals

This workflow does not dump full Codex transcripts into task bundles, does not add a vector database, does not require backend LLM summarization, and does not make every small task heavy by default.
