# workflow-v2 pilot: report for an independent process audit

Date: 2026-11-10. Author: the main Claude Code session (model claude-opus-5-5) that ran release 1a work on L2Solo the same day.
Sources: `fork/ivan/workflow-v2` (ee7d7ba5f) against the local workflow of that day (`fork/ivan/workflow` 00ca843f4 = the local CLAUDE.md, planning/ and .claude/ scripts byte for byte).
Convention: **Fact** = observed in a command output, a file, a CI run or an agent's report with evidence. **Assumption** = my inference. Unavailable metrics are marked `unknown`.

## 1. Adoption

### 1.1 What workflow-v2 changes and the verdict

| Change in v2 | Verdict | Why |
|---|---|---|
| CLAUDE.md cut from 37 KB to a 6.5 KB entry point; Part 1/Part 2 moved verbatim into `.claude/workflow/{coding,git,planning,agents,testing,release}.md` | **Accepted, adapted** | Fact: an independent clause-by-clause comparison found ~150 clauses copied verbatim and only 8 sentences changed. Every agent reads CLAUDE.md; 30 KB less per agent start. Adapted: absolute paths restored (below). |
| Risk routes Fast / Standard / Critical (`routes.md`) | **Accepted, adapted** | Ceremony scales with risk; correctness standard unchanged. Adapted: "how bots spread over shared things (spots, market, parties)" added to the Critical entry, because the old mandatory offline-simulation trigger was not named by any route. |
| Task-evidence CLI `.claude/workflow.js` (start/status/verify/record-review/record-ci/ready) | **Accepted, adapted** | Records base SHA, policy digest, route and evidence per task in Git's common dir. Adapted: four defects fixed (1.2). |
| `prune-branches.sh`: dry-run by default, `--apply` to delete, exact branch+commit run evidence, leased deletion, origin cleanup manual | **Accepted, adapted** | Safer than the old script (which deleted on any run). Adapted: one GitHub query instead of one per branch (1.2). Origin/local cleanup stays manual: a deliberate narrowing, noted. |
| `tests-for.js` `--depth` parsing (`??` and validation) | **Accepted** | Fact: the old `Number(opt('--depth') || 2)` turned `--depth 0` into depth 2, so every "depth 0" selection run this session was really depth 2. |
| `hygiene.js` CLAUDE.md budget 40 → 14 KB | **Accepted, adapted** | Adapted: a 40 KB budget for `.claude/workflow/*.md` together, else the moved 38 KB has no growth bound; comments that cited "CLAUDE.md's list" now cite git.md. |
| Review: "applicable hard rules, others N/A with reason" | **Adapted** | Kept the N/A mechanism but restored "a review answers every rule" (the v2 heading and body contradicted each other). |
| Review brief: "read the pinned CLAUDE.md" | **Adapted** | Restored "from disk, by absolute path" (`.claude/` and CLAUDE.md are git-excluded: a worktree agent cannot find them by relative path) plus the digest check. |
| Cadence: one review per route task, 2 review rounds then stop, planner only when cause/design uncertain, traced batch only if behaviour affected, exploratory audit at release boundary or on anomaly | **Accepted as pilot, flagged** | These are process relaxations, not lost rules; no hard rule, invariant or release gate is removed. The audit cadence change is the one I would watch (section 3). |

### 1.2 Problems found (all fixed in the installed copy unless marked)

CLI (`workflow.js`):
1. **`ready` did not prove the needed tests ran.** `record-ci` accepted any green Picked tests run on the SHA. Fact: Picked run 42900285952 (`tests/347a4e4f9/economy_context`) ran one unrelated test and the original code would record it as evidence for a change whose selection was `test_wish_network.js`. Fixed: Picked tests must list every selected test (from the branch name or the list commit's `ci-tests.txt`); now refused with "did not run the selected tests". PR checks must have all 12 `Node tests (n/12)` shards green (GitHub sometimes creates fewer jobs).
2. **Picked tests via a list commit could never be recorded.** A long list runs on a throwaway child commit adding `ci-tests.txt`, whose SHA ≠ HEAD. Fixed: accepted when the run's commit is a child of HEAD that changes only `ci-tests.txt` (verified with run 42900348343).
3. **Picked tests runs neither `npm run check` nor rules-check**, yet `ready` passed on a Picked run alone. Fixed: `verify --check` records them; `ready` asks for them unless PR checks ran on HEAD.
4. **Domain-regex selection added files the runner refuses** (notRunTests, unlisted names → `--only` exits 2). Fixed: selection filtered to `run-tests.js --list` ∪ `--geodata --list`.
5. Not fixed (documented): the policy digest covers only CLAUDE.md and `.claude/workflow/*.md`, not `workflow.js`, `hygiene.js`, `rules-check.js`, `tests-for.js`; any edit to those docs invalidates every open task record (observed: the CLI test task and the pilot task had to be re-started after a routes.md edit). `status` without `--root` shows the primary checkout's HEAD.
6. Not fixed: domain regexes are broad (`item|gear|shop|...`), so most economy changes select far more than 8 tests and `--local` refuses; in practice everything goes to Picked tests CI (fine, but `--local` is rarely usable).

Instructions:
7. Dangling references after the split: rule 15 "(below)", "detail in the sections after", "Part 2, CI", "Part 2, Git", "(Releases)", "(Perf runs)", "(Git)", "the paths of this file", "added to the list here". All repointed to the file and section.
8. Contradictions: planning.md said CLAUDE.md 40 KB while hygiene.js said 14 KB; git.md "the prune script's deletions excepted" while the new script deletes nothing in origin; "never with force" vs the script's `--force-with-lease` deletion; CLAUDE.md "never push to origin" without naming the standing ask (fast-forward `ivan/next-release`). All reconciled in text.
9. The testing doc's "Picked tests: push to `tests/$sha`" collides with an existing `tests/$sha/<list>` ref (Git cannot hold both); observed as a failed push. Workaround: `tests/list-$sha`. Documented.

Scripts:
10. **`prune-branches.sh` v2 took > 15 minutes for a dry run** (fact: observed in this session) because it calls `gh run list` once per branch and the fork had 460 `ci-*/tests/*/tables/*` branches. Rewritten to one `gh run list --limit 1000` query: 41 s, 346 candidates, same rules (exact branch+commit, all runs completed > 1 day ago, none seen = kept). Fresh branches from this session (`tests/347a4e4f9/*`, `tests/list-347a4e4f9`) were correctly kept.
11. The fork holds 494 branches; the old cadence ("after each CI round") was not followed. Assumption: because the old script needed a manual run and was all-or-nothing.

### 1.3 Old rules restored
- Absolute paths of CLAUDE.md and `.claude/workflow/` for worktree agents (old CLAUDE.md line 3-4).
- Review brief: "read from disk (the copy in your context may be older)" and answer **every** hard rule (old line 286).
- A size bound on the workflow text (old 40 KB budget, now split 14 + 40 KB).
- The offline-simulation trigger for changes that move how bots spread over shared things, made a Critical route entry.
- The standing ask to push `ivan/next-release` named next to the origin ban.

### 1.4 Does `ready` confirm the right tests for the exact SHA?
Original v2: **no** for Picked tests (any green run on the SHA counted, whatever it ran) and **partly** for PR checks (no shard count). Installed version: yes within the selector's scope — the run must be on HEAD (or its `ci-tests.txt` child), completed and green, and Picked tests must include every selected test; PR checks must have 12/12 shards. Remaining limits: the selection itself is heuristic (tests-for depth 2 + domain regex, "not proof of completeness"), and review evidence is a recorded verdict, not an attestation. Verified cases: 42900279168 (right list) accepted, 42900285952 (wrong list) refused, 42900348343 (list commit) accepted, 42893435780 (other SHA) refused, PR checks 42872182422 accepted with `tests: all`.

## 2. Pilot task

**Task:** DT-173 round-1 review fixes (release 1a). Round 1 of the DT-173 review (gatekeeper pocket fix, commit 6aa4f7dc9) found two rule-8 gaps: the town-departure escape and its route failures were not counted, and `walkerRoadStepBacks` counted two different events. CLI slug `dt173-review`.
**Route:** Fast (counters only: no shared decision, data, protocol or performance impact). `verify` agreed (`critical: false`).
**Base SHA:** 6aa4f7dc9d585063779af0351876773491da20e7 (ivan/dt173). **Final task SHA:** 61ee2b18a8c59bf4972c6b55b92db82d9eb3fed3 (two commits: 002500336 the fixes, 61ee2b18a a CI test-stub fix). **Landed:** 66d99ecd1 on ivan/batch-1a (one squashed step commit with 6aa4f7dc9, identical tree), pushed to the fork.
**Policy digest:** c446a98b… (the first record, a37dee25…, was invalidated by a routes.md edit 11 s after `start` and re-created).
**Total:** start 20:56:21 → `ready` true 21:21:34 (25 min) → landed 21:22.

Stages actually run (times UTC, from the session's own log and agent usage lines; coordinator = this session):

| Stage | Wall time | Agents (role) | Model | Tokens | Context read | Tests / results | CI | Review |
|---|---|---|---|---|---|---|---|---|
| start (CLI) | 20:56:21 → 20:56:33 (re-start after digest change) | coordinator | claude-opus-5-5 | unknown (coordinator usage not exposed) | — | — | — | — |
| brief | ~0.5 min | coordinator | same | unknown | the round-1 review report | — | — | — |
| implement | 20:57:10 → 21:03:10 (374 s) | 1 implementer | inherited from coordinator (assumed claude-opus-5-5; not shown per agent) | 92,714 (subagent total) | CLAUDE.md 6.9 KB, routes.md, coding.md (11 KB) by brief; code files unknown | 4 test files pass locally (test_bot_town_travel, test_bot_activation_placement with geodata, test_cold_honest_travel, test_summoned_activation_placement); both new assertions fail on old source (checked); found and fixed a test the base commit broke | — | — |
| verify (CLI) | inside implement | implementer | — | — | — | selection: **606 tests** (PopulationMetrics is widely loaded; domain "population") → too broad for local, goes to CI | — | — |
| verify --check (CLI) | 21:03:40 → 21:07:21 (3 min 41 s) | coordinator | — | — | — | `npm run check` pass (syntax 2782 files, tables fresh); rules-check 0/0 | — | — |
| scoped review, round 2 | 21:03:40 → ~21:05:20 (100 s) | 1 reviewer | inherited (assumed) | 73,862 | CLAUDE.md, routes.md, the diff; `status` digest check | re-ran the 4 tests, and the two changed tests against old sources in a throwaway copy: fail on old, pass on head | — | **pass, 0 findings** (round 2 of 2) |
| full CI #1 | 21:03:40 → 21:10:14 (6.5 min) | — | — | — | — | PR checks, 12 shards: **10/12 green, 2 failed** (`test_clan_alliance_flow`, `test_clan_alliance_travel`: their VM allow-list stubs lacked `DecisionTrace`, which round 1's commit 6aa4f7dc9 added to BotSpotTravel). Both files were in the CLI's 606-test selection; round 1's implementer had used `tests-for --depth 0` (12 tests, really depth 2 because of the parsing bug) and missed them. | run 42901224437 | — |
| CI fix | 21:10:14 → 21:11:45 | coordinator | claude-opus-5-5 | unknown | the 2 failing logs | both tests fail on old stubs, pass on new (local, one file each; one needed `mkdir tmp` in the worktree first) | — | coordinator self-review of a 4-line stub diff, recorded as such (no agent: an agent review would cost ~70 k tokens for 4 lines) |
| full CI #2 | 21:11:45 → 21:18:41 (7 min) | — | — | — | — | PR checks 12/12 green | run 42902635371 | — |
| record-review / record-ci / verify --check / ready (CLI) | 21:18:58 → 21:21:34 | coordinator | — | — | — | `verify --check` again (3.5 min, redundant once PR checks is recorded) | 42902635371 recorded with `tests: all` | ready: **true** |
| land | 21:22 | coordinator | — | — | — | — | — | squash onto ivan/batch-1a, push to fork |

Earlier stages of the same item, run under the old flow before the pilot (for comparison):

| Stage | Wall time | Agents | Tokens | Result |
|---|---|---|---|---|
| investigation (cause hunt with geodata probes) | 946 s | 1 | 224,178 | cause found: closed geodata pocket + recovery key reset |
| implementation | 600 s | 1 | 143,178 | 6aa4f7dc9, 12 selected tests pass locally |
| review round 1 | 221 s | 1 | 101,551 | 2 rule-8 gaps, 1 pre-existing rule-2 gap (limits rows), 1 coverage gap (field pockets) |
| **pilot round (above)** | ~10 min to review pass | 2 | 166,576 | counters added, review pass |

Fixes in the pilot round: 2 planned (the two rule-8 gaps) + 2 unplanned test-stub fixes for breakage from round 1 (one found by the implementer, `test_summoned_activation_placement`; two found only by full PR checks). Review rounds on the item: 2 agent rounds (limit reached; no blocker left) + a coordinator check of the stub-only commit. Agents in the pilot round: 2 (implementer, reviewer); in the whole item: 5. Tokens, pilot round: 166,576 (agents) + coordinator unknown; whole item: 635,483 (agents).
Evidence gap seen while landing: the task record proves 61ee2b18a; the landed commit 66d99ecd1 is a different SHA with the same tree, and nothing records that link (the CLI has no `land`). Open items carried as problem lines, not fixed here: field-side pockets (Karul Bugbear case), limits.md rows for the escape limits.

## 3. Independent assessment

Observed in this session (one day, release 1a, ~20 agents). Facts first, then assumptions.

### 3.1 Which stages duplicate each other
- **Fact:** the planner and the implementer each re-derive the cause. Implementers re-read the same trace records and code the planner had cited (RM-31: planner 195 k tokens, implementer 190 k; DT-202: planner 164 k + 227 k, implementer 222 k). The brief carried the conclusion but not the evidence handles, so the implementer re-verified.
- **Fact:** the problems.md line, the planner and the review each re-state the cause; for RM-31 and DT-196 the problems.md cause was wrong, the planner corrected it, and the review then re-litigated the owner (RM-31 cap vs row identity). Three layers held three different causes over the day.
- **Fact:** `tests-for` locally, Picked tests on CI and then full PR checks often cover the same files for one commit (DT-174: local selection → Picked 58 files → later full CI at landing).
- **Fact:** reviews re-run the tests the implementer already ran and also re-check "fails on old code" — this duplication is cheap (≈100-200 s) and caught nothing new here, but it is the one check I would keep (3.5).

### 3.2 Where time and tokens go without visible gain
- **Fact:** investigations whose premise came from an earlier agent's guess: the "hot retry loop" agent (182 k tokens, 430 s) disproved its own brief (the loop was cold); RM-31 went through 3 implementations (cap → owner fix rejected at 50 files → separate-array owner fix).
- **Fact:** agents in "waiting on background work" states for long CI/test runs (earning-spot implementer > 30 min, > 249 k tokens).
- **Fact:** prune v2 dry run > 15 min (now 41 s).
- **Fact:** `verify --check` (3.5 min) re-run after PR checks already covered it; the coordinator ran it out of habit. The CLI does not need it then.
- **Assumption:** reading full planning maps per agent; with the 6.9 KB entry point the fixed cost per agent drops by ~30 KB, but agents still pull problems.md (large) when a line is cited.

### 3.3 Rules agents break or read ambiguously
- **Fact:** "fails on old code" is claimed, sometimes not checked (DT-173 r1 review: "I did not check that they fail on the old code").
- **Fact:** stop limits: the DT-208 and RM-31 implementers correctly stopped at the brief's limit; others widened scope by a step and said so ("deviation"). Usually acceptable, but each deviation needed coordinator reading.
- **Fact:** rule 3/4 "owner" is the most contested call (RM-31 cap, DT-197 buyer fare, DT-173 town-only fix); reviewers and implementers disagree on where the owner is.
- **Fact:** the old "review answers each rule" vs v2 "applicable rules" was itself ambiguous.
- **Fact:** problems.md causes written from an audit's first guess were wrong in 2 of 5 items this day (RM-31, DT-196) and one item had a wrong subject (DT-181 "merchants killed": no evidence in the saved runs).

### 3.4 Better as a script than an agent
- Test selection + CI dispatch + evidence check (now partly in the CLI).
- "Fails on old code": restore old sources of the changed `src/` files in a throwaway worktree and run the new tests — deterministic, an agent does it by hand each time.
- Trace queries that every planner re-writes (per-bot timelines, counts by raise kind, A-B-A flip counts): several agents wrote near-identical scratch scripts (`flips2.js`, `aba.js`, `count.js`, `probe.js`).
- Branch hygiene, planning hygiene, rules-check (already scripts).
- Squash-landing a reviewed branch with its evidence.

### 3.5 Checks that must not be cut
- A test that fails on the old code (every fix this day that skipped it would have shipped untested; the pilot found a CI-breaking stub only by running neighbours).
- Cause verification on a run's trace before a fix (2 of 5 problem lines had the wrong cause).
- The offline count/simulation before changing a shared economy rule (DT-208: the literal fix would have unfunded 71 ordinary NPC jewellery buys in 37 bots; found only by the count).
- Independent review of owner/one-path (RM-31 cap would have added a second money rule).
- Full PR checks before landing (fact, this pilot: two tests that load the changed module in a VM with an allow-listed `invoke` broke; the narrow local selection missed them, full CI caught them) and the release A/B.

### 3.6 Why repeated fixes, re-runs and late changes happen
- **Fact:** problem lines are written from audit symptoms with a guessed cause, and the guess becomes the brief.
- **Fact:** several agents edit adjacent mechanisms in parallel (economy: RM-31, DT-208, earning spot, DT-197) and discover each other's surfaces late (DT-202 counter vs DT-173 landing exemption).
- **Fact:** the release scope keeps growing during the day as each investigation finds 1-3 new problems (this day: ~15 new problem lines).
- **Assumption:** the A/B and traced runs come at the end of the batch, so behaviour interactions between fixes surface only after code freeze — hence late changes and re-runs.

### 3.7 Three changes for the next iteration
1. **Cause gate before a problem enters a release:** a problem line gets `cause: verified (trace/test ref)` or `cause: guess`; only verified lines enter a release row; a guess gets a short read-only verification task first. Why: the most expensive rework this day came from wrong causes.
2. **Scripted evidence:** extend the CLI with `old-code-check` (restore old src, run the new tests, record the failure), a shared trace-query library for planners, and `land` (squash + record evidence + push to fork). Why: the repeated manual steps are deterministic.
3. **Hand the evidence, not just the conclusion:** briefs carry the planner's evidence handles (trace record ids, file:line, script paths) and a "do not re-derive" line; implementers verify one handle, not the whole chain. Plus: one owner-map per area listing which agent edits which mechanism this batch, to avoid parallel collisions. Why: planner/implementer double investigation was the largest token sink.

## 4. Result

- Branch: see the session's final message (`ivan/workflow-v2-pilot` on posukhoff/L2Solo), a child of `ivan/workflow-v2` so `git diff fork/ivan/workflow-v2 fork/ivan/workflow-v2-pilot` shows every adaptation.
- Contents: CLAUDE.md, `.claude/workflow/*.md`, `.claude/workflow.js`, `.claude/prune-branches.sh`, `.claude/gpush.sh`, `planning/` as of this day (closed list; hygiene.js and tests-for.js adapted), this report, and the pilot task's evidence record (`reports/dt173-review.task.json`).
- Not included: agent transcripts, `config/local.ini`, auto-memory, run databases.

## Appendix A. Agent usage over the day (release 1a, before and during the pilot)

Source: the usage line of each agent's completion notice (subagent tokens, tool uses, wall time). Model: subagents inherit the coordinator's (claude-opus-5-5) unless overridden; none was overridden. Coordinator usage: unknown.

| Agent (role) | Item | Tokens | Wall | Outcome |
|---|---|---|---|---|
| planner | RM-31 | 194,583 | 607 s | cause partly right (D2), D1 ruled out |
| planner | DT-202 | 163,520 | 529 s | dominant kind = gatekeeper landings |
| planner | earning spot | 195,103 | 579 s | problem line's fix would catch ~3 % |
| investigator | DT-173 | 224,178 | 946 s | geodata pocket + recovery key |
| planner | DT-208 | 171,326 | 506 s | priority floor owner |
| planner | DT-202 loop | 226,698 | 800 s | cooling writer owner |
| investigator | "hot retry loop" | 181,747 | 430 s | premise wrong, no change (wasted) |
| reviewer | DT-174 | 96,759 | 161 s | pass |
| implementer | RM-31 (cap → stop → owner fix) | 190,227 + 203,234 + 297,397 (one agent, resumed twice) | 1040 + 83 + 1410 s | owner fix f8c93f780 |
| reviewer | RM-31 cap | 117,433 | 317 s | rules 3/4 violation → redo |
| implementer | DT-208 (stopped at limit, resumed) | 154,192 → 215,118 total | 1532 s total | 367bf7354 |
| implementer | DT-173 | 143,178 | 600 s | 6aa4f7dc9 |
| reviewer | DT-173 r1 | 101,551 | 221 s | 2 rule-8 gaps |
| implementer | DT-197 | 160,142 | 793 s | d7d0db87f |
| implementer | DT-202 | 221,934 | 1432 s | e72bde28b, e72b46c23 |
| implementer | earning spot | 263,341 | 2657 s | 7e1cba9a6 |
| comparer | workflow-v2 rule coverage | 101,266 | 122 s | 8 changed sentences of ~150 |
| implementer | pilot (DT-173 r1 fixes) | 92,714 | 374 s | 002500336 |
| reviewer | pilot round 2 | 73,862 | 100 s | pass |

Facts from the table: planners and investigators ≈ 1.36 M tokens, implementers ≈ 1.94 M, reviewers ≈ 0.39 M; one wasted investigation ≈ 0.18 M; RM-31 alone ≈ 1.0 M across planner, three implementations and a review.
