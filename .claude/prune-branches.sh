#!/bin/zsh
# Prune finished fork branches (.claude/workflow/git.md "Branch hygiene"): after a PR merges and after each CI round.
# Explicit completed-run evidence; fail closed on unavailable GitHub information.
# - fork ci-*/tests/*/tables/*: deleted when every run of that exact branch and commit completed over a day ago
#   (no run seen = queued, not started or older than the run window: kept);
# - any other fork branch already in origin/develop, except the keep list.
# Origin and local branches are cleaned by hand (never a colleague's ref).
# Default dry-run. --apply deletes only the listed candidates, each with a lease on its listed commit.
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1
mode="${1:---dry-run}"
[[ "$mode" == "--dry-run" || "$mode" == "--apply" ]] || { echo "usage: $0 [--dry-run|--apply]" >&2; exit 2; }
git fetch -q --prune --multiple fork origin
keep=(main ivan/next-release perf-tooling ivan/workflow ivan/workflow-v2)
refs=$(git ls-remote --heads fork)
# One query for the recent runs (one call per branch took ~1 s each: 460 branches, ~10 min). A failed query aborts.
runs=$(gh run list -R posukhoff/L2Solo --limit 1000 --json headBranch,headSha,status,createdAt)
done_refs=$(printf '%s' "$runs" | node -e '
let s = ""; process.stdin.on("data", x => s += x); process.stdin.on("end", () => {
    const by = new Map();
    for (const r of JSON.parse(s)) { const k = r.headBranch + " " + r.headSha; (by.get(k) || by.set(k, []).get(k)).push(r); }
    for (const [k, list] of by) if (list.every(r => r.status === "completed" && Date.now() - Date.parse(r.createdAt) > 86400000)) console.log(k);
});')
count=0
for line in "${(@f)refs}"; do
  sha="${line%%$'\t'*}"
  ref="${line#*$'\t'}"; ref="${ref#refs/heads/}"
  (( ${keep[(Ie)$ref]} )) && continue
  if [[ "$ref" == ci-* || "$ref" == tests/* || "$ref" == tables/* ]]; then
    [[ $'\n'"$done_refs"$'\n' == *$'\n'"$ref $sha"$'\n'* ]] || continue
  else
    git merge-base --is-ancestor "$sha" origin/develop 2>/dev/null || continue
  fi
  echo "fork: $ref ($sha)"; count=$((count + 1))
  if [[ "$mode" == "--apply" ]]; then
    # A deletion leased on the listed commit (a branch moved since the query stays); no history is rewritten.
    git push -q --force-with-lease="refs/heads/$ref:$sha" fork ":refs/heads/$ref"
  fi
done
echo "fork: $count candidates ($mode)"
echo "origin: no automatic deletions"
