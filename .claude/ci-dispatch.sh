#!/bin/zsh
# CI for a task's exact SHA: PR checks (ci-<sha>) and, when `verify` selects map tests, one Picked list commit
# (tests/list-<sha>: geodata-only names and +optional raw-map names). Pushes to the fork only (gpush.sh retries).
# Usage: ci-dispatch.sh <task-worktree> <slug> [--no-pr]
set -u
wt=$1 slug=$2; cd "$wt" || exit 1
[[ -z $(git status --porcelain) ]] || { echo 'worktree not clean'; exit 1; }
here=$(git rev-parse HEAD); s=$(git rev-parse --short=9 HEAD); W=/Users/iposukhoff/L2Solo/.claude/workflow.js; P=${0:A:h}/gpush.sh
plan=$(node $W verify $slug --root $PWD) || { echo "verify failed: $plan" | head -3; exit 1; }
names=$(print -r -- "$plan" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("\n".join([t[5:-3] for t in d["geodataOnly"]]+["+"+t[5:-3] for t in d["optionalGeodata"]]))')
if [[ ${3:-} != --no-pr ]]; then
  $P fork HEAD:refs/heads/ci-$s >/dev/null || exit 1
  sleep 2; gh workflow run pr-checks.yml -R posukhoff/L2Solo --ref ci-$s || exit 1
fi
[[ -z $names ]] && { echo "no Picked tests for $s"; exit 0; }
printf '%s\n' "$names" > ci-tests.txt
git add ci-tests.txt && git -c user.name=iposukhoff commit -q -m "ci tests"
$P fork HEAD:refs/heads/tests/list-$s >/dev/null; rc=$?
git reset -q --hard $here
[[ $rc == 0 ]] && echo "PR ci-$s + Picked tests/list-$s ($(print -r -- "$names" | wc -l | tr -d ' ') files)"
exit $rc
