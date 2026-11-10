# Risk routes and task evidence

This is a pilot. All hard rules and release gates remain binding. A route controls ceremony, not the correctness standard.

| Route | Entry | Execution | Verification |
|---|---|---|---|
| Fast | Localized bug, UI/copy/config tweak without shared decision, data, protocol or performance impact | One implementer, concise cause/owner/test brief, independent scoped review | Syntax, targeted behaviour tests, rule check; integration full CI as before |
| Standard | Gameplay feature/fix with bounded domain impact | Planner when cause or design uncertain, implementer, reviewer | Targeted tests + domain regression; full CI at integration; traced batch if behaviour affected |
| Critical | Shared hot/cold rule, worker/state ownership, DB migration, global economy, generated tables, performance or cross-module architecture | Explicit invariants and plan, isolated worktrees, design review, implementation and independent review | Targeted tests, full integration CI, relevant trace/coverage and A/B per release policy |

Escalate if changed files reveal a more risky surface, or if the owner/cause is uncertain. No automatic fast classification. Review round 1 checks the whole scoped diff against applicable hard rules (0–15). Round 2 checks fixes and related regressions. Unresolved blockers after round 2 stop the task; coordinator replans or splits. No blocker is waived. Unrelated findings enter problems.md and do not expand the task. Any release blocker still blocks release.

Every traced run: automated named invariants and task counters; investigate misses. Full exploratory audit once at release boundary and on a material unexplained anomaly. Do not discard an observed invariant violation. Coverage/unchecked cells and final world acceptance are unchanged. This pilot does not implement the automated invariant extractor: retain current manual checks until equivalent automation exists.

## CLI pilot

Install the workflow files in the primary local game checkout, preserving your local planning directory. Run from that checkout, or pass `--root /absolute/game/worktree` and run the script by absolute path. Do not run on the workflow-only snapshot.

```sh
node .claude/workflow.js start party-fix --base ivan/batch-6 --risk standard
node .claude/workflow.js status party-fix
node .claude/workflow.js verify party-fix --root /path/to/topic-worktree
node .claude/workflow.js verify party-fix --root /path/to/topic-worktree --local
node .claude/workflow.js record-review party-fix --root /path/to/topic-worktree --result pass --evidence "review report identifier"
node .claude/workflow.js record-ci party-fix --root /path/to/topic-worktree --run 123456789
node .claude/workflow.js ready party-fix --root /path/to/topic-worktree
```

Start records base SHA, instruction digest, route, and creation time in Git's common directory (`l2solo-workflow/<slug>.json`), shared across worktrees. No branch is created or pushed. Create your normal worktree from the recorded base. Verification requires a clean committed tree and base ancestry; default mode prints selected tests and warnings only. Explicit --local runs syntax, rules-check and up to 8 non-geodata selected tests; never use while a benchmark/trace is running. A broad or geodata set goes to existing Picked tests CI. No automated merge, push, server, table rebuild or release. Record-ci checks GitHub's run status, workflow and exact head SHA. Ready reports task-level evidence, not integration/release authorization; full CI remains required on the integration head. Changing code invalidates prior evidence. Changing policy requires a fresh task record or explicit coordinator re-evaluation. Keep sensitive data out of evidence text.

Test selector is deliberately conservative: dependency depth 2 + domain tests; it flags uncertain changes, deleted files and unmatched cases for coordinator selection and CI. It is not proof of completeness. Review evidence is a recorded human/agent verdict, not a cryptographic attestation. Use the existing runner and Git policy for actual landing.
