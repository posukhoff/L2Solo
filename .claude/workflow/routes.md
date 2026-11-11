# Risk routes and task evidence

All hard rules and release gates remain binding. Route controls ceremony, not correctness.

| Route | Entry | Execution / verification |
|---|---|---|
| Fast | Localized bug/UI/config without shared rule, data, protocol or perf impact | Cause/owner/test brief, implementer, scoped independent review, rules-check |
| Standard | Bounded gameplay change | Planner if cause/design uncertain, implementer, reviewer; traced batch when behaviour affected |
| Critical | Shared hot/cold rule, worker/state ownership, DB, global economy, changes to how bots spread over spots/market/parties (offline simulation first), generated tables, performance claims or cross-module architecture | Explicit invariants, design review, isolated worktrees, independent review, trace/coverage/A/B per release policy |

Every route ends with full PR checks on the task SHA plus Picked tests for the map tests it skips: routes differ in planning and review depth, not in CI. Escalate when uncertain. Review 1 checks all hard rules (N/A with reason); review 2 gets prior findings, exact delta and new tests, checks fixes/related regressions; expand only for changed owner, scope or new evidence. Unresolved blockers stop the task. Unrelated findings become lc issues (`lc add`). Every traced run retains named invariants and task counters; full exploratory audit at release or material unexplained anomaly. Until invariant automation exists retain manual checks. Release coverage and acceptance unchanged.

## CLI

Use primary local checkout or absolute script path + --root worktree. See evidence.md for brief shape and gates.

Commands: `start --base <ref> --risk <route> --kind fix`, `record-brief --file <brief>`, `verify --dev` (or `--dev-local`, ≤8 non-map tests), `verify --show-tests`, `verify --rules`, `verify --check`, `record-regression`, `record-review`, `record-ci`, `ready`, `record-land --remote --branch`, `record-rebase`, `record-retro`. Use `--root` for topic worktrees. See evidence.md.

CLI records evidence in Git common dir. Dev tests (`--dev-local`) are feedback and record nothing. `verify --check` runs syntax/table + rules locally; no local tests during perf/trace. Full PR checks are mandatory on every task SHA and again on the integration head. No automated merge, push, server, tables or release.
