# Planning and roadmap

## Problems, plans and the roadmap

- Review/audit [tail] findings: `findings-<release>.md`, sorted out at the release boundary (maintainer 11-11).
- One problem = one line in `architecture/problems.md`, whatever found it: id | origin | rule | file:line | what is
  wrong → impact | fix | tag. A problem already there gets the new finder's id merged into its line. Other files cite
  the id, never copy the evidence. At the next task boundary each new line is tagged `[rN]` (a roadmap row of release N
  cites it), `[large]` (its own plan) or `[tail]` (small, here only). At each release boundary a `[tail]` whose origin
  date is two releases old moves to a roadmap row (`[rN]`) or is deleted with its reason (rule 0: not worth its cost);
  problems.md stays within its budget this way, not by a bigger one (maintainer 2026-11-10).
- One queue: `roadmap.md`, numbered releases; a row is a label plus ids or a plan file. Done means gone everywhere: the
  commit that finishes an item deletes its row and its problem lines; obsolete ones go with the reason.
- A roadmap step's plan lives in `target-architecture/step.md` and is deleted when the step lands; its binding
  decisions move first into the map, one clause on the row of the rule each shapes. Maintainer decisions taken outside
  a step go on the problem's line or the plan.md principle they shape.
- The map holds the current state only: an area line is rewritten to the new state, a paid problem's line is deleted;
  no history, no "was/now", no step or decision ids.
- One writer: only one agent at a time edits planning/ (the only editing agent, or the main session). Agents running in
  parallel put their planning edits (problem lines, map clauses, limits rows) in their report; the main session applies
  them. A file over budget is pruned (done items, history, detail to its owner), not given a bigger budget without my
  ok, never squeezed by dropping words.
- No unbounded growth: `node planning/hygiene.js` at every task boundary (exit 1 = prune first). It fails on a file
  outside the list or over its KB budget and on CLAUDE.md over 14 KB or `.claude/workflow/*.md` over 40 KB together, lists stale worktrees, stray files and perf runs
  beyond the kept sets; `--remove` removes clean merged or stale worktrees (branches stay). A new planning file only
  with my ok (added to the list in git.md "Where things are" and to `ALLOWED`).
- Planning files are for agents, not for me: I read reports in chat, never these files. Dense: one item per line, no
  hard wraps or blank lines, no headings or prose for a human reader, file:line instead of description; content stays
  exact (ids, file:line, numbers, reasons), code names in backticks (`check.js` finds stale names by them).
- One file per future release's design (`economy.md` for release 7), options as sections.

