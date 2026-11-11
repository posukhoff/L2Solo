# workflow V5.1 stabilization (11-11, 06:30-09:30 UTC+2 day session)

Source: `reports/workflow-v5.1-pilot.md` (night pilot, branch `ivan/workflow-v5.1-pilot`). Independent-audit fixes applied (record-rebase, record-land, token-usage); **V5.1 is frozen at this commit**: no new functions, stages or tools. Fork only: nothing pushed to origin, no PR, no V6. Changes are edits of existing stages (record-land, record-rebase, CI dispatch, the cost rules of agents.md), not new stages. Token numbers below come from transcripts: per-message usage, kept by each message's own timestamp, counted once per message id across files (`reports/tools/token-usage.py`; the first version filtered by transcript start and undercounted the night's subagents by ~7 %). "Input-equivalent" weights input 1, cache write 1.25, cache read 0.1, output 5 (relative list prices); it compares cost, not context size.

## 1. What was fixed, and at which SHAs

| Item | SHA | What |
|---|---|---|
| DT-214 (release 1a, maintainer decision) | **e83fd26e5** on `ivan/batch-1a` | the town-corridor A* became a generator (`GeodataEngine.findPathSteps`, `TownPathCorridor.buildSteps`); the path worker runs ≤ 150 ms per turn and continues on the next (`setImmediate`); cancellation at every pause (STALE_PATH); main still drops stale routes by revision; `workerMs` sums slices; `PATH_BUDGET` is gone with all its consumers; same paths (md5-equal on Giran). `test_companion_pathfinding_worker` under CPU load: **10/10 vs 0/10** on the old code; assertions and timeouts unchanged |
| DT-243 (release 1a, maintainer decision) | **9e189d2b2** | a goal that cannot pay the money floor is parked: the build takes the next funded goal; it returns when fundable; survival stock keeps its tier (3 review rounds, see §3) |
| RA1-7 (audit) | **95a12356b** | dead comments and an ignored argument removed in the cold worker (Sonnet) |
| findings-1a.md missing in the published report | 70b34b8dc on `ivan/workflow-v5.1-pilot` | the shared `info/exclude` ignores new files under `planning/`; added with `-f` |
| `record-land` | V5.1 branch (§6) | requires `--remote <r> --branch <b>`; reads the remote's actual head with `git ls-remote`, refuses a head that is not fetched, a missing branch or another tree, and records the remote head (audit fix: a stale local ref can no longer pass). The earlier `--ref` form was proven live on DT-214 (refused before the push, recorded after) |
| `record-rebase` | V5.1 branch | equal patch-id on a new base that left the task's files unchanged carries the review and the old-code evidence; if the base changed those files nothing carries and the changed files are named (audit fix: the review is redone in the new context); CI/rules/ready never carry. Proven live: DT-243 onto DT-214 and RA1-7 onto DT-243 (task files untouched by the base) kept review + regressions and needed only CI |
| CI dispatch | `.claude/ci-dispatch.sh` | PR checks + the Picked list from `verify`, through the existing `gpush.sh` retries (the night's push failures were its flaky ssh-agent signing); stops on a failed verify (the night's empty-list mistake) |
| Stacking / CI timing | git.md | stack only on a reviewed task with green PR checks; full CI after a passed review unless overlap clearly saves time (the existing rule I had dropped in the morning edit, restored) |
| Token rules | agents.md | reports ≤ 250 words; briefs carry handles; targeted tests; a fix round is a new narrow agent (never resumed); cheaper model for low-risk mechanical work; the coordinator hands off past ~200 k context |

`.claude/workflow.test.js`: 47 → 65 PASS (all earlier cases kept or rewritten for the new rules; regressions: missing remote branch, remote holding another tree, unfetched remote head, base that changed the task files carries nothing, unchanged context carries review + old-code evidence and never SHA receipts). `reports/tools/token-usage.test.py` PASS (per-message window, [from, to) bounds, one count per message id across files, broken lines). Workflow docs stay within their 40 KB budget (text replaced, not added).

## 2. Time and token problems removed

- **DT-214 flake** (night: 15 extra Picked attempts, ~0.75 per landing, plus single-test checks): removed at the source. Day Picked runs on heads containing the fix: 4 of 4 green on the first attempt (33-file list for DT-214 itself); the only day failure was a run on the pre-fix base.
- **Restack re-records**: a same-patch move no longer needs a new record or a re-review (night: ~60 records for 21 tasks).
- **Landing before push**: impossible now.
- **Push failures**: use `gpush.sh` (retries) — no push failure today.
- **Wasted CI on blocked reviews**: the day showed 3 of 4 first reviews on critical tasks blocked, so CI sent in parallel with review was mostly waste (3 runs cancelled); the restored rule sends full CI after the review.
- **Token accounting**: the night's "8.35 M subagent tokens" summed the harness `subagent_tokens`, which is the last message's context size, not consumption, and for resumed agents a later context size. Real usage is in §3.

## 3. Measured vs hypothesis

Measured (night 00:45-06:30 UTC; transcripts):

| | messages | cache read | cache write | output | input-equivalent |
|---|---|---|---|---|---|
| subagents | 2702 | 320.7 M | 9.41 M | 1.73 M | ≈ 52.5 M |
| coordinator | 547 | 251.6 M | 0.85 M | 0.37 M | ≈ 28 M (avg context ~460 k per turn) |

Median context per subagent message ~119 k (verifier 114 k, implementer 93 k, reviewer 78 k in the per-role split). **Cost = context × turns; the coordinator alone was ~35 % of the night.** Uncached input is negligible (5 k); mandatory docs are ~5 k tokens of the ~80-150 k contexts.

Measured CI (night): of 48 PR-checks runs started, 19 useful (on a SHA that landed), 4 superseded, 19 cancelled (restacks), 5 failed (3 real causes); Picked 47 started, 20 useful, 16 superseded, 9 cancelled. Day: DT-214 and DT-243 landed on their first CI after review; RA1-7 needed a second CI after a re-pick (the cost of parallel tasks on one base).

Measured, day tasks (input-equivalent per agent):

| Task | Agents | Rounds | Input-equivalent |
|---|---|---|---|
| DT-214 | impl Opus 867 k; r1 Opus 332 k; dead-code deletion Sonnet 112 k; fix Sonnet 220 k; r2 Sonnet 56 k | 2 (r1 blocked: unreachable revision queue) | 1.2 M Opus + 0.39 M Sonnet |
| DT-243 | impl 493 k; r1 314 k; fix 358 k; r2 297 k; fix 232 k; r3 133 k (all Opus) | 3 (deviation: the coordinator decided after the 2-round limit) | 1.83 M |
| RA1-7 | impl Sonnet 109 k; review Sonnet 53 k | 1 | 0.16 M Sonnet |
| coordinator (day 06:30-07:35 UTC, 91 turns) | — | — | 8.0 M (avg context **826 k** per turn); day subagents together 3.8 M (255 messages, avg context 68 k) |

Hypotheses (not proven):
- Sonnet on low-risk work is ~5-10× cheaper per task than Opus: the per-agent units are 3-8× lower, but the tasks were simpler and the Opus/Sonnet price ratio for these models is not in the transcripts. Quality signal (positive, small sample): Sonnet stopped correctly on RA1-5 (a behaviour change hidden in rounding), reviewed correctly, deleted correctly; one slip (a `sed -i` backup file left untracked).
- The new report/brief limits cut tokens: day reviewers used 8-25 messages (night median 32) and briefs were shorter, but no controlled comparison.
- The coordinator hand-off rule would cut its cost several-fold: it follows from the numbers (821 k context per turn now vs ~200 k), not yet tried.

## 4. Time and tokens saved

- **Proven:** DT-214's ~1 rerun per landing (15 at night) is gone; restack re-review is gone (DT-243 and RA1-7 moved with review carried — at night each such move cost a manual record and a patch-id check, and 30+ carries were done by hand); no landing before push.
- **Not proven as totals:** a per-task token saving cannot be claimed yet. DT-243 cost 1.83 M in three review rounds because the reviewers found two real regressions the implementer missed (stock funding lost, next goal dropped from the queue); that is the review doing its job, not overhead. A fair comparison needs the same task under both rule sets.
- **Not comparable:** night vs day landings per hour (different task mix, agents, prior work); the V5 pilot (3 tasks) vs V5.1 night (20) vs day (3).

## 5. Faster now / still bottlenecks

Faster: CI per landing (no flake reruns), restacks (one command, review carried), landings (ref-checked, gpush retries).
Still bottlenecks:
1. **Coordinator context.** ~826 k per turn by the end; it dominates cost. Action: a fresh coordinator per batch with a handoff note (the rule is now in agents.md; this session should be the last long one).
2. **Review rounds on critical economy changes.** 3 of 4 first reviews blocked; each round costs 0.3 M+. Action: implementer briefs that name the invariants the reviewer will probe (stock, queue membership) — partly done in the fix briefs.
3. **Policy-digest churn.** Every docs/CLI edit invalidates open records (5 re-records today). Action: batch policy edits; freeze them while tasks are open.
4. **Critical-route over-trigger.** A comment-only cleanup in ColdSimulationWorker required critical (full PR checks + selection-ack). Kept (no relaxation), noted.
5. **CI capacity** (~1 PR run at a time) — unchanged.

## 6. Tools actually needed

- Kept and used: `ci-dispatch.sh` (replaced ~25 hand-typed dispatches at night), `record-land --ref`, same-patch `record-rebase`, `reports/tools/token-usage.py` (the only way to see real cost; it found the accounting error).
- Not added: no new stages, no scheduler, no automatic stacking. The per-task cost table can come from token-usage.py when needed.

## 7. Release 1a state and remaining blockers

`ivan/batch-1a` = **95a12356b** (fork): night's 20 items + DT-214 + DT-243 + RA1-7. Each landed with review, PR checks + Picked on its exact SHA, old-code evidence and a ref-checked landing.

Left in 1a (roadmap): DT-247/DT-248 (crystal/shot ping-pong after a funding refusal; crystals round-tripped through a bot's own line — pre-existing, owner of DT-248 unverified), DT-231 rest (main judges "could it bid" for its withdraw), RA1-2, RA3-2, RA3-3, RM-20 (world test needs a save with an owned hall and a player clan), DT-238 (perf recorder misses partial starvation). Release gates owed: full CI on the final head, the final A/B after code freeze. No traced run was made after DT-214/DT-243 today (their effects are pinned by tests; DT-243's run-level effect — fewer no-leaf builds — is to be confirmed in the A/B).

Workflow development stops here; this state is for the independent audit.
