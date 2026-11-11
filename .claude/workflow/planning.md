# Planning and roadmap

## Problems, plans and the roadmap

- Review/audit [tail] findings: `findings-<release>.md`, sorted out at the release boundary (maintainer 11-11).
- One problem = one line in `architecture/problems.md`, whatever found it: id | origin | rule | file:line | what is
  wrong → impact | fix | tag. A problem already there gets the new finder's id merged into its line. Other files cite
  the id, never copy the evidence. At the next task boundary each new line is tagged `[rN]` (a roadmap row of release N
  cites it), `[large]` (its own plan) or `[tail]` (small, here only). At each release boundary a `[tail]` whose origin
  date is two releases old moves to a roadmap row (`[rN]`) or is deleted with its reason (rule 0: not worth its cost);
  `lc tails` lists the due ones (part of the growth diagnosis; maintainer 2026-11-10, sizes as guides 11-11).
- Planning state: the fork ref `ivan/lifecycle-data`, kept by `node .claude/lc.js` (reference `.claude/lc.md`). Until the cutover
  acceptance (M12, after 1a) it runs in shadow: these files stay hand-edited, `lc absorb`/`render --out` show drift. After it
  roadmap.md and problems.md are rendered (`render --write` only with my ok); agents still append problem lines and the
  main session takes them with `lc absorb`; placing, closing and release state go through lc only.
- One queue: `roadmap.md`, numbered releases; a row is a label plus ids or a plan file. Done means gone everywhere: the
  commit that finishes an item deletes its row and its problem lines; obsolete ones go with the reason.
- A roadmap step's plan lives in `target-architecture/step.md` and is deleted when the step lands; its binding
  decisions move first into the map, one clause on the row of the rule each shapes. Maintainer decisions taken outside
  a step go on the problem's line or the plan.md principle they shape.
- The map holds the current state only: an area line is rewritten to the new state, a paid problem's line is deleted;
  no history, no "was/now", no step or decision ids.
- One writer: only one agent at a time edits planning/ (the only editing agent, or the main session). Agents running in
  parallel put their planning edits (problem lines, map clauses, limits rows) in their report; the main session applies
  them. Sizes are guides, never gates: hygiene prints a size note, nobody trims text to fit; growth is diagnosed (who
  reads it, how often: context-cost) and fixed at its cause. roadmap.md and problems.md have no size guide: lc keeps all open data; the
  context is budgeted (lc show pages a step's pack; growth is diagnosed by lc status/check with an owner action per
  cause: place, assign or drop with reason, decide a duplicate, refresh a stale line, split a broad row); nothing is
  deleted or merged to save context.
- No unbounded growth: `node planning/hygiene.js` at every task boundary (exit 1 = clean up first). It fails on a file
  outside the list, on lifecycle views that are not the lc render after the cutover, on stale worktrees, stray files and perf runs
  beyond the kept sets, and prints size notes (planning files, CLAUDE.md 14 KB, 32 KB of policy per role) without failing;
  `--remove` removes clean merged or stale worktrees (branches stay). A new planning file only
  with my ok (added to the list in git.md "Where things are" and to `ALLOWED`).
- Planning files are for agents, not for me: I read reports in chat, never these files. Dense: one item per line, no
  hard wraps or blank lines, no headings or prose for a human reader, file:line instead of description; content stays
  exact (ids, file:line, numbers, reasons), code names in backticks (`check.js` finds stale names by them).
- One file per future release's design (`economy.md` for release 2), options as sections.

