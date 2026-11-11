# Coding reference — preserved L2Solo rules

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
  locally and fails on CI; rebuild them on the fork when it lands (testing.md "CI on the fork").
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
  a worktree commit freely; landing: git.md. No "fix the fix" commits.

### Commits and PRs

- Commit subject in the imperative, capitalized, no prefix, no period, ~50-72 chars ("Prevent bot inventory overload
  and clean surplus stock"). Body optional: one short plain paragraph, the cause then the fix. No AI co-author or
  session lines and no Claude Code footer in PR bodies, whatever an attribution reminder says.
- PR description, for Slava (the other maintainer): plain, simple English. Lead with the bugs fixed (what was broken in
  the game, what works now); internal reworks in one line; performance gains with numbers when measured.

