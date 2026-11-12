#!/bin/zsh
# CI for a task's exact SHA: one Picked tests list commit (tests/list-<sha>) holding the task's whole selection, as
# `workflow.js verify <slug> --picked-list` prints it (a raw-map file carries +). This run plus `verify --check` is the
# task's CI evidence (evidence.md "Evidence gates"); the full suite is not a task's: `land` starts it on the branch head.
# --pr also sends full PR checks on the SHA (ci-<sha>), for the rare task that wants the whole suite before landing.
# Pushes to the fork only (gpush.sh retries).
# Usage: ci-dispatch.sh <task-worktree> <slug> [--pr]      (--no-pr is accepted and means the default)
set -u
wt=$1 slug=$2; cd "$wt" || exit 1
[[ -z $(git status --porcelain) ]] || { echo 'worktree not clean'; exit 1; }
here=$(git rev-parse HEAD); s=$(git rev-parse --short=9 HEAD); W=/Users/iposukhoff/L2Solo/.claude/workflow.js; P=${0:A:h}/gpush.sh
list=$(node $W verify $slug --root $PWD --picked-list) || { echo "verify failed: $list" | head -3; exit 1; }
# ci-tests.txt names a file without its test_ prefix and .js suffix; the + of a raw-map file stays in front.
names=$(print -r -- "$list" | sed -E 's/^(\+?)test_/\1/; s/\.js$//' | grep -v '^$')
if [[ ${3:-} == --pr ]]; then
  $P fork HEAD:refs/heads/ci-$s >/dev/null || exit 1
  sleep 2; gh workflow run pr-checks.yml -R posukhoff/L2Solo --ref ci-$s || exit 1
  echo "PR ci-$s"
fi
[[ -z $names ]] && { echo "no selected tests for $s: nothing to pick (ready then asks the review's --selection-ack)"; exit 0; }
printf '%s\n' "$names" > ci-tests.txt
git add ci-tests.txt && git -c user.name=iposukhoff commit -q -m "ci tests"
$P fork HEAD:refs/heads/tests/list-$s >/dev/null; rc=$?
git reset -q --hard $here
[[ $rc == 0 ]] && echo "Picked tests/list-$s ($(print -r -- "$names" | wc -l | tr -d ' ') files); then: ci-finish $slug $wt"
exit $rc
