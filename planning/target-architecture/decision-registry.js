#!/usr/bin/env node
'use strict';
// Decision registry check (situations.md: completeness by construction, not by reading rounds).
// Collects from the code every sign of a decision taken by the clock or on every step/tick:
//   const   — a *_MS / TTL / RETRY / INTERVAL / COOLDOWN / DELAY / WINDOW / AGE constant
//   timer   — setInterval / setTimeout
//   clock   — a comparison of now/timestamp/Date.now() with a *At / until / retry / expires / due / deadline field
//   literal — a duration written as a number next to the clock; fn — a function returning a duration
//   step    — a call made from a per-step or per-tick body (ColdSimulationWorker planLifecycle/projectResolve,
//             BotAI.tick, the hot states' tick)
// Each site's key is file + kind + the site's own text (constant name, callee, or the trimmed line), so moved lines
// keep their key and a changed line shows up as new. registry.json maps key -> { class, home, note }:
//   class: situation | deleted | deadline | cache | system | execution | diagnostics | out
//   home: the situation or decision it belongs to, or the step that deletes it.
// Usage: node decision-registry.js [--root <checkout>] [--list] [--unclassified] [--stale] [--json]
//   default prints counts by class and the unclassified sites; exit 1 when any is unclassified.

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const rootArg = args.indexOf('--root');
const root = rootArg >= 0 ? path.resolve(args[rootArg + 1]) : path.resolve(__dirname, '../..');
const registryFile = path.join(__dirname, 'decision-registry.json');

const DIRS = ['src/GameServer/Bot', 'src/GameServer/Clan', 'src/GameServer/ClanHall', 'src/GameServer/AfkTrade',
    'src/GameServer/Social', 'src/GameServer/RaidBoss', 'src/GameServer/Party'];
const STEP_BODIES = [
    ['src/GameServer/Bot/Population/ColdSimulationWorker.js', ['planLifecycle', 'projectResolve', 'decideWorkshop', 'leafStart']],
    ['src/GameServer/Bot/BotAI.js', ['tick']],
    ['src/GameServer/Bot/AI/States/HuntingState.js', ['tick']],
    ['src/GameServer/Bot/AI/States/ShoppingState.js', ['tick']],
    ['src/GameServer/Bot/AI/States/RestingState.js', ['tick']],
    ['src/GameServer/Bot/AI/States/FollowingState.js', ['tick']],
    ['src/GameServer/Bot/AI/States/GettingBuffedState.js', ['tick']]
];

function walk(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

const CONST_RE = /\b(?:const|let)\s+([A-Z][A-Z0-9_]*(?:_MS|_TTL|TTL_MS|RETRY[A-Z_]*|_INTERVAL[A-Z_]*|COOLDOWN[A-Z_]*|_DELAY[A-Z_]*|_WINDOW[A-Z_]*|_AGE[A-Z_]*|_PERIOD[A-Z_]*))\s*=/g;
const TIMER_RE = /\b(setInterval|setTimeout)\s*\(/;
// clock: a line that compares (or offsets) the clock with a time-ish field, in any form
// (`Number(x.retryAt || 0) > timestamp`, `now - at >= cooldown`, `deadline <= Date.now()`).
const NOW_RE = /\b(?:now|timestamp|nowMs|currentTime)\b|Date\.now\(\)|this\.now\(\)|performance\.now\(\)/;
const TIMEISH_RE = /(?:At|Until|until|[Rr]etry\w*|[Ee]xpir\w*|[Dd]ue\w*|[Dd]eadline\w*|[Cc]ooldown\w*|[Ww]indow\w*|Ms|_MS|TTL|[Aa]ge)\b/;
const COMPARE_RE = /[<>]=?(?!>)|-\s*(?:Number\()?[\w.?]/;
const CLOCK_RE = { test: line => NOW_RE.test(line) && TIMEISH_RE.test(line) && COMPARE_RE.test(line) };
// literal: a duration written as a number next to the clock (`timestamp + 300000`, `20 * 60 * 1000`).
const LITERAL_RE = /(?:\b(?:now|timestamp)\b|Date\.now\(\))\s*[+-]\s*\(?\s*\d{4,}|\b\d+\s*\*\s*60\s*\*\s*1000\b|\b\d+\s*\*\s*60000\b|\b\d+\s*\*\s*3600000\b/;
// fn: a function that returns a duration (`function cooldownMs(`).
const FN_RE = /\bfunction\s+(\w*(?:Ms|MS|Ttl|TTL|Cooldown|Delay|Interval))\s*\(|^\s*(\w*(?:Ms|Cooldown|Delay|Interval))\s*\([^)]*\)\s*\{/;

const norm = text => text.trim().replace(/\s+/g, ' ').slice(0, 160);
const rel = file => path.relative(root, file);

function bodyOf(source, name) {
    // The body of `function name(` or a method `name(...) {`: brace matching from the first `{` after it.
    const re = new RegExp(`(?:function\\s+${name}\\s*\\(|^\\s*(?:async\\s+)?${name}\\s*\\([^)]*\\)\\s*\\{)`, 'm');
    const match = re.exec(source);
    if (!match) return null;
    let at = source.indexOf('{', match.index);
    let depth = 0;
    const start = at;
    for (; at < source.length; at++) {
        const ch = source[at];
        if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) return { text: source.slice(start, at + 1), offset: start };
    }
    return null;
}

const CALL_RE = /\b((?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*)\s*\(/g;
const NOT_CALLEES = new Set(['if', 'for', 'while', 'switch', 'return', 'function', 'catch', 'Number', 'String', 'Boolean',
    'Math.max', 'Math.min', 'Math.round', 'Math.floor', 'Math.ceil', 'Math.abs', 'Object.keys', 'Object.entries',
    'Object.values', 'Object.assign', 'Array.isArray', 'Date.now', 'Set', 'Map', 'JSON.stringify', 'JSON.parse',
    'Number.isFinite', 'Number.isSafeInteger', 'Number.isInteger', 'String', 'parseInt', 'parseFloat', 'Error', 'TypeError',
    'Promise.resolve', 'Promise.all', 'require', 'invoke', 'Symbol']);
const NOISY_TAILS = /\.(push|get|set|has|add|delete|map|filter|some|every|find|forEach|reduce|includes|slice|join|concat|sort|indexOf|keys|values|entries|toFixed|trim|startsWith|endsWith|then|catch|finally|call|apply|bind|count)$/;

function collect() {
    const sites = new Map();
    const add = (file, kind, key, line, text) => {
        const id = `${rel(file)}|${kind}|${key}`;
        if (!sites.has(id)) sites.set(id, { id, file: rel(file), kind, key, line, text: norm(text) });
    };
    for (const dir of DIRS) for (const file of walk(path.join(root, dir))) {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        lines.forEach((raw, index) => {
            const line = raw.replace(/\/\/.*$/, '');
            if (!line.trim()) return;
            CONST_RE.lastIndex = 0;
            let m;
            while ((m = CONST_RE.exec(line))) add(file, 'const', m[1], index + 1, raw);
            const timer = TIMER_RE.exec(line);
            if (timer) add(file, 'timer', norm(line), index + 1, raw);
            if (CLOCK_RE.test(line)) add(file, 'clock', norm(line), index + 1, raw);
            else if (LITERAL_RE.test(line)) add(file, 'literal', norm(line), index + 1, raw);
            const fn = FN_RE.exec(line);
            if (fn) add(file, 'fn', fn[1] || fn[2], index + 1, raw);
        });
    }
    for (const [relative, names] of STEP_BODIES) {
        const file = path.join(root, relative);
        if (!fs.existsSync(file)) continue;
        const source = fs.readFileSync(file, 'utf8');
        for (const name of names) {
            const body = bodyOf(source, name);
            if (!body) { add(file, 'step', `${name}:<missing>`, 0, `${name} body not found`); continue; }
            const text = body.text.replace(/\/\/.*$/gm, '');
            CALL_RE.lastIndex = 0;
            let m;
            while ((m = CALL_RE.exec(text))) {
                const callee = m[1];
                if (NOT_CALLEES.has(callee) || NOISY_TAILS.test(callee) || /^[a-z]$/.test(callee)) continue;
                const line = source.slice(0, body.offset + m.index).split('\n').length;
                add(file, 'step', `${name}>${callee}`, line, callee);
            }
        }
    }
    return [...sites.values()];
}

const registry = fs.existsSync(registryFile) ? JSON.parse(fs.readFileSync(registryFile, 'utf8')) : {};
const sites = collect();
const unclassified = sites.filter(site => !registry[site.id]?.class);
const live = new Set(sites.map(site => site.id));
const stale = Object.keys(registry).filter(id => !live.has(id));

if (flag('--json')) {
    process.stdout.write(JSON.stringify(flag('--unclassified') ? unclassified : sites, null, 1));
    process.exit(0);
}
const byClass = {};
for (const site of sites) {
    const cls = registry[site.id]?.class || 'UNCLASSIFIED';
    byClass[cls] = (byClass[cls] || 0) + 1;
}
const byKind = {};
for (const site of sites) byKind[site.kind] = (byKind[site.kind] || 0) + 1;
console.log(`sites ${sites.length} (${Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(', ')}); `
    + Object.entries(byClass).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', '));
if (flag('--list')) for (const site of sites) console.log(`${registry[site.id]?.class || '?'}\t${site.file}:${site.line}\t${site.kind}\t${site.key}`);
if (flag('--stale') && stale.length) console.log(`stale registry keys (gone from the code): ${stale.length}\n  ${stale.join('\n  ')}`);
if (unclassified.length && !flag('--list')) {
    console.log(`unclassified ${unclassified.length}:`);
    for (const site of unclassified.slice(0, flag('--unclassified') ? Infinity : 40)) console.log(`  ${site.file}:${site.line}\t${site.kind}\t${site.key}`);
}
process.exit(unclassified.length ? 1 : 0);
