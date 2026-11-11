# Testing and CI reference

## How much testing

- Per commit: `verify --dev-local` (the brief's tests plus the direct loaders of the changed files, at most 8 non-map
  files; feedback only) when no perf measurement or traced run is on the laptop; a longer list (a normal commit loads
  100-250 tests) goes to the fork as Picked tests or the task's full PR checks; `npm run check`.
- Per landing on the integration branch (a squashed step or a merged branch): full PR checks on the fork, with fresh
  tables if their inputs changed. Topic agents end with targeted tests and counters to watch; the coordinator dispatches full PR checks for each reviewed task SHA and again for the integration head.
- Per batch: the main session runs one traced server for all merged branches (agents do not each run one) and reports
  the step's target rates and rule 14's player rates (town trips per bot-hour and the share that buy and sell nothing,
  deaths, income and EXP per hour, bots stuck, goals completed) and the threads: longest turn of main and the worker,
  worker lag (oldest due step: p50/p99/max, boot and steady) against their limits.md targets; a miss is a defect, not a
  number; a branch runs alone only when its counter regresses. After a batch's review fixes, its perf runs (release.md "Perf runs").
- Coverage: after every traced run `node planning/coverage.js <trace> --root <tree>` prints decision × situation × place
  × mode with the empty cells; each empty cell is closed by a test, a run scenario or an "unchecked" line with the
  reason. A cold traced run has a player online (`tests/e2e/online-player.js`); a hot traced run lasts ≥ 20 min.
- Invariants (checked by every traced run's report and audit; a miss is a release blocker): bots carry shots of their
  weapon's grade and wear a usable weapon; no buy, craft or errand retry loops (failures per bot-hour below a bound);
  no bot stands in town or on lost ground for long; no bot frozen or quarantined; worker lag and turn length inside
  their limits.md targets; spots over room within the release's bound; deaths and EXP/income per hour not worse than
  the released version. A bug once fixed gets its invariant here or a test, so it cannot come back unseen.
- Audit: at release boundary, or on a triggered anomaly, one read-only agent mines the run's DB, logs, trace and profiles for problems nobody
  asked about (not only the batch's metrics): every warning/error kind counted; per-bot outliers (decision rate,
  frozen state, repeating events); progress by level band and class; deaths by cause and spot; economy sanity (adena
  created vs destroyed, runaway or empty wallets, item counts, absurd prices, buy-sell loops); party and clan
  lifecycles; PvP/karma; gear and supplies (unequipped upgrades, no shots, overweight); DB writes and growth, CPU hot
  paths, memory growth; hot vs cold rates. Findings become lc issues (`lc add`) or fix batches, ranked by severity.
- A review-fix round re-runs the server only when its fixes can move the batch's rates; else CI is enough. A fix is
  proven by a test failing on the old code plus CI; a question about a run is answered from its saved DB and trace
  before any new run. One traced run on the release's final head feeds the audit and coverage.
- Before the PR: the final traced runs' coverage over the whole release; its remaining empty cells listed as unchecked
  in the release report.

## Tests on this laptop

- Never root `npm test`, `npm run test:geodata`, broad batches or table generators here. Use Picked CI. `npm run check` per commit (or full CI); dev-local feedback is not commit verification.
- Known local-only failures: `tests/test_saved_games_history_recovery.js` (config/local.ini interferes) and the
  geodata tests in a worktree without geodata; both pass on CI.

## CI on the fork

`sha=$(git rev-parse --short=9 HEAD)`. A run checks the commit, not the working tree: commit only what was asked before
pushing.
- Full tests (`PR checks`, 12 shards, ~9 min): `git push fork HEAD:refs/heads/ci-$sha`, then
  `gh workflow run pr-checks.yml -R posukhoff/L2Solo --ref ci-$sha`. Shard 1 runs `npm run check` first: stale tables
  fail it before its tests run, so a run on stale tables is not green. Do not wait in a CI loop. After a red run re-run
  only the failed files and the tests of what the fixes touch. GitHub sometimes creates fewer than 12 jobs: re-run.
- Picked tests (`.github/workflows/tests.yml`, a push starts it): `git push fork HEAD:refs/heads/tests/$sha/<a,b,c>`
  (x = `tests/test_x.js`); each file runs as in PR checks, 8 files a shard. A long list: a throwaway commit on top with
  `ci-tests.txt` (one name per line, `+name` for optional raw-map tests) pushed to `tests/list-$sha`, never on the work branch. The separate name avoids a ref collision with `tests/$sha/<list>`. This is how a red file is
  re-checked after a fix.
- Bot tables (`.github/workflows/tables.yml`, ~20 min): `git push fork HEAD:refs/heads/tables/<what>/$sha`, `what` =
  `all` | `spot` | `hunt` | `probe`; `gh run download <run-id> -R posukhoff/L2Solo`, copy `spot-table/*.json` →
  `data/Bots/`, `hunt-tables/*.json` → `data/Bots/hunt/`, `node scripts/check-tables.js`, commit. A few spots:
  `tables/pick/$sha/<id,id>[/<class lines>]` (`:` in an id as `@`; `pick-full` for the table's hours): artifact
  `spot-pick`, never copied into `data/`.
- Follow a run: `gh run list -R posukhoff/L2Solo --limit 5`, `gh run watch <run-id> -R posukhoff/L2Solo`; on failure
  `gh run view <run-id> -R posukhoff/L2Solo --log-failed`.

