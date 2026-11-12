# shared helpers, sourced by the coordinator scripts (not run directly)
W=/Users/iposukhoff/L2Solo/.claude/workflow.js
BIN=${${(%):-%x}:A:h}
# ready_json <slug> <worktree> : prints "taskReady|reason; reason" or "ERR|text"; never empty
ready_line() {
  local out; out=$(node $W ready $1 --root $2 2>&1)
  print -r -- "$out" | python3 -c '
import json,sys
t=sys.stdin.read()
try:
    d=json.loads(t)
    print("%s|%s"%(str(d.get("taskReady")).lower(),"; ".join(x[:150] for x in d.get("reasons",[]))))
except Exception:
    print("ERR|"+(t.strip().splitlines() or ["empty answer"])[0])'
}
ai_lines() { git -C $1 log $2 --format='%h %B' | grep -iE 'co-authored-by|claude-session|claude\.ai'; }
# full_run <sha> : the newest PR checks run of that commit as "<id> <status> <conclusion>", "none", or "ERR" when gh fails
full_run() {
  gh run list -R posukhoff/L2Solo --commit $1 --workflow pr-checks.yml --limit 20 --json databaseId,status,conclusion 2>/dev/null | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: print("ERR"); sys.exit()
r=max(d,key=lambda x:x["databaseId"]) if d else None
print("%s %s %s"%(r["databaseId"],r["status"],r["conclusion"] or "-") if r else "none")'
}
# integration_branch : the release's integration branch, from RC_BRANCH or `lc get $RC_RELEASE branch`; no default
LC=/Users/iposukhoff/L2Solo/.claude/lc.js
integration_branch() {
  if [[ -n ${RC_BRANCH:-} ]]; then print -r -- $RC_BRANCH; return 0; fi
  [[ -n ${RC_RELEASE:-} ]] || { echo 'set RC_RELEASE=<lc release key> (or RC_BRANCH=<branch>) first' >&2; return 2; }
  node $LC get $RC_RELEASE branch --repo /Users/iposukhoff/L2Solo
}
