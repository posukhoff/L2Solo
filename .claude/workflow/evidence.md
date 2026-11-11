# V3 evidence-first pilot

## Cause gate and handoff

Separate symptom from hypothesis in problems.md: cause: guess or verified + trace/test/source ref. Guesses enter investigation, not implementation; critical blockers get immediate triage. Verify causal chain and owner before handoff. Briefs carry exact base and evidence handles; implementer spot-checks a decisive handle, reinvestigates only if contradicted. Coordinator resolves overlapping owner scopes before edits; review stays scoped.

Start with --kind fix (default), feature or chore. A guess is investigation-only. CLI validates shape, not truth; coordinator inspects evidence. New brief resets task evidence; changed policy requires new slug. Keep evidence handles, not secrets/log dumps. Sample:

```json
{
  "base": "<full task base SHA>",
  "symptom": "Observed incorrect town departure",
  "owner": "BotSpotTravel: departure/recovery",
  "cause": {"status":"verified","explanation":"What caused the observed failure","evidence":["run ID / trace record / source file:line"]},
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

- Full PR checks only covers the default runner suite (12 distinct successful shards). Raw-geodata-only tests require additional Picked tests or valid local evidence; optional geodata variants still need explicit scenario checks when applicable. Record multiple successful runs, coverage union; a green subset does not by itself prove readiness.
- Picked tests: require exact SHA or single-parent list commit adding only ci-tests.txt, successful Plan and expected shards.
- Always run local mechanical rules-check for HEAD (verify --rules); PR checks includes syntax/table check but not planning/rules-check.js. --selection-ack records reviewer judgement for uncertain selection; full CI also required in that case. Broad selection >96 prefers full CI and a Picked run for any uncovered geodata tests; no automatic dispatch.
- Fixes record the expected old assertion failure and new pass (base SHA and evidence reference) with record-regression; manual evidence, not an automated old-code execution. Every named regression test needs its own receipt; regression tests are a subset of brief tests. Preserve existing independent review, simulation and release A/B requirements.
- ready is task evidence, not merge authorization. `record-land --remote <r> --branch <b>` records that the remote branch holds the verified tree; no automatic push/merge. If batch integration changes the tree, do not transfer evidence: reverify the integrated result. Final full integration CI still mandatory.
- Digest includes entry point, references and the local scripts used for verification/cleanup. It does not pin all map files; use exact file/line/trace handles and re-evaluate if they change.

## Pilot
Measure time, tokens, cause corrections, review rounds, CI and repeat investigations on comparable tasks. No automatic old-code restoration, trace query or invariant extractor yet. Single coordinator writer per slug.
