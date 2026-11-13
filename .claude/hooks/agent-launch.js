#!/usr/bin/env node
// PreToolUse hook on the Agent tool: every launch names its model and effort, and Fable is never a first attempt
// (agents.md, model table). Reads the hook JSON on stdin; prints a deny decision or nothing. A fork inherits both.
// A planner, implementer or reviewer is the type l2-<role>: its definition holds the role's standing rules. A session that
// started before .claude/agents/ existed does not list the types (2026-11-12: three sessions made 837 general-purpose
// launches and none read a definition, so the rules reached agents only as each coordinator retold them). Such a launch
// must make the agent read the definition itself.
// The task's facts come from the record, not from the coordinator's retelling: a role launch names the brief file that
// .claude/tools/brief wrote and stays short (the brief and its --notes carry the content). A role agent with no task
// record yet (a plan review, an investigation before `start`) says so in its description: "no task record: <why>".
let raw = '';
process.stdin.on('data', c => raw += c).on('end', () => {
    let t; try { t = JSON.parse(raw).tool_input || {}; } catch (_) { return; }
    if (t.subagent_type === 'fork') return;
    const miss = /^l2-/.test(t.subagent_type || '') ? [] : ['model', 'effort'].filter(k => !t[k]); // a typed role launch takes both from its definition
    const second = /second attempt|attempt 2\b/i.test(`${t.description || ''} ${String(t.prompt || '').slice(0, 400)}`);
    const why = miss.length ? `name ${miss.join(' and ')} on this launch as the role's definition gives them (/Users/iposukhoff/L2Solo/.claude/agents/l2-<role>.md frontmatter; its description says when to pass another); for an agent with no role: opus high for reading and judging, sonnet medium for work a plan fixes`
        : /fable/i.test(t.model) && !(second && t.effort === 'medium') ? 'fable only as a second attempt at medium effort: say "second attempt" in the description and what the first one failed on'
        : (() => {
            const text = `${t.description || ''} ${String(t.prompt || '').slice(0, 400)}`.toLowerCase();
            const role = ['planner', 'implementer', 'reviewer'].map(r => [text.indexOf(r), r]).filter(x => x[0] >= 0).sort((a, b) => a[0] - b[0])[0]?.[1];
            const def = `/Users/iposukhoff/L2Solo/.claude/agents/l2-${role}.md`;
            if (!role) return '';
            const prompt = String(t.prompt || '');
            if (t.subagent_type !== `l2-${role}` && !prompt.includes(def)) return `a ${role} is launched as type l2-${role}. If this session does not list that type (it started before the definitions existed; a restart loads them), begin the prompt with: "Read ${def} in full and act as that agent; it outranks this brief."`;
            if (/no task record:\s*\S/i.test(t.description || '')) return '';
            const file = (/(\/\S+-(?:planner|implementer|reviewer)-brief(?:-\d+)?\.md)/.exec(prompt) || [])[1];
            let made = false; try { made = require('node:fs').readFileSync(file, 'utf8').startsWith('# L2Solo brief · '); } catch (_) { /* no such file */ }
            if (!made) return `a ${role}'s brief is printed from the task record: run /Users/iposukhoff/L2Solo/.claude/tools/brief <slug> <worktree> ${role} --out <your scratch dir> [--round n] [--notes <file with this task's facts>] and launch with the prompt it prints (for a role agent with no task record, put "no task record: <why>" in the description)`;
            return prompt.length > 1500 ? `the launch prompt is ${prompt.length} characters: the brief file carries the task, and what only you know goes into brief --notes as facts (1500 characters at most here, so that rules are not retold)` : '';
        })();
    if (why) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Agent launch refused: ${why}` } }));
});
