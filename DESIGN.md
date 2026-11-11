# lc — issue and release lifecycle for L2Solo (v2, after the 11-12 audit)

Built on frozen Workflow V5.1, which it does not change. CLI: `lc.js` (970 lines, node only) and `lc.test.js` (9
behaviour tests on scratch repos with a bare fork and origin). Data: the ref `ivan/lifecycle-data`, an orphan branch
that is never checked out.

## Architecture (accepted 11-12)

- **One place per issue.** `issue.at` is a step key, or null for triage/tail. Releases list steps, never issue ids.
- **One commit per write.** Each write is checked against the fork's copy (`ls-remote`), moved by compare-and-swap (`update-ref new old`), and pushed without force. A refused push undoes the local move.
- **Sync without force.** `lc sync` fast-forwards or pushes. On a divergence it keeps this copy's commits at `refs/lc/conflict/<time>`, takes the fork's data, and prints the commands to run again.
- **Views.** `roadmap.md` and `problems.md` render in their V5.1 formats. `render --write` writes temp files first, then commits the data, then renames the files. A failure leaves either the old state or one that a rerun finishes. It refuses hand edits (`absorb` first), budget overruns, and a copy the fork has moved past.
- **Evidence.** V5.1 records and run directories are read, never written. lc pushes nothing to origin and opens no PR.

## What the 11-12 audit required, and where it is

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

## Maintainer decisions recorded (M7–M13)

| Decision | Content | Effect in data |
|---|---|---|
| M7 | RC-2, RC-4, SF-2 → 3.main-writes-far | assigned there; the "Situation raises" row no longer names them |
| M8 | M2 scope | overrides bound to the eight; DT-226 → triage "investigate before classification" |
| M9 | ECO-10 → ECO-10 (own move, §3) + ECO-17 (bid worth, §2); ECO-14 (= RM-33) → ECO-14 (refusals, §2) + ECO-18 (fault counting, §3) | all file:line and text kept across the parts; the ECO-14 fix line now reads "input to the economy redesign; no fix chosen" (its old fix went with ECO-18) |
| M10 | caps 11 / 8 | both releases are at their cap |
| M11 | arch gates ci, trace, ab, behaviour, report | `behaviour` needs a verdict naming the recorded A/B runs plus "behaviour: preserved" |
| M12 | cutover only after 1a and a separate acceptance | — |
| M13 | records the 1a RC's own closing of RM-20 (row removed 11-11 18:41), so the deletion could be taken in | RM-20 archived; gaps RM-47..50 |

Seed decisions M1–M6 carry no `allows`, so they authorize nothing.

## Migration check (real data)

- **Original import.** All 452 lines accounted for: 451 open, RM-20 archived. 48 alias heads unchanged. Fields differ only for DT-121, RM-45 and DT-128 (edited by the RC) and for ECO-10 and ECO-14 (split). No dependencies exist in planning, and none were added.
- **Against today's planning** (`lc import --compare`). No id missing, no alias difference. The remaining differences are exactly the decisions: tags of parties-6, ECO-10, ECO-14, DT-226, RA3-3, and the split lines and rows.
- **Not yet in planning.** Writing those differences into planning/ was blocked by the auto-mode permission check, because the 1a RC writes those files too. The ready render is `lc render --out <dir>`.
- **Triage (14).** DT-226 (M8), plus 13 lines the RC added at 18:41 tagged [r3]/[r2] that no roadmap row names: RM-47…55, DT-263…266. The view keeps the finder's tag until a row or rule places them.

## V5.1 task ledger (`tasks.jsonl`, the 96 records unchanged)

| Class | Count | Rule |
|---|---|---|
| landed | 53 | 34 by their own record-land on an integration branch, 19 by the same patch-id as one of those |
| superseded | 35 | a later landed record of the same family |
| abandoned | 5 | dt123, n-shaman, v4-refuted, wf-clitest, wf-prtest: no landing in the family |
| refuted | 2 | V5.1 close |
| release-gate | 1 | release-1a-ci, kept open |

A record-land head on no integration branch would be `landed-test`; there are none today.

## Open

- Applying the decision diff to planning/ (needs a permission or the RC).
- Placing the 13 RC lines and DT-226.
- Pruning both views to budget (roadmap 13/12 KB, problems 117/108 KB) before cutover.
- Cutover after 1a (M12).
