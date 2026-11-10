#!/usr/bin/env node
'use strict';
// CLAUDE.md hard rules by text. `<base>..<head> [--root <tree>]`: added lines, exit 1 on ERROR; `--all [--list]`: src/.
const fs = require('fs'),path = require('path'),{execFileSync: run} = require('child_process');
const args = process.argv.slice(2),ALL = args.includes('--all'),range = args.find(a=>a.includes('..'));
const at = args.indexOf('--root'),root = path.resolve(at >= 0 ? args[at + 1] : `${__dirname}/..`);
if (!range && !ALL) process.exit(console.log('usage: <base>..<head> | --all [--list], [--root <tree>]') || 2);
const opt = {encoding: 'utf8',maxBuffer: 1 << 28},git = (...a)=>run('git',['-C',root,...a],opt);
const disk = f=>{try {return fs.readFileSync(path.join(root,f),'utf8');} catch (_) {return '';}};
const read = f=>{try {return ALL ? disk(f) : git('show',`${range.split('..')[1] || 'HEAD'}:${f}`);} catch (_) {return '';}};
let F,N; const hits = [],hit = (d,m,e = 0)=>hits.push({d,f: F,n: N,m,e});
const CITE = /planning\/|\b[\w-]+\.md\b|§|\bsituations step\b|\bstep \d+\b|\b(?:SR|PC|RC|SF|TBL|ECO|AI|CMB|PER|POP|WOR|TS|PL|DM|DT|RM|BA|RA)-\d+\b|\b(?:user|maintainer) \d{1,2}-\d{2}\b|\b[DQ]\d{1,2}\b(?=[):,\s])/;
const RAISE = /\braise(?:Far|Near|OnRow|Bag)?\(([^;]*)/,SIT = /'([a-z][a-z_]*(?::[a-z_]+)?)'/g;
// Raised names: `name: '…'` entries when the call has them (a reason argument and payload strings are no names), else the strings outside object literals.
const raisedNames = a => { if (!a) return []; if (/\bname:\s*'/.test(a)) return [...a.matchAll(/\bname:\s*'([a-z][a-z_]*(?::[a-z_]+)?)'/g)].map(m => m[1]); let b = a, c; while ((c = b.replace(/\{[^{}]*\}/g, '')) !== b) b = c; return [...b.matchAll(SIT)].map(m => m[1]); };
const known = new Set([...read('src/GameServer/Bot/Situations.js').matchAll(SIT)].flatMap(m=>[m[1],m[1].split(':')[0]]));
const scope = new Map(); // file -> added lines (null: all)
if (ALL) for (const f of fs.readdirSync(`${root}/src`,{recursive: true})) {if (f.endsWith('.js')) scope.set(`src/${f}`,null);}
else for (const row of git('diff','-U0','--no-color',range,'--','src','tests','scripts').split('\n')) {
    const h = /^@@ -\S+ \+(\d+)/.exec(row);
    if (row.startsWith('+++ ')) F = row.slice(6); else if (h) N = +h[1];
    else if (F?.endsWith('.js') && row[0] === '+') (scope.get(F) || scope.set(F,new Set()).get(F)).add(N++);
}
// Worker-loaded files (module-scope imports); FORBID, stubs: the worker's boundary.
const W = 'src/GameServer/Bot/Population/ColdSimulationWorker.js',ws = disk(W),worker = new Set();
const FORBID = RegExp(/const forbidden = \/(.+)\/;/.exec(ws)?.[1] || '$^'),stubs = new Set([...ws.matchAll(/^\s*\['([\w/]+)',/gm)].map(m=>m[1]));
for (const todo = [W]; todo.length;) {
    const f = todo.pop(),s = !worker.has(f) && disk(f);
    if (s) worker.add(f);
    for (const [,k,m] of s ? s.matchAll(/^\S.*\b(require|invoke)\('([.\w/-]+)'\)/gm) : []) {
        const id = k === 'invoke' ? m : m[0] === '.' && path.join(path.dirname(f),m).slice(4);
        if (id && !FORBID.test(id) && !stubs.has(id)) todo.push(`src/${id}.js`,`src/${id}/index.js`);
    }
}
// Owners' numeric constants: a literal beside the owner's domain words.
const owned = Object.entries({Karma: 'karma|xp|pk',ProgressionRates: 'blue|chance',PvpRules: 'pvp|flag','Bot/Situations': 'situation'})
    .flatMap(([o,w])=>[...disk(`src/GameServer/${o}.js`).matchAll(/^const (\w+) = (\d{2,});/gm)].map(([,n,v])=>({o,n,w: RegExp(`\\b(${w})`,'i'),v: RegExp(`(?<![\\d.])${v}(?![\\d.])`)})));
const PLUMB = /worker_threads|register\(|'main' :|RETAIN|initialized|cache|Diagnostics|FailureLog|typeof invoke|\? invoke\(|deps\.\w+ =|hasOwn\(deps/;
for (const [f,lines] of scope) {
    const s = read(F = f),rows = s.split('\n'),on = n=>!lines || lines.has(n),src = f.startsWith('src/');
    rows.forEach((t,i)=>{
        const c = /^\s*(?:\/\/|\*|\/\*)/.test(t) ? t : /\/\/(.*)$/.exec(t)?.[1];
        if (!on(N = i + 1)) return;
        if (c && CITE.test(c)) hit('r13-cite',t.trim().slice(0,99),1);
        for (const k of /\bfunction\s+raise/.test(t) ? [] : raisedNames(RAISE.exec(t)?.[1])) if (!known.has(k)) hit('r1-raise',`undeclared '${k}'`,1);
        if (!src || c === t) return;
        if (/Math\.random\(\)(?!\.toString)/.test(t) && /^src\/GameServer\/(Bot\/|.*Policy[^/]*$)/.test(f)) hit('r9-random','not seeded');
        if (/isMainThread/.test(t) && /^src\/GameServer\/Bot\/(?!.*(Worker|TableMirror|Receiver))/.test(f) && !PLUMB.test(t)) hit('r5-main','isMainThread branch');
        if (worker.has(f) && !/isMainThread/.test(t)) for (const [,m] of t.matchAll(/invoke\('([\w/]+)'\)/g)) if (FORBID.test(m) && !stubs.has(m)) hit('r9-world',`invokes ${m}`);
        for (const o of owned) if (!f.endsWith(`/${o.o}.js`) && o.v.test(t) && o.w.test(t)) hit('r4-const',`= ${o.o}.${o.n}`);
    });
    // Bare `.catch(() => {})`; a catch block empty (no throw after) or only logging.
    if (src && !/\/public\//.test(f)) for (const m of s.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{([^{}]*)\}(\s*throw\b)?|\.catch\(\s*(?:\(\w*\)|\w+)\s*=>\s*\{\s*\}\s*\)/g)) {
        const body = m[1]?.replace(/\/\/.*|\/\*[\s\S]*?\*\//g,'').trim();
        if (!on(N = s.slice(0,m.index).split('\n').length) || m[2] || body == null && /\breturn\b|[^=!<>]=[^=>]|\.(then|finally)\(/.test(rows[N - 1])) continue;
        if (!body) hit('r8-catch','empty',1);
        else if (/^(console\.\w+\([^;]*\);?\s*)+$/.test(body)) hit('r8-catch','console-only');
    }
}
// Clock sites in decision modules the decision registry lacks.
for (const x of JSON.parse(run('node',[`${__dirname}/target-architecture/decision-registry.js`,'--root',root,'--json','--unclassified'],opt))) {
    const l = scope.get(F = x.file);
    if (/Bot\/(AI|Economy|Population)\//.test(F) && l !== undefined && (!l || l.has(N = x.line))) hit('r2-clock',`unclassified ${x.kind}`);
}
N = 0;
if (!ALL) for (F of git('log','--format=%h','-i','-E','--grep=Co-Authored-By:|Claude-Session:|Generated with \\[Claude',range).split('\n').filter(Boolean)) hit('r13-commit','AI co-author',1);
const errs = hits.filter(h=>h.e).length,tally = k=>Object.entries(hits.reduce((m,h)=>(m[h[k]] = (m[h[k]] || 0) + 1,m),{}));
if (!ALL || args.includes('--list')) for (const h of hits.sort((a,b)=>a.e - b.e)) console.log(`${h.e ? 'ERROR' : 'warn '} ${h.d} ${h.f}:${h.n} ${h.m}`);
if (ALL) console.log(`per detector: ${tally('d').map(e=>e.join(' ')).join(', ')}\n${tally('f').sort((a,b)=>b[1] - a[1]).slice(0,15).map(([f,v])=>`  ${v}\t${f}`).join('\n')}`);
console.log(`rules-check ${range || '--all'}: ${errs} errors, ${hits.length - errs} warnings`);
process.exit(errs && !ALL ? 1 : 0);
