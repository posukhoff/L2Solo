# Risk routes and task evidence

All hard rules and release gates remain binding. Route controls ceremony, not correctness.

| Route | Entry | Execution / verification |
|---|---|---|
| Fast | Localized bug/UI/config without shared rule, data, protocol or perf impact | Cause/owner/test brief, implementer, scoped independent review, targeted tests and rules-check |
| Standard | Bounded gameplay change | Planner if cause/design uncertain, implementer, reviewer; targeted + domain tests, traced batch when behaviour affected |
| Critical | Shared hot/cold rule, worker/state ownership, DB, global economy, changes to how bots spread over spots/market/parties (offline simulation first), generated tables, performance claims or cross-module architecture | Explicit invariants, design review, isolated worktrees, independent review, full CI, trace/coverage/A/B per release policy |

Escalate when uncertain. Review round 1 checks all hard rules (N/A with reason); round 2 checks fixes and related regressions. Unresolved blockers stop the task. Unrelated findings enter problems.md. Every traced run retains named invariants and task counters; full exploratory audit at release or material unexplained anomaly. Until invariant automation exists retain manual checks. Release coverage and acceptance unchanged.

## CLI

Use primary local checkout or absolute script path + --root worktree. See evidence.md for brief shape and gates.

```sh
node .claude/workflow.js start party-fix --base ivan/batch-6 --risk standard --kind fix
node .claude/workflow.js record-brief party-fix --file /path/to/brief.json
node .claude/workflow.js status party-fix
node .claude/workflow.js verify party-fix --root /path/to/topic --show-tests
node .claude/workflow.js verify party-fix --root /path/to/topic --rules
node .claude/workflow.js record-regression party-fix --root /path/to/topic --test test_example.js --old <base-sha> --evidence 'old assertion failure; new pass; log ref'
node .claude/workflow.js record-review party-fix --root /path/to/topic --result pass --evidence 'review ref'
node .claude/workflow.js record-ci party-fix --root /path/to/topic --run 123456789
node .claude/workflow.js ready party-fix --root /path/to/topic
node .claude/workflow.js record-land party-fix --root /path/to/integration
```

CLI records evidence in Git common dir. No automated merge, push, server, tables or release. Use verify --check for syntax/table + rules, or --local for up to 8 non-geodata selected tests (not during perf/trace). Full integration CI mandatory. See evidence.md.
