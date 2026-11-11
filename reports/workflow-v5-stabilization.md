# workflow V5: stabilization and three tasks

Date 2026-11-10 (UTC 22:40-23:47). Coordinator: main Claude Code session (claude-opus-5-5); subagents inherit the model. Coordinator tokens: unknown (not exposed). Subagent tokens are each agent's own usage line; for an agent resumed with a follow-up, the number is cumulative.

## 1. Stabilization

| Item | Change | Evidence |
|---|---|---|
| Raw-map receipt SHA | `workflow.js record-ci`: the receipt's `sha` is required and must equal the run's commit (the list commit for a `ci-tests.txt` run) | contract tests: missing, `null` and other-commit receipts refused; 39 PASS |
| custody trades | the bot's trades of deposited items around the last deposit and liquidation (last 3 up to the deposit, all between ≤ 20 with `betweenTruncated`, first 3 after), not the oldest 20 of all history; `missing` (ids not found) apart from `truncated` (cut by `--limit`) | fixture with 25 older trades; real run: 2001410 `before` = trade 7457 (its buy 2 s before the deposit) |
| log-query time | `estimatedWindow {notBefore, notAfter}` instead of a time; the mapping to the perf timeline requires every numeric summary field that is also a timeline delta to agree (18 counters on the hot run, `countersCompared`), else `null` | fixture where one disagreeing counter refuses the mapping; DT-202 numbers unchanged (193 activations near the landing, 44 re-activated) |
| ci-raw-geodata review | independent review: **pass**, 3 minor findings (unknown names reported before the `+` rule; receipt counts `.l2j` map regions; re-run shard replaces its artifact, `overwrite: true`) — all fixed in 192f00373 | real CI: `+` via branch ref (42914617322, 42919143813), via `ci-tests.txt` with 9 files on 2 shards and the `+` file in shard 2 (42918658894, receipt sha = list commit), plain Picked without `+` (42918664433, no artifact), probe `assert.fail` inside the map block fails only with `+` (42914645646 vs 42914650302), PR checks 12/12 (42919302994) |
| Integration | ivan/batch-1a: e875e0394 + ea5d52f4a (same tree as the reviewed 192f00373; `record-land` caught that my first landing used a stale local ref without the review fixes, corrected by a follow-up commit, no force push) | fork only; nothing to origin |

## 2. Three tasks through V5

| | DT-200b craft recovery | Warehouse custody (staff sold) | DT-200a henna repeat |
|---|---|---|---|
| Route | Standard | Critical (escalated: Database.js) | Critical (situations) |
| Cause gate | reused the earlier DT-200 verifier's verified chain (no new cost) | new verifier: **guess confirmed, owner corrected** (stale PersonalWarehouseIndex, not the sale filter): 620 s, 193,316 tok | reused the DT-200 verifier's verified chain |
| Base → landed | 8904efbfd → **42e3d07ee** | 8904efbfd → **7e1fa4a2d** | ea5d52f4a → **6c1455b5e** |
| Implementer | 427 s, 118,497 tok; + round-1 fix 281 s; + CI fix 206 s (cumulative 137,132 tok) | 494 s, 112,142 tok | 543 s, 129,113 tok; + F1 fix 275 s (cumulative 140,587 tok) |
| Review rounds | r1 **blocked** (rules 3/5: check copied into both callers; owner CraftWorkshopService) 193 s 101,039 tok; r2 pass 99 s 75,671 tok | r1 pass 207 s 107,287 tok | r1 pass + F1 should-fix 237 s 124,217 tok; r2 pass 169 s 104,053 tok (F2 + test gap → problems) |
| CI runs | 7: PR 42920613298 (superseded), Picked 42920624372 (flaky fail), Picked raw 42920655986, PR 42921884766 (**real fail**: a test stand-in bare code now read as a refusal), Picked 42921920760, PR 42923998420, Picked list 42924054223 | 2: PR 42921804233, Picked 42921852986 (3 geodata-only + 3 raw) | 4: PR 42922130141 (superseded), Picked list 42922166614 (flaky fail), PR 42924968704, Picked list 42925004081 (flaky fail → green on rerun) |
| Re-investigation | none (spot-check only; ~10 min own lookups) | none (~5 min own lookups) | none (~10 min own lookups) |
| Wall time start → land | 22:54:31 → 23:37:51 (43 min) | 22:55:30 → 23:27:41 (32 min) | 23:07:56 → 23:46:31 (39 min) |
| Agent tokens (sum) | ≈ 314 k | ≈ 413 k | ≈ 369 k |

Workflow events seen (facts):
- Two rebases onto a moved integration branch: the CLI selects tests from `base..HEAD`, so after a rebase the integration's own commits enter the selection (non-JS warning; DT-200b was asked to escalate to Critical because the custody commit touched Database.js). Worked around by a new record at the new base. Needs a small CLI change (record the brief against the rebased base).
- A long Picked branch name (10 tests) was rejected by GitHub (ref > 255 bytes): `ci-tests.txt` list commits are the reliable form.
- `test_companion_pathfinding_worker` timed out in 3 of 5 Picked runs (also at 8904efbfd, before the CI change): a flaky pre-existing test; a rerun of the failed job made it green.
- My own instruction "squash with `reset --soft ivan/batch-1a`" would have reverted a commit landed meanwhile; caught and corrected before the agents acted.

## 3. Diagnostics actually used
| Command | Task | Replaced manual work |
|---|---|---|
| `db-query custody --bot 2001410`, then all 55 buyers (`--limit 100`) | custody verifier | the purse/plan/deposit/liquidation SQL and the separate trade lookup |
| `db-query market --item 90` | custody verifier | the market-churn SQL |
| `run-query timeline --bot 2001410/2001202/2001368` | custody verifier | per-bot python trace filters |
| `workflow.js` record/verify/ready/record-land | all | hand-tracked SHAs, CI ids, review verdicts; caught a stale landing |
Not replaced (done by hand): the plan as it was at the sale and the withdrawal record (custody shows only the snapshot), `bot_life_events`, an all-bots scan, base-code repro scripts. DT-200a/b reused the earlier verifier's scratch scripts (`rep.js`, `recovery.js`); implementers used no diagnostics (the briefs sufficed).

## 4. Problems found (for problems.md)
- `BotImprovementService.js:139` early return skips the end-of-step raise when a near body cools during the native write; uncounted (F2). The F1 test writes the bag by hand.
- Workshop recovery: rolled-back errors with spaced messages ("workshop ownership changed", "workshop price changed") still go through the original-token recovery and fail with `craft_executor_changed`.
- Gear plan lagging the worker's build focus at the sale; worker-captured materials withdraw a paused project's parked share (custody verifier nonGoals).
- limits.md:90 still describes the removed index drain pass.
- Flaky `test_companion_pathfinding_worker` (geodata fallback, then 180 s timeout).
- NPC buys recorded as `Item <id>`; NPC sales absent from `market_trades`.
- CLI: rebased tasks need re-recording; Picked refs > 255 bytes.
