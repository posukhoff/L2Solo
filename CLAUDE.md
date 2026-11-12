# L2Solo — agent entry point

Node.js >=22.5, CommonJS, SQLite, Lineage II C4. Hot bots execute near the player on main; cold simulation runs on a worker. The target is one owner per rule, one decision at named situations, held until the next situation; hot and cold share the same pure rule. Do not trade observable gameplay correctness for apparent performance.

## Read only what your role needs

Start with this file, `planning/architecture/README.md` and the touched area of the architecture map. Read the relevant sections, not all planning files. The workflow reference lives in `.claude/workflow/` in the primary local checkout (not the game-code branch): /Users/iposukhoff/L2Solo/.claude/workflow/; this file is /Users/iposukhoff/L2Solo/CLAUDE.md. Both are git-excluded, so an agent in a worktree reads the references by these absolute paths, and this file only when it is not already in its context (explicit re-reads were the largest avoidable policy cost). Resolve paths from the actual checkout; do not assume a worktree contains local planning. A task brief names the base SHA, route, policy digest and relevant files. Do not use newer policy or map silently for older work: check the recorded SHA/digest and resolve drift with the coordinator.

| Work | Additional reading |
|---|---|
| Any code change | coding.md: applicable domain, style, tests and hard-rule detail |
| Worktree, merge, fork or CI | git.md, testing.md |
| Planning / review | agents.md, planning.md; touched map and plan; `node .claude/lc.js status` |
| Runtime/benchmark/release | testing.md, release.md, planning/perf-tooling/test-recipe.md |

The files above are under `.claude/workflow/`. This entry point and routes.md control workflow cadence; detailed references preserve project-specific engineering policy. If a detailed reference describes the old universal review or audit cadence, routes.md supersedes that cadence only. No gameplay, security, performance or release gate is relaxed.

### Hard rules (every change; a review answers each one for the diff)

Each as the question a review asks (each answered: ok with evidence, violation file:line, or N/A with its reason); detail in coding.md.
0. Need: for each added piece of code, state, message, special case or test: what breaks for a player or the server
   without it (a number or a concrete case)? Nothing observable → do not add it. Of two correct fixes take the cheaper
   per bot per step, then the one adding less mechanism (state, paths, special cases; not fewer lines); deleting is a
   fix. A gain too small to see (a few builds per hour) does not buy a new mechanism.
1. One question: does each decision touched answer one question and own its output? Is every situation a physical fact
   (no prices, board, clock or another decision's answer inside it)?
2. Situations, not time: is a decision taken only at its named situations and held between them? Any new window, timer
   or "again after N s"? (Only for a situation with no event yet: reason + limits.md row + the missing event as an
   lc issue.)
3. Owner: is the fix in the mechanism that owns the rule, not a guard, special case or retry at the call site?
4. One path: does it add a second mechanism for something that exists? Every copy of the concept is listed (search
   terms and hits, hot and cold); the change merges them or names each one left as an lc issue. Is the replaced
   path deleted in the same change, with its tests and config keys?
5. Hot = cold: do hot and cold call one function for the rule?
6. Cost: what does it add per bot per step (CPU, allocations, DB writes, worker messages), on main or the worker? Any
   per-tick scan over all bots, or main rebuilding what the worker published? Can one turn of main or the worker run
   long (a loop over bots or a whole decision in one go)? Work is sliced so no turn blocks the thread (targets:
   limits.md "Turn length" and "Worker lag"); a plan names its longest turn, a review checks the yield points.
7. Caches: is each cache key exactly the result's named inputs?
8. Failures: is every survived failure counted via `FailureLog`, every decision and lifecycle end traced, every limit
   a limits.md row with an observable hit?
9. Purity: are rules pure functions of plain data (no World/DB, seeded rolls); does worker code avoid World?
10. Data: named fields across modules, the worker boundary and storage; state objects replaced, not edited in place?
11. Tests: do they pin behaviour a player or the world sees, not internals, and fail on the old code?
12. C4: does behaviour follow C4 (source named when chosen), or say it is our choice?
13. Text: do comments state the rule (never cite `planning/`); does the map follow the change; are commits free of AI
    co-author/session lines? (`node planning/rules-check.js <base>..<head> --root <tree>`: the mechanical part.)
14. Trade: one line per change: its cost, what a C4 player does here, what it gives up (simulation, realism,
    performance). A review asks "would a player do this?" as it asks the cost.
15. Direction: toward the target architecture (coding.md "Target architecture"), neutral, or away? Away only with its reason, an lc issue
    and the named replacement; a review counts it like a violation otherwise.


## Routes and stopping conditions

A task runs on a route (fast, standard, critical: `.claude/workflow/routes.md`) with a recorded evidence brief (`.claude/workflow/evidence.md`). Whoever plans, implements, reviews or lands a task reads both first; a read-only search agent does not. A bug's cause is verified with trace/test/source handles before implementation; an unknown root cause is an investigation, not leave to implement. Escalate when uncertain; never downgrade to avoid checks or weaken a hard invariant. A review answers every hard rule; a second review is scoped to the fixes and related regressions; after two rounds unresolved blockers stop the task for a coordinator decision. Unrelated findings become lc issues (`lc add`), never a silent expansion of the task (a small fix is taken in only by name in the brief: planning.md "Small fixes").

Tasks and releases live in lc only (planning.md): read with `node .claude/lc.js status` / `show <step>`; create, edit, place, move and close through lc; roadmap.md and problems.md are generated, never edited. The coordinator records task evidence with `node .claude/workflow.js` (routes.md); `ready` is evidence, not leave to merge. Never push to shared origin or open a PR without explicit authorization (the one standing ask: fast-forward `ivan/next-release` to origin when release commits or a develop update land on it, git.md); never expose secrets. Long game runs only by the RC after the readiness gate (release.md). Maps stay local, single-writer, current-state only.
