#!/usr/bin/env node
// PreToolUse hook on every tool: an agent's context is a budget of about 70 calls, and what it finds must be on file
// before the budget ends. The main session is not touched (no agent id in the hook input); a fork starts with its
// parent's whole context by design and is not limited.
// Why: a turn is paid by the whole context. Measured 2026-11-11..13 over 494 agents: a turn costs about $0.05 under
// 100k tokens and $0.12 to $0.22 past 200k; before any limit 41% of all agent money ($647 of $1564) was spent past
// 200k, and 13 of 21 planners that passed 200k went on past 300k. An agent starts at about 31k and a call adds 2.0 to
// 2.9k (half of it the agent's own output, the rest what it reads), so 200k is about 70 calls.
// Why the first version (one refusal at 200k, 2026-11-12) was not enough: it stopped 24 of 114 agents, and 14 of them
// had written the first line of their result past 160k. The hand-over was then written at the dearest point from an
// agent's memory, and the next agent paid for the same reading again. So the rules are, in the order they fire:
//   NOTE  an agent may not carry more than 60k tokens of work that is on no file: the call is refused once, the agent
//         writes what is established to its result file (an implementer commits) and goes on. First at about 100k.
//   NORUN past 170k no command is started in the background: 4 of the 24 stopped agents were stopped waiting for one.
//   WARN  at 200k one refusal: finish if about 15 calls remain, otherwise hand over now (an addition to the file).
//   STOP  from 250k only Write, Edit, reading or stopping its own background command and the return work pass.
// How: the agent's own transcript is <session transcript without .jsonl>/subagents/agent-<agent_id>.jsonl; the usage of
// its last answer is the context it now pays for (it lags by a turn at most). What the hook has already said to an
// agent and the context at its last write live in <tmp>/l2solo-agent-context-<agent_id>.
// L2SOLO_AGENT_CONTEXT=off disables it; a missing or unreadable transcript never blocks a call.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const START = 40000, NOTE = 60000, NORUN = 170000, WARN = 200000, STOP = 250000;
const k = n => Math.round(n / 1000) + 'k';
const HANDOVER = 'the hand-over goes into the file your brief names for your result (if it names none or you have no Write tool, into your final message): '
    + 'what is established with its handles (file:line, test, run), what is done and committed, what is half-done and in which files, the next three steps, '
    + 'and the exact file:line ranges the next agent must read to go on (it reads those, not the whole files). Leave no uncommitted edit unexplained. '
    + 'If a command of yours still runs in the background, read its result or stop it first: nobody else will see it. '
    + 'Then return; the coordinator starts a fresh agent on your hand-over.';
const SAY = {
    note: (ctx, loose) => `Context ${k(ctx)} tokens, and about ${k(loose)} of your work is on no file. This call was refused once. `
        + 'Before you go on, write to the file your brief names for your result what is established so far with its handles (file:line, test, run) and what you are doing next '
        + '(an implementer: commit what works first). Then repeat this call and continue. From here add to the file after each finding: '
        + `at ${k(WARN)} you are asked to finish or hand over, and what is on file is what survives.`,
    norun: ctx => `Context ${k(ctx)} tokens: there is no room left to wait for a background command (at ${k(WARN)} you are asked to finish or hand over). `
        + 'Run it in the foreground if it ends within minutes; otherwise write its exact command line into your result file for the coordinator to run.',
    warn: ctx => `Context ${k(ctx)} tokens: a turn now costs about 2.5 times a fresh agent's. This call was refused once. Decide now. `
        + `If everything that remains fits in about 15 calls, finish the task (from ${k(STOP)} only Write, Edit and your return work pass). `
        + 'Otherwise stop now and hand over: ' + HANDOVER,
    stop: ctx => `Context ${k(ctx)} tokens: only Write, Edit, reading or stopping a background command of yours, and your return work now. Hand over: ` + HANDOVER,
};
const deny = text => console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: text } }));
// What counts as putting work on file: a text file written or changed, or a commit.
const records = h => (/^(Write|Edit)$/.test(h.tool_name) && /\.(md|txt|json|jsonl)$/i.test(h.tool_input?.file_path || ''))
    || (h.tool_name === 'Bash' && /\bgit\b[^|;&]*\bcommit\b/.test(h.tool_input?.command || ''));
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
        const mark = path.join(process.env.L2SOLO_AGENT_CONTEXT_DIR || os.tmpdir(), `l2solo-agent-context-${id}`);
        let s = {}; try { s = JSON.parse(fs.readFileSync(mark, 'utf8')); } catch (_) { /* nothing said yet */ }
        if (typeof s !== 'object' || !s) s = { warned: true };  // a mark of the first version: that agent was already told
        const keep = () => fs.writeFileSync(mark, JSON.stringify(s));
        if (records(h)) { s.wrote = ctx; keep(); return; }
        if (ctx >= STOP) { if (!/^(Write|Edit|SubagentHandback|SendMessage|BashOutput|KillShell|TaskOutput|TaskStop)$/.test(h.tool_name)) deny(SAY.stop(ctx)); return; }
        if (ctx >= WARN) { if (!s.warned) { s.warned = true; keep(); deny(SAY.warn(ctx)); } return; }
        if (ctx >= NORUN && h.tool_name === 'Bash' && h.tool_input?.run_in_background) return deny(SAY.norun(ctx));
        const loose = ctx - Math.max(s.wrote || START, s.noted || 0);
        if (loose >= NOTE) { s.noted = ctx; keep(); deny(SAY.note(ctx, ctx - (s.wrote || START))); }
    } catch (_) { /* a hook fault must not stop an agent */ }
});
