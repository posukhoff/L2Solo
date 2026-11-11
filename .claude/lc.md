# lc — issue and release lifecycle (reference for `.claude/lc.js`, Workflow V5.2)

lc.js is outside the policy digest on purpose: an lc fix must not void open workflow.js tasks (`workflow.js:117`); `.claude/lc.test.js` guards it (`node --test .claude/lc.test.js`, ~70 s, needs git). Rules it enforces are stated in planning.md and git.md.

Built on frozen Workflow V5.1, which it does not change. CLI: `lc.js` (970 lines, node only) and `lc.test.js` (9
behaviour tests on scratch repos with a bare fork and origin). Data: the ref `ivan/lifecycle-data`, an orphan branch
that is never checked out.

## Context, not files (V5.2; rationale in .claude/context-budgets.md)

- **Paged packs.** `lc show <step|release> [--page N] [--role rc]` is an agent's pack: the row, its issue lines (with `why` notes), direct dependencies (open lines, or archived with their closure) and the decisions that apply. The budget is `meta.budgets` (pack 12 KB, rc 2 KB). Over it, the pack is paged with a header (`page 1/3 · lines 1-30 of 74 · next: …`); a line is never cut or dropped.
- **Growth diagnosis.** `lc status` prints a `growth:` line, and `lc check` lists the causes: `dup?` (two open issues share an exact quoted member `Module.method` and a rule number; a module name alone, or a name shared by more than 6 issues, is not evidence), `broad` (a row over `rowIssues` 25), `stale` (check.js "member gone" on problems.md lines), triage, tails due, and resolved issues waiting for close. Each cause has an owner action; nothing is merged or deleted.
- **Warnings on intake.** `add` and `absorb` print open issues that quote the same code name. `start` prints open issues naming a module from the V5.2 brief's `cause.chain`.
- **Size only warns.** `render --write` notes a view over an old KB budget instead of refusing. `render --check` (used by hygiene) fails only after the cutover, when a view is not the render.
- **Measurement.** `.claude/tools/context-cost.py [--since --until]` counts planning and policy reads, re-reads and tokens per role from the transcripts. The RC runs it at release close.

## Architecture (accepted 11-11)

- **One place per issue.** `issue.at` is a step key, or null for triage/tail. Releases list steps, never issue ids.
- **One commit per write.** Each write is checked against the fork's copy (`ls-remote`), moved by compare-and-swap (`update-ref new old`), and pushed without force. A refused push undoes the local move.
- **Sync without force.** `lc sync` fast-forwards or pushes. On a divergence it keeps this copy's commits at `refs/lc/conflict/<time>`, takes the fork's data, and prints the commands to run again.
- **Views.** `roadmap.md` and `problems.md` render in their V5.1 formats. `render --write` writes temp files first, then commits the data, then renames the files. A failure leaves either the old state or one that a rerun finishes. It refuses hand edits (`absorb` first), budget overruns, and a copy the fork has moved past.
- **Evidence.** V5.1 records and run directories are read, never written. lc pushes nothing to origin and opens no PR.

## What the 11-11 audit required, and where it is

| Item | How lc meets it | Test |
|---|---|---|
| P0 close | an issue in a landed step needs its own result (`lc resolve`): a V5.1 regression test (old fails, new passes, on the landed head) whose brief names the id, or a run of a commit holding the landing whose verdict has "ID: resolved". `close` refuses the unresolved, or `--carry` moves them | close: … never archived |
| P0 ci | needs the V5.1 record of the frozen full SHA to hold PR checks and rules-check; `workflow.js verify` (read only) names the selection; Picked runs must cover its geodata-only tests and raw evidence its optional geodata tests | end to end (incomplete CI, wrong head, old rules) |
| P0 trace/ab | run.json resolved to one full commit equal to the frozen head; directory names it; not dirty; exit 0; scenario, script and window fit the profile; artifacts present (trace adds world.sqlite); coverage, invariants and verdict files name the run and head; "verdict: pass" required; sha256 of each kept. A/B: both scenarios on both sides, A an ancestor, one save, diagnostics on | end to end (wrong SHA, dirty, short, missing artifact, misnamed, fake or failed verdict) |
| P0 no bypass | code gates cannot be waived (`--waive`/`--decision` refused); `lc gates` cannot drop ci, trace, ab or report | end to end |
| P0 validated ≠ published | `close` archives as `validated, published: null`. `lc publish` only records a publication someone made with the maintainer's authorization: a decision that allows `publish` for that release, plus origin's branch containing the head | end to end |
| P1 render | temp → data → rename; refuses on a moved fork even when the data is unchanged | views |
| P1 remote | `ls-remote` is the tip; a failed or disagreeing fetch refuses; freeze takes the fork's tip and refuses when local differs | remote truth |
| P1 decisions | `decide --allow action=…,issue=…,to=…`; every `--decision` is checked against the action and subject (rule-override, scope-add, cap, order, land-no-code, drop, split, publish, gates, placement-rule) | decisions … |
| P1 place | only one naming row or one explicit `lc placement` rule (itself authorized); the section heuristic is gone | views |
| P1 writers | fork check before write, push after, `sync` with conflict refs | writers |
| P1 tools | `split` (old id, aliases and history stay; new id records `split from`), `tails` (due two releases on), `step set|move|drop`, `dep` | split …, ledger |
| P1 rc-tools | `land` and `check-candidate` read B from `RC_BRANCH` or `lc get $RC_RELEASE branch`; no default | manual (tmp/rc-tools) |

## Maintainer decisions recorded (M7–M14, all 2026-11-11)

| Decision | Content | Effect in data |
|---|---|---|
| M7 | RC-2, RC-4, SF-2 → 3.main-writes-far | assigned there; the "Situation raises" row no longer names them |
| M8 | M2 scope | overrides bound to the eight; DT-226 → triage "investigate before classification" |
| M9 | ECO-10 → ECO-10 (own move, §3) + ECO-17 (bid worth, §2); ECO-14 (= RM-33) → ECO-14 (refusals, §2) + ECO-18 (fault counting, §3) | all file:line and text kept across the parts; the ECO-14 fix line now reads "input to the economy redesign; no fix chosen" (its old fix went with ECO-18) |
| M10 | caps 11 / 8 | both releases are at their cap |
| M11 | arch gates ci, trace, ab, behaviour, report | `behaviour` needs a verdict naming the recorded A/B runs plus "behaviour: preserved" |
| M12 | cutover only after 1a and a separate acceptance | — |
| M13 | historical approval of closing RM-20 after its world test | RM-20 archived as `completed` (not dropped) with run, verdict and log evidence; follow-ups RM-47..50 |
| M14 | routing of the 1a RC findings | RM-47/48/54 trace gaps; RM-51/52/53, DT-263 behaviour bugs; RM-55 flaky tests; DT-265 uncounted failures; DT-266 run tooling; DT-264 sure-price owner; RM-49, RM-50 triage |

Seed decisions M1–M6 carry no `allows`, so they authorize nothing.

## Investigation status

RM-51, RM-52, RM-53, DT-263 and DT-264 carry `why: investigation: cause unverified`; the line states an observation, not a cause.

A cause is verified in V5.1 before implementation: the task brief's `cause.status: verified` needs evidence handles and regression tests. lc neither verifies nor promotes a cause. `lc resolve` comes after landing and only records that the issue's own result exists (a V5.1 regression test, or a run verdict naming the id); it does not prove the cause.

V5.2 is not applied to the open V5.1 tasks of release 1a. lc reads whichever record a task has and never writes one.

Limit: `assign` clears `why`. Moving such an issue again needs the note set again; no CLI feature was added for this.

## Triage (3)

- **DT-226** (M8): investigate first.
- **RM-49**: its only site, `ClanPartyHelp.request`, is what 1b.2 replaces with `clan_call`. It becomes obsolete or re-aimed after 1b.2, and is not added to 1b.2.
- **RM-50**: checked, a fixture rather than a growth defect, so not split. At x50, level 1 needs a ledger of ≥ 6.54 M; worlds hold at most 4.38 M, with no blocked advance.

## V5.1 task ledger (`tasks.jsonl`)

The ledger serves history and cleanup only. `land`, `resolve` and `gate` read each task's own V5.1 record, never this ledger, so a patch-id match is not review, CI or regression evidence.

| Class | Count | Rule |
|---|---|---|
| landed | 53 | 34 own record-land on an integration branch, 19 by patch-id |
| superseded | 35 | |
| abandoned | 5 | |
| refuted | 2 | |
| release-gate | 1 | |

## Cutover readiness (2026-11-11 20:20)

- **No lost ids.** All 452 original ids are open or archived (RM-20). All 464 ids in today's planning are open in data. `onlyInData` holds ECO-17 and ECO-18.
- **Exact diff.** `cutover/preview.diff on fork `ivan/lifecycle`` (planning → render) has 9 roadmap rows, 6 changed problem lines and 2 new ones. Nothing else differs.
- **Not ready.** The 1a RC still runs: a hot B run is in progress, and its log and session were active at 20:10. It plans new 1b lines (crash, the 2001104 loop) and V5.2.
- **Planning files** are untouched by lc (maintainer: no edits while the RC works).
- **Sequence after 1a closes:**
  1. `lc sync`
  2. `lc absorb` (the RC's new lines and edits)
  3. `lc check`
  4. `render --out`
  5. compare with the planning files
  6. acceptance
  7. prune both views to budget (roadmap 13/12 KB, problems 117/108 KB); `render --write` refuses until then
  8. `render --write`
