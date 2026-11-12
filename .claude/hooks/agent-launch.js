#!/usr/bin/env node
// PreToolUse hook on the Agent tool: every launch names its model and effort, and Fable is never a first attempt
// (agents.md, model table). Reads the hook JSON on stdin; prints a deny decision or nothing. A fork inherits both.
let raw = '';
process.stdin.on('data', c => raw += c).on('end', () => {
    let t; try { t = JSON.parse(raw).tool_input || {}; } catch (_) { return; }
    if (t.subagent_type === 'fork') return;
    const miss = ['model', 'effort'].filter(k => !t[k]);
    const second = /second attempt|attempt 2\b/i.test(`${t.description || ''} ${String(t.prompt || '').slice(0, 400)}`);
    const why = miss.length ? `name ${miss.join(' and ')} on this launch (agents.md model table: opus high by default, sonnet medium for work a plan fixes)`
        : /fable/i.test(t.model) && !(second && t.effort === 'medium') ? 'fable only as a second attempt at medium effort: say "second attempt" in the description and what the first one failed on'
        : '';
    if (why) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Agent launch refused: ${why}` } }));
});
