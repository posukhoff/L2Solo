# Release Coordinator pilot (two-level coordination), release 1a, 2026-11-11

For the auditor: facts and open questions. Policy V5.1 frozen at `da25f2b85`, unchanged. Times are EET (UTC+2).
State file during the pilot: `tmp/release-1a-pilot.md` (local, git-excluded). Status at writing (14:15): step B landed, step A in its run.

## 1. Setup

- Level 1, release coordinator (RC): roadmap, step choice, landing queue, run machines, Git/CI gates. No investigation or review.
- Level 2, step coordinator (SC): one step, own worktree and V5.1 slug. Starts fresh verifier / implementer / reviewer
  sub-agents (Claude Code nested sub-agents, version 2.1.319: they work). Returns ≤150 words + handles. Never lands.
- Integration: fork `ivan/batch-1a`, base `95a12356b`. Nothing pushed to origin, no PR.
- Steps chosen (independent owners, different size): A = DT-247 + DT-248 (spare units in the bag, economy, critical);
  B = RA1-2 ("no spot" handled four ways, one path through `Situations.spotAsk`, critical). DT-231 and RA3-2 conflict with
  A/B; RA3-3 and DT-238 judged too small for an SC (direct implementer, not started).

## 2. Outcome per step

| Step | Result | Evidence |
|---|---|---|
| B, attempt 1 | Closed BLOCKED after 3 review rounds: the change was correct by review and CI, but the hot run showed a command loop | run `20261111-111313-0982` (95a12356b vs 7f11fd415): hot-bot commands 3,610 → 31,617; commands per cold bot-hour 14.2 → 55.1; jump at ~12 min when hot bots cool |
| B2 (fresh SC) | **Landed** `0c759221c` (fork `ivan/batch-1a` 95a12356b → 0c759221c, ff, `record-land`) | cause: a closed clan waiter released on every step: `release` deleted `equipmentPlan`, the stats merge (BotLifeState.js:2847) restored it, `released()` (ClanPartyDuty.js:46) stayed true; the deleted 30 s rest had hidden it. Run `0c759221c-hot-20261111-113103`: commands 3,610 / 31,617 / 3,446 (base / attempt 1 / new), per cold bot-hour 14.2 / 55.1 / 13.3, party_wait 8 / 143 / 10, decisions within 5 %. PR 43011558140, Picked 43011567027 |
| A, head 1 (`ea5af89c1`) | Not accepted by RC: DT-247 fixed, DT-248 worse | run `dt247-new-ea5a` vs `dt247-base-0825`: sale refused ≤2 s after its build 161 → 129, worst bot 6 → 2; round trips (units sold ≤30 min after own purchase) 993 → 5,804, share of purchases 4.7 % → 15.6 %, Soul Ore bought 8,889 → 26,833 |
| A, head 2 (`e78ad210f`) | Review + CI green, run in progress; then rebase onto 0c759221c, scoped re-review + CI (shared test file `tests/test_bot_afk_buy_shop.js`) | causes: regression of head 1 (craft hold covered only the selected root; bot 2001159 re-bought 11,848 Soul Ore) + base (hold dropped when a tier filter removed a live wish; bot 2000764). PR 43011949869, Picked 43011959895 |

Quality gates: none skipped. Both regressions were caught **before landing**, both only by a traced run (tests and
reviews passed). Root causes were found at the owner (no guard), as the user required for DT-248.

## 3. Time

Timeline: start 10:22 (both SCs). First landing 13:59 (B2), 3 h 37 min. A expected ~15:10.

| Line | Elapsed | Agent work (cause, code, review, CI) | Runs on the critical path | Waiting for a run machine |
|---|---|---|---|---|
| B → B2 | 10:22-13:59 (217 min) | ~111 min | 106 min (A/B 44, diagnosis 36, check 26) = 49 % | 0 |
| A (to 14:22) | 10:22-14:22 (240 min) | ~126 min | 59 min (37 + 22) | 49 min (22 behind B's run incl. 7 min VPS idle by an RC error; 27 behind B2's run) |

Run machine-minutes: VPS 129 (B A/B 44, A1 37, B2 26, A2 22); laptop 52 (diagnosis 36, a duplicate 16, stopped).
Not needed in hindsight: the diagnosis run (the verifier then reproduced the loop with a harness on save bots in minutes)
and the duplicate laptop run (no laptop base to compare with): 52 machine-minutes, 36 of them on B's critical path.

V5.1 itself (testing.md 29-31, release.md 50) does not require a run per fix: a fix is proven by a test failing on the
old code plus CI; a run question is answered from saved runs first; one traced run on the release's final head is
mandatory; a fix check is "a 15-20 min run or the saved run DBs". Behaviour runs may run up to 3 at once on the laptop
(no local tests); A sides one at a time. The pilot ran a traced check on every step and full 30-min windows at first.

## 4. Tokens

`reports/tools/token-usage.py` (da25f2b85), input-equivalent weights 1 / 1.25 / 0.1 / 5, 10:00-14:10, three agents of the
previous session excluded (a32c28512, ac630a999, adb7c98ea). Roles by the first word of each prompt.

| Level | Transcripts | Messages | Input-equivalent | Share |
|---|---|---|---|---|
| Release coordinator | 1 | 119 | 2.06 M | 7.3 % |
| Step coordinators | 3 (A 3.80 M / 120 msg; B 3.06 M / 116; B2 1.12 M / 60) | 296 | 7.99 M | 28.2 % |
| Verifiers | 9 | 462 | 8.48 M | 30.0 % |
| Implementers | 9 (5 on Sonnet) | 354 | 6.94 M | 24.5 % |
| Reviewers | 8 | 197 | 2.83 M | 10.0 % |
| Total | | | 28.3 M | |

- Coordination share 35.5 % vs the V5.1 night 36 % (coordinator 28.1 M of 77.2 M). **The RC's saving was almost fully
  offset by the step coordinators.** RC average context ~125 k per message vs the night coordinator's median ~460 k.
- Per step: ~14 M per step so far vs ~2.9 M per item at night (77.2 M / 27 items). Not comparable as is: the night items
  were smaller and had no per-item traced runs; both pilot steps were critical and each needed a second cause round.
- SC cost drivers seen: Opus with 100-200 k context, resumed 4-6 times each (every resume re-reads the context);
  A computed run counters itself (verifier work); waiting for CI/runs inside the SC context.

## 5. Problems found (for the auditor to rank)

1. **Coordination cost not reduced** (§4): RC 7 % + SC 28 % ≈ night coordinator 36 %.
2. **Runs dominate wall time** (§3): 49 % of B's line; A waited 49 min for a machine on top of 59 min of runs.
3. **Shared resources delegated to SCs at first**: B ran an unreviewed head on the VPS while A queued behind it.
   Changed: RC assigns run machines, only reviewed heads.
4. **RC operational errors**: a launcher loop that would have relaunched a job forever (stopped before effect);
   `~/perf/tracejob.sh` not executable on the VPS → launches silently did nothing, VPS idle 7 min undetected;
   laptop idle while both steps queued for the VPS; then a duplicate laptop run (stopped). 
5. **File-lock rule cost more than it saved**: B2 stopped for an approval on a file nobody else touched; A edited two
   files from B's list anyway without conflict. Removed (owners are separated at step choice; overlaps are found at
   landing by `git diff --name-only` and paid by the V5.1 rebase rule).
6. **SCs did verifier work and polled** (counted runs, waited in context). Changed by rule, effect not yet measured.
7. **V5.1 gaps seen (not changed, frozen)**: no CLI record for a traced run (both SCs noted it; run evidence lives only
   in reports and the state file); a shared test file forces a full scoped re-review after rebase.
8. **Not verified by RC**: whether SCs ran `planning/coverage.js` and the invariant checks after each traced run
   (testing.md 15-18).
9. Noise: completion notices of three agents from the previous session arrived in this session.

## 6. Rules adopted during the pilot (user-confirmed; for the auditor to keep or drop)

1. SC orchestrates only: no counting / trace / SQL analysis (verifier), no polling (one background wait command).
2. An SC only when a step expects > 3 sub-agents; otherwise RC starts implementer / verifier / reviewer directly.
3. RC checks `git diff --name-only base..head` before landing (overlap detector).
4. Run machines (VPS and laptop) are assigned by RC, only to reviewed heads.
5. No file locks between steps; an SC reports only when its change rebuilds an owner another running step rebuilds.
6. A step waiting for one machine while the other is idle is a scheduling miss.
7. Runs: one per step against a saved base, window 15 min (player script) / 20 min (hot); diagnosis runs only when a
   harness script on the save cannot reproduce; one machine per step. Final release A/B unchanged.

Proposed, not adopted: no comparison run per bug. A bug is proven by a failing-old-code test + CI; a run only when the
change moves rates (market, command flow, spot spread), against a saved base; one traced run per batch on the
`batch-1a` head after several landings (both pilot regressions were large and would show there; the trace names the
step). Cost: a regression found after landing is fixed forward or reverted on the fork branch.

## 7. Open questions for the auditor

- Keep the second level at all, only for large steps (rule 2), or run steps directly from RC with fresh agents?
- SC on a cheaper model, given it only orchestrates (rule 1)?
- Per-bug runs vs one batch run (proposal above), within V5.1 testing.md 29-31.
- A run-record command and a coverage/invariant receipt in the CLI (a V6 item; V5.1 untouched).

## 8. Where things are

- Fork `ivan/batch-1a` = `0c759221c`. Branches: `ivan/dt247` (A), `ivan/ra12b` (landed), `ivan/ra12` (attempt 1, evidence).
- Pending planning edits (RC, after A): RA1-2 closed; DT-247/248 per result; new problems: BackgroundResolver.js:2744
  60 s no-spot wait needs a limits.md row (missing event: end of the SpotRiskPolicy mark); ColdSimulationKernel ~1690
  30 s placeholder; luxury_exchange steps without a route; dead fallbacks PopulationService.js:2629/:2752; map text
  `commandSpot` (population.md:81, bot-ai.md:36); limits.md row CRAFT_HOLD_ROOTS = 4 (`craft_hold:dropped`);
  economy.md craft hold; DT-144; bots 2000599 (root switch ~1.5 s) and 2000229 (D crystal re-buy loop), base behaviour.
- Remaining 1a: DT-231, RA3-2, RA3-3, DT-238, RM-20; full CI on the final head; final A/B (cold 30 + player, hot 20) vs
  9d6bf579a and 21ef29385, save d2f4aa5d.
