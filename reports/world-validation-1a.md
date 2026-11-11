# Release 1a world validation (V5)

Batch under test: **ivan/batch-1a `6c1455b5e`** (DT-174 8b36104c6, DT-173 66d99ecd1, DT-200 8904efbfd, raw-map CI e875e0394+ea5d52f4a, warehouse custody 7e1fa4a2d, DT-200b 42e3d07ee, DT-200a 6c1455b5e). Not in the batch: RM-31, DT-208, earning spot, DT-202, DT-197 (implemented, not reviewed/landed).
Status: criteria, F2 verdict, automation split, proposals and the traced run's results (below) are final. The final A/B is not run: the release scope is not closed (five fixes pending), and the A/B follows the code freeze.

## F2 (BotImprovementService.js:139) — not a blocker for DT-200a
- `if (!current()) return result;` exists unchanged since d4322a214 (2026-10-06, before any of this work; line 126 at base 8904efbfd). Before DT-200a no commit path, hot or cold, raised the end of its step; DT-200a adds the raise on both success paths. F2 is the remaining case: a near body that stops being current (cooled, logged off, dead) during the native write returns before the raise, uncounted.
- So F2 is a pre-existing defect narrowed by DT-200a, not introduced by it. Acceptance of DT-200a holds unless the run shows repeats not explained by F2 (criterion C2). F2 stays a problems.md line: fix = raise through `raiseOn` before that early return.
## Runtime criteria (release 1a world validation)

Run under test: batch `6c1455b5e` (ivan/batch-1a), save `d2f4aa5d` ("late world x50 1700 bots"), `--scenario=script --script=tests/e2e/online-player.js --minutes=30`, 5 min warm-up, `developerDiagnostics` + `decisionTrace` on — the same settings as baseline B `9d6bf579a-script-online-player-20261110-200920` (release 1) and A `21ef29385-script-online-player-20261110-154249` (v0.1.2, untraced A side).
All counters below are server.log end-of-run `BotPopulation :: summary` values (cumulative from boot) unless stated.

| # | Fix | Source | Query | Metric | Baseline B (9d6bf579a cold / hot) | PASS | FAIL | Limits |
|---|---|---|---|---|---|---|---|---|
| C1 | Warehouse custody (7e1fa4a2d) | `world.sqlite` `bot_life_state.statsJson`: `lastWarehouseWithdrawal{at,items[[selfId,…]]}`, `lastNpcLiquidation{at,sold[[selfId,count,price]]}`, `equipmentPlan` (+`inputPreparation`) materials | `node scratchpad/wv/wd-sale.js <run> 100` (scratch: needs implementation in db-query) | bots whose last NPC sale sold, within 100 ms after their last withdrawal in this run, an item that withdrawal returned (`hits`), and of those plan inputs (`planInputHits`) | 6 / 5 (all plan inputs; 2.14 M / 2.84 M adena) | `planInputHits` = 0 | `planInputHits` > 0 | snapshot: only each bot's last withdrawal and last liquidation, so a lower bound; the plan read is the end-of-run plan |
| C2 | DT-200a henna/improvement repeat (6c1455b5e) | trace `decided` build with an improving leaf, `raise goal_failed`, DB `lastImprovement.at`, `hennas` | `node scratchpad/dt200/rep.js <run>` (scratch) | improving steps refused within 10 s after the bot's last draw (`…/last_draw<10s_before`, full + free) | 36 / 30 | 0, or every remaining case traced to F2 (body retired during the write) | a repeat not explained by F2 | trace detail is sampled; a repeat outside the trace is invisible |
| C3 | DT-200a, same | server.log summary `rejected=` | grep `improvement:henna:invalid_bot_henna:N` | invalid_bot_henna refusals | 31 / 26 | well below baseline with C2 = 0 (no fixed threshold: legitimate refusals remain possible) | — (reported, not gated alone) | counts all causes, not only repeats |
| C4 | DT-200b workshop recovery (42e3d07ee) | server.log summary `dbFailureOps`, `dbRefusalOps` | grep `craft:customer` | failed craft:customer jobs, with refused craft:customer jobs > 0 as proof the path ran | failures 18, refusals 18 / 0, 0 | failures = 0 and refusals > 0 | failures > 0 | if refusals = 0 the path did not occur: inconclusive |
| C5 | DT-200 refusal classification (8904efbfd) | server.log summary `dbFailureOps bot:improvement`, `improvementRetired`, `rejected=` | grep | bot:improvement failures vs non-refusal reasons (invalid_bot_henna is the only non-REFUSALS reason seen) | 39 = 31 henna + 8 retired / 36 = 26 + 10 | bot:improvement failures = count of non-REFUSALS reasons (improvement_source_retired no longer among failures); improvementRetired observed > 0 | failures include retired cases | improvementRetired = 0 makes it inconclusive |
| C6 | DT-174 book trips (8b36104c6) | server.log `BotGoals :: forced inventory cleanup … npcOnly=N reason=npc_only_inventory` | grep (scratch python) | npc_only_inventory trips with npcOnly < 20 | 758 / 584 | 0 | > 0 | — |
| C7 | DT-173 town pockets (66d99ecd1) | trace census `raise spot_unreachable`; timeline counters `townDepartureRouteFailures`, `townStuckEscapes`, `walkerStartTownPlacements` | `run-query census`, `log-query counters --keys …` | spot_unreachable raises; departure failures vs escapes | 173 / — (new counters: no baseline) | reported (no threshold); failures that end in an escape | a body with repeated departure failures and no escape | counters exist only in the new code |
| C8 | Loops (release invariant) | trace | `run-query refusals --limit 10` | groups with peak > 5 refusals / 60 s | 2001410 190 (RM-31, not in this batch) | none attributable to the batch's fixes | a new loop | RM-31 is not in the batch: item-90 loops may remain |

Not gated by this run (need the final A/B after scope closes): EXP and income per bot-hour, deaths, stuck bots vs the released version; RM-31, DT-208, earning spot, DT-202, DT-197 are not in the batch.

## Runtime results — traced run `6c1455b5e-script-online-player-20261111-015741`
Run: exit 0, window 00:02:47-00:32:47 UTC, 41,417 trace records, 1780 bots. Same save and settings as baseline B (9d6bf579a cold+player). Commands are those of the criteria table; outputs below are the run's end values.

| # | Result | Baseline B | Verdict |
|---|---|---|---|
| C1 custody | `wd-sale.js 100`: 152 bots with both events in the run, **0 hits, 0 plan-input hits** | 6 (all plan inputs, 2.14 M) | **PASS** (lower bound: last events only) |
| C2 DT-200a repeats | `rep.js`: **0** steps refused within 10 s of the bot's last draw; 2 `goal_failed` after a henna answer, both without a recent draw and matching the 2 `improvement:henna:no_station` refusals | 36 | **PASS**; no case needs F2 to explain it |
| C3 invalid_bot_henna | **0** (henna `improvement_missing_materials` 0) | 31 (36) | reported: gone |
| C4 DT-200b | `dbFailureOps` none; `craft:customer` refusals **2** | failures 18 | **PASS** (path ran twice) |
| C5 DT-200 | `dbFailures` **0**; `improvementRetired` 3, counted under `dbRefusalOps bot:improvement:22` | 57; 8 retired as failures | **PASS** |
| C6 DT-174 | 33 npc_only trips, **0** under 20 slots | 758 | **PASS** |
| C7 DT-173 | `spot_unreachable` **28** over 22 bots (max 3 per bot); `townDepartureRouteFailures` 0, `townStuckEscapes` 0, `walkerStartTownPlacements` 27 | 173 | reported: no stuck pattern; no gatekeeper failure occurred, so the escape path was not exercised |
| C8 loops | `run-query refusals`: one candidate, 2000566 peak 7/60 s on `power:854:1:item:90:shopping` | 2001410 190/60 s | not attributable to the batch: item-90 shop steps are RM-31/DT-208 (not landed) |

Also seen: `lateInViewActivations` 35 of 49 activations — DT-202 (the landing exemption) is not in the batch, so this is expected.

**Confirmed by this run:** custody (C1), DT-200a (C2/C3), DT-200b (C4), DT-200 (C5), DT-174 (C6). **Not confirmed (not exercised or not in batch):** DT-173's escape path (no departure failure happened), the RM-31/DT-208 item-90 loop (C8, fixes not landed), all A/B criteria (EXP, income, deaths, stuck bots) — final A/B after the scope closes.
**Blockers found:** none for the landed fixes.

## Automation split
Already automated by existing diagnostics: C7 (`run-query census`, `log-query counters --keys townDepartureRouteFailures,townStuckEscapes,walkerStartTownPlacements`), C8 (`run-query refusals`), the window bounds for C1 (`run-query census` → observedFrom/To).
Needs implementation (each is a scratch script or grep today):
- C1: `db-query` has no withdrawal field; `scratchpad/wv/wd-sale.js` reads `lastWarehouseWithdrawal` / `lastNpcLiquidation` (window from run.json `startedAt`). Add to custody as a scan mode.
- C2: `scratchpad/dt200/rep.js` (trace + DB join on `lastImprovement.at` and henna rows). Candidate query: "repeat of a committed step".
- C3-C5: server.log summary fields `rejected=`, `dbFailureOps`, `dbRefusalOps`, `improvementRetired` are not in the perf timeline counters, so `log-query counters` cannot read them; add a `summary --keys` query over the last server.log summary line.
- C6: grep of `forced inventory cleanup` lines; add to log-query.

## Proposals (not implemented: no new workflow version)
**Rebased task records.** Observed twice: after a rebase onto a moved ivan/batch-1a, `verify`/`ready` select tests from `base..HEAD`, so the integration's own commits enter the task (a non-JS warning; DT-200b was asked to escalate to Critical because the custody commit touched Database.js). Minimal fix: `record-brief --rebase <ref>` — allowed only when the old base is an ancestor of the new base and the new base is an ancestor of HEAD; it sets `state.base` and `brief.base` to the new base, keeps the brief, clears evidence (the head changed anyway), and records the old base for history. One contract test: a task rebased past a Database.js commit selects only its own files.
**test_companion_pathfinding_worker (flaky, 3 of 5 Picked runs).** Facts: it failed at 8904efbfd too (run 42923444577), so not from the raw-map change; the failing assert (`lastPathfinding.strategy` 'worker_geodata_error_fallback' instead of 'worker_geodata', test line ~127, the 30,000-node Giran route) is followed by a 180 s kill, i.e. the failure also leaves the worker pool alive. The pool's per-request timeout defaults to 2,000 ms (`PathfindingWorkerPool.js:101`) and the log shows the worker loading large regions (e.g. 20_21 14.5 MB) during that request on a cold runner. Hypothesis to confirm first: region loading counts against the request timeout. Minimal steps, no weaker test and no longer timeout: (1) print `lastPathfinding` (error code, elapsed) in the assertion message and close the pool in a `finally`, so a failure is diagnosable and fails in seconds instead of 180 s; (2) if PATH_TIMEOUT during the first region load is confirmed, fix the owner: the worker reports region loading done before the request timer starts (or the pool starts the timer when the worker begins the search) — the same cold-load stall would otherwise hit a real bot's first path in a new region.

## Recommendations for a minimal V6 (when one is wanted)
1. `record-brief --rebase` (above).
2. A `summary --keys` query over server.log summaries plus the custody withdrawal scan, so C1 and C3-C6 stop being scratch scripts.
3. Picked tests: document `ci-tests.txt` as the default for more than a few files (GitHub rejects refs over 255 bytes).
