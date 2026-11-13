# Agents and review reference

## Agents

- Drive the work without waiting for me: take decisions by the recommendation, log each (step file or lc issue;
  a parallel agent puts it in its report),
  report at each step and release task; stop and ask only at a fork the plan and rules do not settle (a gameplay fork
  goes to me with your recommendation). Never sit idle: while one lane waits, start what does not depend on it.
- Lanes: the laptop (exclusive for a perf measurement; up to 3 behaviour runs at once), the team VPS (behaviour runs
  only, never perf: a panel world shares it), CI and tables on the fork, read-only agents. Start the longest independent
  job first. Only the release coordinator (main session) assigns machines and starts runs, on reviewed heads; others
  ask it for a runtime slot. One machine per step, no duplicate runs; a step waiting on one machine while the other
  idles is a scheduling miss.
- An editing agent gets its own worktree and branch from the integration head (`git worktree add
  .claude/worktrees/<topic> -b ivan/<topic> <head>`). Editing agents run in parallel only on disjoint files; work on
  overlapping files (the same module, its tests) runs one after another. Read-only agents need no worktree.
- A brief names the plan it works under (the roadmap's release, the step file, `target-architecture/situations.md` for
  the maintainer's answers; the mechanism is population.md "Situations"), carries the paths of CLAUDE.md (/Users/iposukhoff/L2Solo/CLAUDE.md), the workflow reference (/Users/iposukhoff/L2Solo/.claude/workflow/), the map and the plan, and holds at most 4
  items (plan items or findings) so each gets its cause hunt. The main session checks the brief against the plan for
  contradictions (e.g. a plan step that needs a run vs a brief that forbids a server) before sending it. The agent
  labels each change stays (part of the target) / temporary (the comment and the commit name what replaces it, e.g.
  "temporary: until the town plan owns the sell stop") / throwaway (only when without it something breaks now), and
  names every deviation.
- Cost is context × turns: reports ≤ 250 words, not counting the review table (one line per rule and one for the cause, evidence.md "Review"; the reviewer writes it to a file the coordinator passes to `record-review --rules`) (a brief's limit wins); briefs carry handles; targeted tests only; a fix round is a new narrow agent, never a resumed one; the coordinator batches calls and hands off past ~200 k context. Reports: what changed with file:line, decisions, problems, the hard-rule line
  (`0 ok, 3 violation file:line …`, rule 0 for every mechanism added) and `rules-check` output. A report may add `RETRO CANDIDATE: <systemic cause> | <consequence> | <proposed guard>` (a process cause, not the task's bug); the coordinator records it with `record-retro` (`--critical`: a critical process violation). An "ok" needs its evidence: rule 4/5 the concept search and
  its hits, rule 6 the cost in numbers; an answer without it counts as unanswered. Reports to me separate what an agent
  claims from what a review confirmed.
- Context limit (hook `.claude/hooks/agent-context.js`, every agent except a fork): at 200k tokens of its own context an agent's next call is refused once with a hand-over order, and from 240k only Write, Edit and its return work. So every brief names the file the agent's result goes to (a planner is launched as `l2-planner`, which can write its plan file; the built-in Plan type has no Write tool and can only return text); an agent that returns a hand-over (what is established with handles, what is done and committed, what is half-done, the next three steps) is not resumed: the coordinator starts a fresh agent of the same type on that file. A turn costs its whole context: about $0.045 under 100k, $0.10 to $0.12 past 300k.
- A role agent's brief is printed, not written: `.claude/tools/brief <slug> <worktree> <planner|implementer|reviewer> --out <scratch dir> [--round <n>] [--notes <file>]` prints it from the task record and gives the launch prompt; the launch hook refuses a role launch without that file or with a prompt over 1500 characters. `--notes` holds facts of this task only (the lc step and issues, the plan's path, what a run showed); rules are in the role's definition and are not retold. A role agent with no task record yet says "no task record: <why>" in its description.
- Agents are launched by type (`/Users/iposukhoff/L2Solo/.claude/agents/`: `l2-planner`, `l2-implementer`, `l2-reviewer`). A session lists these types only if `.claude/agents/` existed when its program started; one that does not (the Agent tool answers "Agent type not found") launches general-purpose with the prompt beginning "Read /Users/iposukhoff/L2Solo/.claude/agents/l2-<role>.md in full and act as that agent; it outranks this brief." The launch hook refuses a planner, implementer or reviewer launched any other way. Each definition is the only place for its model, effort, tools, standing brief lines and working rules, and its description names the case that passes another model or effort on the launch; nothing is left to the session default, and a hook refuses a launch that names no model or no effort, or Fable outside a named second attempt (`.claude/hooks/agent-launch.js`; maintainer 2026-11-12: the default put seven planners on the top model, 41% of the tokens, at one call per turn). Fable only as the second attempt, at medium effort (an opus planner returned no verified cause, or blockers stand after two review rounds); the report to me names each such launch and its reason; if it also fails, the task stops for my decision.
- Fix batches (review findings, pass findings, run bugs) go plan → check → implement → review:
  - a read-only planner (it first answers the open issues on the code it reads: planning.md "Validating an issue") writes per finding the cause chain, followed to the deepest cause it can prove, with the line `deeper cause: fixed here` or `deeper cause: left as <id> because <exception>` (evidence.md "Cause gate") (symptom where it shows → … → first wrong decision or broken invariant → the rule's owner as *the question it answers* and the function that answers it; a site is never the owner), alternatives ruled out with handles, and for a deleted timer/rest/guard/retry what it alone held and what holds it now, every copy of the concept with search evidence (hot and cold), the fix (keep, delete, the test failing on
    old code), its cost and a hard-rule pre-check; where the toward fix and a quick fix differ, both with costs;
  - a change that moves how bots spread over shared things (spots, market, parties) is first run as an offline
    simulation on real data (the save's population, the real tables and pure code) in the scratchpad, comparing variants
    by numbers (share over capacity, peaks, trips, oscillation, value); the design is picked from those numbers;
  - the main session checks the plan against rules 0, 1, 2, 14 and the brief; an item failing them is dropped or replaced with the reason, even when already decided or implemented;
  - the implementer follows it; the review checks diff vs plan and rules, and asks per fix: does the chain reach the deepest provable cause and not only the wrong decision nearest the symptom (re-derive one link from the handles yourself; check the brief's deeper-cause line against the code), is the owner the mechanism, not the place the symptom shows, does the regression assert the broken invariant, and what did any removed mechanism alone hold?
  - review fixes go to a NEW narrow agent; the second review checks those fixes and related regressions. After two rounds unresolved blockers stop the task; the coordinator chooses replan (the one Fable second attempt named above), split or defer; a failed second attempt goes to the maintainer. Unrelated findings become lc issues (`lc add`). A fix that
    reveals another copy of the same concept means the concept search was incomplete: merge all copies in that fix.
- Ad hoc `Verifier:` prompts end with this return block (replaces "Owner: file:line"): Return: Shows at (file:line). Chain to the first wrong decision or broken invariant (one handle per link), followed to the deepest cause you can prove; one line `deeper cause: fixed here` or `deeper cause: left as <id> because <exception>` (evidence.md "Cause gate"). Alternatives ruled out (handle each). Owner = the question the rule answers + its function; list every copy hot/cold/main/worker by concept; flag two deciders of one step (rule 1). Proof (repro/trace/counterexample) and the share of the counted symptom it explains. A fix at "Shows at" is mitigation only.
- A review agent's brief says "read the relevant /Users/iposukhoff/L2Solo/.claude/workflow/ references from disk; CLAUDE.md (/Users/iposukhoff/L2Solo/CLAUDE.md) only if it is not already in your context or the coordinator says it changed this session; check the task's policy digest (`node /Users/iposukhoff/L2Solo/.claude/workflow.js status <slug>`) and answer every hard rule and `cause` first, as the 17-line review table written to the file this brief names (format: evidence.md "Review" and your definition) (ok with evidence, violation file:line, or N/A with its reason)".
- Review findings are triaged before any fix (fix now / temporary / belongs to step N / reject with reason; a `violation` line of the review table is not rejected by triage: it stands until a later review round replaces it or it is `left` with its allowed issue or decision, evidence.md "Review"); rule 0
  first: a fix that costs more than the harm it prevents is rejected (or the feature that caused it removed). A number
  that improves past what the fix explains (a counter dropping to 0) is checked for a hidden cause (a card held forever
  reads as 0 unwoken builds). A finding in
  temporary code that a planned step rewrites goes to that step, not into a second patch of the temporary code.
- Every batch and release report counts its changes toward / neutral / away; a release adds no "away" without my ok.
  The release report also counts full runs, minutes of blocked development, the share that gave a decision, repeats
  from preparation errors, regressions only runtime found and the cost of repeated implementation cycles, cost per session, role and launch (the lines the report gate asks are listed in one place: lc.md "Measurement"), planning reads (`context-cost.py`), the flow's own cost (`.claude/tools/flow-stats.js --since <release open>`: records per landing, restarts, records lost to a policy change, lifecycle writes outside a command), review rounds and cause corrections per task, and runs the
  retro over all open candidates.
- Cost of agents: resuming a large agent re-reads its whole transcript; a design-level fix spanning several areas goes
  to a new agent of the author's type started on the author's plan file, the rest to new narrow agents (the planner's entries, the plan and rules paths), folded into the
  commit they belong to. No work ahead of need (plans for far steps, extra passes).
- The decision registry (`node planning/target-architecture/decision-registry.js --root <worktree>`) runs after each
  commit of the situations work: exit 0 (no unclassified clock/step site), and `--stale` shows the windows a step
  deleted.

