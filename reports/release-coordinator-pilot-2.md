# Release Coordinator pilot 2, release 1a, 2026-11-11 (14:17-16:00 EET)

For the workflow analyst. Policy V5.1 frozen at `da25f2b85`, unchanged. Pilot 1: `reports/release-coordinator-pilot.md`
(this branch's parent). State file: `tmp/release-1a-pilot.md` (local). Times EET. Tokens: input-equivalent
(input + 1.25 × cache write + 0.1 × cache read + 5 × output) from `reports/tools/token-usage.py`.

Model under test: one release coordinator (RC); a step coordinator (SC) only for a step expected to need > 3
sub-agent calls, on Sonnet (effort medium), orchestration only; small steps delegated by RC directly. Verifier and
reviewer on Opus when the judgement is hard, Sonnet otherwise; implementers on Sonnet.

## 1. Steps finished (fork `ivan/batch-1a`: 0c759221c → **3c164d3cc**, all four landed)

| Step | Mode | Landed SHA | Start → land | Review rounds (defects) | CI (exact SHA) | Runtime check |
|---|---|---|---|---|---|---|
| A tail: DT-247/248 (from pilot 1) | RC direct (SC not resumed) | 5e6f1e009 | run 14:18 → land 14:53 | post-rebase scoped 1 (0) | PR 43023316113, Picked 43023326816 | VPS 15 min vs base cut to 15 min: refusals ≤2 s 94 → 88, worst bot 6 → 3, flips 42 → 22, round trips 0.53 % → 1.32 % (was 15.6 % at the previous head); Soul Ore ×4.9 → DT-249, left to the economy redesign (maintainer) |
| D: DT-238 recorder sample gaps | RC direct | 0ab48bbfd | 14:20 → 14:38 (18 min) | 2 + selection-ack (5 fix-now: wrong brief evidence, false comment, wrong output on old runs, 3 names for one count, missing test) | PR 43021045480 | none needed (tooling); reviewer measured the threshold on 7 saved runs |
| C: DT-231 main withdraw | **SC (Sonnet)** | f44a63cf3 | 14:18 → 15:33 (75 min) | 1 by SC + post-rebase 1 by RC (0) | PR 43021953159 + Picked 43021963301; after rebase PR 43025237551 + Picked 43025249157 | hot 20 min: no flow regression (buys +7 %, IPC +8 %, decisions +10 %, faults 0); world-kept 15-min run: churn not measurable (no bid records, DT-259), proxies in the intended direction |
| E: RA3-2 design-id comments | RC direct | 3c164d3cc | 14:56 → 16:09 (73 min) | 2 (round 1 BLOCKED: 4 wrong comments of ~60 sampled + 9 leftover ids) | PR 43030705421 **red**: stale bot tables (32 table-input files had comment edits; DT-261); Picked 43030716125 green; tables 43031842726 rebuilt (content minus `header` identical in all 10 tables, checked by RC and reviewer); final PR 43034666896 + Picked 43034678746 green | none (comments only; acorn token streams equal in 127 files) |

Deferred by the freeze: RA3-3 and RA3-2's CITE check change `planning/rules-check.js`, which is in the V5.1 policy
digest (`.claude/workflow.js:20`) → roadmap section 2 (maintainer).
Regressions caught before integration: A's Soul Ore ×4.9 (accepted as DT-249 by the maintainer); D's wrong output
for old runs; E's false comment. No regression found after landing.

## 2. Tokens (14:17-15:35, 22 transcripts; final to 16:10 below the table)

| Level | Transcripts | Messages | Input-equivalent | Share |
|---|---|---|---|---|
| Release coordinator | 1 | 104 | 3.26 M | 39.5 % |
| Step coordinator (C, Sonnet) | 1 | 20 | 0.23 M | 2.8 % |
| Verifiers | 5 | 74 | 0.97 M | 11.7 % |
| Implementers | 7 | 145 | 1.90 M | 23.0 % |
| Reviewers | 8 | 146 | 1.91 M | 23.0 % |
| Total | 22 | 489 | **8.27 M** | |

Final to 16:10 (24 transcripts): total 9.76 M, RC 4.49 M (46 %), SC 0.23 M (2.4 %), verifiers 0.97 M, implementers 2.04 M, reviewers 2.03 M. The RC share kept rising with every turn at full context, which supports change 2 in §6.

Per step (sub-agents only; RC shared on top): C 2.44 M (SC 0.23 + its verifier 0.20 / implementer 0.62 / reviewer
0.47 + RC-run post-rebase review 0.42 + two run verifiers 0.50); D 0.95 M; E ~0.95 M (incl. tables rebuild and review 3); A tail 0.40 M; helper scripts
0.26 M; planning update 0.17 M.

Against pilot 1 (28.3 M for two critical steps, one landed, SC 28.2 %, RC 7.3 %): the SC level fell from ~3-4 M per
step (Opus, analysis and polling in context, 4-6 resumes) to 0.23 M. Total cost per landed step fell from ~14 M to
~1-2.5 M. **Not like for like:** pilot 1's steps each needed a second cause round after a traced run found a
regression; C, D and E did not.

**RC overrun.** RC rose to 3.26 M (≈ 31 k per message). Two causes: (1) the RC context was carried over from
pilot 1 in the same session (~250-300 k cached per turn, past the V5.1 hand-off guideline of ~200 k); (2) for
direct steps RC runs the CLI, CI, rebases and landings itself (~10-15 tool calls per step). Cause (1) is the larger
one: pilot 1's RC averaged ~17 k per message at a smaller context.

## 3. Time

| | Agent work | Checks (CI + runs) | Waiting | Coordination incidents |
|---|---|---|---|---|
| A tail | 10 min (verifier, scoped review) | run 22 min, CI 12 min | VPS idle 13:57-14:18 (RC launcher read an ssh "Network unreachable" as started) | resale verifier stopped by maintainer decision |
| D | 12 min | CI 7 min | — | CLI refused route fast (src/Perf is a critical surface) → new slug |
| C | 18 min (SC) + 9 min (RC review/verifiers) | CI 2 × ~10 min, runs 26 + 21 min | 2 min for the VPS | first hot run without `--keep-world` (RC error) → bid metrics lost → second run |
| E | 8 min implementers, 9 min reviews | CI ~15 min | waited for C's landing on purpose (one rebase + one review instead of two) | `record-rebase` refused (task paths changed) → new slug |

Machine time: VPS 69 min (A 22, C 26 + 21), ~21 min idle by an RC error; laptop no runs (agents' local tests).
CI (fork, 14:31-15:44): 5 PR-checks runs (D 43021045480, C 43021953159, A 43023316113, C after rebase 43025237551, E 43030705421) and 4 Picked runs (C 43021963301, A 43023326816, C 43025249157, E 43030716125); 1 red (E PR checks: stale bot tables, not a test failure), 0 cancelled, 0 reruns; plus 1 Tables run for E (43031842726) and E's final PR 43034666896 + Picked 43034678746 (green): in total 6 PR checks, 5 Picked, 1 Tables. C ran its CI twice because the rebase onto A changed a shared test file.
Re-investigations: 1 stopped (resale, maintainer); 1 repeated run (C, RC error). Cause corrections: 0.

## 4. Was the SC useful?

- **C (SC):** yes, at Sonnet cost. It ran verifier → implementer → reviewer → CI request cleanly in 18 min for
  0.23 M, returned a ≤150-word report with handles, and stopped at NEED-RUN as instructed. The post-landing work
  (rebase, re-review, runs) went through RC because the SC had finished. That part is the same for both modes.
- **D, E (direct):** fine without an SC. The RC did ~10-15 CLI/CI/landing calls per step, cheap per call but paid at
  RC context size. For E the review fan-out (implementer → BLOCKED review → fix + rebase → scoped review) would have
  been the same under an SC.
- Conclusion for the analyst: an SC on Sonnet costs ~0.2 M and removes RC tool calls; at RC contexts above ~100 k it
  is cheaper to give even small steps a Sonnet SC than to drive them from RC. Below that, direct is cheaper.

## 5. Problems seen (pilot 2)

1. **RC context not reset between pilots** → RC 39.5 %. The handoff guideline existed and was not followed.
2. **RC hand-written shell loops failed three times** (ssh error read as a start; zsh did not split an id list →
   polled a bogus run; launcher of a non-executable script). Replaced by tested helpers (§6).
3. **A run launched without the needed outputs** (`perf.js remote run` without `--keep-world`): testing.md's
   first-minutes self-check ("trace present, diagnostics on, world kept") was not applied by RC.
4. **Evidence quality:** D's brief claimed a run had no cpu profiles (it had 68); C's receipts included 4
   "pass on both" guard tests recorded as regression receipts; the planning sub-agent pruned DT-144 without
   verifying the fix (RC restored it with "verify then prune").
5. **A comment-only change broke PR checks** through the bot-table staleness hash (DT-261): +20 min tables CI.
6. **Telemetry gap** (DT-259): bid post/withdraw leaves no record, so trade-loop checks on bids are impossible today.
7. **CLI friction (V5.1, unchanged):** route escalation and changed task paths need a new slug and a re-recorded
   brief; there is no run-record command; `ready` needs an explicit `--selection-ack` from a reviewer after full CI.

## 6. Changes worth keeping (proposal; the analyst decides)

1. SC only for steps expected to need > 3 sub-agent calls; SC on Sonnet; no analysis, counting or polling in the SC
   (pilot 1 rule 1). Measured effect: SC 0.23 M vs 3-4 M.
2. **RC hands off to a fresh session from the state file after every 2-3 landings or past ~150 k context.**
3. Fresh narrow agents for fix rounds and run counts; never resume a large context (A's tail cost 0.40 M instead of
   resuming a 3.8 M SC).
4. Helper scripts instead of hand-written loops and repeated sequences (scratchpad `bin/`, not in the V5.1 digest):
   `wait-ci`, `wait-vps` (must see the job running; ssh error = not yet), `ci-finish`, `check-candidate`, `land`
   (refuses unless synced, fast-forward, ready, no AI lines), `vps-run` (pushes the commit, waits for a free VPS,
   confirms the start), `laptop-run`, `pilot-tokens`. First real uses of `land`, `ci-finish`, `vps-run` worked.
   Candidates for a permanent place in `.claude/`.
5. Runs: one per step against a saved base, 15-min window for the player script, only when the change moves rates;
   a run that must count per-bot behaviour keeps the world (use `vps-run`/tracejob, which always keep it).
6. Land independent steps as soon as each is ready; sequence only those sharing files, and land the one that others
   would conflict with first (E waited for C → one rebase, one scoped review).
7. No file locks; overlaps found by `check-candidate --against` and paid by the V5.1 rebase rule.

## 7. What blocks finishing release 1a

- RM-20: world-test measurement of PvP/revenge and clan paths needs a save with an owned hall and a player clan
  (save 312ebb2e has neither); RC task at release level.
- Release gates: full CI on the final head; the final traced run with coverage and invariants (testing.md 15-18,
  31); final A/B after code freeze: cold 30 min with player + hot 20 min, sequential, vs 9d6bf579a and 21ef29385,
  save d2f4aa5d.
- Open findings entered in problems.md: DT-249 (resale Soul Ore), DT-250..257 (from A, B2), DT-258..260 (from C),
  DT-144 (verify then prune).
- Policy: RA3-3 and the CITE check wait for the V5.1 freeze to end.
