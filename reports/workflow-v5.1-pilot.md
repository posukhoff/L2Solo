# workflow V5.1 pilot: release 1a night run

Date 2026-11-11, 02:50-08:25 EET (landings until 07:15; runs, analyses, decisions and the report after). Coordinator: the main Claude Code session (claude-opus-5-5); subagents inherit the model. **Coordinator tokens: unknown** (not exposed). Agent tokens and times are each agent's harness usage line (`subagent_tokens`, `duration_ms`); a resumed agent's number is cumulative, and for three implementers (DT-197, DT-208, RM-31) it includes their work from before the night. Fork only: nothing pushed to origin, no PR, no V6 work. No databases, configs or full logs published. Workflow V5.1 (fork `ivan/workflow-v5.1` 43aea4177) installed locally and used for every task; `.claude/workflow.test.js` 47 PASS.

## 1. Release 1a: done and left

`ivan/batch-1a` (fork): `9d6bf579a` (release 1) → **1a7619d3e** (30 commits; 22 tonight, listed below; the 8 before tonight landed in the V5 pilot: DT-174, DT-173, DT-200, ci-raw-geodata ×2, custody, DT-200b, DT-200a).

Landed tonight, in order. Each: brief, review pass, PR checks + Picked list green on its exact SHA, old-code failure of its test verified, `verify --rules` 0/0, `ready`, `record-land`.

| # | Item | SHA | Player-visible result |
|---|---|---|---|
| 1 | DT-202 (2 commits) | 031ee6732, 52eb1107c | a cooled body keeps its town trip; a gatekeeper landing in view is no late activation (late activations 4 vs 22 in release 1) |
| 2 | Earning spot (DT-196/122/194) | 1ff7b2b4a | a solo bot hunts at its earning answer unless its step farms the plan's item (off-answer hunts 5 vs 77; hunt-spot A-B-A flips −49 %) |
| 3 | DT-197 | 32ac85f1b | a meeting seller pays the gatekeeper from its wallet: ~1200 conditional sell lines become buyable |
| 4 | DT-211 | 319b71f19 | a near body's improvement step ends on its row when the body left mid-write |
| 5 | DT-214 cleanup | 7668e09c7 | the flaky pathfinding test fails in ~23 s instead of holding its shard 180 s (cause still open, §7) |
| 6 | DT-208 | f3eec5444 | a luxury exchange/craft root is valued at most at its item's worth: Goat Head Staff buys −42 %, 91 % consumed, 0 sold back |
| 7 | RM-31 | 12962fed3 | one budget per money root: the 190-raise funding loop is gone (max 5 goal_failed per bot per minute vs 190) |
| 8 | DT-203 | 83b6b46df | a near bot keeps every refused quote of one item (it no longer walks back to the second stall that refused it) |
| 9 | DT-207 | 126a74c0d | one buy-refusal classifier hot and cold; hot invariant breaks are counted; a live player store's refusal marks its quote |
| 10 | DT-201 | 4dde46367 | a card-served town step holds the build's bids (no re-post every 1-2 s, no A-B-A) |
| 11 | DT-146 | 4ab2856b6 | a far visit collects its banked inputs before its held improvement (no refusal + withdraw/re-deposit) |
| 12 | RM-3 (+ tables) | 86cf10b87, 9c37ae336 | no `combat.user_info` TypeError on an NPC; a character gets its UserInfo once; toggle MP tick sends vitals only |
| 13 | DT-204 (= DT-230) | d68fab586 | a hot bot admits offers against its body's own quote marks: it moves to the next stall like a cold bot |
| 14 | DT-231 | 22e3e1fb3 | main's town-step reconcile no longer re-decides bids from the card (24 % of traced buy-ad writes) |
| 15 | DT-205 | 242299cf8 | hot bodies hear `offer_posted` through the kernel's one situation wake (0 of 1119 before) |
| 16 | DT-239 | d53b2571f | a closed party request is held on a served no-leaf card until the next build (it was reopened every ~50 s; opens +40 %) |
| 17 | DT-242 | 95427f498 | crystals a held step buys after its decision are no longer listed by the same visit (the 1/s re-buy loop, 3.4 M lost by one bot) |
| 18 | RA2-1 (audit) | d8cf46c47 | a kill no longer captures every rewarded bot's full state on main (~190 µs + 8 KB per bot) |
| 19 | DT-196 rest | d981990b1 | an offer wake re-weighs the held step only against buying the offered item (no farm-leaf/spot re-roll) |
| 20 | RA2-2 (audit) | 1a7619d3e | a clan-duty stay trip traces its departure and exactly one end; ticket expiry counted |

Closed by evidence, no code: DT-187 (henna/enchant repeats: 0 improving repeat pairs after DT-200a vs 45 in release 1; a mark would add a mechanism with no gain), DT-181 (merchants killed: no case in 4 runs; "Lienrik Lad" npc 787 is a level-40 monster), RM-22, RM-23, DT-169 (absent / not reproduced in the traced run), roadmap "Ready" Orc Shaman row (b842ebdb0 + 9008fe288 are already in the head as 88dcecbb0, stricter), RM-32 measured and closed (§7).

Left in 1a (roadmap rows now):
- DT-214: implement the decided sliced corridor search; 15 extra Picked attempts tonight.
- DT-243: implement the decided "next funded goal".
- DT-247 / DT-248: crystal/shot ping-pong after a funding refusal and crystals round-tripped through the bot's own line (pre-existing; found in the final runs).
- DT-231 rest: main still judges "could it bid" (from the card) for its withdraw.
- RM-20 (world test on a save with an owned hall and a player clan); DT-238 (perf recorder misses partial starvation).
- Rules audit: RA1-2 (no-spot four ways, three clocks), RA3-2 (~57 comments cite unresolvable design ids), RA3-3 (Trade lines); [tail] findings in `planning/architecture/findings-1a.md` and `reports/rules-audit-1a.md`.

Closed this morning by your decisions: DT-202 rest, RM-32 (§7).

## 2. Branches and exact SHAs (fork posukhoff/L2Solo)

| Branch | SHA | State |
|---|---|---|
| `ivan/batch-1a` | **1a7619d3e** | release 1a integration, all landings above |
| `ivan/workflow-v5.1-pilot` | (this commit) | this report, the rules audit, task records, the planning snapshot (child of `ivan/workflow-v5.1`) |
| `ivan/workflow-v5.1` | 43aea4177 | V5.1 as installed tonight (unchanged) |
| `ivan/workflow-v5-pilot` | 2a1c8d947 | V5 pilot + world validation report (unchanged) |
| `ivan/ci-pathfinding-cleanup` | e6e239bfd | superseded by 7668e09c7 on batch-1a |
| `ivan/next-release` (fork) | 563f9e6d5 | untouched (local `ivan/next-release` = 9d6bf579a, release 1) |
| origin | — | nothing pushed, no PR |

Tonight's `ci-<sha>`, `tests/list-<sha>`, `tests/<sha>/<test>` and `tables/all/<sha>` refs on the fork are throwaway CI refs; task worktrees are local.

## 3. Session statistics

**Totals (02:50-07:15 landings; runs, analyses and the report after).** 20 items / 22 commits landed, 7 items closed or parked by evidence (DT-187, DT-181, RM-22, RM-23, DT-169, the Shaman port, RA1-1 latent), 1 rules audit (3 passes). About 80 subagent runs incl. resumes: **8.9 agent-hours, ≈ 8.35 M subagent tokens** (coordinator unknown). 32 review rounds: 26 pass, 5 blocked (RM-31 r1 rule 5, RM-31 r2 rule 11, DT-146 r1 telemetry regression, DT-201 r1 rule-4 listing, RA2-2 r1 rule 4/8), 1 pass-with-fix-now (DT-205 placement). Re-investigations of a confirmed cause: 0. Task records: about 60 for 21 tasks (most extra ones superseded by restacks).

**CI tonight (fork, 00:51-05:15 UTC):** PR checks 23 green, 5 red, 19 cancelled (restacks); Picked 36 green (+15 rerun attempts), 9 cancelled; tables 1 green, 1 cancelled. Median wall per run including queue: PR checks 7.3 min, Picked 4.3 min, tables 14.9 min. Fork capacity ≈ one PR-checks run at a time; queues reached 5 runs. Of the PR-checks failures 3 were real (DT-197: 3 tests pinned the old free-money fare; DT-208: a test pinned the old floor; RM-31: a test helper walked the money packet raw) and each was fixed by a test-only change; every Picked failure was DT-214 (`test_companion_pathfinding_worker` PATH_BUDGET): **15 extra Picked attempts** (≈ 0.75 per landed item) plus two single-test runs to clear a change, 0 real.

**Critical path vs useful parallel work.** No idle CI waits: while a run was queued or running the coordinator recorded evidence, restacked, edited planning, or 2-6 agents verified/implemented/reviewed other items. The wait that did block landings was CI capacity plus DT-214 reruns: e.g. DT-207 waited 4 Picked attempts (~6 min), DT-205 4 attempts (~4 min) plus a single-test check to rule itself out.

| Item | Route | Start → landed (EET) | Verifier | Implementer | Review rounds (time, tokens) | CI on the landed SHA | Restacks / records | Notes |
|---|---|---|---|---|---|---|---|---|
| DT-202 | critical | impl. before night → 03:18 | — | before night | r1 pass (336 s, 97.8 k) | PR green; Picked 3 attempts (DT-214 ×2) | 1 / 2 | |
| Earning spot | critical | before night → 03:31 | — | before night | r1 pass (353 s, 126.3 k) | first try | 4 / 5 | a stacked run failed on DT-208's test |
| DT-197 | critical | before night → 03:39 | — | test fix 315 s (cum. 169.2 k) | r1 pass (168 s, 92.4 k), r2 pass (28 s, 59.4 k) | PR first try; Picked 2 (DT-214) | 4 / 5 | 1 real CI fail (3 tests pinned the old fare) |
| DT-211 | critical | 02:55 → 03:39 | — | 791 s, 97.9 k | r1 pass (126 s, 82.5 k) | first try | 4 / 5 | brief file empty at first read (my shell quoting) |
| DT-214 cleanup | fast→critical | before night → 03:40 | (cause: own measure) | before night | scoped pass (42 s, 59.7 k) | PR first; Picked 2 (DT-214) | 5 / 6 | CLI demanded critical at ready: re-recorded with a verified cause |
| DT-208 | critical | before night → 03:48 | — | test fix 302 s (cum. 231.4 k) | r1 pass (196 s, 103.1 k), r2 pass (268 s, 85.3 k) | first try | 4 / 4 | 1 real CI fail (test pinned the old floor) |
| RM-31 | critical | before night → 03:56 | — | 3 resumes 1126 s (cum. 346.5 k) | r1 blocked (336 s, 119.8 k), r2 blocked (162 s, 97.5 k), r3 pass (174 s, 69.7 k), r4 pass (158 s, 62.6 k) | first try | 5 / 5 | 1 real CI fail (helper); round limit → coordinator decision: tests + narrow reviews |
| RM-3 | standard→critical | 03:49 → 04:42 | — | port 364 s, 87.2 k | r1 pass (314 s, 95.6 k) | first try | 3 / 3 | tables rebuild 15 min; finding 1 applied by coordinator |
| DT-201 | critical | 03:49 → 04:40 | 565 s, 223.1 k | 1104 s, 229.4 k | r1 rule-4 listing (599 s, 207.6 k) → amended | first try | 3 / 4 | stacked on unreviewed DT-146: 1 restack |
| DT-146 (+DT-187) | standard | 03:49 → 04:42 | 757 s, 196.5 k | 1233 s (cum. 193.4 k) | r1 blocked (508 s, 130.6 k), r2 pass (54 s) | PR first; Picked 2 (DT-214) | 1 / 2 | DT-187 closed by the same verifier |
| DT-203 | standard | 04:00 → 04:35 | (in implementer) | 568 s, 116.6 k | r1 pass (194 s, 86.3 k) | first try | 2 / 3 | |
| DT-207 | standard | 04:00 → 04:40 | (in implementer) | 768 s, 141.2 k | r1 pass (263 s, 116.7 k) | PR first; Picked 4 (DT-214 ×3) | 2 / 2 | |
| DT-204 | standard | 04:36 → 05:10 | 630 s, 191.4 k | 932 s, 133.8 k | r1 pass (333 s, 105.1 k) | first try | 0 / 1 | |
| DT-231 | critical | 04:44 → 05:26 | (measure in implementer) | 1410 s, 226.9 k | r1 pass (403 s, 130.6 k) | PR first; Picked 2 (DT-214) | 2 / 3 | |
| DT-205 | critical | 04:36 → 05:35 | 403 s, 132.8 k | 1711 s (cum. 238.2 k) | r1 pass+fix-now (548 s, 153.2 k), r2 pass (127 s) | PR first; Picked 4 (DT-214 ×3) | 2 / 3 | single-test runs proved DT-214, not DT-205 |

| DT-239 | critical | 06:05 → 06:58 | 520 s, 171.3 k | 579 s, 128.3 k | r1 pass (218 s, 100.3 k) | first try | 0 / 1 | found by the run analysis (party requests +40 %) |
| DT-242 | critical | 06:13 → 07:00 | 929 s, 236.5 k | 1050 s, 177.4 k (probe first) | r1 pass (438 s, 140.0 k) | first try | 1 / 2 | found in QUIET as a "new loop"; verifier proved it pre-existing |
| RA2-1 | standard | 06:30 → 06:58 | (audit) | 651 s, 108.2 k | r1 pass (246 s, 80.8 k) | PR only (no geodata tests) | 1 / 2 | pure cost fix: the test fails on old code only on the capture spy |
| DT-196 rest | critical | 06:10 → 07:05 | 535 s, 142.2 k | 1745 s, 191.6 k | r1 pass (636 s, 170.7 k) | first try | 1 / 2 | focus kept on offer wakes: checked in QUIET2 |
| RA2-2 | standard | 06:30 → 07:15 | (audit) | 608 + 837 s (cum. 164.1 k) | r1 blocked (184 s, 90.1 k), r2 pass (167 s, cum. 124.9 k) | PR first; Picked 2 (DT-214) | 2 / 3 | trace moved to the row-commit owner in round 2 |

"Before night" = implemented and partly reviewed in the previous session (V5 records n-*); tonight's work on them was review rounds, test fixes, restacks, CI and landing. Remaining acceptance per item: all landed items meet their brief's acceptance by test; the run-level acceptance (behaviour in a world run) is in §6.

**V5.1 tools that saved work (facts):** `record-brief` with a cause gate made 3 verifiers' verdicts ("close" for DT-187, DT-181, Shaman) cheap and final; `verify` lists (geodata-only and `+` raw-map tests) fed every Picked list commit (no laptop geodata run); `ready` caught 4 missing pieces before a landing (selection-ack after full CI ×5, missing regression ×2, wrong route ×2); `record-land`'s tree check confirmed every landed tree equals the reviewed one; patch-id equality carried a review across restacks 30+ times without a re-review; diagnostics (run-query/db-query/log-query) gave the verifiers bot sequences in minutes (DT-201's A-B-A, DT-146's withdraw/re-deposit, DT-204's repro, DT-205's 0/1119).

## 4. V5.1 vs the V5 pilot

| | V5 pilot (11-10, 22:54-23:47) | V5.1 night (11-11, 02:50-07:15 landings) |
|---|---|---|
| Items landed | 3 (+ ci-raw tooling) | 20 items, 22 commits |
| Items closed by evidence | 0 | 7 (DT-187, DT-181, RM-22, RM-23, DT-169, Shaman port, RA1-1 latent) |
| Wall time per item, start → land | 32-43 min | 23-59 min for the 8 started tonight (median ~50); queue-bound, not agent-bound |
| Landings per hour of coordinator time | ~3.4 | ~4.6 (20 in 4 h 25 min) |
| Parallel agents at once | 2-3 | up to 6 |
| Subagent tokens | ≈ 1.10 M (3 items) ≈ 0.37 M/item | ≈ 8.35 M (20 landed + 7 closed + audit + 4 run analyses) ≈ 0.31 M/item |
| Review rounds / blocked | 5 / 1 | 32 / 5 (+1 fix-now) |
| Real CI failures | 1 (a test stand-in) | 3 (all tests pinning the old rule) |
| Flaky CI attempts (DT-214) | 3 | 15 |
| Re-investigations of a confirmed cause | 0 | 0 |
| Task records per item | ~1.5 (rebase re-records) | ~2.9 (restacks) |
| Rebase/restack incidents | 2 (rebase widened the selection) | 9 restacks/re-picks (3 caused by a failure low in a stack) |
| Stale landing caught | 1 (record-land) | 0; but record-land recorded one landing before the push (defect, §5) |

What V5.1 changed in practice:
- **Dev test plans and list commits** (`verify` → geodata-only + `+raw` names → `tests/list-<sha>`): every Picked run was one list commit, no laptop geodata run, no ref-length failure (V5 had one).
- **Rebase receipts** (`record-rebase`): not usable for tonight's moves — a task moved down/up a stack (old base not an ancestor of the new one) or onto a base that changed the path set. All moves were done as new records with patch-id equality as the review carry-over. That worked but cost 33 superseded records and coordinator time.
- **selection-ack after full CI** for critical surfaces: caught 5 landings that would otherwise have gone without the explicit "full PR checks seen" receipt.
- **Cause gate** (`record-brief` refuses a fix without a verified cause, evidence handles and regression tests): forced the DT-214 cleanup to be re-recorded with its real cause; made three verifiers end in "close" instead of code.

## 5. Bottlenecks and proposals

Measured, in order of cost tonight:

1. **DT-214 flaky pathfinding test: 15 extra Picked attempts** (≈ 3-5 min each, about 1 per landing), plus two single-test checks to prove a new change innocent. The cause is known (150 ms corridor budget; the test's shard neighbours load the runner). *Decided (§7):* slice the corridor search across turns. Until it lands: run `test_companion_pathfinding_worker` in its own Picked shard (the runner's sharding, not the test) so its neighbours do not push it over the budget.
2. **Stack cascades: 6 restacks, 3 forced by one failure low in a stack** (DT-197 CI, DT-208 CI, DT-146 review). My own process error once: I stacked three tasks on DT-146 before its review returned; its block cost 5 cancelled runs and a restack. *Proposal (workflow, not V6 code):* stack only on a task whose review passed and whose PR checks are green; dispatch CI for an unreviewed task on the integration head alone.
3. **CI capacity ≈ one PR-checks run at a time** on the fork; queues up to 5. With 2-6 agents producing, CI was the critical path from ~04:15. *Proposal:* a second runner pool or fewer shards for small diffs; or CI only on the top of a reviewed stack with a CLI "stack receipt" (patch-id equality) for the tasks under it.
4. **record-rebase cannot move a task** within a stack or onto a base whose path set differs → a new record per move (about 60 records for 21 tasks). *Proposal:* accept a move when the task's own patch-id is unchanged and its old base is in the new base's history or the move is a pure reorder.
5. **record-land records the checkout HEAD and ignores `--ref`**: it wrote a landing for 7668e09c7 before my push had succeeded (the push failed; I re-pushed). *Proposal:* record-land reads the integration ref (fetch) and refuses unless it equals the reviewed tree.
6. **Route escalation found late**: two tasks (DT-214 cleanup fast, RM-3 standard) were refused at `verify`/`ready` as critical (test surface; bot tables). Cheap, but each cost a re-record and once an empty Picked list (my `ci.sh` did not stop on the verify failure; fixed). *Proposal:* `start` runs the critical-surface check on the brief's scope and suggests the route.
7. **Laptop runs vs local agents**: the first traced run overlapped with agents' single-file tests; the OS starved the server for ~10 min and the run showed a false 19 s worker lag. It cost a profile analysis (5 min, 134 k tok) and a second, quiet run. *Proposal:* a local run lock (`workflow.js run-lock`) that agents check before running node tests; the perf recorder flags partial starvation by profile sample gaps (DT-238).
8. **Planning budget**: problems.md hit its 108 KB budget four times; tonight's reviews and audits produce ~1-2 lines per task. I kept it in budget by deleting landed lines, moving evidence out of new lines, and moving 4 low-value tails to this report. *Proposal:* decide whether audit/review [tail] findings belong in problems.md or in a release-scoped findings file.
9. **Environment**: `git push` right after `git fetch` in one shell call failed 4 times, then succeeded standalone (not diagnosed; no data lost). Minor.

Not bottlenecks: verifiers and implementers (no re-investigation, briefs sufficed), reviewers (median ~5 min), diagnostics (each verifier found its sequences in minutes).

## 6. CI, runtime and release readiness

**CI.** Every landed SHA has green PR checks (12 shards, full suite) and a green Picked list (geodata-only + raw-map optional tests) on that exact SHA; `record-ci` stored both. The only red left anywhere is DT-214 (flaky, not a regression: the test alone is green on every head checked).

**Runtime (same save d2f4aa5d "late world x50 1700 bots", script online-player, 30-min traced window).**

| | B release 1 (9d6bf579a) | C pre-night batch (6c1455b5e) | NEW (12962fed3) | QUIET (242299cf8) | QUIET2 (1a7619d3e = batch-1a head) |
|---|---|---|---|---|---|
| EXP per bot-hour | 7.81 M | 8.09 M | 8.04 M | 7.89 M | 7.96 M |
| Net adena per bot-hour | 1.391 M | 1.575 M | 1.570 M | 1.461 M | 1.468 M |
| Deaths | 10 | 7 | 9 | 7 | 12 |
| Stuck (excl. 45 merchants, 35 L70 crafters) | 4 | 4 | 2 | 2 | 2 |
| DB failures / swallowed failures | 57 / 14 | 0 / 12 | 2 / 8 | 2 / 0 | 3 / 0 |
| goal_failed raises / bots > 5 per 60 s | 1297 / 8 | 913 / 6 | 610 / 0 | 651 / 2 (DT-242) | — / 2 (2000465 crystal/shot loop, 2000278 small) |
| workerDue steady p99 / max | 1.0 / 1.2 s | 1.0 / 1.3 s | 19.3 s (laptop starved: DT-238) | 1.0 / 3.1 s | 1.0 / 1.7 s |
| Worker turn p99 / max | 77 / 341 ms | 74 / 313 | 240 / 655 | 82 / 440 | 69 / 403 |
| Main turn p99 / max | 26 / 311 ms | 21 / 239 | 24 / 315 | 25 / 262 | 21 / 272 |
| board:replace calls / DB ms (whole run) | 4511 / 8688 | 3454 / 6394 | 3142 / 5370 | 2643 / 4490 | — |
| lateInViewActivations | 22 | 35 | 4 | 3 | — |
| item-90 goal_failed after its answer | 324 | 101 | 31 | 2 | 0 |
| combat.user_info | 14 | 12 | 8 | 0 | 0 |

QUIET's worst worker turns (1.0-1.1 s, `buildForState` → `GearAcquisitionPlanner.sourceFacts` → `LevelingRoutes.isSpotAllowedForState`) run code unchanged since B; B and C have the same chain in their worst turns. The NEW-run lag was CPU starvation of the whole process while agents ran tests (profile sample gaps on both threads; `buildForState` CPU per chunk 4512 vs C 4506 samples).

QUIET2 also shows: party_progress opens 950 with 0 opened without a build (QUIET 1411 / 628; B 1030 / 186), joins 84 (B 66); offer-only build wakes keep their answer 70 % (QUIET 55 %), hunt-spot moves after an offer 61 (QUIET 75), shopping answers after an offer convert to a done goal 67 % (QUIET 65 %); crystals bought then re-listed by 1 of 9 bulk buyers (QUIET 3 of 6). **Not fixed:** a crystal/shot re-take loop of another shape (2000465: `stock:shots:item:1785` ↔ a selling step, 92 goal_failed in ~2.5 min, 2.8 M of D crystals) and D-crystal board buying at ~2× release 1's volume (11.3 k units / 55 M vs 5.9 k / 29.7 M) — a verifier found the ping-pong pre-existing (release 1: 178 flips over 83 bots; 1a: 59 over 17) and self-ending, the round-trip a residual of the DT-242 class with its reader unverified; logged as DT-247 and DT-248 rather than fixed blind.

**Found by the runs and handled tonight:** the worker lag (noise, recorder gap → DT-238), DT-239 (party request reopened on every served no-leaf step; ~3× after DT-208), DT-242 (a pre-existing crystal re-buy loop made large by Dion's market depth), DT-243 (DT-208's side effect: 468 bots hold an unfundable top goal), C1 custody (1-2 plan-input sales a run, plans deferred or end-of-run plans: DT-240 in the night report), RA1-1 (latent).

**Release readiness: not yet.** Code-wise every landed change is reviewed and CI-green and the quiet runs show no regression in health, lag or deaths beyond noise. Open before the release: DT-214 (now decided: slice the corridor search), DT-243 (decided: next funded goal), DT-247/DT-248 (crystal/shot ping-pong and round-trip), DT-231 rest, RA1-2/RA3-2/RA3-3, RM-20. The release gates still owed: full CI on the final integration head, the final A/B after code freeze (cold 30 min with player + hot 20 min, sequential, vs 9d6bf579a and 21ef29385), and your decisions in §7.

## 7. Maintainer decisions

Asked and answered this morning (11-11):
1. **DT-214** → slice the corridor search across worker turns, 150 ms per turn (recommended).
2. **DT-243** → while the top goal is unfundable, the build takes the next funded goal (recommended).
3. **RM-32** → closed: the remaining Orc Shaman gap is inside the class spread and C4-like.
4. **DT-202 rest** → accepted, closed.
5. **DT-196 focus rule** → kept (an offer wins only as a buy of the offered item; label it "our choice": DT-249).
6. **problems.md budget** → release-scoped `architecture/findings-1a.md` (16 KB) for review/audit [tail] findings, sorted out at the release boundary; planning.md, git.md and hygiene.js updated; 32 tails moved there.

Nothing else waits on you right now.

## Appendix: lines moved out of problems.md overnight (now in findings-1a.md)

- `DT-225|rm31 review 11-11|11|tests/test_bot_goal_planner.js 65-71 raw walk of stats.money; nativeEconomyPolicyAssertions no length check|the walk would read root ids as rows once a fixture funds a row (none does today: the check is empty); the helper trusts the packet's own row count|read through StatsPacket; assert the packet length from its rows|[tail]`
- `DT-226|dt187 verifier 11-11|8|BotImprovementService enchant improvement_missing_materials|2000204 and 2000895 (6c1455b5e) refused an enchant whose scroll is not in the bag, no warehouse use, no trade: cause not found (single refusals, the bot re-plans)|find how the step saw the scroll|[tail]`
- `DT-236|dt204 verifier 11-11|10|ShoppingState.waitForShoppingMeeting ~322-326 copies cachedState over session.coldLifeState after each meeting|drops quote marks written since the last cache refresh until the next near answer (seconds)|keep the session's marks|[tail]`
- `DT-237|dt204 verifier 11-11|5|trade_meeting_cancelled marks nothing; rememberPriceRefusal cold buyers only (TradeMeetingService.js 531)|a hot bot may pick the same meeting quote again (guess)|one price-refusal memory hot and cold|[tail]`
- `DT-240|run 12962fed3 11-11|3|custody of a deferred plan's inputs|2000439 withdrew item 40 and sold it 59 ms later; the plan holding it was deferred (wish_focus)|decide whether a deferred plan keeps its inputs|[tail]`
