# Git and machine operations

## Where things are

- Main checkout /Users/iposukhoff/L2Solo; work happens in worktrees under `.claude/worktrees/<topic>`. A new worktree
  needs `ln -s /Users/iposukhoff/L2Solo/node_modules` and, for a server, `L2NODE_GEODATA_DIR=/Users/iposukhoff/L2Solo/data/Geodata`;
  geodata tests fail in a worktree without it (they run on CI).
- Planning, a closed list (`planning/hygiene.js` `ALLOWED` fails on any other file): `roadmap.md` the one queue
  (numbered releases, rows cite ids); `architecture/`: `README.md` (index, how the map is kept, category passes), area
  maps `bot-ai.md` `combat.md` `economy.md` `population.md` (with the situations mechanism) `persistence.md` `world.md`
  `tables.md` `e2e.md`, `limits.md`, `problems.md` (every open problem, rendered by lc), `check.js`; `target-architecture/`: `plan.md`
  (principles and large plans), `situations.md` (maintainer answers still binding), `economy.md` (release 2 design),
  `memory.md` (memory census), `step.md` (the open roadmap step's plan, only while one is open),
  `decision-registry.js/.json`; `perf-tooling/test-recipe.md`; `hygiene.js`, `rules-check.js`, `tests-for.js`,
  `coverage.js`.
- Coordinator scripts: `.claude/tools/` (`land`, `check-candidate`, `ci-finish`, `wait-ci`, `laptop-run`, `vps-run`, `wait-vps`, token counters; each prints its usage), `.claude/ci-dispatch.sh`, `gpush.sh`, `prune-branches.sh`.
- Fix-batch plans, review notes, simulations and run copies live in the session scratchpad, never in the repo or planning/.
- Auto memory (`~/.claude/projects/-Users-iposukhoff-L2Solo/memory/`): facts outside the repo only (e.g. the team VPS).

## Git

- `origin` = `pmbstyle/L2Solo` (shared, I have push), `fork` = `posukhoff/L2Solo` (my staging area and CI runner).
- `ivan/next-release` is the release branch: finished work goes to `origin` only by a PR from it into `develop`; only
  a fix for the released game goes into `main`. The integration branch of the release being built is
  `ivan/batch-<n>` or the landing branch the session names (local + fork; scripts read it with `lc get <release> branch`,
  never a hardcoded name); a worktree branch lands on it as one commit
  per task, never a merge commit or the agent's commit series: `.claude/tools/land` folds the task's own commits into one (`--message <file>` gives its message when there are several), keeps each small fix named in the brief as its own commit after it and makes the table builds (commits changing only `data/Bots/`) one commit at the end; a series already of that shape is fast-forwarded. The folded series ends in exactly the reviewed tree or nothing lands, and the task's evidence holds on it (evidence.md "same tree").
- One coordinator lands queued reviewed topics in readiness order; agents do not chase the moving batch. Stack only on a topic with a passed review and green CI on its selection; else base it on the integration head alone. After a landing, move the rest with `record-rebase --base <parent> --from-head <old-tip> --evidence <recheck>`: the same patch on a base that left its files unchanged keeps its review and old-code evidence; otherwise they are redone; SHA receipts never carry. `.claude/ci-dispatch.sh` sends both CI runs. No blind reset --soft onto a moving ref. Full CI after a passed review unless overlap saves time.
- No regroup (maintainer 2026-11-10): the integration branch's commits go to `ivan/next-release` as they are, so each
  lands in its final form: one per step or bug, review fixes and their tests folded in before it is pushed, a message
  that says what changed in the game. A fix found after the push is its own commit naming the bug it fixes, never "fix
  the fix", test-only or WIP commits. Standing ask: push `ivan/next-release` to `origin` when release commits or a
  develop update land on it (fast-forward, never force; a pushed commit is never reworded). Never push anything else to
  `origin` (`ivan/perf-remote` stays there, unmerged by my choice), open a PR or
  merge without my explicit ask.
- Pushing the integration/work branch and `ci-*` / `tests/*` / `tables/*` branches to `fork` is allowed without asking,
  never with force (prune's `--force-with-lease` ref deletion of a finished branch is a deletion, not a history rewrite; a force push of a rebased integration branch to the fork only with my ok).
- Before a session's work: `git fetch --multiple fork origin` (I may have pushed from another machine).
- At each task boundary (a task finished, before the next roadmap item, before a PR): `git fetch origin`;
  `git log ivan/next-release..origin/develop` non-empty = Slava's work landed. Then: fast-forward or merge develop into
  `ivan/next-release` in a scratch worktree, the Picked tests of `tests-for.js` on the merge diff, the architecture pass
  on that diff (release.md "Releases"), push it; then merge it into the integration branch (the only merge commit there): conflicts keep both
  intents; where Slava fixed code we rewrote, port his fix's intent into our code with a test of what the player sees.
- Branch hygiene: inspect `.claude/prune-branches.sh --dry-run` after CI/PR; apply explicitly with `--apply`. Temporary fork refs require completed runs for the exact SHA, older than one day. Shared-origin and local branch cleanup is manual. Never touch other people's branches in origin.
- Never bare `git stash` (shared across worktrees); set work aside with a WIP commit.
- Push failures `Permission denied (publickey)` while `ssh-add -l` lists the key: `GIT_SSH_COMMAND="ssh -o
  IdentitiesOnly=yes -i ~/.ssh/id_ed25519"`; `.claude/gpush.sh <push args>` does that with retries.

