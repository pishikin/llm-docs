# Contributing

## Development setup

```bash
npm install
npm run build
```

## Source tree

- `src/v2`: v2 context-ops engine, task model, MCP layer, host packs, workspace services.
- `src/commands`: public CLI commands plus hidden `internal` hook commands.
- `src/core`, `src/providers`, `src/emitters`: legacy v1 generation/validation subsystem kept for compatibility.
- `tests/unit`, `tests/integration`, `tests/e2e`: layered coverage for pure services, real temp repos, and full lifecycle flows.

## Local workflow

Use the v2 surface when validating the new product path:

```bash
node dist/index.js setup --dry-run
node dist/index.js doctor
node dist/index.js server --transport stdio
```

Legacy commands remain available but are secondary:

```bash
node dist/index.js generate
node dist/index.js sync
node dist/index.js validate --json
```

## Verification before handoff

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:e2e
npm run build
```

Use `npm run verify` for the default combined gate.

## Scope rules

- Keep changes focused and avoid unrelated refactors.
- Add or update tests when behavior changes.
- Do not do a big-bang rewrite of the legacy v1 subsystem.
- Prefer additive changes in `src/v2/**` for new task-bundle workflows.
- Keep v1 provider logic in `src/providers` and v1 generation/validation logic in `src/core`.

## Commit and PR expectations

- Explain what changed and why.
- Include reproduction/verification steps.
- Mention any limitations or follow-ups explicitly.
