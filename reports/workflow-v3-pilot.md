# workflow-v3 pilot: report

Date 2026-11-10. Coordinator: main Claude Code session, model claude-opus-5-5 (subagents inherit it; none overridden). Compared: `fork/ivan/workflow-v2-pilot` (e36326de7) → `fork/ivan/workflow-v3` (f7026b487), diff only. Local `planning/` kept as is (V3 did not change planning; nothing was copied from the branch). Facts are marked by their source; unknown metrics are `unknown`.

## 1. V3 changes: verdict

| V3 change | Verdict | Note |
|---|---|---|
| `evidence.md`: cause gate (guess vs verified), evidence brief JSON, handoff rule "spot-check one decisive handle, re-investigate only if contradicted" | **Accepted** | Pilot below: the gate refuted one hypothesis and split another into 1 refusal + 2 bugs before any code was written. |
| CLI `start --kind fix|feature|chore`, `record-brief` (shape validation; a guess blocks verify) | **Accepted** | Works as designed on real tasks. No way to close a task as refuted (DT-123 record stays open): minor. |
| `record-regression` (manual old-fail/new-pass receipt per regression test, tied to the base SHA) | **Accepted** | Manual evidence, documented as such. |
| `record-ci`: 12 distinct PR-check shards; Picked tests: exact SHA or single-parent `ci-tests.txt` child, Plan job + every expected shard; coverage = runner-normalized list; PR checks covers only the default (non-geodata) suite; runs accumulate (`ciRuns`) | **Accepted** | Verified on real runs 42902635371 (12 shards), 42906004422 / 42906122078 (Picked with Plan + Tests 1/1). Geodata-only selections are reported as missing until a Picked run covers them (5 tests for the DT-173 diff). |
| `ready`: union coverage, rules-check always (`verify --rules`), syntax/table via PR checks or `--check`, regression receipts, selection ack for warnings | **Accepted** | |
| `record-land`: tree equality with the reviewed head | **Accepted, fixed** | Failed on a real squash (see 2). |
| Digest covers `workflow.js`, `tests-for.js`, `rules-check.js`, `hygiene.js`, `prune-branches.sh` | **Accepted, flagged** | Correct, but any script fix invalidates every open task record (observed: 2 records re-created). |
| `workflow.test.js` (isolated contract tests with fakes) | **Accepted, extended** | 19/19 pass; one case added for the squash fix. |
| routes.md / CLAUDE.md trimmed, evidence step named in CLAUDE.md | **Accepted** | Workflow text now 39.7 KiB of its 40 KiB hygiene budget: the next addition must cut elsewhere. |

## 2. Problems found in V3

1. **`record-land` refused a real squash** (fact): task `v3-clitest` (base 6aa4f7dc9, a topic-branch commit) reviewed at 61ee2b18a; the squash 66d99ecd1 on ivan/batch-1a has the identical tree 637cda918 but `record-land` failed with "Task base is not an ancestor of HEAD" — the ancestry check ran before the land branch. Fixed: `record-land` checks only cleanliness and tree equality; test case added (squash outside the base history). Re-run on the real squash: receipt recorded (`reviewedHead 61ee2b18a`, `head 66d99ecd1`, same tree).
2. **Optional-geodata tests count as covered but their map block never runs on CI** (fact): `test_bot_activation_placement.js` is in `optionalGeodataTests`; the runner sets `L2NODE_SKIP_RAW_GEODATA_TESTS=1` for it in PR checks and in Picked tests (`rawGeodata` is true only for `geodataTests` or `--geodata` mode), and no workflow runs `--geodata`. V3 marks it covered by PR checks. Consequence: the DT-173 regression assertions (in that block) were proven only by local runs in the v2 pilot, not by CI; v2-pilot's `ready` with "tests: all" overstated it. Not fixed in the CLI (needs a runner/CI decision: run optional-geodata files with the map in Picked tests, or require a local receipt for them). Recorded as a problem.
3. **Digest churn** (fact): editing `workflow.js` to fix (1) changed the digest and invalidated the open records `v3-clitest` and `dt123`; both re-created (`v3-clitest2`, `dt123-v2`). Proposal: version the policy, let the coordinator re-pin an open task with an explicit `repin` that keeps evidence whose inputs did not change.
4. **No terminal state for a refuted cause** (fact): DT-123's guess was refuted; the CLI can only leave the record open. Proposal: `close <slug> --refuted --evidence <ref>`.
5. **Selection breadth** (fact): Database.js change → 397 tests (domains combat, population, persistence by regex on paths), DT-173 counters → 606. Full PR checks is the only practical evidence; `--local` never applies to these.
6. **The test file fakes Git's `merge-base` as always true** (fact), so (1) could not be caught by `workflow.test.js`; now covered.
7. Optional: `verify` prints the selection as counts; the coordinator needs `--show-tests` to see which geodata files are missing (fine, documented).

## 3. Pilot tasks (real roadmap 1a items, cause not confirmed beforehand)

### 3.1 DT-123 — refuted at the cause gate
- Slug `dt123` (re-created as `dt123-v2` after the digest change), Critical (situation wake mechanism), kind fix, base 66d99ecd1. Guess brief recorded; `verify` refused ("Cause is a hypothesis").
- Cause verifier: ~21:34 → ~21:36, **135 s, 89,564 tokens, 19 tool uses**, 1 agent.
- Result (fact, with a proof script): the `offer_posted` payload is read by nothing — `Situations.raisedFacts` clears every quote mark through `GearMarks.forgetQuotes` whatever the item — so losing one item's payload changes nothing (rule 0). Saved runs: 966 / 1374 offer_posted raises, 0 bots left with an uncleared quote mark.
- Outcome: no implementation, no CI, no review. Two side problems logged (dead payload; `contest_lost` keeps the first displacement). The CLI has no state to close the record (problem 4).

### 3.2 DT-200 — verified in part, implemented, landed
Slug `dt200`, Critical (src/Database.js), kind fix. **Base** 66d99ecd17a2 (ivan/batch-1a). **Final** 8904efbfd45e. **Landed** 8904efbfd on ivan/batch-1a (one commit: fast-forward = squash), `record-land` receipt same tree d9b8459ea.

| Stage | Wall (UTC) | Agents / role | Tokens | Result |
|---|---|---|---|---|
| start + guess brief | 21:36:49 | coordinator | unknown | implementation blocked |
| cause gate | 21:37:30 → 21:48:07 (650 s) | 1 verifier | 193,683 (89 tools) | hypothesis "3 expected refusals" → **1 verified refusal** (`improvement_source_retired`), **2 verified bugs** (`invalid_bot_henna`: a committed improvement's held step re-runs 3-9 s later, 30/31 cases; `craft:customer`: recovery of a refused workshop craft always throws `craft_executor_changed`; the message named in the problem line never fires). Brief written with decisive handles. |
| record verified brief | 21:48:07 | coordinator | unknown | implementation allowed |
| implement | ~21:48:30 → ~21:52:30 (236 s) | 1 implementer | 63,686 (12 tools) | 8904efbfd: one REFUSALS entry + regression test asserting both the refusal and that `invalid_bot_henna` stays a failure; fails on base (`1 !== 2`), passes on head; brief tests pass locally; npm check, rules-check clean |
| verify --rules, record-regression | seconds | coordinator | — | receipts |
| CI | PR checks 42909286769 (12/12) + Picked 42909297537 (2 geodata-only files) | — | — | both green, recorded |
| review round 1 | 68 s | 1 reviewer | 69,784 (11 tools) | pass, 0 findings; spot-checked the brief's chain at base, re-ran the test on base and head |
| ready / land | 21:59:31 / 21:59:51 | coordinator | — | ready true (selection warning acknowledged); landed, pushed to the fork |

Totals: 23 min start → land; 3 agents; 327,153 agent tokens; 2 CI runs; 1 review round, 0 fixes. Not checked: acceptance item 3 (a traced run's `dbFailureOps` drops by exactly `improvementRetired`) — needs the batch's traced run.

### 3.3 Did the implementer avoid a repeated investigation?
**Yes** (fact, from its report and its usage): 63,686 tokens and 12 tool uses, "looked up nothing beyond the brief (under 1 min), no re-investigation". For comparison this day, old-flow implementers used 143-297 k tokens (median ≈ 190 k) and re-derived causes. The task is very small, so the comparison is indicative, not proof.

Handles:
| Handle | Used? | Sufficient? |
|---|---|---|
| Spot-check: `tests/test_cold_skill_write_admission.js` `refusalMetrics()` at base already drives `applyBotImprovement` through `validate()` | used | sufficient alone (matched in one step) |
| `Database.js:332-338` REFUSALS, `:398` catch, `:8879-8881` guard | used | sufficient |
| `BotImprovementService.js:69-73` throw, `:80-87` handler | used (+1 grep to confirm the only throw site) | sufficient |
| server.log summary lines of the two runs | not needed | — |
| nonGoals naming the two bugs | used by the implementer and the reviewer | decisive for scope (the reviewer checked both stay failures) |
| Missing | none for implementation; acceptance 3 lacks a handle until a traced run exists | — |

Cost of the gate itself: the verifier was the most expensive stage (650 s, 194 k). It paid for itself here by keeping two bugs from being hidden as refusals; on DT-123 it replaced a whole implementation cycle with 90 k tokens.

## 4. Repeated game-data queries (for the next iteration)
Each was written at least once from scratch by an agent or the coordinator this day (scripts named are scratch copies, not in the repo). Inputs are a run folder `tmp/perf/runs/<sha>-<kind>-<time>/` (server.log, logs/decision-trace.jsonl, world.sqlite, world.history.sqlite) unless said otherwise. "Normal / anomalous" gives the line this day's work used; thresholds marked (proposed) are mine.

| # | Query | Inputs | Current script / query | Expected output | Normal | Anomalous |
|---|---|---|---|---|---|---|
| 1 | Trace census | decision-trace.jsonl | ad-hoc python: count by (kind, phase/decision) | table of record kinds | stable mix between comparable runs | a kind missing (trace off for a path) or a kind ×3 vs the baseline run |
| 2 | One bot's timeline without noise | trace + bot id + window | `node scripts/trace.js --bot <id>` then a python filter dropping `wish_alternative`/`wish_need` | ordered decided / raise / funding / purchase / trip records | decisions only at named situations, held between | the same answer re-taken right after a refusal; builds every ~0.1 s |
| 3 | Refusal-retake loops | trace (`raise` goal_failed impossible, `purchase_goal` reasons), server.log timeline (`fundingShort` counter) | grep + per-bot counting (RM-31: 2001410 190 raises in 39 s; DT-208 planner: 321 after `item:90:shopping` over 72 bots) | per bot: raises per minute, the step key, the refusal reason | ≤ 1 refusal per step per visit | > 5 refusals of one step per bot-minute (proposed) |
| 4 | Decision flips (A-B-A) | trace `decided` hunt_spot / earning_spot / build + DB `bot_life_state` stats.earning | `aba.js`, `flips2.js`, `ex.js` (earning planner) | flips per bot-hour, A-B-A count, which side is the earning answer, the raise that woke each flip | ≈ arrival rate (≈ 1.1 per bot-hour in the released build) | 2.28 per bot-hour, 233 A-B-A in 0.58 h (this day) |
| 5 | Funding of a purchase | trace `detail` phase funding / purchase_goal / buy_request / native_funding by bot and item | python filter over `wallet, escrow, available, reserve, priorityReserve, unitPrice` | the purse the build saw vs the purse the buyer saw | buyer purse ≥ unit price for every step the build took | `funding_short` on a step the build admitted; escrow appearing between build and buy |
| 6 | Activation placement | server.log `requested activation` lines (placement loc), cooling lines; player position | `corr.js`, DT-202 planners' counts | activations by distance to the player and to gatekeeper landing points; re-activations; time hot before cooling | landings at a teleport point (C4); hot bodies stay ≥ the grace | same bot landing ≥ 2× in 25 min; cooled < 150 s; bodies inside a closed geodata region |
| 7 | Late in-view split | server.log summary `lateInViewActivations`, `lateInViewWalkers` (new) | grep of summary lines | late count per summary window, walker share | walkers from outside the view only | ≥ 10 % of settled activations inside the view excluding landings (proposed) |
| 8 | Town trips by reason | server.log `forced inventory cleanup … npcOnly=N reason=` and trip reasons | grep + histogram (DT-174) | trips per reason and per npcOnly count, per bot-hour | trips at the threshold (≥ 20 NPC-only slots, full bag) | trips under the threshold (580 of 589 before DT-174) |
| 9 | Item churn on the market | world.sqlite / history `market_trades`, NPC buys and sells | SQL per item: buys, sells back, warehouse deposits, board listings | per item: count, adena, buy→sell-back pairs | price near template/board worth, few sell-backs | item 90: 104 buys in 35 min for 432 M; buy then NPC sale while the plan holds it |
| 10 | Custody of a planned input | world.sqlite items, warehouse tables, `bot_life_state` stats (`lastWarehouseDeposit`, `lastNpcLiquidation`, plan materials) | manual SQL + JSON reads (DT-208 planner, bot 2001410) | where each planned input is and who moved it | an input held by a plan stays until used | an input withdrawn/sold while its plan still lists it |
| 11 | Offline economy count | world.sqlite (bots), board records, market counters; the real `Economy.forState` | `dt208/count.js`, `dt208/lose.js` | per root: funded?, price, worth, which bots change activity | the change moves only the targeted roots | ordinary purchases losing funding (71 roots / 37 bots for the rejected variant) |
| 12 | Admission of board lines | world.sqlite `afk_trade_shops/lines`, `bot_life_state` | `fare-count.js` (DT-197) | lines refused per rule (fare, funding) | refused lines have a reason a player would accept | 1225 of 2879 stocked lines unbuyable for a fare the seller can pay |
| 13 | Geodata pockets | data/Geodata, coordinates from DB/logs | `dt173/probe.js`, `flood.js`, `survey.js` | closed walkable regions near respawn/landing points; whether a path exists | bots stand in regions with an exit | bodies inside a closed region (2003-cell yard at Hunter's Village) |
| 14 | Deaths by cause and spot | trace `kind: death` (killer, spot, playerDist) | python filter | deaths per spot / killer / level band | spread, in line with spot danger | one spot or NPC dominating; deaths of non-combat bots |
| 15 | Progress and stuck bots | world.sqlite exp/level deltas, journal kills | SQL per bot over the run | kills, EXP and adena per bot-hour; zero-progress bots | progress for every active hunter | 0 kills all run (9/23 hot bodies in DT-173) |
| 16 | CI failure extraction | `gh run view <id> --log-failed` | grep `AssertionError|FAILED` | failing files and first assertion per shard | — | any; also fewer than 12 PR-check shards |

Script candidates (smallest first): 1, 2, 3, 16 as one `planning`-free `scripts/run-query.js <run> <query> [--bot]` with fixed outputs; 4 and 5 as named reports; 6 and 7 inside the perf report; 9-13 stay per-investigation tools but should live in the repo (`scripts/inspect/…`) instead of scratchpads, so the next agent reuses them.

## 5. Conclusions
- **Facts:** the cause gate ran twice on real items and both times changed the plan before code (1 refuted, 1 split into 1 fix + 2 bugs). The evidence brief let the implementer stay at ~64 k tokens with no re-investigation. The CLI's CI evidence now matches the real workflows, except optional-geodata blocks, which no CI run executes.
- **Assumption:** the gate's cost (≈ 90-200 k tokens per item) is lower than one wrong implementation cycle (this day: RM-31 ≈ 1 M across three implementations).
- **Next iteration (small, no new orchestrator):** (1) decide where optional-geodata blocks run (Picked tests with the map, or a required local receipt) and make `ready` ask for it; (2) `close --refuted` and an explicit `repin` for policy changes; (3) move queries 1-5 and 16 into one repo script with fixed outputs, and keep the investigation tools (9-13) in `scripts/inspect/` instead of scratchpads.
