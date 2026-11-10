# V3 evidence-first pilot

## Cause gate and handoff

An audit reports an observed symptom and a hypothesis separately. Mark each bug in problems.md with cause: guess or cause: verified plus a trace/test/code reference. A guess can enter the investigation queue, not implementation. Critical release blockers still get immediate triage. For fixes, a planner/coordinator verifies the cause before handing off: concrete observation, causal chain, rule owner, evidence handles and expected player-visible outcome. Briefs carry exact base SHA and evidence, not only conclusions. The implementer spot-checks a decisive handle; do not repeat the investigation unless evidence contradicts the brief or the source changes. Keep owner/mechanism scopes disjoint across concurrent worktrees; coordinator resolves overlap before edits. Review checks the scoped diff and evidence, not all unrelated backlog items.

Start with --kind fix (default), feature or chore. Record the brief before implementing. A fix with cause.status=guess is investigation-only. The CLI validates shape and requires a verified claim and references, **not the truth of the claim**. The coordinator must inspect evidence. A new brief resets task evidence; changed policy invalidates the task record. Use new slug after re-evaluation, preserve old receipt. Record source and trace identifiers rather than secrets or huge logs. Sample:

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

A guess brief needs only base, symptom, evidence and cause hypothesis; complete owner/scope/acceptance/tests before verification. Feature/chore omit cause/regressions but supply goal, owner, scope, evidence (spec/reference), acceptance and tests. No source edits are done by CLI. This is a local process gate, not enforcement against an agent bypassing the CLI.

## Evidence gates

- Full PR checks only covers the default runner suite (12 distinct successful shards). Raw-geodata-only tests require additional Picked tests or valid local evidence; optional geodata variants still need explicit scenario checks when applicable. Record multiple successful runs, coverage union; a green subset does not by itself prove readiness.
- Picked tests: require exact SHA or single-parent list commit adding only ci-tests.txt, successful Plan and expected shards. Normalize test names through runner. This trusts the repository's configured workflows; it does not independently attest execution.
- Always run local mechanical rules-check for HEAD (verify --rules); PR checks includes syntax/table check but not planning/rules-check.js. Avoid re-running syntax if PR checks already proved it. --selection-ack records reviewer judgement for uncertain selection; full CI also required in that case. Broad selection >96 prefers full CI and a Picked run for any uncovered geodata tests; no automatic dispatch.
- Fixes record the expected old assertion failure and new pass (base SHA and evidence reference) with record-regression; manual evidence, not an automated old-code execution. Every named regression test needs its own receipt; regression tests are a subset of brief tests. Preserve existing independent review, simulation and release A/B requirements.
- ready is task evidence, not merge authorization. record-land records exact tree equality after the normal squash; no automatic push/merge. If batch integration changes the tree, do not transfer evidence: reverify the integrated result. Final full integration CI still mandatory.
- Digest includes entry point, references and the local scripts used for verification/cleanup. It does not pin all map files; use exact file/line/trace handles and re-evaluate if they change.

## Pilot measurements

Record actual stage duration, model/token usage where available, cause corrections, review rounds, CI dispatches and repeated investigation. Compare on similar tasks; a single counter fix is not a representative architecture benchmark. No automated old-code restoration, trace query library or runtime invariant extractor yet. Task records have a single coordinator writer; do not issue concurrent updates to the same slug.
