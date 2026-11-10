# Testing a release with perf.js (from the perf-tooling session, 2026-11-03)

Branch `fork/perf-tooling` @ **39630885** (merge this one; earlier heads 7ed5f0d6, b5162eb9). 39630885 adds always-on
recording: PopulationStatus.vitals(), ColdSimulationCoordinator `failures`, ColdCommitQueue `failures.afterCommitErrors`,
[Perf] keepProfilesPerDay; extra merge conflicts in those three files. After merging also run test_cold_commit_queue,
test_cold_simulation_kernel, test_bot_population_policy, test_main_safety_orphans. The hot scenario's player is now a real
Session on a counting socket; hot runs made before 7ed5f0d6 are not comparable with later ones. Checked on the
server: hot --players=2 --route=4 --route-minutes=3 gave 6 teleports, 156 cold->hot (avg 27 ms), 168 hot->cold, no
errors. Earlier note: The route/players part (b5162eb9)
passed its tests but was not yet run on the server.

## Merge into ivan/next-release

Touches: HotActivation, HotPartyLifecycle, PvpEncounterLifecycle, Cooldown (`recordActivation/recordCooldown` take a
`durationMs`); PopulationMetrics (transitions in `snapshot()`); PopulationService.logSummary (one recorder call);
NodeL2 (`LiveRecorder.start()` first, `HotCrowd.start()` where HotBotLoadTest was); BotManager ~343
(`[...MERCHANT_BOTS]`); default.ini (new `[Perf]` section at the end); run-tests.js (7 `test_perf_*` at the top);
package.json (`load:mixed` removed). Expect small conflicts there only.
After merging, one at a time: test_perf_cpu_profile, test_perf_heap_profile, test_perf_live_recorder (~30 s, timing
sensitive), test_perf_report, test_perf_compare, test_perf_hot_crowd, test_bot_population_cooldown_cleanup,
test_floor_aware_activation_policy, test_const_party_session.

## Before / after

- **Run every side from a detached worktree** (`git worktree add --detach <dir> <sha>`, node_modules symlinked). On a
  branch checkout the code identity is local (`RecomputeGeneration`): held builds hold within the process, but no
  restart proof is saved or restored, so its start-up is not comparable with a detached run. Before the identity fix
  (2026-11-04) a branch had no identity at all and rebuilt every held build: the first after-runs from the main
  checkout were invalid.

- Baseline: a release's runs are the next release's "before" on the same save; re-run "before" only when
  the perf tool, the world or the machine changes. World: save `312ebb2e-e9ee-417c-ae0e-5a58f2923b37` (1731 bots,
  avg level 25, made on f22da767).

- Before = the perf-tooling branch itself (9f27b7fa + tool), after = ivan/next-release head + the merge.
- Make the save on the BEFORE code (older schema); the after code migrates it on load. Not the other way round.

1. `export L2NODE_GEODATA_DIR=/Users/iposukhoff/L2Solo/data/Geodata` (worktrees have none).
2. World: save `9deb5cf7-c010-42d9-914a-1aba52e473c4` in `/Users/iposukhoff/L2Solo/tmp/saves` ("perf test world x50,
   681 bots", made at 9f27b7fa; 46 rows still hot after a SIGINT). Or grow one on the before code:
   `node scripts/perf.js prepare --minutes=60` (1700 bots takes hours). `node scripts/perf.js saves` lists them
   (`--saves=/Users/iposukhoff/L2Solo/tmp/saves` from a worktree).
3. Same runs on each side, ~17 min each (5 warm-up + 10 window + boot/stop):
   - `node scripts/perf.js run --save=<id> --scenario=cold` (twice)
   - `node scripts/perf.js run --save=<id> --scenario=hot --players=2 --route=4 --route-minutes=3` (twice)
   ~70 min per side; minimum: one cold per side when a comparable run exists, two after a restart-card VERSION bump (CLAUDE.md Perf runs).
4. `node scripts/perf.js compare <before run> <after run>` (folders under `tmp/perf/runs`); cold with cold, hot with hot.

## Reading the numbers

Noise between two runs of the same code: cores and busy share 3-4 %, a function's CPU share < 1 point, long
turns/min 10-16 %, heap at the end 9-16 %, sampled heap growth up to 50 %, the single longest turn 30-90 %.
`compare` marks changes inside these as noise. Trust busy %, cores, CPU by part/function, transitions avg, player wait
p95. For longest turn and memory growth use two or more runs per side.

## Run under caffeinate

Start every run as `caffeinate -dimsu node scripts/perf.js run ...`: on 2026-11-06 the cold worker's profiler starved
(270-420 samples/min vs ~40 000) in an uncaffeinated run and its chunks were useless; the recorder now counts sample-less
stretches and starved chunks (7405feef7), but a starved run still has to be repeated.

## Must not

- `npm test` / `npm run test:geodata` here.
- Two perf runs at once, or a run beside tests, CI or another server (CPU contention spoils both).
- Compare runs with different `--diagnostics` (hot defaults ON, cold OFF; compare says "not comparable").
- `perf.js capture snapshot` on main while measuring (blocks main for seconds, needs ~heap size of memory).
- Read mainElu/workerElu while the recorder is on (the profiler inflates ELU: 0.5 reads 0.8); use busy share.

## Fault accounting at the merge (from the quarantine change on t106dev)

t106dev counts bot faults in the worker (`failures: {workerFaults, faultsByStage, faultBackoff, faultQuarantined}` on
the heartbeat) and main gets only the first fault per (bot, message) plus the quarantine message. When merging
39630885: keep its main-side `this.failures = {workerFaults, faultsByStage, lastFault}`; in the 'fault' case count
there only faults with neither `payload.characterId` nor `payload.partyId` (protocol/size faults; party faults carry `partyId`) and set `lastFault` from every message; delete
its `faultBots` Set (use the worker's faultBackoff + faultQuarantined); in `snapshot()` build ONE `failures` (main
protocol counts + worker counts, merged faultsByStage, lastFault, faultBackoff, faultQuarantined) that `vitals()` and
the status line read. Fold t106dev's `refusals.commandDbErrors` (main command failed on the DB / a pending write, 6e521123) into that
`failures` too. `ColdCommitQueue.failures.afterCommitErrors` stays as is.
- Traced server runs (rates for a step, not perf): `node scripts/run-server.js` on a copy of save 312ebb2e (1731 bots, x50) with `L2NODE_PROGRESSION_RATE=x50` (default.ini is x1; perf.js sets x50 itself, scripts/perf/window.js:59). Runs before 2026-11-07 were x1 on the x50 save: their trip/craft rates are not comparable. Template: scratchpad fxrun2.sh (decisionTrace on, minutes 6-16).
- Traced run, player online: `L2NODE_SHARED_CONFIG_FILE=<ini: [BotPopulation] decisionTrace = true> node scripts/perf.js run --save=312ebb2e-e9ee-417c-ae0e-5a58f2923b37 --scenario=script --script=<idle script> --minutes=<len> --diagnostics --keep-world` (shared ini layer survives perf's server.ini, src/Global.js:165); the player logs in at boot at the script's `place()` (src/Perf/HotCrowd.js), the window ends at --minutes (capture timeout line: harmless). Then `node planning/coverage.js <run>/logs/decision-trace.jsonl --root <tree> --log <run>/server.log`.
- Missing: the idle script (tests/e2e scripts act and end early), ~5 lines: `{ name, players: 1, place() { return TownRespawn.getClosestTown(<town far from crowds>) }, run: () => new Promise(() => {}) }`.
