# Default task bundle quality

`llm-docs` task bundles are designed to be useful as future coding-agent context, not just as a last checkpoint log. The default profile is now `normal`: it captures a compact but complete implementation story while avoiding full transcript dumps, raw diffs, and oversized generated memory files.

## Default bundle surfaces

A newly created simple task bundle contains these durable files:

```text
raw.md                  original source material or imported task text
context.md              current working state, implementation story, and reload map
changelog.md            chronological milestone log
state.json              deterministic structured state for llm-docs
artifacts/index.json    attached screenshots, logs, Jira snapshots, or other evidence
```

Full task bundles also include `task.md` as the stable task spec. The root agent docs stay thin; task-specific detail belongs in the bundle.

## What `context.md` should contain

The default `context.md` structure is intentionally richer than a plain summary:

```text
Entry Point
Original Request / Source Brief
Acceptance / Done Criteria
Prepared Plan
Current State
Implementation Notes
  User-Facing Behavior
  Implementation Details
  Source / Files Map
Decisions
Superseded / Historical Notes
Verification
Validation Gaps
Risks / Constraints
Next Steps
Related Docs
Bundle Files
Latest Checkpoint
```

This gives a next agent enough information to continue without reading every artifact first. It is still compact: source text is trimmed into the entry point, full source remains in `raw.md` or artifacts, and implementation sections should be grouped bullets rather than transcript history.

## Semantic checkpoints

Checkpoint commands and MCP input can now record the implementation story directly:

```bash
llm-docs task checkpoint TASK-123 \
  --kind milestone \
  --summary "Checkout flow now supports saved cards behind the payment feature flag." \
  --requirement "Use existing payment session API; do not change legacy checkout route." \
  --plan "Keep UI changes page-local, then wire the existing payment hook." \
  --behavior "User can select a saved card and continue payment." \
  --implementation-detail "PaymentCardSelector owns local selection state and delegates submit to usePaymentSession." \
  --implementation-map "checkout UI: src/pages/Checkout/*, src/components/PaymentCardSelector/*" \
  --decision "No new API shape; reuse payment session contract." \
  --verification "npm test -- Checkout PaymentCardSelector" \
  --validation-gap "E2E with real provider token still requires staging credentials."
```

The same fields are available in `llmdocs.save_context_checkpoint`:

```json
{
  "taskId": "TASK-123",
  "checkpointKind": "milestone",
  "summary": "Checkout flow now supports saved cards behind the payment feature flag.",
  "requirements": ["Use existing payment session API; do not change legacy checkout route."],
  "plan": ["Keep UI changes page-local, then wire the existing payment hook."],
  "userFacingBehavior": ["User can select a saved card and continue payment."],
  "implementationDetails": ["PaymentCardSelector owns local selection state and delegates submit to usePaymentSession."],
  "implementationMap": ["checkout UI: src/pages/Checkout/*, src/components/PaymentCardSelector/*"],
  "decisions": ["No new API shape; reuse payment session contract."],
  "verification": ["npm test -- Checkout PaymentCardSelector"],
  "validationGaps": ["E2E with real provider token still requires staging credentials."]
}
```

## Compactness rules

Use these rules for agent-authored bundle content:

- Prefer 3–7 grouped bullets per section.
- Keep exact raw requirements in `raw.md`; summarize only the relevant source brief in `context.md`.
- Describe user-visible behavior and implementation approach, not every changed line.
- Keep source maps grouped by purpose, for example `routing`, `UI components`, `state/API`, `tests`, `assets`.
- Mark superseded plans explicitly instead of deleting contradictory history.
- Record verification evidence and validation gaps separately.
- Do not paste full Codex/Claude transcripts, full CI logs, or large diffs into `context.md`.

## Why this default changed

Long tasks often failed not because the bundle had no files, but because the entry point overfit the latest incident while the real implementation story stayed scattered across `state.json`, additional docs, and old checkpoints. The default bundle now makes source, plan, implementation, decisions, verification, and gaps first-class sections from the beginning.

Long-task profiles still exist for bigger budgets and changelog/journal expectations, but a normal task no longer starts from a dry stub.
