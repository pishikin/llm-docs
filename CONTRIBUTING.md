# Contributing

## Development setup

```bash
node --version # use Node 20.19+ for the current dev toolchain
npm install
npm run build
```

## Source tree

- `src/engine`: current task-bundle engine, task model, MCP layer, host packs, workspace services.
- `src/commands`: public CLI commands plus hidden `internal` hook commands.
- `src/core`, `src/providers`, `src/emitters`: legacy generation/validation subsystem kept for compatibility.
- `tests/unit`, `tests/integration`, `tests/e2e`: layered coverage for pure services, real temp repos, and full lifecycle flows.

## Local workflow

Use the current surface when validating the new product path:

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
- Do not do a big-bang rewrite of the legacy subsystem.
- Prefer additive changes in `src/engine/**` for new task-bundle workflows.
- Keep provider logic in `src/providers` and generation/validation logic in `src/core`.

## Commit and PR expectations

- Explain what changed and why.
- Include reproduction/verification steps.
- Mention any limitations or follow-ups explicitly.
