#!/bin/zsh
# Prune branches that are done (CLAUDE.md "Git"): run after a PR merge and after each CI round.
# - fork: temporary ci-*/tests/*/tables/* branches whose runs are not in progress;
#   any other branch already merged into origin/develop, except main, ivan/next-release and the keep list.
# - origin: ivan/* branches merged into origin/develop, except ivan/next-release.
# Never force-pushes; only deletes refs. Pass --dry-run to list only.
cd /Users/iposukhoff/L2Solo || exit 1
dry=0; [[ "$1" == "--dry-run" ]] && dry=1
keep=(main ivan/next-release perf-tooling)
git fetch -q --prune --multiple fork origin
busy=(${(f)"$(gh run list -R posukhoff/L2Solo --limit 50 --json headBranch,status -q '.[] | select(.status != "completed") | .headBranch' 2>/dev/null)"})
del_fork=(); del_origin=()
for ref in ${(f)"$(git ls-remote --heads fork | awk '{print $2}' | sed 's#refs/heads/##')"}; do
  (( ${keep[(Ie)$ref]} )) && continue
  if [[ $ref == ci-* || $ref == tests/* || $ref == tables/* ]]; then
    (( ${busy[(Ie)$ref]} )) || del_fork+=$ref
  elif git merge-base --is-ancestor "fork/$ref" origin/develop 2>/dev/null; then
    del_fork+=$ref
  fi
done
for ref in ${(f)"$(git ls-remote --heads origin 'ivan/*' | awk '{print $2}' | sed 's#refs/heads/##')"}; do
  [[ $ref == ivan/next-release ]] && continue
  git merge-base --is-ancestor "origin/$ref" origin/develop 2>/dev/null && del_origin+=$ref
done
echo "fork: ${#del_fork} to delete${del_fork:+ (${del_fork[1,5]}…)}"; echo "origin: ${#del_origin} to delete ${del_origin}"
(( dry )) && exit 0
(( ${#del_fork} )) && git push -q fork --delete $del_fork
(( ${#del_origin} )) && git push -q origin --delete $del_origin
for b in ${(f)"$(git branch --merged origin/develop --format='%(refname:short)' | grep '^ivan/' | grep -v '^ivan/next-release$')"}; do git branch -d "$b"; done
echo done
