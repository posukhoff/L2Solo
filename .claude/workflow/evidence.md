# Task evidence

## Cause gate and handoff

Separate symptom from hypothesis in the issue (`lc add`; problems.md is its rendered line): cause: guess or verified + trace/test/source ref. Guesses enter investigation, not implementation; critical blockers get immediate triage. A cause is verified when its chain runs from the observed symptom to the first wrong decision or broken invariant (C4 rule, situation, owner contract). The chain names where the symptom shows apart from the mechanism that produced it, rules out each plausible alternative with a handle, and is proven by a reproduction, trace or counterexample that accounts for the counted symptom, not one instance. Stop at the nearest controllable cause whose fix restores the invariant; unproven after one bounded investigation → blocker. Independent causes get separate linked slugs. Containment of a serious defect is labelled temporary, with an open root-cause lc issue. Briefs carry exact base and evidence handles; implementer spot-checks a decisive handle, reinvestigates only if contradicted. Coordinator resolves overlapping owner scopes before edits; review stays scoped.

Start with --kind fix (default), feature or chore. A guess is investigation-only. CLI validates shape, not truth; coordinator inspects evidence. New brief resets task evidence; changed policy requires new slug. Keep evidence handles, not secrets/log dumps. Sample:

```json
{
  "base": "<full task base SHA>",
  "symptom": "Observed incorrect town departure",
  "owner": "BotSpotTravel: departure/recovery",
  "cause": {"status":"verified","explanation":"What caused the observed failure","chain":["where the symptom shows (file:line)","first wrong decision or broken invariant (handle)"],"excluded":["plausible alternative ruled out (handle), or none plausible: reason"],"evidence":["run ID / trace record / source file:line"]},
  "scope":["src/..."],
  "nonGoals":["Unrelated field recovery"],
  "acceptance":["Expected observable behaviour"],
  "evidence":["Saved run ID and SQL result reference"],
  "tests":["test_bot_town_travel.js"],
  "regressions":["test_bot_town_travel.js"]
}
```

A guess brief needs only base, symptom, evidence and cause hypothesis; complete owner/scope/acceptance/tests before verification. Feature/chore omit cause/regressions but supply goal, owner, scope, evidence (spec/reference), acceptance and tests. No source edits are done by CLI.

## Evidence gates

- Every task on every route needs full PR checks on its SHA (`ready` refuses without it, and `lc land` reads the same). Full PR checks only covers the default runner suite (12 distinct successful shards). Raw-geodata-only tests require additional Picked tests; optional geodata variants still need explicit scenario checks when applicable. Record multiple successful runs, coverage union; a green subset does not by itself prove readiness.
- Picked tests: require exact SHA or single-parent list commit adding only ci-tests.txt, successful Plan and expected shards.
- Always run local mechanical rules-check for HEAD (verify --rules); PR checks includes syntax/table check but not planning/rules-check.js. --selection-ack records reviewer judgement for an uncertain selection (a deleted file, a non-JS change, no selected tests); a critical surface is a route check and asks no ack. No automatic dispatch.
- Fixes record the expected old assertion failure and new pass (base SHA and evidence reference) with record-regression; manual evidence, not an automated old-code execution. Every named regression test needs its own receipt; regression tests are a subset of brief tests. Preserve existing independent review, simulation and release A/B requirements.
- ready is task evidence, not merge authorization. `record-land --remote <r> --branch <b>` records that the remote branch holds the verified tree; no automatic push/merge. If batch integration changes the tree, do not transfer evidence: reverify the integrated result. Final full integration CI still mandatory.
- Retro: `ready`, `record-land` and `close` print `RETRO DUE: <reason>` (a critical violation, one cause twice, or 5 open candidates). The coordinator then sends one narrow Retro agent (common root cause, consequences, minimal guard, result saved) and marks them `record-retro <slug> --processed <ids|all> --result <path>`. No standing process, nothing fires by itself: a candidate counts only once the coordinator records it (`record-retro --cause --text`) when it reads the report or writes the handoff.
- Digest = workflow.js, evidence.md, routes.md (what defines evidence); CLAUDE.md, the other references, hygiene and lc change without voiding open records. The three digest files change only between releases (no release open in lc) or for a defect that blocks work, as one batch: every edit voids every open record. It does not pin map files; use exact file/line/trace handles and re-evaluate if they change.

## Limits
No automatic old-code restoration, trace query or invariant extractor yet: the old-code failure and the review are recorded references the coordinator inspects, not something the CLI ran. Single coordinator writer per slug.
