#!/bin/zsh
# git push with the key file and a few retries (the ssh-agent signing is flaky here).
export GIT_SSH_COMMAND="ssh -o IdentitiesOnly=yes -i $HOME/.ssh/id_ed25519"
for i in 1 2 3 4 5; do git push "$@" 2>/tmp/gpush.err && exit 0; sleep $((i*2)); done
cat /tmp/gpush.err >&2; exit 1
