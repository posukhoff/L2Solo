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
