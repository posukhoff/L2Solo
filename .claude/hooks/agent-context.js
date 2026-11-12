#!/usr/bin/env node
// PreToolUse hook on every tool: an agent whose context passed the limit hands its work on instead of carrying it.
// Why: a turn is paid by the whole context. Under 100k tokens a turn costs about $0.045, past 300k $0.10 to $0.12; in
// release 1b.0f three planners that passed 300k cost $37 of the release's $128, most of it after 200k.
// The main session is not touched (no agent id in the hook input): its context is the maintainer's and compaction's.
// How: the agent's own transcript is <session transcript without .jsonl>/subagents/agent-<agent_id>.jsonl; the usage of
// its last answer is the context it now pays for. Past WARN the first call is denied once with the hand-off order and the
// agent may finish its step; past STOP only Write, Edit, reading or stopping its own background command and the hand-back
// pass, so it can write the hand-off and must return.
// A fork starts with its parent's whole context by design and is not limited. The transcript lags by a turn at most.
// L2SOLO_AGENT_CONTEXT=off disables it; a missing or unreadable transcript never blocks a call.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const WARN = 200000, STOP = 240000;
const order = (ctx, hard) => `Context ${Math.round(ctx / 1000)}k tokens: every further turn costs about twice a fresh agent's. `
    + (hard ? 'Only Write, Edit, reading or stopping a background command of yours, and your return work now. ' : 'This call was refused once; you may finish the step you are in (a few calls), then stop. ')
    + 'If a command of yours still runs in the background, read its result or stop it first: nobody else will see it. '
    + 'Hand over: write to the file your brief names for your result (if it names none or you have no Write tool, return it as your final message) '
    + 'what is established with its handles (file:line, test, run), what is done and committed, what is half-done and in which files, '
    + 'and the next three steps you would take. Leave no uncommitted edit unexplained. Then return; the coordinator starts a fresh agent on your hand-over.';
let raw = '';
process.stdin.on('data', c => raw += c).on('end', () => {
    try {
        if (process.env.L2SOLO_AGENT_CONTEXT === 'off') return;
        const h = JSON.parse(raw), id = h.agent_id;
        if (!id || !h.transcript_path) return;
        const file = h.agent_transcript_path || path.join(h.transcript_path.replace(/\.jsonl$/, ''), 'subagents', `agent-${id}.jsonl`);
        if (!fs.existsSync(file) || /fork/i.test(h.agent_type || '')) return;
        try { if (/fork/i.test(JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')).agentType || '')) return; } catch (_) { /* no meta: not a fork we know of */ }
        // The last answer's usage sits at the end of the file: read its tail, not the whole transcript.
        const size = fs.statSync(file).size, take = Math.min(size, 400000), buf = Buffer.alloc(take), fd = fs.openSync(file, 'r');
        fs.readSync(fd, buf, 0, take, size - take); fs.closeSync(fd);
        let ctx = 0;
        for (const line of buf.toString('utf8').split('\n').reverse()) {
            if (!line.includes('"usage"')) continue;
            let u; try { u = JSON.parse(line).message?.usage; } catch (_) { continue; }
            if (u) { ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0); break; }
        }
        if (ctx < WARN) return;
        const hard = ctx >= STOP, mark = path.join(os.tmpdir(), `l2solo-agent-context-${id}`);
        if (hard ? /^(Write|Edit|SubagentHandback|SendMessage|BashOutput|KillShell|TaskOutput|TaskStop)$/.test(h.tool_name) : fs.existsSync(mark)) return;
        if (!hard) fs.writeFileSync(mark, String(ctx));
        console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: order(ctx, hard) } }));
    } catch (_) { /* a hook fault must not stop an agent */ }
});
