# workflow-v4 pilot: report

Date 2026-11-10 (late). Coordinator: main Claude Code session (claude-opus-5-5); no subagents were used in this round. Diff reviewed: `fork/ivan/workflow-v3-pilot` (5965e87df) → `fork/ivan/workflow-v4` (6863c7f42). Local `planning/` kept; no player databases, configs or full logs are published (only counts and single trace lines quoted below).

## 1. Tests
- `node .claude/workflow.test.js` (Node v24.15.0): 27 PASS on V4 as shipped; 30 PASS after the change below.
- `node scripts/inspect/run-query.test.js`: PASS on V4; PASS after the fixes with 4 new real-shape fixtures. The new fixtures fail on V4's `run-query.js` (TypeError on `buildAnswers`; flips assertions) and pass on the fixed one.

## 2. close --refuted and optional raw-geodata (real temporary task records)
- `close --refuted`: a fresh guess task (`v4-refuted2`, base 66d99ecd1) closed with evidence; afterwards `verify` and `record-brief` refuse ("Task closed"). **Bug:** a guess record started under an older policy (the real `dt123-v2`) could not be closed (policy check ran first). Fixed: closing adds no evidence, so it is allowed and records `policyCurrent:false`; contract test added; `dt123-v2` closed for real.
- Optional raw-geodata: for the DT-173 task head (61ee2b18a vs 6aa4f7dc9) `verify` lists 7 optional-geodata tests (`test_bot_activation_placement`, `test_pathfinding_worker_pool`, `test_player_move_destination_height`, `test_player_transition_recovery`, `test_ti_magic_shop_transition`, `test_town_npc_approach`, `test_town_transit_policy`) and `ready` blocks until each has raw-map evidence. One run (`verify --raw-geodata --test test_bot_activation_placement.js`, `L2NODE_GEODATA_DIR` set): 2 s, recorded. Without geodata the same file fails, so the receipt is real. The other 6 were not run (laptop rule). Finding: even a counters-only change asks for 7 local raw-map runs; the gate is right but needs CI support (section 6).

## 3. Queries vs earlier investigations (runs 9d6bf579a cold-with-player and hot)

| Query | Earlier result (who) | V4 as shipped | After fix | Verdict |
|---|---|---|---|---|
| census | coordinator's ad-hoc census grouped raise by phase → "raise None 10010" | 48,255 records (= 48,256 lines − header), raise split by name | same | V4 better than the scratch version |
| refusals | RM-31: 2001410 190-192 raises in 39-40 s on `item:90` (planner, hot-loop agent) | 2001410 count 192, peak/60 s 190 — **step unknown** (raise has no wishKey) | same + `buildAnswers` `power:852:1:item:90:shopping` ×190, and 2000566/2000532 on `power:854:1:item:90:shopping` | found the loop; the step needed a fix |
| timeline | coordinator's filtered python dump for 2000320/2001410 | 441 records for 2001410 = all its trace lines; 208 builds, 193 on the item-90 step; sorted by `at` across threads | same | equivalent; replaces the scratch filter |
| funding | coordinator's manual reconstruction (RM-31 D2): escrow 2,111,616 appears between build and buy, then `funding_short` | the funding/purchase lines, **without the bid posting** | adds `buy_ad_reconcile` (line 37178) between `native_funding` and the refused buy | fixed: the decisive handle is now in the output |
| flips (hunt_spot) | earning planner: 233 A-B-A cold, 161 hot, 25 bots ≥3; 2304 changes | 233 / 161 / 25; changes **1365** | **350 / 239**, 39 bots ≥3; changes **2294** | V4 and the earlier planner both undercounted: the first record's `was` (the answer held before the trace saw the bot) was ignored. Spot-checked lines 20221→20232 (bot 2000163: 14_29 → 19_33 → 14_29 in 0.5 s). |

Missed signatures fixed (with fixtures): refusal step from the preceding build answer; first-record `was`; `null` answers (7 hunt_spot records); bid posting in the funding chain.
Not covered by V4 at all (fact): DT-202 (activation placement is only in server.log), DT-200 (`dbFailureOps`, `improvementRetired` are server.log summaries; the henna repeat timing needed `lastImprovement.at` from the DB), DT-123's consumer question (code reading), the earning planner's join of flips with each bot's earning answer.

## 4. Cost
- Each query: 0.26-0.30 s on a 9.4 MB trace (Node, single pass, no index). Output: census 5 KB; timeline (2001410) 17 KB; funding 29 KB; refusals 66 KB at the default 50 entries, 7 KB at `--limit 5`; flips 155 KB at 50, 34 KB at 10.
- Replaces: the scratch scripts `aba.js`, `flips2.js`, `ex.js` (flip counts, not the earning-side join), the ad-hoc census and timeline filters, and the per-bot funding reconstruction; together these took the earlier planners several tool calls each and were rewritten by three agents.
- Verifier effect (assumption, from today's numbers): the RM-31 and earning-spot planners spent ~195 k tokens each, a large share re-deriving these five views; with the tool the views are one command each with file:line handles. The DT-200 and DT-202 verifiers would gain little: their decisive data is in server.log and SQLite.

## 5. Two SQLite queries for the next iteration

**Q1 — item churn in a run window** (`world.history.sqlite`, table `market_trades(id, eventKey, occurredAt, channel, sourceType, selfId, itemName, quantity, unitPrice, totalPrice, town, sellerCharacterId, sellerName, buyerCharacterId, buyerName, enchant)`, index `market_trades_item_recent(selfId, occurredAt DESC)`). The history DB spans more than the run (10,221 trades from 1794234572584): always bound by the trace window (`run-query.js census` → `observedFrom/To`).
```sql
SELECT selfId, itemName, channel, sourceType, COUNT(*) trades, SUM(quantity) qty, SUM(totalPrice) adena,
       COUNT(DISTINCT buyerCharacterId) buyers, MIN(unitPrice) minPrice, MAX(unitPrice) maxPrice
FROM market_trades WHERE occurredAt BETWEEN :from AND :to
GROUP BY selfId, channel, sourceType ORDER BY adena DESC LIMIT 10;
-- buys sold back later by the same bot (EXISTS, not a JOIN: a join multiplies rows)
SELECT b.selfId, b.itemName, COUNT(*) buysSoldBack, COUNT(DISTINCT b.buyerCharacterId) bots, SUM(b.totalPrice) boughtFor
FROM market_trades b WHERE b.occurredAt BETWEEN :from AND :to AND b.buyerCharacterId IS NOT NULL
  AND EXISTS (SELECT 1 FROM market_trades s WHERE s.selfId = b.selfId AND s.sellerCharacterId = b.buyerCharacterId
              AND s.occurredAt > b.occurredAt AND s.occurredAt <= :to)
GROUP BY b.selfId ORDER BY boughtFor DESC LIMIT 10;
```
Real result (cold run, 0.58 h, 0.5 s): item 90 `npc_buy` 55 trades, 228,602,770 adena, 54 buyers at 4,156,414 each; sell-backs: item 1785 114 buys by 63 bots, item 40 67 by 14, D crystals 14 by 6. Normal: a dear item bought by few bots near its worth, few sell-backs. Anomalous: one dear item bought by dozens of bots in an hour (DT-208), buy-then-sell loops. (A first JOIN version reported 288 sell-backs for item 1785: rows multiplied; the EXISTS form is the correct one.)

**Q2 — a bot's purse, plan and custody snapshot** (`world.sqlite`, `bot_life_state(characterId, characterName, adena, activity, spotId, statsJson, mindJson, …)`; `mindJson.money` = `[hourAdena, moneyPrice, refillReserve, firstUnfundedPrice, (ratio, cumulative, itemId) per funded row …]`, `mindJson.wishFocus[0]`, `mindJson.earning.spotId`; `statsJson.equipmentPlan.{strategy,target.selfId}`, `statsJson.lastWarehouseDeposit{items[],at,projectTarget}`, `statsJson.lastNpcLiquidation{at,payout,sold[[selfId,count,price]]}`).
```sql
SELECT characterId, characterName, adena, activity, spotId,
       json_extract(mindJson,'$.money') money, json_extract(mindJson,'$.wishFocus[0]') focus,
       json_extract(mindJson,'$.earning.spotId') earnSpot,
       json_extract(statsJson,'$.equipmentPlan.strategy') planStrategy,
       json_extract(statsJson,'$.equipmentPlan.target.selfId') planTarget,
       json_extract(statsJson,'$.lastWarehouseDeposit') lastDeposit,
       json_extract(statsJson,'$.lastNpcLiquidation') lastLiquidation
FROM bot_life_state WHERE characterId IN (:ids);
```
Real result: 2001410 `money [1539557, 6.5e-7, 410785, 4176814]` (no funded row, first gap 4.18 M), focus `power:852:1`, plan `luxury_exchange` target 852, deposit `{items:[{selfId:90,"Goat Head Staff",1}], projectTarget:852}`, liquidation `sold [[90,1,700000], …]` — the staff the plan holds was sold to an NPC (the DT-208 custody bug, found by hand earlier). 2000320: funded row `(9.63e-5, 15900, 854)`, deposit of the staff, plan target 854. Normal: a deposited project input is not in a later liquidation while the plan holds it. Anomalous: `sold` contains a `selfId` of `lastWarehouseDeposit.items` with `projectTarget` = `planTarget`.

## 6. Minimal Picked-tests change for optional raw-geodata (proposal, game branch)
Today the runner gives the raw map only to `geodataTests` or `--geodata` mode; Picked tests runs `--only` lists, so an optional file's map block is skipped. Smallest change: a `+` prefix in a Picked list (`tests/<sha>/+bot_activation_placement,town_travel` or a `+name` line in `ci-tests.txt`; `+` is legal in ref names, `:` is not) marks a raw-map run of an optional file. `scripts/run-tests.js`: parse the prefix in `--only`, set `L2NODE_SKIP_RAW_GEODATA_TESTS=0` for those files and make `--needs-geodata` true when any is present (the existing workflow then downloads the cached map). `tests.yml`: no change. `workflow.js record-ci`: record `+name` files as raw-geodata evidence. Cost: one Picked job per task with the map cached (geodata download is already cached by key); nothing moves to the laptop.

## 7. V4 findings (summary)
1. refusals named no step for the main loop signature (fixed: `buildAnswers`).
2. flips undercounted A-B-A by ~50 % and changes by ~40 % (fixed: seed from `was`, count `null`).
3. funding missed the bid posting (fixed).
4. a refuted guess under an older policy could not be closed (fixed).
5. optional raw-geodata gate is correct but asks for 7 local runs on a counters change (proposal in 6).
6. default limits are too large for agent context (flips 155 KB): use `--limit 10`.
7. server.log and SQLite signals remain manual (two queries specified in 5).

## 8. Next stage
- Land the `+name` raw-map Picked change in the game repo, then make `ready` accept it.
- Add `server-log` queries (activations near a point, summary counters over time) and the two SQLite queries to `run-query.js`, each with a real-shape fixture.
- Require the verifier brief to cite query commands + file:line instead of attaching scratch scripts; keep scripts only for one-off probes (geodata, offline economy counts).
