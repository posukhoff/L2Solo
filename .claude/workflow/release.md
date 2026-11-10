# Releases, performance and diagnostics

## Releases

- Small releases every few days; a release is a numbered theme of `roadmap.md`, a priority queue, not a promise: take
  from the top while there is time, the rest rolls over. A finding goes into the queue at its urgency (what breaks the
  server or blocks the release goes to the top).
- One kind per release (maintainer 2026-11-09, after release 1 mixed everything and broke things it had fixed): a
  release is bug fixes, or optimization, or one architecture step (one mechanism moved to its owner), or one gameplay
  feature, never several at once, so a regression points at its release. An architecture step changes one mechanism
  and keeps behaviour (the A/B shows no player-visible change), its behaviour changes come in their own release. Bugs
  are still fixed in the rule's owner with a test of what the player sees, never as a call-site patch: small releases
  on a dirty codebase otherwise turn into endless symptom fixing.
- Scope closes after the release's final traced run: from then on only fixes of what the runs and the A/B show.
  Code freezes before the final A/B: a change landing after it repeats the A/B, so everything else waits for the next
  release (maintainer 2026-11-10: most of a day went to re-running after late fixes).
- When a release's changes are done: full CI on the release head; the world test: an A/B against the version
  players have (the late save, same flags, cold with a player online 30 min and hot 20 min, each side alone on the
  laptop; the early save adds nothing; the party case is its e2e scenario, not an A/B), thresholds: EXP and income
  per bot-hour not below −10 %, no bots stuck (no progress all run, no visible loop), deaths not below; checks of the
  release's behaviours in logs and the DB; my in-game check (the client is on my other laptop); fix what broke, refresh
  the map, then the PR.
- Map refresh before the PR: `node planning/architecture/check.js` (after the release commits land on
  `ivan/next-release`) lists map names gone from the code; one agent updates the touched entries from each file's
  "Checked at" sha, deletes paid problem lines, updates limits.md, fixes what check.js lists and sets "Checked at"
  to the release head.
- Architecture passes: after every develop update merged in, one read-only agent reviews that diff against these rules
  and the map (parallel paths, call-site patches, a rule with two owners, a decision on the wrong thread, limits,
  silent failures, C4); findings go to problems.md and are fixed by porting (Git). Whole-code passes rotate, 2-3 categories per
  release (dead branches, dormant, fields, logic, silent failures, step cost, purity, client, races, tests, tables,
  data vs C4), near the release's end; last run per category in the map's README.

## Perf runs

- Measured with `scripts/perf.js`, recipe and baseline save in `planning/perf-tooling/test-recipe.md`; reason the cost
  with numbers first (counts per step, bytes per row).
- `tmp/perf/runs` keeps the last release's end (`BASELINE_RUNS` in `planning/hygiene.js`) and the newest measurement;
  hygiene lists the rest for deletion (an A/B side still needed moves to the scratchpad first). A release's runs are the
  next release's "before"; re-run a "before" only when the perf tool, the world or the machine changed. Per side one
  cold run when a comparable run exists (two after a restart-card VERSION bump); a second only when the numbers sit
  inside the noise or the longest turn / memory growth decide something; a hot run only when the hot path changed
  (players, near bots, packets) or a hot case is checked, and always in the release A/B.
- A run starts from a detached worktree, never a branch checkout (restart proof and start-up comparable); its folder
  lands in the worktree's `tmp/perf/runs`: copy it to the main checkout's right after. A detached worktree (perf side,
  merge, squash) is removed when its job is done.
- A perf measurement (timings, memory: one cold + one hot per release, or a fix that claims speed) runs alone: no
  other agent, test or server on this laptop. Behaviour runs (trace, audit, a fix check) need no exclusivity: up
  to 3 at once beside read-only and fork-CI work, no local tests. A run checks in its first minutes that it is what was
  asked (trace file present, diagnostics on, world kept) and stops otherwise. A fix is checked by a 15-20 min run or
  the saved run DBs; full-length runs only for the final A/B. Parallel runs hold only while each worker keeps up (`cold due max` near 0): an
  older version's worker is saturated alone, so A sides and the final A/B run one at a time (2026-11-10: three A sides
  in parallel starved to 1000 overdue bots and read −40 % EXP).
- zsh does not split an unquoted variable: pass perf arguments as an array (`P=(--save=… --saves=…)`, then
  `node scripts/perf.js run $P …`).

## Looking at what bots do (local servers)

- `[BotPopulation] developerDiagnostics = true` in `config/local.ini` turns on developer counters, timings and detail.
  `decisionTrace = true` (same section, off by default) writes the decision trace; `node scripts/trace.js --bot <id>`
  reads one bot's.
- `scripts/perf.js` passes its own `server.ini` as `L2NODE_CONFIG_FILE`, which skips `config/local.ini`: a perf run gets
  `decisionTrace` through `L2NODE_SHARED_CONFIG_FILE=<an ini>` (the trace lands in the run folder's `logs/`).
- Runs with different diagnostics are not comparable in perf.

