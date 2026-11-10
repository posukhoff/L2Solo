# workflow-v5 pilot: report

Date 2026-11-10 (late). Coordinator: main Claude Code session (claude-opus-5-5); no subagents this round. Diff reviewed: `fork/ivan/workflow-v4-pilot` (fd265db8f) → `fork/ivan/workflow-v5` (9557f346b). Saved runs reused (no new simulation): `9d6bf579a-script-online-player-20261110-200920` (cold with player) and `9d6bf579a-hot-20261110-204530`. Local `planning/` kept. No databases, configs or full logs published.

## 1. Tests (Node v24.15.0)
- `db-query.test.js` PASS on V5; PASS after fixes with 3 new real-shape cases (fail on V5's db-query: grouping by name, `missing`, attached trades).
- `run-query.test.js` PASS (V5 only changed default limits and duplicated an object key `synthetic`; the duplicate is removed).
- New `log-query.test.js` PASS. `workflow.test.js`: 30 → 36 PASS (raw-map CI cases).

## 2. market and custody vs the earlier manual SQL

| Check | Manual SQL (V4 pilot) | V5 as shipped | After fix |
|---|---|---|---|
| item 90 in window 1794334185602-1794336268022 | npc_buy 55 trades, 228,602,770 adena, 54 buyers | same, plus a separate row for `bot_wts` (6 trades) | same; both rows named `Goat Head Staff` |
| later-sale candidates (all items) | 1785: 114 buys / 63 bots; 40: 67 / 14; D crystals 14 / 6 | **1785: 42 + 72 in two rows; 40: 43 + 24** | 1785: 114 / 63; 40: 67 / 14 (matches) |
| bot 2001410 custody | deposit of item 90 (projectTarget 852) 18:21:32, NPC sale of 90 for 700,000 at 18:27:02, plan luxury_exchange 852 | candidate true (correct) | + own trade 7457: NPC buy of item 90 at 18:21:30.047 — the full chain buy → deposit → sale in one output |
| bot 2000320 custody | money packet with row (9.63e-5, 15900, 854), deposit of item 90 | candidate false (the last liquidation precedes the deposit) — correct | + own trade 9037: buy of item 90 at 1794335616883 |
| missing ID | — | reported as `truncated:false` | `missing: [1]` |

Root cause of the market discrepancy (fact): `market_trades.itemName` is `Item <id>` for NPC buys and the real name for board trades; grouping by `(selfId, itemName)` split one item. Fix: group by item id, take a real name from any trade of that id. (Also a data-quality problem in the game: NPC trades are recorded without the item name.)

## 3. Read-only guarantee
- V5 opened `{readOnly:true}` + `query_only`: content hashes of all `world*.sqlite*` files unchanged, but SQLite touched the `-shm` wal-index (mtime changed). Fixed: open `file:…?immutable=1` (no -shm/-wal access) and refuse a snapshot whose `-wal` is non-empty (immutable would read it stale); the history DB is attached the same way. Re-checked: hashes unchanged, -shm mtimes unchanged. No server needed.

## 4. Optional raw-geodata in Picked CI (game fork branch `ivan/ci-raw-geodata`, 379b3ce2e)
- Chain: `run-tests.js --only` accepts `+name` for optional-geodata files only (else exit 2); `--list` prints `+tests/test_x.js`, so the Plan job's `only` keeps the mode; the test job passes it back to `--only`; `rawGeodata()` gives those files the map; `--needs-geodata` turns the map download on; each shard writes and uploads a receipt (`raw-geodata-<shard>`: file, `skipRaw`, number of map files, outcome, commit).
- Real CI proof: Picked `tests/379b3ce2e/+bot_activation_placement,bot_town_travel` (run 42914617322) green; receipt `{sha 379b3ce2e…, test_bot_activation_placement, skipRaw "0", geodataFiles 142, passed}`. Probe commit 8f975e749 with `assert.fail('PROBE: the raw map block ran')` inside the map block: with `+` (run 42914645646) **failed on the probe**; without `+` (run 42914650302) **passed** (block skipped). So the + run executes the optional block and the plain run does not.
- `workflow.js record-ci`: for `+` names, requires the runner at HEAD to keep the mark, downloads the receipts, and records raw-geodata evidence only for a passed file with `skipRaw "0"` and map files present, on the run's commit. A plain green run adds nothing. Real record on run 42914617322: `rawGeodata [{test_bot_activation_placement, source ci, run 42914617322}]`. Contract tests: no-map receipt refused, runner without the mark refused, valid receipt recorded.
- Cost: the Picked job downloads the map (cache miss here: `npm run geodata`, ~5 s); nothing runs on the laptop.

## 5. server.log and timeline queries
Formats (fact, from code and the runs):
- `BotPopulation :: requested activation for <name> reason=<r> activity=<a> plan=<p> spot=<s> loc=<x,y,z> playerDist=<d> ready=<yes|no>` (HotActivation.js:280), `BotPopulation :: cooled <name> reason=<r>` (Cooldown.js:69) — both only with `developerDiagnostics`; **no timestamp, names not ids**, some lines wrapped in ANSI colour codes.
- `BotPopulation :: summary k=v …` (234 fields, ~30 s) — no timestamp either.
- The perf recorder's `timeline-*.jsonl` (`type: summary`, `t`, `population.metrics.counters` and `.delta`) is timestamped and stable: the source for counters over time.
Implemented `log-query.js`:
- `activations [--near X,Y --radius R] [--name N]`: counts by reason/plan, 1000-unit placement cells, bots activated ≥2 with their activation/cooling sequence; each line's time = the window between summary lines, mapped to the timeline only when every summary's `activations` equals the timeline delta at the same position (verified on the hot run), else `null`.
- `counters --keys a,b [--points]`: first/last/peak-delta per key from the timeline.
Validation against DT-202 planners (hot run): 260 activations, 193 within 1600 of the landing 82684,183551, **44 bots re-activated there** (planner: 44), DOMInAnce 5 activations each followed by `cooled reason=policy` 2 min later (planner: 5); densest cell 83000,184000 = 70 bodies.

## 6. Cost and replacement
| Query | Time | Output |
|---|---|---|
| db market (item 90) / market (all) / custody (2 bots) | 0.57 s for 3 (0.43 s market all after fix) | 4.5 / 8.1 / 3.0 KB |
| log activations / near / counters | 0.72 s for 3 | 22 / 22 / 1.7 KB |
| trace queries (V4) | 0.26-0.30 s each | 5-30 KB with `--limit 10` |
Manual queries replaced this round: the market-churn SQL and its sell-back variant (2), the bot purse/custody SQL and the separate trade lookup (2), the DT-202 activation scripts (`corr.js`, landing counts by distance, re-landing per name, activation→cooling pairing: 3-4), summary-counter grepping (1). With V4's five trace queries that is 13 of the 16 catalogued repeated queries.

## 7. Known cases the diagnostics still cannot find
- DT-200's henna repeat (needs `lastImprovement.at` and the trace's build of the held step in one view) and `dbFailureOps` per operation over time (server.log summary field, not in the timeline counters).
- DT-173's geodata pocket (needs the pathfinder: one-off probe scripts).
- DT-208's offline economy count (needs the real `Economy.forState`).
- The earning-spot join (flips with each bot's earning answer and the waking raise kind).
- Activations of bots without `developerDiagnostics`; names → ids still need custody/SQL.
- NPC liquidations are not market trades, so a custody chain shows the sale only through `lastNpcLiquidation`, and only the last one.

## 8. Remaining problems
1. Game data: NPC buys are recorded as `Item <id>` in `market_trades`; NPC sales are not recorded there at all.
2. `ivan/ci-raw-geodata` needs review and its own landing (game branch: not merged).
3. The geodata cache missed on the fork (each raw-map job downloads it); cache warm-up per key would save ~5 s per job.
4. Optional-geodata selection is still broad (7 files for a counters change); with CI support it costs one Picked job, not 7 local runs.
5. server.log activation lines need `developerDiagnostics`; a run without it has no activation data.
6. Policy-digest churn: every workflow script fix still invalidates open task records.
