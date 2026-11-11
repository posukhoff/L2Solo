# Gate 3 verifier: coverage and invariants of the final traced run (release 1a, 3c164d3cc)

Run: tmp/perf/runs/l2solo-perf-3c164d3cc-script-online-player-20261111-144517 (VPS, cold, PerfPlayer online, 30.1 min window, diagnostics off, trace on, world kept; a panel world shared the VPS).
Base: tmp/perf/runs/9d6bf579a-script-online-player-20261110-200920 (laptop, diagnostics on). Same save d2f4aa5d, 1735 cold + 45 hot, x50.
Per bot-hour = 1700 hunters (merchants and bot_craft_ left out) x 35.1 min (start to window end): 994 bot-h on both sides.
Helpers (read-only, node:sqlite): tmp/rc-tools/gate3-verifier/{inv.js,room.js,cells.js}; outputs inv-new.json, inv-old.json, cov.txt there.
`node tmp/rc-tools/gate3-verifier/inv.js <world.sqlite> tmp/saves/d2f4aa5d-dc82-4241-bdcf-d3bb256899ba/database.sqlite <run.json> <logs/decision-trace.jsonl>`
(Run on copies: the live world.sqlite is open elsewhere, so a read-only open can fail.)

## 1. Coverage

`node planning/coverage.js <run>/logs/decision-trace.jsonl --root .claude/worktrees/rel1a`. Trace: 34,460 records, one boot.
Cells: 118 decision x situation x place rows (7 decisions). Taken: far 48/59, near 11/59. Empty: far 11, near 38. Uncaused: build unwoken:step 1390, unwoken:member 175, hunt_spot route 986 (same as 9d6: 1395/172).

### Empty far cells (11)
| Cell | Closed by |
|---|---|
| earning_spot<recovered (raised 3, woke/wait 3, none taken in the window) | test_held_earning_spot (the recovery lifted wakes the decision alone, one search) |
| earning_spot<spot_dangerous | test_held_earning_spot (died/spot_empty/spot_dangerous/party_left each wake one search, l.128) |
| earning_spot<spot_unreachable, build<spot_unreachable | raised only by a body's walk (near: 24 in run); far: test_bot_hunting_route_failure, test_held_earning_spot |
| earning_spot<goal_affordable:potions, build<goal_affordable:potions | test_cold_worker_one_decision, test_player_moment |
| earning_spot<karma_changed | test_cold_karma_policy, test_held_earning_spot (no karma wash in 30 min) |
| build<player_command | e2e scenario tests/e2e/player-command.js; test_hot_hunting_continuation (online-player script gives no command) |
| own_lines<goal_failed:line | unchecked: raised only when main cannot apply a look (ColdSimulationCoordinator.js:1661); named in a raise list only in test_hot_hunting_continuation:188, no own_lines test of the wake |
| party_stay<party_outleveled, party_stay<party_need_ended | test_party_stay (l.34, 117-120, 189) |

### Empty near cells (38), grouped
| Group | Cells | Closed by |
|---|---|---|
| earning_spot near (11) | grade_changed, spot_outleveled, gear_changed, died (woke/wait 1), recovered, spot_disappoints, spot_dangerous, moved_by_world, party_left, goal_affordable:potions, karma_changed | rule: test_held_earning_spot (same Situations.detect near and far); near post → worker answer → body: test_near_decision_order, test_near_fact_post. Near place itself unchecked in run (avg 61 hot bots, 30 min) |
| build near (14) | grade_changed, gear_changed, recipe_learned, party_left, goal_affordable:potions, out_of_money, goal_done:goal, goal_failed, source_stalled, clan_call, clan_changed, player_command | test_player_moment, test_cold_worker_one_decision, test_bot_acquisition_recovery + test_near_decision_order (transport); player_command: e2e player-command.js |
| gear_plan near (4) | grade_changed, gear_changed, clan_changed, source_stalled | test_bot_acquisition_recovery, test_player_moment + test_near_decision_order |
| workshop near (2) | arrived_town:own, recipe_learned | recipe_learned: test_cold_worker_one_decision; arrived_town:own near: unchecked (no hot crafter arriving at its own town in run; rule same as far, 238 far taken) |
| own_lines near (2) | goal_done:line (woke/wait 1), goal_failed:line | goal_done:line: test_decision_trace, test_market_buyer_waiters; goal_failed:line: unchecked (as far) |
| rebuff near (1) | buffs_expired | test_rebuff_decision, test_hot_hunting_continuation |
| party_stay near (6) | died (woke/wait 1), bag_full (raised 2, woke none), goal_affordable:focus (raised 1, woke none), grade_changed, party_outleveled, party_need_ended | unchecked by design: known DT-49 (problems.md:61, a hot party decides stay only at its first cold step) |

### Lifecycles
- errand taken/done/failed 0/0/0: unchecked, craft errands dormant (known DT-64).
- party formed 0 (also 0 in 9d6) while party joined 31, dissolved 11, member 642 and 31 `party` life events: the `formed` trace hook (BackgroundPartyState.js:181, revision 0 only) never fires on this path; unchecked: candidate problems line (trace gap, not behaviour).
- meeting prepared/accepted/delivered 218/85/85, refused 1, cancelled 0; raid search/forming/outcome 10/1/1.

## 2. Invariants (3c164d3cc vs 9d6bf579a)

| Invariant | New | 9d6 | Verdict | Handle |
|---|---|---|---|---|
| Wear a usable weapon (equipped, grade allowed by level) | 0 no weapon, 0 over-grade | 0 / 0 | PASS | inv.js `shots.noWeapon/gradeAboveLevel` (class/weapon kind fit not checked) |
| Shots of weapon grade carried | 759/1700 shotless (+1 other grade only) | 726 (+2) ; save start 120 | FAIL, known RM-45 (maintainer 11-10: not a release-1 blocker, release 7); +33 bots vs released | inv.js `shots.noShotOfGrade`; problems.md:185 RM-45 |
| No buy/craft/errand retry loop | fail raises 661 = 0.67/bot-h; worst bot 2001093 8 (13.8/h, 7 goal_failed:visit); FailureLog sites 0; rejected= 32; botFaults 0/0/0; stepsRefused 10; errands 0 | 1536 = 1.56/bot-h; worst 2001410 192 (332/h: a loop); FailureLog 14; rejected= 152 | PASS (bound: ≤ released, no bot ≥ 20/h; builds 6.9/bot-h ≤ 8 population.md, 9d6 9.3) | trace raises goal_failed*/source_stalled/out_of_money; server.log last `situations=` line `rejected=`, `stepsRefused=` |
| No bot long in town | cold shopping/crafting > 15 min: 0 (9d6: 2000569 shopping 1672 min). Hot: 4 bots with zero EXP all run standing at Hunter's Village (≈117k,76k): 2001106, 2001351, 2001553, 2001611 (last trace 14:47-14:49, nothing after) | 4 alike: 2000108, 2001106, 2001351, 2001512 | FAIL (pre-existing, same ids in 9d6) | SQL below Q1; trace `"bot":2001351,` last record 14:48:05 hunt_spot route 21_12 |
| No bot on lost ground | 2000772 (cold L74, hunting, spotId null since 2026-11-09, `earning:no_spot`, party request no_solo_ground→too_few_members, zero EXP); 2001553 (hot, hunting, no spot) | 2000772 alike | FAIL (pre-existing in save and 9d6) | Q1; trace 14:47:15 `note earning:no_spot` bot 2000772 |
| No bot frozen | cold rows unwritten all window: 2001177 (leader, grouped, no spot, zero EXP) + 2000947 (member, resting 30_6), party bgp_mwc8f6re_2001177 formed 14:46:24, row revised every minute (rev 39, rounds 33) but no member progress | 2000751 + 2001126, party bgp_mwb0d7rt_2001126 alike | FAIL (pre-existing: stuck 2-member party) | Q2; history bot_life_events `party` 14:46:24 "formed a party at Doom Guard fields" |
| None quarantined | workerFaults 0, quarantinedMax 0, botFaults 0/0/0, swallowed 0/0 | swallowed 14 (combat.user_info) | PASS | summary.json context.failures |
| Worker lag | steady p50 0 / p99 916 / max 916 ms (≤ 1 s); boot max 34 s (≤ 60 s), drained 175 s | steady max 1197 ms (miss), boot 60.8 s | PASS | summary.json workerDue |
| Turn length (≤ 50 ms, p99 ≤ 20 ms) | turns.main/worker null (diagnostics off: unmeasured); attributed longest main 674 ms, worker 885 ms; long turns/min 42 / 97 | turns max 311/341, p99 26/77 (miss); longest 388/966; 61/132 per min | FAIL vs target, pre-existing (released misses too), not worse; p99 unchecked here | summary.json turns, threads.*.longestMs |
| Spots over room | end state, with travellers: 392 occupied, 17 over, 8 over 1.15x, max excess 12 (13_31 46/34), excess bots 55/1609 = 3.4 % | 378, 12, 11, 9 (13_31 43/34), 47/1573 = 3.0 %; 9d6 status series 11-19 over, max excess ≤ 12 | PASS vs released (no numeric release bound written; 13_31 over 1.15x already in save 41/34) | room.js (room = clamp(round(density×0.75),9,36), LevelingRoutes.js:259) |
| Deaths per bot-hour | trace 6 (0.0061), deathCount Δ 7 | 11 (0.0112), Δ 10 | PASS | trace kind death; bot_life_state.deathCount vs save |
| EXP per bot-hour | 8.47 M (2517 level-ups) | 8.18 M (2454) | PASS +3.6 % | characters.exp vs save |
| Income (adena) per bot-hour | 1.509 M | 1.458 M | PASS +3.5 % | items selfId 57 vs save (warehouse Δ 0) |

Context: town arrivals 1573 (1.58/bot-h) vs 2542 (2.56); steady worker steps 30,475 vs 37,935 (VPS); player schedule max 368 ms > 150 limit (9d6 283 ms, also over). 21ef29385 for reference: EXP 6.18 M, adena 1.35 M, deathCount Δ 40, shotless 530.

### Queries
Q1 (zero EXP all run; run on copies):
```
attach '<save>/database.sqlite' as s;
select l.characterId,l.phase,l.activity,l.spotId,l.level,l.partyId,l.locX||','||l.locY
from bot_life_state l join characters c on c.id=l.characterId
join s.bot_life_state sl on sl.characterId=l.characterId join s.characters sc on sc.id=l.characterId
where l.activity<>'merchant' and l.accountName not like 'bot_craft_%' and max(c.exp,l.exp)=max(sc.exp,sl.exp);
```
New: 2000772, 2001106, 2001177, 2001351, 2001553, 2001611. 9d6: 2000108, 2000122, 2000569, 2000632, 2000751, 2000772, 2001106, 2001126, 2001351, 2001406, 2001512.
Q2: `select partyId,memberIdsJson,spotId,revision,datetime(updatedAt/1000,'unixepoch') from bot_background_parties where partyId='bgp_mwc8f6re_2001177'` and `select characterId,activity,datetime(updatedAt/1000,'unixepoch') from bot_life_state where updatedAt < <windowStart ms> and phase='cold'`.
