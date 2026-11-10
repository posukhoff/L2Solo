# L2Solo — Claude Code, this machine

Rules for this repository, git-excluded (local only). Agents in a worktree read this file at
/Users/iposukhoff/L2Solo/CLAUDE.md.

# Part 1 — coding rules

Lineage II Chronicle 4 server emulator (a NodeL2 fork) for a solo MMO: the world is populated by bots, simulated
"hot" near the player (main thread) and "cold" elsewhere (a worker thread). Node.js >= 22.5, CommonJS, SQLite, no
build step. The rules bind every agent and change, whoever wrote the code (Slava's merged code included).

The map of what exists, who owns each rule and which path is canonical: `planning/architecture/` (start with
`README.md`; read the area you touch before changing it). `planning/` is ours only and git-excluded: it lives in the
main checkout, /Users/iposukhoff/L2Solo/planning; a worktree has none, so agents read (and, as its one writer, edit) it
there by absolute path and
run `node planning/*.js` from there with `--root <worktree>`. It holds open work only: a finished plan, audit or
report is deleted when the work is done; no "done" sections, no PR texts after the PR merges.

### Hard rules (every change; a review answers each one for the diff)

Each as the question a review asks; detail in the sections after.
0. Need: for each added piece of code, state, message, special case or test: what breaks for a player or the server
   without it (a number or a concrete case)? Nothing observable → do not add it. Of two correct fixes take the cheaper
   per bot per step, then the one adding less mechanism (state, paths, special cases; not fewer lines); deleting is a
   fix. A gain too small to see (a few builds per hour) does not buy a new mechanism.
1. One question: does each decision touched answer one question and own its output? Is every situation a physical fact
   (no prices, board, clock or another decision's answer inside it)?
2. Situations, not time: is a decision taken only at its named situations and held between them? Any new window, timer
   or "again after N s"? (Only for a situation with no event yet: reason + limits.md row + the missing event as a
   problems.md line.)
3. Owner: is the fix in the mechanism that owns the rule, not a guard, special case or retry at the call site?
4. One path: does it add a second mechanism for something that exists? Every copy of the concept is listed (search
   terms and hits, hot and cold); the change merges them or names each one left as a problems.md line. Is the replaced
   path deleted in the same change, with its tests and config keys?
5. Hot = cold: do hot and cold call one function for the rule?
6. Cost: what does it add per bot per step (CPU, allocations, DB writes, worker messages), on main or the worker? Any
   per-tick scan over all bots, or main rebuilding what the worker published? Can one turn of main or the worker run
   long (a loop over bots or a whole decision in one go)? Work is sliced so no turn blocks the thread (targets:
   limits.md "Turn length" and "Worker lag"); a plan names its longest turn, a review checks the yield points.
7. Caches: is each cache key exactly the result's named inputs?
8. Failures: is every survived failure counted via `FailureLog`, every decision and lifecycle end traced, every limit
   a limits.md row with an observable hit?
9. Purity: are rules pure functions of plain data (no World/DB, seeded rolls); does worker code avoid World?
10. Data: named fields across modules, the worker boundary and storage; state objects replaced, not edited in place?
11. Tests: do they pin behaviour a player or the world sees, not internals, and fail on the old code?
12. C4: does behaviour follow C4 (source named when chosen), or say it is our choice?
13. Text: do comments state the rule (never cite `planning/`); does the map follow the change; are commits free of AI
    co-author/session lines? (`node planning/rules-check.js <base>..<head> --root <tree>`: the mechanical part.)
14. Trade: one line per change: its cost, what a C4 player does here, what it gives up (simulation, realism,
    performance). A review asks "would a player do this?" as it asks the cost.
15. Direction: toward the target architecture (below), neutral, or away? Away only with its reason, a problems.md line
    and the named replacement; a review counts it like a violation otherwise.

### Target architecture (where every change heads)

- A decision is taken on the worker at its named situations and held; main executes and reads the published answer,
  never decides for a cold bot or rebuilds a worker answer. A hot bot is a body: it posts facts and executes.
- One owner per rule: one function that hot and cold, main and worker call.
- A bot's state has one writer: the worker's commit (main's writes only for a hot body or a player act, through the
  owner); data crosses threads and storage as named messages.
- Cold simulation heads to owned components and a typed core (plan.md); new state is shaped for it, not added to the
  stats blob without an owner. Bot memory: one owner per topic, lifetimes by named situations, not ms or steps (rule 2's
  exception applies the same way).
- Contested resources (spots now) go by competition at the resource, not by an omniscient filter at choice (plan.md).
- Each map file names its area's target and its gaps (problems.md ids).

### Performance is a primary criterion

The server targets ~1700 bots today on modest hardware; the goal is 5-10k. Every decision weighs CPU, memory and DB
writes as much as behaviour:
- Reuse a computed result instead of recomputing; no work on the main thread that the worker can do.
- A bot decides the way a C4 player does: rarely and by situation. A decision (where to hunt, what to wish for or buy,
  a workshop, a party, an action plan) is taken at the situations a player takes it at (arrived at a spot, a new gear
  grade, new gear, death, a crowded spot, invited, a stock run low) and held until the next one; between them the bot
  carries out the plan. Its other inputs (prices, money, bag counts) are read when it decides and do not wake it. One
  mechanism holds and wakes every decision: owners (combat, market, town, party) raise named situations in one place,
  each decision only declares which wake it; no decision keeps its own wake logic.
- A bot knows what a player would know: its own sight, what it heard (town, clan, friends) and its own experience;
  never a live count of the world (a spot's crowd is seen at arrival).
- One question per decision (rule 1): "leave the field now?" and "what to sell, to whom" are two decisions; a
  situation that reads prices, the board or the clock is a decision in disguise. Before a decision is moved or
  rewritten, write its one question, output, decision-time reads and wakes; split fused questions first.
- A cached result of a pure calculation (damage, a price, a route, a table read) names its inputs (a comment at the
  key) and its key is exactly those inputs: a finer key throws work away (an object identity, `updatedAt`, a raw
  activity string, an exact MP value), a coarser one serves a stale answer. It is recomputed when an input changes.
- A change for speed that claims the same behaviour proves it: it lists the inputs it relies on and a test pins the
  same result, also after an input changes. Otherwise it says what goes stale and by how much.
- A player can be online all the time. No work waits for an idle server: maintenance, cleanup and repairs run with a
  player online within a stall budget (a limits.md row); only what cannot (e.g. VACUUM) runs at boot or shutdown.
- Game rules are pure functions of plain data (no World or DB inside a rule; worker code gets lookups passed in),
  deterministic (seeded rolls), crossing the worker boundary as explicit plain messages. Per-bot state and per-step
  work grow only with need: they multiply with the population.

### Architecture debt: do not add to it

The code has parallel paths for one rule, leftover old paths and half-done unifications (AI-written, patched where a
symptom showed). The direction is one mechanism per rule.

- The current code is not the spec: it has bugs, and existing behaviour and tests may encode one. When two paths
  disagree, the answer is what C4 does (or the stated design), not whichever path exists; say which and why. A test
  that pins a wrong behaviour is fixed with the code.
- Before a fix, find who owns the rule (the mechanism that decides it, not the spot where the symptom shows) and every
  copy of the concept (by concept, not by name: "where does the bot stand" had four), and fix it there once, never by
  a special case, guard or retry at the call site. If several paths compete, say so and keep the one C4 or the plan names.
- No new parallel mechanism: search for an existing helper, cache, planner, carrier or rule first and reuse or extend it.
- Data that crosses a module, the worker boundary or storage has named fields, or one owner of its layout with named
  readers and writers; positional slots (`money[2]`) and sentinel values (`-1`) live only inside that owner.
- A bot state object is replaced, not edited in place; code that must edit one owns it, and no cache keyed by object
  identity reads it while it changes.
- Tails found but not fixed (duplicate path, dead code, half-migration): a problems.md line, not a fix inside an
  unrelated change.
- Code merged from another branch that breaks these rules is rewritten to them in its own commit that says what it
  brings in line and why (the merge commit stays a plain merge).

### Code

- `require('../src/Global')` sets globals: `invoke('GameServer/...')` loads a module from `src/`, also `utils`,
  `options`, `path`. Use them as neighbouring code does.
- 4-space indent, `'use strict'`, ESLint `eslint:recommended`. Match the density and style of the surrounding code.
- Comments explain the game rule or the reason, not the code. They never cite `planning/` (sections, step plans,
  decision or problem ids, step numbers): it is local only and the other maintainer has none. "Temporary" names what
  replaces it in plain words. No blanket JSDoc: a module that owns a rule gets a short header (what it owns, who calls
  it: hot, cold, worker); data shapes only at boundaries easy to get wrong (worker <-> main messages, the
  `bot_life_state` row, `ColdEconomyPlan` plans).
- Game behaviour follows C4. References: L2J Lisvus and L2J Mobius C4 (rules, formulas), https://l2hub.info/ (data).
  When they disagree, say which is used. When behaviour is our choice, say so.
- Data under `data/` produced by a `scripts/generate-*` script: change the generator and regenerate, never edit the
  JSON by hand. After changing items, mobs, skills or spawns, run `npm run generate:knowledge-base`.
- Bot tables (`data/Bots/spot-table.json`, `spot-reward-npcs.json`, `hunt/*`) are simulated by real code and carry a
  fingerprint of their input files (`TableFingerprint`; inputs: `planning/architecture/tables.md` "When to rebuild",
  comments included). A change to an input makes them stale (say so in the commit message): `npm run check` warns
  locally and fails on CI; rebuild them on the fork when it lands (Part 2, CI).
- Limits (caps, budgets, page/byte sizes, pool sizes, timeouts) live in `planning/architecture/limits.md`; a new or
  changed limit gets a row, and hitting it must be observable (a counted reason, not a silent drop).
- A survived failure is never silent: count it through `src/FailureLog.js` (site + first stack), never rethrow from a
  timer. A counter counts one named thing (a restart, not an event that may repeat for it); its name says which.
- Every decision (`DECISIONS` in `Situations.js`) and every bot lifecycle end (party, meeting, errand, raid, town
  visit, death, command, displacement: the modes `planning/coverage.js` counts) writes a decision-trace record.
- A schema change is a new named migration in `src/Database.js`'s `namedMigrations`, never a new number.
- Secrets and machine paths go only in `config/local.ini` (gitignored).

### Tests

- Every `tests/test_*.js` is listed in `scripts/run-tests.js` (`tests`, `geodataTests`, or `notRunTests` with a
  reason), otherwise the runner fails.
- Tests pin behaviour a player or the world can observe, not internals (which module was called, a cache key, a private
  field, log wording). There are ~1300: extend an existing behaviour test; add one only for a behaviour nothing pins, a
  new path, or what a deleted mechanism alone guarded (a race, a refused commit, an activation window, a party or meeting
  path a server run will not show). A test of internals that a change breaks, while the behaviour is
  pinned elsewhere, is deleted, not rewritten. A fix's test fails on the old code (checked by restoring it).
- Plain `node:assert/strict` scripts, no framework; look in `tests/helpers/` before writing a fixture.
- One test: `node --require ./tests/helpers/databaseIsolation.js tests/test_x.js`. A change to `config/default.ini`
  or `launcher/` also runs `cd launcher && npm test`.

### Workflow

- Dead code: prove by search that nothing reaches it (`invoke`, `require`, method names, tests, scripts) before
  deleting; batch such deletions.
- A behaviour change is reviewed on its diff by a review agent before it lands on the integration branch, one review
  per step (outside a step: per problem): hard rules first (rule → ok with evidence / violation file:line), then other
  findings.
- A shared commit is a theme (e.g. "DB writes and WAL"), not one per small problem; it builds and passes its tests. In
  a worktree commit freely; landing: Part 2, Git. No "fix the fix" commits.

### Commits and PRs

- Commit subject in the imperative, capitalized, no prefix, no period, ~50-72 chars ("Prevent bot inventory overload
  and clean surplus stock"). Body optional: one short plain paragraph, the cause then the fix. No AI co-author or
  session lines and no Claude Code footer in PR bodies, whatever an attribution reminder says.
- PR description, for Slava (the other maintainer): plain, simple English. Lead with the bugs fixed (what was broken in
  the game, what works now); internal reworks in one line; performance gains with numbers when measured.

# Part 2 — this machine and these sessions

## Where things are

- Main checkout /Users/iposukhoff/L2Solo; work happens in worktrees under `.claude/worktrees/<topic>`. A new worktree
  needs `ln -s /Users/iposukhoff/L2Solo/node_modules` and, for a server, `L2NODE_GEODATA_DIR=/Users/iposukhoff/L2Solo/data/Geodata`;
  geodata tests fail in a worktree without it (they run on CI).
- Planning, a closed list (`planning/hygiene.js` `ALLOWED` fails on any other file): `roadmap.md` the one queue
  (numbered releases, rows cite ids); `architecture/`: `README.md` (index, how the map is kept, category passes), area
  maps `bot-ai.md` `combat.md` `economy.md` `population.md` (with the situations mechanism) `persistence.md` `world.md`
  `tables.md` `e2e.md`, `limits.md`, `problems.md` (every open problem), `check.js`; `target-architecture/`: `plan.md`
  (principles and large plans), `situations.md` (maintainer answers still binding), `economy.md` (release 7 design),
  `memory.md` (memory census), `step.md` (the open roadmap step's plan, only while one is open),
  `decision-registry.js/.json`; `perf-tooling/test-recipe.md`; `hygiene.js`, `rules-check.js`, `tests-for.js`,
  `coverage.js`.
- Fix-batch plans, review notes, simulations and run copies live in the session scratchpad, never in the repo or planning/.
- Auto memory (`~/.claude/projects/-Users-iposukhoff-L2Solo/memory/`): facts outside the repo only (e.g. the team VPS).

## Git

- `origin` = `pmbstyle/L2Solo` (shared, I have push), `fork` = `posukhoff/L2Solo` (my staging area and CI runner).
- `ivan/next-release` is the release branch: finished work goes to `origin` only by a PR from it into `develop`; only
  a fix for the released game goes into `main`. The integration branch of the release being built is
  `ivan/batch-<n>` or the landing branch the session names (local + fork); a worktree branch lands on it as one commit
  per step, squashed by the main session (`git merge --squash`), never a merge commit or the agent's commit series.
- No regroup (maintainer 2026-11-10): the integration branch's commits go to `ivan/next-release` as they are, so each
  lands in its final form: one per step or bug, review fixes and their tests folded in before it is pushed, a message
  that says what changed in the game. A fix found after the push is its own commit naming the bug it fixes, never "fix
  the fix", test-only or WIP commits. Standing ask: push `ivan/next-release` to `origin` when release commits or a
  develop update land on it (fast-forward, never force; a pushed commit is never reworded). Never push anything else to
  `origin` (the prune script's deletions excepted; `ivan/perf-remote` stays there, unmerged by my choice), open a PR or
  merge without my explicit ask.
- Pushing the integration/work branch and `ci-*` / `tests/*` / `tables/*` branches to `fork` is allowed without asking,
  never with force (a force push of a rebased integration branch to the fork only with my ok).
- Before a session's work: `git fetch --multiple fork origin` (I may have pushed from another machine).
- At each task boundary (a task finished, before the next roadmap item, before a PR): `git fetch origin`;
  `git log ivan/next-release..origin/develop` non-empty = Slava's work landed. Then: fast-forward or merge develop into
  `ivan/next-release` in a scratch worktree, the Picked tests of `tests-for.js` on the merge diff, the architecture pass
  on that diff (Releases), push it; then merge it into the integration branch (the only merge commit there): conflicts keep both
  intents; where Slava fixed code we rewrote, port his fix's intent into our code with a test of what the player sees.
- Branch hygiene: after a PR merges and after each CI round `.claude/prune-branches.sh` (deletes the fork's finished
  `ci-*`/`tests/*`/`tables/*`, fork branches already in `origin/develop` except main/ivan/next-release/perf-tooling, and
  merged `ivan/*` in origin; `--dry-run` lists). Never touch other people's branches in origin.
- Never bare `git stash` (shared across worktrees); set work aside with a WIP commit.
- Push failures `Permission denied (publickey)` while `ssh-add -l` lists the key: `GIT_SSH_COMMAND="ssh -o
  IdentitiesOnly=yes -i ~/.ssh/id_ed25519"`; `.claude/gpush.sh <push args>` does that with retries.

## Problems, plans and the roadmap

- One problem = one line in `architecture/problems.md`, whatever found it: id | origin | rule | file:line | what is
  wrong → impact | fix | tag. A problem already there gets the new finder's id merged into its line. Other files cite
  the id, never copy the evidence. At the next task boundary each new line is tagged `[rN]` (a roadmap row of release N
  cites it), `[large]` (its own plan) or `[tail]` (small, here only). At each release boundary a `[tail]` whose origin
  date is two releases old moves to a roadmap row (`[rN]`) or is deleted with its reason (rule 0: not worth its cost);
  problems.md stays within its budget this way, not by a bigger one (maintainer 2026-11-10).
- One queue: `roadmap.md`, numbered releases; a row is a label plus ids or a plan file. Done means gone everywhere: the
  commit that finishes an item deletes its row and its problem lines; obsolete ones go with the reason.
- A roadmap step's plan lives in `target-architecture/step.md` and is deleted when the step lands; its binding
  decisions move first into the map, one clause on the row of the rule each shapes. Maintainer decisions taken outside
  a step go on the problem's line or the plan.md principle they shape.
- The map holds the current state only: an area line is rewritten to the new state, a paid problem's line is deleted;
  no history, no "was/now", no step or decision ids.
- One writer: only one agent at a time edits planning/ (the only editing agent, or the main session). Agents running in
  parallel put their planning edits (problem lines, map clauses, limits rows) in their report; the main session applies
  them. A file over budget is pruned (done items, history, detail to its owner), not given a bigger budget without my
  ok, never squeezed by dropping words.
- No unbounded growth: `node planning/hygiene.js` at every task boundary (exit 1 = prune first). It fails on a file
  outside the list or over its KB budget and on CLAUDE.md over 40 KB, lists stale worktrees, stray files and perf runs
  beyond the kept sets; `--remove` removes clean merged or stale worktrees (branches stay). A new planning file only
  with my ok (added to the list here and to `ALLOWED`).
- Planning files are for agents, not for me: I read reports in chat, never these files. Dense: one item per line, no
  hard wraps or blank lines, no headings or prose for a human reader, file:line instead of description; content stays
  exact (ids, file:line, numbers, reasons), code names in backticks (`check.js` finds stale names by them).
- One file per future release's design (`economy.md` for release 7), options as sections.

## Agents

- Drive the work without waiting for me: take decisions by the recommendation, log each (step file or problem line;
  a parallel agent puts it in its report),
  report at each step and release task; stop and ask only at a fork the plan and rules do not settle (a gameplay fork
  goes to me with your recommendation). Never sit idle: while one lane waits, start what does not depend on it.
- Lanes: the laptop (exclusive for a perf measurement; up to 3 behaviour runs at once), the team VPS (behaviour runs
  only, never perf: a panel world shares it), CI and tables on the fork, read-only agents. Start the longest independent
  job first.
- An editing agent gets its own worktree and branch from the integration head (`git worktree add
  .claude/worktrees/<topic> -b ivan/<topic> <head>`). Editing agents run in parallel only on disjoint files; work on
  overlapping files (the same module, its tests) runs one after another. Read-only agents need no worktree.
- A brief names the plan it works under (the roadmap's release, the step file, `target-architecture/situations.md` for
  the maintainer's answers; the mechanism is population.md "Situations"), carries the paths of this file, the map and the plan, and holds at most 4
  items (plan items or findings) so each gets its cause hunt. The main session checks the brief against the plan for
  contradictions (e.g. a plan step that needs a run vs a brief that forbids a server) before sending it. The agent
  labels each change stays (part of the target) / temporary (the comment and the commit name what replaces it, e.g.
  "temporary: until the town plan owns the sell stop") / throwaway (only when without it something breaks now), and
  names every deviation.
- Reports ≤ 400 words (a brief's own limit wins): what changed with file:line, decisions, problems, the hard-rule line
  (`0 ok, 3 violation file:line …`, rule 0 for every mechanism added) and `rules-check` output. An "ok" needs its evidence: rule 4/5 the concept search and
  its hits, rule 6 the cost in numbers; an answer without it counts as unanswered. Reports to me separate what an agent
  claims from what a review confirmed.
- Fix batches (review findings, pass findings, run bugs) go plan → check → implement → review:
  - a read-only planner writes per finding the cause chain (symptom → mechanism → the rule's owner, the invariant it
    restores), every copy of the concept with search evidence (hot and cold), the fix (keep, delete, the test failing on
    old code), its cost and a hard-rule pre-check; where the toward fix and a quick fix differ, both with costs;
  - a change that moves how bots spread over shared things (spots, market, parties) is first run as an offline
    simulation on real data (the save's population, the real tables and pure code) in the scratchpad, comparing variants
    by numbers (share over capacity, peaks, trips, oscillation, value); the design is picked from those numbers;
  - the main session checks the plan against rules 0, 1, 2, 14 and the brief;
  - the implementer follows it; the review checks diff vs plan and rules, and asks per fix: cause removed or symptom
    hidden?
  - review fixes go to a NEW narrow agent and get a short review too, until a review finds no rule violation. A fix that
    reveals another copy of the same concept means the concept search was incomplete: merge all copies in that fix.
- A plan item (a situation, a wake, a design choice) that fails rule 0, 1, 2 or 14 is dropped or replaced with the
  reason, before or after it is implemented; being decided does not settle it. Before a step is implemented its plan
  (wakes, decisions, commits) is checked against those rules first.
- A review agent's brief says "read /Users/iposukhoff/L2Solo/CLAUDE.md from disk (the copy in your context may be
  older) and answer its hard rules first".
- Review findings are triaged before any fix (fix now / temporary / belongs to step N / reject with reason); rule 0
  first: a fix that costs more than the harm it prevents is rejected (or the feature that caused it removed). A number
  that improves past what the fix explains (a counter dropping to 0) is checked for a hidden cause (a card held forever
  reads as 0 unwoken builds). A finding in
  temporary code that a planned step rewrites goes to that step, not into a second patch of the temporary code.
- Every batch and release report counts its changes toward / neutral / away; a release adds no "away" without my ok.
- Cost of agents: resuming a large agent re-reads its whole transcript; a design-level fix spanning several areas goes
  back to the author, the rest to new narrow agents (the planner's entries, the plan and rules paths), folded into the
  commit they belong to. No work ahead of need (plans for far steps, extra passes).
- The decision registry (`node planning/target-architecture/decision-registry.js --root <worktree>`) runs after each
  commit of the situations work: exit 0 (no unclassified clock/step site), and `--stale` shows the windows a step
  deleted.

## How much testing

- Per commit: the tests that load its changed files (`node planning/tests-for.js <base>..HEAD --root <tree> --depth 0`),
  locally, one file at a time, when no perf measurement or traced run is on the laptop (else as Picked tests on the
  fork); `npm run check`.
- Per landing on the integration branch (a squashed step or a merged branch): full PR checks on the fork, with fresh
  tables if their inputs changed. Parallel fix agents each end with tests and CI and name the counters to watch.
- Per batch: the main session runs one traced server for all merged branches (agents do not each run one) and reports
  the step's target rates and rule 14's player rates (town trips per bot-hour and the share that buy and sell nothing,
  deaths, income and EXP per hour, bots stuck, goals completed) and the threads: longest turn of main and the worker,
  worker lag (oldest due step: p50/p99/max, boot and steady) against their limits.md targets; a miss is a defect, not a
  number; a branch runs alone only when its counter regresses. After a batch's review fixes, its perf runs (Perf runs).
- Coverage: after every traced run `node planning/coverage.js <trace> --root <tree>` prints decision × situation × place
  × mode with the empty cells; each empty cell is closed by a test, a run scenario or an "unchecked" line with the
  reason. A cold traced run has a player online (`tests/e2e/online-player.js`); a hot traced run lasts ≥ 20 min.
- Invariants (checked by every traced run's report and audit; a miss is a release blocker): bots carry shots of their
  weapon's grade and wear a usable weapon; no buy, craft or errand retry loops (failures per bot-hour below a bound);
  no bot stands in town or on lost ground for long; no bot frozen or quarantined; worker lag and turn length inside
  their limits.md targets; spots over room within the release's bound; deaths and EXP/income per hour not worse than
  the released version. A bug once fixed gets its invariant here or a test, so it cannot come back unseen.
- Audit: after every traced run one read-only agent mines the run's DB, logs, trace and profiles for problems nobody
  asked about (not only the batch's metrics): every warning/error kind counted; per-bot outliers (decision rate,
  frozen state, repeating events); progress by level band and class; deaths by cause and spot; economy sanity (adena
  created vs destroyed, runaway or empty wallets, item counts, absurd prices, buy-sell loops); party and clan
  lifecycles; PvP/karma; gear and supplies (unequipped upgrades, no shots, overweight); DB writes and growth, CPU hot
  paths, memory growth; hot vs cold rates. Findings become problems.md lines or fix batches, ranked by severity.
- A review-fix round re-runs the server only when its fixes can move the batch's rates; else CI is enough. A fix is
  proven by a test failing on the old code plus CI; a question about a run is answered from its saved DB and trace
  before any new run. One traced run on the release's final head feeds the audit and coverage.
- Before the PR: the final traced runs' coverage over the whole release; its remaining empty cells listed as unchecked
  in the release report.

## Tests on this laptop

- Never the root `npm test`, `npm run test:geodata` or a broad batch (hours here; bigger sets go to CI as Picked
  tests); no table generator, not even a few spots. Always `npm run check`.
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
  `ci-tests.txt` (one name per line) pushed to `tests/$sha`, never on the work branch. This is how a red file is
  re-checked after a fix.
- Bot tables (`.github/workflows/tables.yml`, ~20 min): `git push fork HEAD:refs/heads/tables/<what>/$sha`, `what` =
  `all` | `spot` | `hunt` | `probe`; `gh run download <run-id> -R posukhoff/L2Solo`, copy `spot-table/*.json` →
  `data/Bots/`, `hunt-tables/*.json` → `data/Bots/hunt/`, `node scripts/check-tables.js`, commit. A few spots:
  `tables/pick/$sha/<id,id>[/<class lines>]` (`:` in an id as `@`; `pick-full` for the table's hours): artifact
  `spot-pick`, never copied into `data/`.
- Follow a run: `gh run list -R posukhoff/L2Solo --limit 5`, `gh run watch <run-id> -R posukhoff/L2Solo`; on failure
  `gh run view <run-id> -R posukhoff/L2Solo --log-failed`.

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
