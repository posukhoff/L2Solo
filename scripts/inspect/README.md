# V4 offline trace diagnostics — pilot

Source contract: src/GameServer/Bot/DecisionTrace.js and src/DecisionTraceWriter.js on ivan/batch-1a. The tool reads completed run snapshots, never starts the game or changes a database. Install scripts/inspect/run-query.js and run-query.test.js in the primary checkout (or keep the tool in a separate local workflow checkout). No npm dependencies.

```sh
node scripts/inspect/run-query.test.js
node scripts/inspect/run-query.js /path/to/run census
node scripts/inspect/run-query.js /path/to/run timeline --bot 2001410 --limit 100
node scripts/inspect/run-query.js /path/to/run refusals --threshold 5
node scripts/inspect/run-query.js /path/to/run flips --decision hunt_spot
node scripts/inspect/run-query.js /path/to/run funding --bot 2001410
```

JSON output includes source filename + 1-based line for evidence, observed window, record counts, parse errors and detail sampling caveat. --from/--to accept ISO timestamps or epoch milliseconds; --limit caps output (1–1000), --bot filters; --all includes noisy wish detail in timeline. Timeline/funding return newest matching records. Census groups by kind and phase/decision/name. Refusals detects exactly raise goal_failed/impossible and detail purchase_goal funding_short/impossible; groups by bot/event/reason/wishKey or item. Unknown step is explicitly unknown. Counts are sliding 60-second observed peaks; threshold >5 is a proposed triage signal, not a gameplay invariant. Flips detects A-B-A in consecutive distinct observed answers per bot/decision, excludes crossing observed worker restarts, shows examples. Funding returns recorded inputs, not a claim of a causal mismatch; join/compare only with evidence of same purchase.

Reads all 8 known rotations oldest first, one file at a time, then sorts matching sequences by timestamp and file order; limits retained matching rows to 500000, fails rather than truncating analysis. Use a completed immutable run; rejects files changing during individual read. No guarantee against concurrent rotation of a live directory. Trace is sampled/rate-limited; missing data is NOT proof of absence. Observed span is not bot-hours; no rate normalization by unobserved population. No SQLite or full invariant engine yet. Test fixtures are synthetic; real run validation is required before treating findings as release evidence.

Verifier handoff: attach query command, run ID, output counts and decisive file:line records to brief; spot-check original trace and code. Reuse evidence, never infer cause from a high count alone. Preserve final release A/B and manual invariant checks.

## Workflow changes

close --refuted --evidence <reference> closes a fix whose cause is still a hypothesis; no implementation readiness. Optional geodata: selected tests present in both default and --geodata lists require explicit raw-map evidence for exact HEAD. Use verify --raw-geodata --test <name> in a dedicated worktree with installed raw geodata (one at a time, never during perf/trace). It invokes runner --geodata --only=<name>; existing CI does not prove optional raw-map blocks. This is deliberately local pilot; CI raw-map support needs a separate change in the game branch. No automatic repin: policy changes still invalidate open tasks. No auto push or merge.

## Pilot

Compare census/timeline/refusal/flip/funding outputs with the original scratch scripts for DT-123, DT-200 or RM-31 and report discrepancies. Capture duration, data scanned, tool calls, verifier tokens and whether evidence was sufficient. Do not change game behaviour based on diagnostic flags alone. Validate trace field variants against actual saved runs; add fixtures for any missed signature.
