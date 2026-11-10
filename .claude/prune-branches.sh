#!/bin/zsh
# Explicit completed-run evidence; fail closed on unavailable GitHub information.
# Default dry-run. --apply deletes only reviewed candidates.
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1
mode="${1:---dry-run}"
[[ "$mode" == "--dry-run" || "$mode" == "--apply" ]] || { echo "usage: $0 [--dry-run|--apply]" >&2; exit 2; }
git fetch -q --prune --multiple fork origin
keep=(main ivan/next-release perf-tooling ivan/workflow ivan/workflow-v2)
refs=$(git ls-remote --heads fork)
for line in "${(@f)refs}"; do
  sha="${line%%$'\t'*}"
  ref="${line#*$'\t'}"; ref="${ref#refs/heads/}"
  (( ${keep[(Ie)$ref]} )) && continue
  if [[ "$ref" == ci-* || "$ref" == tests/* || "$ref" == tables/* ]]; then
    # Exact branch + commit; no run means queued/not started/unknown, never delete.
    # Query failure aborts rather than treating every branch as idle.
    runs=$(gh run list -R posukhoff/L2Solo --branch "$ref" --commit "$sha" --limit 100 --json status,createdAt)
    verdict=$(printf '%s' "$runs" | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{let a=JSON.parse(s);console.log(a.length>0&&a.length<100&&a.every(x=>x.status==="completed"&&Date.now()-Date.parse(x.createdAt)>86400000)?"done":"keep")})')
    [[ "$verdict" == done ]] || continue
  else
    git merge-base --is-ancestor "$sha" origin/develop 2>/dev/null || continue
  fi
  echo "fork: $ref ($sha)"
  if [[ "$mode" == "--apply" ]]; then
    # Lease protects against deleting a branch that changed after the query.
    # This is a leased ref deletion, never a forced rewrite of commit history.
    git push -q --force-with-lease="refs/heads/$ref:$sha" fork ":refs/heads/$ref"
  fi
done
# Shared-origin cleanup is deliberately manual; never delete colleague refs.
echo "origin: no automatic deletions"
