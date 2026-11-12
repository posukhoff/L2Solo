#!/usr/bin/env node
// PreToolUse hook on Bash: a push to the shared origin asks the maintainer first (CLAUDE.md: never push to shared
// origin without explicit authorization). The one standing leave passes unasked: a plain, unforced push of
// ivan/next-release. Reads the hook JSON on stdin; prints an ask decision or nothing.
let raw = '';
process.stdin.on('data', c => raw += c).on('end', () => {
    let cmd; try { cmd = String(JSON.parse(raw).tool_input.command || ''); } catch (_) { return; }
    for (const part of cmd.split(/&&|\|\||[;|\n]/)) {
        const w = part.trim().split(/\s+/);
        let i = w.findIndex(x => /(^|\/)gpush\.sh$/.test(x));
        if (i < 0) { // git [-C dir] [-c k=v] [--opt] push
            i = w.findIndex(x => /(^|\/)git$/.test(x)); if (i < 0) continue;
            for (i++; i < w.length && w[i].startsWith('-'); i++) if (/^-[cC]$/.test(w[i])) i++;
            if (w[i] !== 'push') continue;
        }
        const rest = w.slice(i + 1), pos = rest.filter(x => !x.startsWith('-')), remote = pos[0];
        if (remote && remote !== 'origin') continue;
        const forced = rest.some(x => /^(-f|--force|--force-with-lease.*|--mirror|--delete|-d)$/.test(x)) || pos.slice(1).some(x => x.startsWith('+') || x.startsWith(':'));
        const standing = remote === 'origin' && !forced && pos.length > 1 && pos.slice(1).every(x => x.split(':').pop().replace(/^refs\/heads\//, '') === 'ivan/next-release');
        if (standing) continue;
        return console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask',
            permissionDecisionReason: `Push to the shared origin (${remote ? pos.slice(1).join(' ') || 'default refs' : 'no remote named: the branch default'}${forced ? ', forced or deleting' : ''}): the maintainer authorizes each one; only an unforced push of ivan/next-release passes unasked.` } }));
    }
});
