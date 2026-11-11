#!/usr/bin/env node
'use strict';
// What the flow cost, from its own records (read-only): task records per landing, restarts of one task, records lost to
// a policy change, time from record to landing, and lifecycle writes made outside an lc command.
// Usage: node .claude/tools/flow-stats.js [--since <ISO date>] [--repo <checkout>]
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const arg = k => { const i = process.argv.indexOf(k); return i < 0 ? undefined : process.argv[i + 1]; };
const repo = path.resolve(arg('--repo') || path.join(__dirname, '../..'));
const since = arg('--since') || '';
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();
const dir = path.join(git('rev-parse', '--path-format=absolute', '--git-common-dir'), 'l2solo-workflow');
const records = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter(r => r.slug && r.created >= since);
const landed = records.filter(r => r.evidence?.landed);
// One task restarted under new slugs: n-dt208, n2-dt208, dt201b, dt201c are the same task by name.
const family = s => s.replace(/^[a-z]\d*-/, '').split('-')[0].replace(/(?<=\d)[a-z]$/, '');
const chains = new Map();
for (const r of records) chains.set(family(r.slug), (chains.get(family(r.slug)) || 0) + 1);
const longest = [...chains].sort((a, b) => b[1] - a[1])[0] || ['-', 0];
const byPolicy = new Map();
for (const r of records) { const p = byPolicy.get(r.policy) || { n: 0, landed: 0 }; p.n++; if (r.evidence?.landed) p.landed++; byPolicy.set(r.policy, p); }
const voided = [...byPolicy.values()].filter(p => !p.landed).reduce((n, p) => n + p.n, 0);
const minutes = landed.map(r => (Date.parse(r.evidence.landed.at) - Date.parse(r.created)) / 60000).sort((a, b) => a - b);
const pct = q => minutes.length ? Math.round(minutes[Math.min(minutes.length - 1, Math.floor(minutes.length * q))]) : '-';
const count = (rs, f) => rs.reduce((n, r) => n + f(r), 0);
console.log(`task records ${records.length} · landed ${landed.length} · records per landing ${landed.length ? (records.length / landed.length).toFixed(1) : '-'}`);
console.log(`restarts: longest chain ${longest[1]} (${longest[0]}) · tasks restarted ${[...chains.values()].filter(n => n > 1).length} of ${chains.size} (by slug name)`);
console.log(`policy digests ${byPolicy.size} · records on a digest that landed nothing ${voided}`);
console.log(`record-rebase used on ${records.filter(r => (r.rebases || []).length).length} records`);
console.log(`record to landing, minutes: p50 ${pct(0.5)} · p90 ${pct(0.9)} (a short time means the record was written after the work)`);
console.log(`CI runs kept on landed heads ${count(landed, r => (r.evidence.ciRuns || []).length)} (runs on earlier heads are not kept) · selection acks ${landed.filter(r => r.evidence.review?.selectionAcknowledged).length}`);
console.log(`routes: ${['fast', 'standard', 'critical'].map(k => `${k} ${records.filter(r => r.risk === k).length}`).join(' · ')}`);
console.log('review rounds: not recorded (record-review keeps only the last)');
// Lifecycle data: a commit whose subject is not an lc command's was written past the commands.
const COMMANDS = /^lc (add|edit|assign|place|dep|split|drop|decide|gates|release|step|open|start|land|resolve|defer|freeze|gate|close|publish|render|placement|import|sync|absorb)\b/;
let log = [];
try { log = git('log', '--format=%cI\t%s', 'ivan/lifecycle-data').split('\n').filter(Boolean).map(l => l.split('\t')).filter(([at]) => at >= since); } catch { /* no lifecycle data here */ }
const off = log.filter(([, s]) => !COMMANDS.test(s));
const used = new Map();
for (const [, s] of log) { const m = COMMANDS.exec(s); if (m) used.set(m[1], (used.get(m[1]) || 0) + 1); }
console.log(`lifecycle writes ${log.length} · outside a command ${off.length}${off.length ? ': ' + off.map(([, s]) => s.slice(0, 40)).join(' | ') : ''}`);
console.log(`lifecycle commands used: ${[...used].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ') || '-'}`);
