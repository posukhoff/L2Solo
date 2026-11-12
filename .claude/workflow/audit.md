# Sample audit of landed tasks (read-only)

The release coordinator sends one auditor at the release close, after the freeze: `lc sample <release>` names three landed tasks (picked by the frozen head, not by the coordinator) with their commit ranges. Launch: opus, effort high, read-only. The launch message gives only the ranges, the frozen head `<head>`, the output file and this file's path; nothing about what the tasks fixed or how their reviews went.

You audit commits that already landed in the L2Solo project (a Node.js Lineage II C4 server with simulated bot players; hot bots run near the player on the main thread, cold bots are simulated on a worker). Each commit was planned, implemented and reviewed by other agents. Nobody tells you what those reviews found, and you must not look: your answers are compared with theirs to measure what reviews miss. You change nothing in any repository or tracker. You write exactly one file: the output file named in your task.

## What you may read
- The hard rules: `/Users/iposukhoff/L2Solo/CLAUDE.md`, section "Hard rules" (questions 0 to 15). Their detail: `/Users/iposukhoff/L2Solo/.claude/workflow/coding.md` (the sections your commits touch, not the whole file).
- The commits: `git -C /Users/iposukhoff/L2Solo log --format='%H %s' <range>` and `show <sha>` (message, src and tests). Code as it is at the frozen head: `git -C /Users/iposukhoff/L2Solo show <head>:<path>` and `git -C /Users/iposukhoff/L2Solo grep -n <pattern> <head> -- src tests`. Do not read the working files under `/Users/iposukhoff/L2Solo/src` (another branch is checked out there).
- The architecture map when you need to know who owns a rule: `/Users/iposukhoff/L2Solo/planning/architecture/README.md` and the one area file it points to.
- Not allowed: anything under `.git/l2solo-workflow`, `/Users/iposukhoff/L2Solo/tmp`, session transcripts, `planning/architecture/problems.md`, `node .claude/lc.js` (they hold the reviews' and planners' conclusions). No servers, no tests, no scripts that run game code.

## The questions, per commit
Answer each of the 16 hard rules (0 to 15) for the commit's diff, and one more, `cause`: does the commit fix the cause in the mechanism that owns the rule, or a nearer symptom (a guard, a retry, a special case at the place where it showed)? Judge the code, not the commit message: check a claim in the message against the diff.

A `violation` needs all of: the file:line (in the commit, and whether the code at the frozen head still has it); the sentence of the rule it breaks; what a player or the server would observe, or for a rule about structure (owner, one path, purity, tests) what concretely is wrong (the second copy and where, the internal a test pins, the behaviour no test pins). Do not report style, naming or anything the rules do not ask. If you cannot establish something in a few tool calls, the verdict is `unsure` with what blocked you; do not guess a violation.

Things reviews are known to miss, look at them on purpose: a cache whose key lacks one of the result's inputs (rule 7); a test that passes on the old code or pins an internal (rule 11: say which assert); a survived failure with no FailureLog count (rule 8); the same concept left in a second place, hot or cold (rules 4, 5: grep the concept's names at the frozen head); a call added to a per-step or per-tick body (rules 2, 6); a comment or commit message that claims C4 behaviour without a source, or cites planning files (rules 12, 13); cost per bot per step on a hot path (rule 6).

## How you work
- About 12 tool calls per commit. Send independent greps and reads together in one message. Read the diff first, then only the code around what it touches.
- Append to the output file after each commit. The last commit of each range is the task's landed head: its line must be there, with its sha written as git prints it.

## Output
One JSON object per line, one line per commit:
`{"sha":"…","answers":{"0":"ok|violation|na|unsure","1":"…", … ,"15":"…","cause":"owner|nearer|na|unsure"},"violations":[{"rule":7,"where":"src/…:123","at_head":true,"breaks":"the rule's sentence in a clause","seen":"what is observed or what is concretely wrong","severity":"blocker|minor"}],"unsure":[{"rule":6,"why":"…"}],"note":"one sentence on the commit as a whole"}`

Your final message: per commit the sha and the count of violations and unsure, nothing else.

## What the coordinator does with it
Each violation with `at_head: true` is a claim, not a fact: read the code, then record what holds as an lc issue (`lc add … --pass audit`) and count the rest as refuted. The release report carries the line `sample audit: <n> claimed · recorded <lc ids|none> · refuted <n>`, and `lc gate <release> report --ref <report> --audit <the output file>` checks it against the file.
