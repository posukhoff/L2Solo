#!/usr/bin/env node
'use strict';
// Tests that load what a diff changed (directly or through up to DEPTH modules), for a Picked-tests run on the fork.
// Usage: node planning/tests-for.js <base>..<head> [--root <worktree>] [--depth 2]   → test names, one per line.
// Modules loaded by many others (hubs: World, Database, Global …) do not carry the walk further: through them every test
// would be listed. Output feeds ci-tests.txt (or tests/$sha/<a,b,c>).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const range = args.find(a => a.includes('..'));
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const root = path.resolve(opt('--root') || path.join(__dirname, '..'));
const DEPTH = Number(opt('--depth') ?? 2);
if (!Number.isInteger(DEPTH) || DEPTH < 0) { console.error('Invalid --depth'); process.exit(2); }
const HUB = 25; // a module loaded by more than this many src modules stops the walk
if (!range) { console.log('usage: node planning/tests-for.js <base>..<head> [--root <tree>] [--depth 2]'); process.exit(2); }

const files = [];
(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full); else if (e.name.endsWith('.js')) files.push(full);
    }
})(path.join(root, 'src'));
const tests = fs.readdirSync(path.join(root, 'tests')).filter(n => /^test_.*\.js$/.test(n)).map(n => path.join(root, 'tests', n));
const helpers = fs.existsSync(path.join(root, 'tests/helpers')) ? fs.readdirSync(path.join(root, 'tests/helpers'))
    .filter(n => n.endsWith('.js')).map(n => path.join(root, 'tests/helpers', n)) : [];

const resolve = (from, spec) => {
    let base;
    if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
    else if (spec.startsWith('GameServer/') || spec.startsWith('Bot/')) base = path.join(root, 'src', spec);
    else return null;
    for (const c of [base, base + '.js', path.join(base, 'index.js')]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    return null;
};
const loadedBy = new Map(); // module → files that load it
for (const file of [...files, ...tests, ...helpers]) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:require|invoke|need)\(\s*['"]([^'"]+)['"]/g)) {
        const target = resolve(file, m[1]);
        if (target) (loadedBy.get(target) || loadedBy.set(target, new Set()).get(target)).add(file);
    }
}
const srcFanIn = file => [...(loadedBy.get(file) || [])].filter(f => f.includes(`${path.sep}src${path.sep}`)).length;

const changed = execFileSync('git', ['-C', root, 'diff', '--name-only', range], { encoding: 'utf8' })
    .split('\n').filter(Boolean).map(f => path.join(root, f)).filter(f => f.endsWith('.js'));
const out = new Set();
let frontier = changed.filter(f => fs.existsSync(f));
const seen = new Set(frontier);
for (const f of frontier) if (f.includes(`${path.sep}tests${path.sep}test_`)) out.add(f);
for (let depth = 0; depth <= DEPTH && frontier.length; depth++) {
    const next = [];
    for (const mod of frontier) {
        if (depth > 0 && srcFanIn(mod) > HUB) continue;
        for (const user of loadedBy.get(mod) || []) {
            if (/[/\\]tests[/\\]test_/.test(user)) out.add(user);
            else if (!seen.has(user)) { seen.add(user); next.push(user); }
        }
    }
    frontier = next;
}
for (const t of [...out].map(f => path.basename(f)).sort()) console.log(t);
console.error(`tests-for ${range}: ${out.size} tests (depth ${DEPTH}, hubs > ${HUB} src loaders stop the walk)`);
