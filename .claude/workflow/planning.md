# Planning and roadmap

## Problems, plans and the roadmap

- Review/audit findings: `lc add` (they enter triage) or the finder's report to the main session; no findings file.
- One problem = one lc issue (its line in `architecture/problems.md`: id | origin | rule | file:line | what is
  wrong → impact | fix | tag), whatever found it; a problem already there gets the new finder's id as an alias. Other
  files cite the id, never copy the evidence. The tag comes from the issue's place in lc: `[rN]` (a row of release N),
  `[large]` (its own plan), `[tail]` (small, here only, or triage). At each release boundary a `[tail]` whose origin
  date (for a debt or gap: its last confirmation, `lc seen`) is two releases old moves to a roadmap row (`[rN]`), is deleted with its reason (rule 0: not worth its cost; `--gone`: the code no longer has it), or, a debt or gap that still holds, is confirmed again;
  `lc tails` lists the due ones (part of the growth diagnosis; maintainer 2026-11-10, sizes as guides 11-11).
- Kinds (maintainer 2026-11-12): what an issue is decides where it lives and how it ends. Set with `lc add --kind` or `lc kind <kind> <id...>`, read with `lc list --kind <kind>`; optional until the open issues are classified.
  - `bug`: a player sees wrong behaviour. `risk`: the server can fall, hang or lose data. Both say what is seen after `→` in the what field, go to a fix release (or sit in the planned step whose mechanism is their fix) and close by their own result (`lc resolve`). A risk may instead be accepted by my decision. Their count does not grow from one release close to the next (`lc status`, the kinds line).
  - `missing`: C4 has it and we do not, or we differ on purpose. It names its C4 source and sits in a feature release.
  - `debt`: a rule broken with no symptom. `gap`: no counter, test or limit. Both stay with the code (`[tail]`), not parked in a release row: the task that touches their site takes them in, or one task closes a module's batch.
- Validating an issue is three answers with evidence: still true (file:line today), what a player or the server sees, not a duplicate.
  - At `lc add` the finder gives them.
  - At every touch the task's planner gives them for the open issues on the code it reads; the `l2-planner` type carries the instruction (`lc near <step|id|Module>`), the coordinator records the answers: still true → `lc seen <id...> --by <who date>`, gone → `lc drop <id> --reason … --gone <file:line>`, taken into the task → `lc assign`.
  - At a release close: the sections the release touched.
- Assembling a release (maintainer 2026-11-12). `lc next` prints the fix queue, the live releases, the next planned release and what it still lacks.
  - A fix release assembles itself: every `bug` or `risk` with a verified cause enters it (one without a cause enters as an investigation step and leaves if none is found); debt and gap on the same code ride along when the planner takes them in. Bugs before risks, then by player impact. It freezes after 6 landed steps or 24 h open, whichever comes first; the rest waits for the next one. Its steps are split to one cause each, never given a plan file.
  - A planned release is its roadmap row in my order. Before it opens, a readiness pass by a cheap agent confirms each issue against the code (`lc seen`, `lc drop --gone`), splits the row into steps of at most 4 issues or names the step's plan with its order of commits (`lc step set <step> --plan <file>`: the step's file under target-architecture/), and sends debt and gap the mechanism does not own to the tail. Then I get one message with the result (steps, issues, gone, moved) and answer once for the whole release.
  - Triage is empty when any release opens: each issue has a kind and a place or is dropped. If bugs and risks grew over a release, the next one is a fix release.
  - lc refuses `open` while a bug or risk has no release, and `start` on a step over 4 issues without a plan; the rest of this bullet is the coordinator's to keep.
  - My decision is needed only for gameplay forks, which `missing` things to build, accepting a risk unfixed, and moves between numbered releases.
- Planning state is lc (cutover 2026-11-11): the fork ref `ivan/lifecycle-data`, kept by `node .claude/lc.js`
  (reference `.claude/lc.md`), is the only source of issues, releases, placement, dependencies and closing. roadmap.md
  and problems.md are rendered views: never edit them. Create, edit, place, move and close only through lc (`add`, `edit`, `kind`, `seen`,
  `assign`, `place`, `dep`, `defer`, `land`, `resolve`, `close`, `drop`), then `lc render --write`. A hand edit of a view is
  refused, never taken in: redo it through lc. New issues enter triage; `place` uses only unambiguous rules (a row naming
  the issue, or a maintainer placement rule). An unknown root cause is an investigation, not leave to implement.
  Lifecycle data changes only by lc commands: no script calls lc's `save`; a correction no command covers waits for one.
- One queue: `roadmap.md` (rendered), numbered releases; a row is a lc step: a label plus ids or a plan file. Done means
  archived by lc (land, resolve and close; or drop with its reason and authority) and gone from the views.
- A roadmap step's plan lives in `target-architecture/step.md` and is deleted when the step lands; its binding
  decisions move first into the map, one clause on the row of the rule each shapes. Maintainer decisions taken outside
  a step go on the lc issue or the plan.md principle they shape.
- The map holds the current state only: an area line is rewritten to the new state, a paid problem is closed through lc (its line leaves the view);
  no history, no "was/now", no step or decision ids.
- One writer: only one agent at a time edits planning/ (the only editing agent, or the main session). Agents running in
  parallel put their planning edits (new issues for `lc add`, map clauses, limits rows) in their report; the main session applies
  them. Sizes are guides, never gates: hygiene prints a size note, nobody trims text to fit; growth is diagnosed (who
  reads it, how often: context-cost) and fixed at its cause. roadmap.md and problems.md have no size guide: lc keeps all open data; the
  context is budgeted (lc show pages a step's pack; growth is diagnosed by lc status/check with an owner action per
  cause: place, assign or drop with reason, decide a duplicate, refresh a stale line, split a broad row into steps); nothing is
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

