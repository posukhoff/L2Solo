# lc — issue and release lifecycle for L2Solo (pilot, 2026-11-11)

Built on frozen Workflow V5.1, which it does not change. Snapshot audited: `ivan/rc-state-1a` f66271932, with the
fixes below at 80becd09e. CLI: `lc.js` (656 lines, node only, no dependencies) with `lc.test.js` (5 behaviour
tests on a scratch repo). Data: the ref `ivan/lifecycle-data`.

## 1. Audit (read only, before the pilot)

| Area | Finding | Handle |
|---|---|---|
| Size | problems.md 114 KB over its 108 KB budget, roadmap 13 KB over 12. The budgets are in `planning/hygiene.js`, which is in the V5.1 digest, so pruning is the only fix | `node planning/hygiene.js` |
| Policy | I edited `planning/hygiene.js` once (17:58–18:16) and so changed the digest: `workflow.js:117` refuses every open task. Restored byte-exact; digest equals the 1a records again | `.claude/workflow.js:18-24,117` |
| Format | 8 problem lines had 8 fields after my retag script, and the roadmap row "Behaviour bugs" had a duplicated tail and a 5th cell. Both repaired locally. Fields that hold `` `a|b` `` need a backtick-aware split | problems.md ECO-10/14, DT-152, DT-249, DT-258..261 |
| Ids | 452 lines, 39 prefixes, 68 aliases, no duplicate id. `R-A` is an id with no digit. The findings file reused DT-249; it became DT-262 | |
| Assignment | RC-2, RC-4, SF-2 are named by two §3 rows. ECO-10 and ECO-14 carry two releases in one tag ("[r3] own move, [r2] bid worth"). parties-6 was tagged [r5] while 1b.1 pays it. RA3-3 is tagged [r1a] but sits in a §3 row | `lc check` |
| Owners | The Who column is empty in 80 of 81 rows. Dependencies exist only in prose ("needs 1b.1") | |
| Release names | Section numbers drift: `.claude/workflow/planning.md` still says "economy.md for release 7" (frozen text); "after release 2" in Large is ambiguous after the renumbering | |
| Branches | `ivan/batch-1a` is hardcoded in `tmp/rc-tools/land` and `check-candidate`; `prune-branches.sh` keeps a fixed list | |
| Task records | 96 V5.1 records: 34 landed, 2 refuted, 60 never closed (superseded attempts such as dt201, dt201b, dt201c). Records link to no problem id; ids appear in slugs and free text only | `.git/l2solo-workflow/` |
| Handoff | The RC handoff "State" is written by hand and goes stale within hours. The memory still says "left RM-20, CI, trace", while the A/B is running | `tmp/release-1a-pilot.md` |

## 2. Architecture

- **One owner per fact.** An issue's place is the single field `issue.at` (a step key) or null (triage/tail). Releases list steps, never issue ids, so one issue cannot sit in two places.
- **Storage: a data-only git ref.** `ivan/lifecycle-data` is an orphan branch that is never checked out. lc reads it and writes it through plumbing (`ls-tree`, `hash-object`, `mktree`, `commit-tree`). Each command is one commit, moved by `update-ref <ref> <new> <old>`. If another writer moved the ref first, the command is refused and writes nothing. `lc push` sends the ref to fork without force.
- **Views.** `planning/roadmap.md` and `planning/architecture/problems.md` keep their exact V5.1 formats and are rendered from data, so agents, `check.js` and `hygiene.js` keep working. `render --write` refuses when a file was edited by hand since the last render, or when the result is over its hygiene budget.
- **Hand edits.** Agents may still append lines to problems.md. `lc absorb` turns new and edited lines into data and refuses deleted lines (only land or drop closes an issue).
- **Evidence.** V5.1 stays the only source of review, CI and landing evidence. `lc land` reads the task record and requires: `landed.branch` equals the release's branch, `review.result=pass`, `ready.head` equals the reviewed head, and the head is on `fork/<branch>`. It copies `{slug, head, tree, ci ids}` into the manifest, so the fork holds the proof.
- **Gates.** `ci` comes from a V5.1 record with CI on the frozen head. `trace` and `ab` come from `run.json` (sha equals the frozen head, not dirty) plus a verdict reference. `report` is a reference. A waiver needs a decision id. lc checks that each gate's evidence exists and refers to the right head; the verdict stays with the reviewer.
- **Decisions.** `decisions.jsonl` holds the maintainer's decisions. Rules are data, e.g. `{sec: economy, only: [2, large], decision: M2}`. Any action that would contradict a decision needs `--decision <id>`. lc never invents one.

## 3. Data (`ivan/lifecycle-data`)

```
meta.json        sections, view heads/tails, roadmap groups, rules, gates per type, lastRender hashes
issues.jsonl     one open issue per line: {id, head, sec, ord, at, origin, rule, sites, what, fix, deps?, tail?, why?, hint?, tagx?, overrides?}
decisions.jsonl  {id, date, text}
releases/<k>.json {key, group, order, type, st, title, branch, base, head, decisions, cap, gates, steps:[{key, title, P, S, who, needs, st, tasks, landed, carried?}]}
archive/<k>.json  closed manifest;  archive/<k>.jsonl  closed issues with closed:{how, step, slug|decision, head, release, at}
```
States: release `planned → open → frozen → closed` (closed releases go to `archive/`). Step `planned → active → landed`; a step that is not done moves whole to another release (`carried` keeps the history). An issue's state is derived: no `at` means triage (or tail); an `at` means queued or active by its step; done means archived. History is the git log of the ref, one commit per transition, with the reason in the message.

## 4. Commands

```
lc status | check | show <id|step|release> | get <release> <field>
lc add … [--to step] | assign <id…> --to <step|triage|tail> [--decision M] | place [--apply] | dep <id> --on ids | drop <id> --reason (--decision|--rule0|--fixed-by slug)
lc release add|set | step add | open <rel> --branch --base | start <step> --task <slug> | land <step> [--keep ids] | defer <step> --to <rel> --reason
lc freeze <rel> | gate <rel> ci|trace|ab|report … | close <rel>
lc render --out <dir> | render --write | absorb [--apply] | import | decide | push
```
`status` costs about 270 bytes. Today an RC reads roadmap (13 KB) plus problems (114 KB), about 40k tokens.

## 5. Invariants (every write runs `check`; a violation refuses the write)

| Invariant | How it is enforced |
|---|---|
| One place per issue | the single `at` field |
| No step points nowhere | step must exist |
| Ids unique across open, aliases and archive, never reused | `add` refuses a used id |
| Steps | step keys unique, `needs` known, no step or dependency cycles |
| Dependency order | a dependency may not be queued in a later release |
| Live releases | open/frozen need branch and base, frozen needs head, one live release per branch |
| Frozen release | every step landed; `assign` into it needs a decision; gates only on the frozen head |
| Landed step | needs `{slug, head}` or `{decision, ref}` |
| Close | all gates present; paid issues archived with evidence; release moved to `archive/` |
| Caps and rules | caps hold; a rule conflict is a warning, and acting against a rule needs `--decision` |

## 6. Automatic placement

`place` assigns a triage issue only when exactly one open step fits. Either its row names it, or its legacy/absorbed tag names a group and that group has exactly one step holding issues of the same section, with no rule conflict. Everything else stays in triage with its candidates listed. `land --keep` and `defer` move issues automatically, and the moves are journaled.

## 7. A release, end to end (run by `lc.test.js` on a scratch repo)

```
lc open 1b.1 --branch ivan/batch-1b1 --base <sha>      # refused for 1b.2 until 1b.1 lands
lc start 1b.1 --task p1                                # the V5.1 slug must exist and belong to no other step
lc land 1b.1 --keep DT-49                              # needs V5.1 record-land on the branch, head on fork; DT-49 back to triage
lc assign DT-49 --to 1b.2
lc freeze 1b.1                                         # every step landed; head on fork
lc gate 1b.1 ci --task rel-ci ; gate trace --run final --verdict gate3.md ; gate ab --run cold --run hot --verdict ab.md ; gate report --ref r.md
lc close 1b.1                                          # DT-44 (+A-11) → archive/1b.1.jsonl with slug and head
lc open 1b.2 … ; lc defer 1b.2 --to 2 --reason …       # the step and its issues carried, reason kept
```

## 8. Migration

1. Import (done in the pilot, reversible): `lc import` parses both files and refuses unless both render back byte for byte. The originals are kept in the import commit under `import/`. Result: 452 issues, 15 releases, 448 placed, 4 in triage, 8 legacy tags.
2. Shadow (now): planning files stay the source. `lc absorb` and `render --out` show the drift. 1a closes in the old flow and is never live in lc.
3. Cutover (needs the maintainer): prune both views under budget, resolve the triage and warnings, then `render --write`. From then on planning edits go through lc, and agents' appended lines through `absorb`.
4. Rollback: `import/` in the first commit plus `git log` of the ref restore any state; `render --out` reproduces every past view.

## 9. Cost

Implementation so far: 656 + 169 lines. Left for production: `split` (one problem into two ids), a [tail]-age report (two releases old), step reorder, roadmap absorb, and rc-tools reading `lc get <rel> branch`. Estimate: 1–2 focused sessions plus one review.

Run time: under 1 s per command (`status` 0.75 s on 452 issues); the tests take about 30 s. Per bot or step: none (planning tooling only).

Upkeep: the view formats are pinned by the lossless import test; a change of V5.1 planning format means updating the parser and renderer together.

## 10. Pilot state (ivan/lifecycle-data, local + fork)

- 1b.1: arch, 11 issues; parties-6's stale [r5] tag cleared by `lc assign` (the row pays it).
- 1b.2: arch, needs 1b.1, 8 issues.
- Not opened, since neither has started.
- Planning files untouched (md5 checked); a preview render differs only in parties-6's tag.

## 11. Open for the maintainer (lc keeps these in triage or warnings; it does not decide)

1. RC-2, RC-4, SF-2: "Main writes far rows" row or "Situation raises" row. Recommended: the first, which names their fix.
2. ECO-10 and ECO-14: split each into two ids (§3 part, §2 part)? Recommended: yes; each id gets one owner.
3. Nine economy-section issues sit outside release 2 (DT-37, DT-65, DT-71, DT-72, DT-73, DT-77, DT-78, DT-226, RA-8). Does M2 cover them? Recommended: one decision "mechanism, safety and poll fixes in economy code are not economy design", recorded as their override.
4. Caps for 1b.1 and 1b.2 (none set) and gate lists per release type (today ci, trace, ab and report for every code release).
5. Cutover after 1a closes; pruning to the budgets is its precondition.
