# Proposal: context budgets instead of file-size limits (for Workflow V5.2; not implemented)

The rule: the canonical lifecycle data is never cut to fit. What is limited is the context an agent is handed. Growth in that context triggers a diagnosis with an owner action; it never triggers deleting text.

## 1. Measured cost (all 622 transcripts of 11-10..11-11: 5 main sessions, 467 subagents)

Tokens ≈ characters / 3.5, counted once per read. Each read then stays in context and is billed again as cache on later turns, so the real cost is higher than these figures.

| Read target | Reads | ≈ tokens | How |
|---|---|---|---|
| target-architecture/*.md | 561 | 990 k | 22 full reads of design docs = 330 k |
| CLAUDE.md (explicit reads, on top of auto-load) | 382 | 515 k | worktree agents read it by absolute path |
| maps (architecture/*.md) | 473 | 393 k | |
| problems.md | 495 | 323 k | 356 grep, 134 partial, 5 full (67 k) |
| workflow/*.md | 146 | 203 k | |
| decision-registry.json | 184 | 87 k | grep/partial |
| roadmap.md | 82 | 64 k | 55 grep |

- **Total planning and policy reads:** about 2.66 M tokens.
- **Main sessions:** 666 reads, of which 596 re-read a file the same session had already read; about 40 k tokens per session.
- **Subagents:** 1 784 reads, of which 927 are re-reads; about 5 k tokens each.
- **Policy reading per role** in V5.2: every role 13.7 KB (CLAUDE.md, routes, evidence); implementer 24.6 KB; landing/CI 24.2 KB; planner/reviewer 23.6 KB; release 31.8 KB. No role reads the 43 KB total that `WORKFLOW_KB = 40` limits.

Conclusion: problems.md's size is not the cost. It is grepped, at about 2.3 k characters per read. The cost drivers are:

- the number of reads and re-reads;
- full reads of target-architecture design docs;
- explicit re-reads of CLAUDE.md.

## 2. What lc already covers

| Requirement | lc today | Gap |
|---|---|---|
| 1 Canonical data without a size limit | the data ref has no budget | `render --write` refuses when over the hygiene KB, which blocks production |
| 2 Limit the context, not the registry | `status` is about 270 B; `show <step\|release\|id>` is scoped | no budget, no paging |
| 3 Active view per release, step and related issues | `show <step>` prints the row and its issue lines | dependencies and decisions not included |
| 4 Closed issues leave the views | `close` archives with evidence | — |
| 5 No duplicates | ids and aliases unique, never reused, `absorb` matches by id | no same-symbol or same-cause check |
| 6 Diagnose growth | triage count, `tails`, `check` warnings | no single diagnosis |
| 7 Warnings, paging, filtering, deterministic output | deterministic render, filter by key | no paging |
| 8 No automatic delete or merge | `absorb` refuses deletions, `drop` needs a reason and authority, there is no merge | — |
| 9 Measure | — | §1 is a one-off script |
| 10 No new infrastructure | met | — |

## 3. Minimal changes

About +120 lines in lc and +60 in tests; no new state except `meta.budgets`.

1. **render --write warns, never blocks.** A view over its old KB budget prints the reason from C3 instead of refusing. The views are grep indexes now, not reading material.
2. **`lc show <key> [--page N]` becomes the agent's pack.**
   - Contents: the row, its issue lines, the open lines of direct dependencies (an archived dependency as one line with its closure), and the decisions the release and issues name.
   - Order is deterministic.
   - The budget comes from `meta.budgets` (`rc: 2 KB`, `pack: 12 KB` per page). Over the budget the pack is paged with a header such as `page 1/3 · 30 of 74 lines · next: lc show 3.behaviour-bugs --page 2`, followed by the C3 diagnosis.
   - A line is never cut and never dropped silently.
3. **One growth line in `status`, and its causes in `check`.** Each cause has an owner action:
   - triage → `place` or `assign`;
   - tails due (exists) → assign, or `drop --rule0` with a reason;
   - possible duplicates: two open issues sharing a backticked symbol in `sites` and a rule number → the maintainer decides on an alias merge or keeping both;
   - stale names: the "member gone" lines `planning/architecture/check.js` already prints for problems.md, run on a temp render → refresh the line, or `drop --fixed-by` with evidence;
   - a row with more than `meta.budgets.rowIssues` (25) issues → splitting it is a decision;
   - resolved issues in landed steps waiting for `close`.
4. **Same symbol or same cause on intake.**
   - `add` and `absorb` print the open issues that share a backticked symbol.
   - `start` prints the open issues whose `sites` name a symbol from the V5.2 brief's `cause.chain`.
   - These are warnings only; nothing is ever merged.
5. **Measurement without a scheduler.** The §1 script becomes `tmp/rc-tools/context-cost`. The RC runs it at release close, as part of the retro already specified 11-11 20:45. The release report gets tokens per role, re-reads and the top files.

## 4. Policy text for V5.2 (replaces the hard limits for lifecycle views)

- **P1** The canonical data (`ivan/lifecycle-data`) has no size budget. An issue leaves only by land, resolve and close, or by `drop` with a reason and authority.
- **P2** Agents read context, not files:
  - the RC reads `lc status`;
  - implementers and reviewers read `lc show <step>` (paged) and grep problems.md by id;
  - a full read of roadmap.md or problems.md is reported by `context-cost`.
- **P3** Budgets apply to context per role: RC status ≤ 2 KB; step pack ≤ 12 KB per page; policy reading per role ≤ 32 KB (measured 24–32 KB). The per-role limit replaces the `WORKFLOW_KB` total.
- **P4** Growth leads to a diagnosis (C3) at task boundaries and at release close, each cause with its owner action. Nothing is deleted or merged to save context.
- **P5** hygiene checks roadmap.md and problems.md for freshness (they equal the last lc render; skipped in shadow), not size. Maps and target-architecture keep their KB budgets for now. target-architecture is the largest read cost (§1), so it is the next candidate for section-addressed reads.
- **P6** planning.md's "a file over budget is pruned" no longer applies to the two lifecycle views.

## 5. Unchanged

V5.1 stays for the open 1a tasks. The cutover still needs its own acceptance (M12). V5.1 budgets apply until V5.2 is installed.
