#!/usr/bin/env node
'use strict';
// lc: L2Solo issue and release lifecycle. One git ref holds the open issues, one manifest per release, the
// maintainer's decisions and the archive; planning/roadmap.md and planning/architecture/problems.md are rendered
// from it. Every write is one commit moved by compare-and-swap (`update-ref new old`), so two writers cannot both
// win. V5.1 task records are read as evidence, never written. No server, database, scheduler or lock file.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

class Refusal extends Error {}
const fail = msg => { throw new Refusal(msg); };

function parseArgs(list) {
    const pos = [], opt = {};
    for (let i = 0; i < list.length; i++) {
        const a = list[i];
        if (!a.startsWith('--')) { pos.push(a); continue; }
        const k = a.slice(2);
        const v = i + 1 < list.length && !list[i + 1].startsWith('--') ? list[++i] : true;
        opt[k] = k in opt ? [].concat(opt[k], v) : v;
    }
    return { pos, opt };
}
const many = v => v === undefined || v === true ? [] : [].concat(v).flatMap(x => String(x).split(',')).map(x => x.trim()).filter(Boolean);
const one = (opt, k, what) => { const v = opt[k]; if (v === undefined || v === true || Array.isArray(v)) fail(`--${k} <${what}> required`); return String(v); };

function context(opt) {
    const repo = path.resolve(opt.repo || process.env.LC_REPO || process.cwd());
    const git = (args, input) => execFileSync('git', args, { cwd: repo, input, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['pipe', 'pipe', 'pipe'] }).replace(/\n$/, '');
    const tryGit = args => { try { return git(args); } catch { return null; } };
    const ok = args => { try { git(args); return true; } catch { return false; } };
    const common = path.resolve(repo, git(['rev-parse', '--git-common-dir']));
    return {
        repo, git, tryGit, ok,
        ref: opt['data-ref'] || process.env.LC_REF || 'refs/heads/ivan/lifecycle-data',
        remote: opt.remote || process.env.LC_REMOTE || 'fork',
        workflowDir: process.env.LC_WORKFLOW_DIR || path.join(common, 'l2solo-workflow'),
        planning: path.resolve(opt.planning || process.env.LC_PLANNING || path.join(path.dirname(common), 'planning')),
        runs: process.env.LC_RUNS || path.join(path.dirname(common), 'tmp/perf/runs'),
        now: process.env.LC_NOW || new Date().toISOString()
    };
}

// ---------- storage: plain files on a git ref ----------
const jsonl = s => (s || '').split('\n').filter(Boolean).map(l => JSON.parse(l));
const lines = arr => arr.map(x => JSON.stringify(x)).join('\n') + (arr.length ? '\n' : '');
function manifestText(r) { // one step per line keeps diffs one line per change
    const { steps, ...head } = r;
    return JSON.stringify(head, null, 1).replace(/\n}$/, `,\n "steps": [\n${steps.map(s => '  ' + JSON.stringify(s)).join(',\n')}\n ]\n}`) + '\n';
}
function load(cx) {
    const sha = cx.tryGit(['rev-parse', '--verify', '-q', cx.ref + '^{commit}']);
    if (!sha) return { sha: null, d: null };
    const files = {};
    for (const line of cx.git(['ls-tree', '-r', '--full-tree', sha]).split('\n').filter(Boolean)) {
        const [meta, name] = line.split('\t');
        files[name] = cx.git(['cat-file', 'blob', meta.split(' ')[2]]);
    }
    const d = { meta: JSON.parse(files['meta.json']), issues: jsonl(files['issues.jsonl']), decisions: jsonl(files['decisions.jsonl']), releases: {}, archive: {} };
    for (const [name, text] of Object.entries(files)) {
        let m;
        if ((m = name.match(/^releases\/(.+)\.json$/))) d.releases[m[1]] = JSON.parse(text);
        else if ((m = name.match(/^archive\/(.+)\.json$/))) (d.archive[m[1]] ||= {}).manifest = JSON.parse(text);
        else if ((m = name.match(/^archive\/(.+)\.jsonl$/))) (d.archive[m[1]] ||= {}).issues = jsonl(text);
    }
    return { sha, d };
}
function encode(d, extra = {}) {
    const files = { 'meta.json': JSON.stringify(d.meta, null, 1) + '\n', 'issues.jsonl': lines(d.issues), 'decisions.jsonl': lines(d.decisions), ...extra };
    for (const [k, r] of Object.entries(d.releases)) files[`releases/${k}.json`] = manifestText(r);
    for (const [k, a] of Object.entries(d.archive)) {
        if (a.manifest) files[`archive/${k}.json`] = manifestText(a.manifest);
        if (a.issues) files[`archive/${k}.jsonl`] = lines(a.issues);
    }
    return files;
}
function writeTree(cx, files) {
    const root = {};
    for (const [p, c] of Object.entries(files)) { const parts = p.split('/'); let dir = root; for (const x of parts.slice(0, -1)) dir = dir[x] ||= {}; dir[parts.at(-1)] = c; }
    const mk = dir => cx.git(['mktree'], Object.entries(dir).map(([n, v]) => typeof v === 'string'
        ? `100644 blob ${cx.git(['hash-object', '-w', '--stdin'], v)}\t${n}` : `040000 tree ${mk(v)}\t${n}`).join('\n') + '\n');
    return mk(root);
}
function save(cx, base, d, msg, extra) {
    const secAt = new Map(d.meta.sections.map((s, i) => [s.key, i]));
    d.issues.sort((a, b) => secAt.get(a.sec) - secAt.get(b.sec) || a.ord - b.ord);
    const { errors } = check(d);
    if (errors.length) fail('refused, invariants would break:\n  ' + errors.slice(0, 20).join('\n  '));
    const args = ['commit-tree', writeTree(cx, encode(d, extra)), '-m', msg];
    if (base) args.push('-p', base);
    const commit = cx.git(args, '');
    try { cx.git(['update-ref', '-m', 'lc', cx.ref, commit, base || '0'.repeat(40)]); }
    catch { fail(`${cx.ref} moved while this command ran; nothing written, run it again`); }
    return commit;
}

// ---------- model helpers ----------
const ID = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/;
const isId = x => ID.test(x) && /\d/.test(x);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text, id) => new RegExp(`(?<![\\w-])${esc(id)}(?![\\w-]?\\w)`).test(text);
const aliasIds = i => { const m = i.head.match(/\(=\s*([^)]*)\)/); return m ? m[1].split(',').map(x => x.trim()).filter(isId) : []; };
const idsOf = i => [i.id, ...aliasIds(i)];
const live = r => ['open', 'frozen'].includes(r.st);
function steps(d) { const m = new Map(); for (const r of Object.values(d.releases)) for (const s of r.steps) m.set(s.key, { r, s }); return m; }
function archivedSteps(d) { const m = new Map(); for (const a of Object.values(d.archive)) for (const s of a.manifest?.steps || []) m.set(s.key, a.manifest); return m; }
const tagFor = (d, i, st = steps(d)) => {
    if (i.tagx) return i.tagx;
    const x = i.at && st.get(i.at);
    return !x ? '[tail]' : x.r.group === 'large' ? '[large]' : `[r${x.r.group}]`;
};
const issueLine = (d, i, st) => [i.head, i.origin, i.rule, i.sites, i.what, i.fix, tagFor(d, i, st)].join('|');
const allIds = d => { const s = new Set(); for (const i of d.issues) idsOf(i).forEach(x => s.add(x)); for (const a of Object.values(d.archive)) for (const i of a.issues || []) idsOf(i).forEach(x => s.add(x)); return s; };
function issue(d, id) { const i = d.issues.find(x => idsOf(x).includes(id)); if (!i) fail(`no open issue ${id}`); return i; }
function release(d, key) { const r = d.releases[key]; if (!r) fail(`no live or planned release ${key}${d.archive[key] ? ' (closed: archive)' : ''}`); return r; }
function step(d, key) { const x = steps(d).get(key); if (!x) fail(`no step ${key}`); return x; }
function cycles(edges) {
    const state = new Map(), out = [];
    const visit = (n, stack) => {
        if (state.get(n) === 2) return;
        if (state.get(n) === 1) { out.push([...stack.slice(stack.indexOf(n)), n].join(' → ')); return; }
        state.set(n, 1); stack.push(n);
        for (const m of edges.get(n) || []) visit(m, stack);
        stack.pop(); state.set(n, 2);
    };
    for (const n of edges.keys()) visit(n, []);
    return out;
}
function rulesFor(d, i, r) { // maintainer constraints: an issue of a section may sit only in the named groups
    return (d.meta.rules || []).filter(x => x.sec === i.sec && r && !x.only.includes(r.group));
}

// ---------- invariants (pure; every write runs them, `lc check` prints them) ----------
function check(d) {
    const E = [], W = [];
    const st = steps(d), arch = archivedSteps(d);
    const groups = new Set(d.meta.groups.map(g => g.key)), secs = new Set(d.meta.sections.map(s => s.key)), decs = new Set(d.decisions.map(x => x.id));
    const keys = new Set(), branches = new Map();
    for (const [k, r] of Object.entries(d.releases)) {
        if (k !== r.key) E.push(`release file ${k} holds ${r.key}`);
        if (!groups.has(r.group)) E.push(`release ${r.key}: unknown group ${r.group}`);
        if (!['planned', 'open', 'frozen'].includes(r.st)) E.push(`release ${r.key}: state ${r.st} (closed releases live in archive/)`);
        if (live(r) && (!r.branch || !r.base)) E.push(`release ${r.key} ${r.st} without branch and base`);
        if (r.st === 'frozen' && !r.head) E.push(`release ${r.key} frozen without head`);
        if (live(r)) { if (branches.has(r.branch)) E.push(`branch ${r.branch} integrates ${branches.get(r.branch)} and ${r.key}`); branches.set(r.branch, r.key); }
        for (const x of r.decisions || []) if (!decs.has(x)) E.push(`release ${r.key}: unknown decision ${x}`);
        for (const s of r.steps) {
            if (keys.has(s.key) || arch.has(s.key)) E.push(`step key ${s.key} used twice`);
            keys.add(s.key);
            if (s.st === 'landed' && !(s.landed && s.landed.head && (s.landed.slug || s.landed.decision))) E.push(`step ${s.key} landed without evidence`);
            if (s.st === 'active' && !(s.tasks || []).length) E.push(`step ${s.key} active without a V5.1 task`);
            if (r.st === 'frozen' && s.st !== 'landed') E.push(`release ${r.key} frozen with step ${s.key} ${s.st}`);
            if (r.st === 'planned' && s.st !== 'planned') E.push(`step ${s.key} ${s.st} in a planned release`);
            for (const n of s.needs || []) if (!st.has(n) && !arch.has(n)) E.push(`step ${s.key} needs unknown ${n}`);
        }
    }
    for (const c of cycles(new Map([...st.values()].map(({ s }) => [s.key, (s.needs || []).filter(n => st.has(n))])))) E.push(`step cycle ${c}`);
    const seen = new Map();
    const note = (id, where) => { if (seen.has(id) && seen.get(id) !== where) E.push(`id ${id} used by ${seen.get(id)} and ${where}`); else seen.set(id, where); };
    for (const [k, a] of Object.entries(d.archive)) for (const i of a.issues || []) for (const x of idsOf(i)) note(x, `archive/${k}`);
    for (const i of d.issues) for (const x of idsOf(i)) note(x, i.id);
    const byId = new Map(d.issues.map(i => [i.id, i]));
    const relOf = i => i.at && st.get(i.at)?.r;
    const count = new Map();
    for (const i of d.issues) {
        if (!secs.has(i.sec)) E.push(`${i.id}: unknown section ${i.sec}`);
        if (i.at) {
            const x = st.get(i.at);
            if (!x) E.push(`${i.id}: step ${i.at} does not exist`);
            else { if (x.s.st === 'landed' && x.r.st === 'planned') E.push(`${i.id}: landed step in planned release`); count.set(x.r.key, (count.get(x.r.key) || 0) + 1); }
        }
        if (i.tagx) W.push(`${i.id}: legacy tag ${i.tagx}, its step says ${tagFor(d, { ...i, tagx: undefined }, st)}`);
        for (const dep of i.deps || []) {
            if (!seen.has(dep)) { E.push(`${i.id}: depends on unknown ${dep}`); continue; }
            const j = byId.get(dep); if (!j) continue; // archived = paid
            const ri = relOf(i), rj = relOf(j);
            if (ri && !rj) W.push(`${i.id} (${ri.key}) depends on ${dep} in triage`);
            if (ri && rj && rj.order > ri.order) E.push(`${i.id} (${ri.key}) depends on ${dep} queued later (${rj.key})`);
        }
        for (const rule of rulesFor(d, i, relOf(i))) if (!(i.overrides || []).includes(rule.decision)) W.push(`${i.id}: ${i.sec} issue in ${relOf(i).key}; ${rule.decision} keeps it in ${rule.only.join('/')}`);
    }
    for (const c of cycles(new Map(d.issues.map(i => [i.id, (i.deps || []).filter(x => byId.has(x))])))) E.push(`dependency cycle ${c}`);
    for (const r of Object.values(d.releases)) if (r.cap?.issues && (count.get(r.key) || 0) > r.cap.issues) E.push(`release ${r.key}: ${count.get(r.key)} issues over its cap ${r.cap.issues}`);
    for (const { r, s } of st.values()) for (const id of (s.title.match(/[A-Za-z][\w-]*\d[\w-]*/g) || [])) {
        const i = byId.get(id) || d.issues.find(x => aliasIds(x).includes(id));
        if (i && i.at && i.at !== s.key) W.push(`step ${s.key} names ${id}, which sits in ${i.at}`);
    }
    const triage = d.issues.filter(i => !i.at && !i.tail);
    if (triage.length) W.push(`triage ${triage.length}: ${triage.map(i => i.id).join(', ')}`);
    return { errors: E, warnings: W };
}

// ---------- views ----------
function splitCells(l) { const out = []; let cur = '', tick = false; for (const ch of l) { if (ch === '`') tick = !tick; if (ch === '|' && !tick) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; }
function renderProblems(d) {
    const st = steps(d), out = [...d.meta.problemsHead];
    for (const s of d.meta.sections) { out.push(s.title); for (const i of d.issues.filter(x => x.sec === s.key).sort((a, b) => a.ord - b.ord)) out.push(issueLine(d, i, st)); }
    return out.join('\n') + d.meta.problemsTail;
}
function stepText(d, s) {
    const extra = d.issues.filter(i => i.at === s.key && !idsOf(i).some(x => mentions(s.title, x))).map(i => i.id);
    return extra.length ? `${s.title}; ${extra.join(', ')}` : s.title;
}
function renderRoadmap(d) {
    const out = [...d.meta.roadmapHead];
    for (const g of d.meta.groups) {
        out.push(g.header);
        if (g.table) out.push(...g.table);
        for (const r of Object.values(d.releases).filter(x => x.group === g.key).sort((a, b) => a.order - b.order))
            for (const s of r.steps) out.push(g.table ? `| ${stepText(d, s)} | ${s.P} | ${s.S} | ${s.who ? s.who + ' ' : ''}|` : `- ${stepText(d, s)}`);
    }
    return out.join('\n') + d.meta.roadmapTail;
}
function budgets(cx) {
    const f = path.join(cx.planning, 'hygiene.js');
    const text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    const kb = name => { const m = text.match(new RegExp(`'${esc(name)}':\\s*(\\d+)`)); return m ? +m[1] : null; };
    return { roadmap: kb('roadmap.md'), problems: kb('architecture/problems.md') };
}
const VIEWS = { roadmap: 'roadmap.md', problems: 'architecture/problems.md' };
const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');

// ---------- import: today's planning files → data, proven lossless by rendering them back byte for byte ----------
function parseProblems(text) {
    const L = text.replace(/\n$/, '').split('\n'), head = [], sections = [], issues = [];
    let sec = null, ord = 0;
    for (const l of L) {
        if (l.startsWith('## ')) { const w = l.slice(3).toLowerCase().match(/[a-z]+/g); const key = sections.some(x => x.key === w[0]) ? w.slice(0, 2).join('-') : w[0]; sec = { key, title: l }; sections.push(sec); ord = 0; continue; }
        if (!sec) { head.push(l); continue; }
        const f = splitCells(l);
        if (f.length !== 7) fail(`problems.md: not a 7-field line in ${sec.title}: ${l.slice(0, 80)}`);
        const tag = f[6];
        issues.push({ id: f[0].split(' ')[0], head: f[0], sec: sec.key, ord: ++ord, at: null, origin: f[1], rule: f[2], sites: f[3], what: f[4], fix: f[5], legacy: tag });
    }
    return { head, sections, issues, tail: text.endsWith('\n') ? '\n' : '' };
}
const TYPES = { '1a': 'fix', '2': 'redesign', '3': 'server', '4': 'perf', '5': 'rule', '6': 'gaps', '7': 'safety', '8': 'feature', large: 'plan' };
function slugOf(title, taken) {
    const base = title.split(/[:(,;]/)[0].toLowerCase().match(/[a-z0-9]+/g).slice(0, 3).join('-').slice(0, 24) || 'step';
    let s = base, n = 2; while (taken.has(s)) s = `${base}-${n++}`; taken.add(s); return s;
}
function parseRoadmap(text) {
    const L = text.replace(/\n$/, '').split('\n'), head = [], groups = [], releases = {};
    let g = null, order = 0;
    const taken = new Map();
    for (const l of L) {
        if (l.startsWith('## ')) {
            const m = l.match(/^## (\d+[a-z]?)\./); const key = m ? m[1] : l.match(/^## (\w+)/)[1].toLowerCase();
            g = { key, header: l, table: null }; groups.push(g); taken.set(key, new Set()); continue;
        }
        if (!g) { head.push(l); continue; }
        if (/^\| Item \|/.test(l) || /^\|---/.test(l)) { (g.table ||= []).push(l); continue; }
        let title, P = '', S = '', who = '';
        if (l.startsWith('| ')) {
            const c = splitCells(l);
            if (c.length !== 6 || c[0] !== '' || c[5] !== '') fail(`roadmap.md: not a 4-cell row: ${l.slice(0, 80)}`);
            title = c[1].replace(/^ /, '').replace(/ $/, ''); P = c[2].trim(); S = c[3].trim(); who = c[4].trim();
        } else if (l.startsWith('- ')) title = l.slice(2);
        else fail(`roadmap.md: unknown line in ${g.header}: ${l.slice(0, 80)}`);
        const sub = g.key === '1b' && title.match(/^(1b\.\d+) (\w+)/);
        const rkey = sub ? sub[1] : g.key;
        const type = sub ? (/^arch/.test(sub[2]) ? 'arch' : 'feature') : TYPES[g.key] || 'feature';
        const r = releases[rkey] ||= { key: rkey, group: g.key, order: (order += 10), type, st: 'planned', title: sub ? title.replace(/\s*\([^)]*\)/g, '').split(':')[0] : g.header.replace(/^## /, ''), branch: null, base: null, head: null, decisions: [], cap: null, gates: {}, steps: [] };
        const needs = [...(title.match(/needs ((?:1b\.\d+(?:, )?)+)/)?.[1].matchAll(/1b\.\d+/g) || [])].map(m => m[0]);
        r.steps.push({ key: sub ? rkey : `${g.key}.${slugOf(title, taken.get(g.key))}`, title, P, S, who, needs, st: 'planned', tasks: [], landed: null });
    }
    return { head, groups, releases, tail: text.endsWith('\n') ? '\n' : '' };
}
function importPlanning(cx, opt) {
    const read = f => fs.readFileSync(path.join(cx.planning, f), 'utf8');
    const ptext = read(VIEWS.problems), rtext = read(VIEWS.roadmap);
    const p = parseProblems(ptext), r = parseRoadmap(rtext);
    const d = { meta: { problemsHead: p.head, problemsTail: p.tail, sections: p.sections, roadmapHead: r.head, roadmapTail: r.tail, groups: r.groups, rules: [], gates: { default: ['ci', 'trace', 'ab', 'report'], plan: [] }, lastRender: {} }, issues: [], decisions: [], releases: r.releases, archive: {} };
    if (opt.decisions) {
        const seed = JSON.parse(fs.readFileSync(opt.decisions, 'utf8'));
        d.decisions = seed.decisions; d.meta.rules = seed.rules || [];
        for (const [k, ids] of Object.entries(seed.releases || {})) if (d.releases[k]) d.releases[k].decisions = ids;
    }
    const st = steps(d), report = { placed: 0, triage: [], legacy: [] };
    for (const i of p.issues) {
        const hits = [...st.values()].filter(({ s }) => idsOf(i).some(x => mentions(s.title, x)));
        if (hits.length === 1) { i.at = hits[0].s.key; report.placed++; }
        else { i.why = hits.length ? `named by ${hits.map(h => h.s.key).join(', ')}` : 'named by no roadmap row'; report.triage.push(`${i.id}: ${i.why}`); const m = i.legacy.match(/^\[r(\w+)\]/); if (m) i.hint = m[1]; }
        if (tagFor(d, i, st) !== i.legacy) { i.tagx = i.legacy; report.legacy.push(`${i.id} ${i.legacy}`); }
        delete i.legacy;
        d.issues.push(i);
    }
    const back = { problems: renderProblems(d), roadmap: renderRoadmap(d) };
    for (const [k, text] of [['problems', ptext], ['roadmap', rtext]]) if (back[k] !== text) {
        const a = back[k].split('\n'), b = text.split('\n'); const n = a.findIndex((x, j) => x !== b[j]);
        fail(`import is not lossless for ${k} at line ${n + 1}:\n  data: ${String(a[n]).slice(0, 160)}\n  file: ${String(b[n]).slice(0, 160)}`);
    }
    d.meta.lastRender = { problems: sha1(ptext), roadmap: sha1(rtext) };
    return { d, report, originals: { 'import/problems.md': ptext, 'import/roadmap.md': rtext } };
}

// ---------- V5.1 evidence (read only) ----------
function task(cx, slug) {
    const f = path.join(cx.workflowDir, slug + '.json');
    if (!fs.existsSync(f)) fail(`V5.1 task ${slug}: no record at ${f}`);
    return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function onRemote(cx, head, branch, opt) {
    if (!opt['no-fetch']) cx.tryGit(['fetch', '-q', cx.remote, `refs/heads/${branch}:refs/remotes/${cx.remote}/${branch}`]);
    const tip = cx.tryGit(['rev-parse', '-q', '--verify', `refs/remotes/${cx.remote}/${branch}`]);
    if (!tip) fail(`${cx.remote}/${branch} unknown`);
    if (!cx.ok(['merge-base', '--is-ancestor', head, tip])) fail(`${head.slice(0, 9)} is not on ${cx.remote}/${branch}`);
    return tip;
}
const sameSha = (a, b) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));
function runSha(cx, ref) {
    const dir = fs.existsSync(ref) ? ref : path.join(cx.runs, ref);
    const f = path.join(dir, 'run.json');
    if (!fs.existsSync(f)) fail(`run ${ref}: no run.json`);
    const r = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (r.dirty) fail(`run ${ref} was made from a dirty tree`);
    return r.sha;
}

// ---------- commands ----------
const C = {};
const write = (cx, base, d, msg, out) => { const c = save(cx, base, d, msg); if (out) console.log(out); console.log(`lc ${c.slice(0, 9)}`); };
function need(cx) { const { sha, d } = load(cx); if (!sha) fail(`no data at ${cx.ref}; run lc import first`); return { sha, d }; }

C.import = (cx, { opt }) => {
    if (load(cx).sha) fail(`${cx.ref} exists; import runs once`);
    const { d, report, originals } = importPlanning(cx, opt);
    if (opt['dry-run']) { console.log(JSON.stringify({ issues: d.issues.length, placed: report.placed, triage: report.triage, legacy: report.legacy }, null, 1)); return; }
    const c = save(cx, null, d, `lc import from ${cx.planning}\n\nlossless: both views render back byte for byte; originals kept in this commit under import/`, originals);
    console.log(`imported ${d.issues.length} issues, ${Object.keys(d.releases).length} releases; placed ${report.placed}, triage ${report.triage.length}, legacy tags ${report.legacy.length}\nlc ${c.slice(0, 9)}`);
};
C.check = (cx) => {
    const { d } = need(cx); const { errors, warnings } = check(d);
    for (const e of errors) console.log('ERROR ' + e);
    for (const w of warnings) console.log('warn  ' + w);
    console.log(`${errors.length} errors, ${warnings.length} warnings`);
    if (errors.length) process.exitCode = 1;
};
C.status = (cx) => {
    const { sha, d } = need(cx); const { errors, warnings } = check(d);
    const tracking = cx.tryGit(['rev-parse', '-q', '--verify', `refs/remotes/${cx.remote}/${cx.ref.replace(/^refs\/heads\//, '')}`]);
    const triage = d.issues.filter(i => !i.at && !i.tail).length, st = steps(d);
    const out = [`lc ${sha.slice(0, 9)} ${tracking === sha ? 'on ' + cx.remote : tracking ? cx.remote + ' differs: lc push' : 'not on ' + cx.remote + ': lc push'} · open ${d.issues.length} · triage ${triage} · ${errors.length} errors · ${warnings.length} warnings`];
    const rels = Object.values(d.releases).sort((a, b) => a.order - b.order);
    for (const r of rels.filter(live)) {
        const wanted = d.meta.gates[r.type] || d.meta.gates.default;
        const done = r.steps.filter(s => s.st === 'landed').length;
        out.push(`${r.key} ${r.st} ${r.type} ${r.branch}${r.head ? ' @' + r.head.slice(0, 9) : ''} · steps ${done}/${r.steps.length} landed · gates ${wanted.map(g => g + (r.gates[g] ? '✓' : '·')).join(' ')}`);
        for (const s of r.steps.filter(x => x.st !== 'landed')) out.push(`  ${s.key} ${s.st}${s.tasks.length ? ' ' + s.tasks.at(-1) : ''} · ${d.issues.filter(i => i.at === s.key).length} issues${s.needs.length ? ' · needs ' + s.needs.join(',') : ''}`);
    }
    for (const r of rels.filter(x => x.st === 'planned' && x.group !== 'large').slice(0, 3)) {
        const n = d.issues.filter(i => st.get(i.at)?.r === r).length;
        const blocked = r.steps.flatMap(s => s.needs).filter(k => st.has(k) && st.get(k).s.st !== 'landed');
        out.push(`next ${r.key} ${r.type} · ${r.steps.length} steps · ${n} issues${r.cap?.issues ? '/' + r.cap.issues : ''}${blocked.length ? ' · waits ' + [...new Set(blocked)].join(',') : ''}`);
    }
    const b = budgets(cx), size = { roadmap: renderRoadmap(d).length, problems: renderProblems(d).length };
    out.push('views ' + Object.keys(VIEWS).map(k => `${k} ${Math.ceil(size[k] / 1024)}/${b[k] ?? '?'} KB${b[k] && Math.ceil(size[k] / 1024) > b[k] ? ' OVER' : ''}`).join(' · '));
    for (const e of errors.slice(0, 3)) out.push('ERROR ' + e);
    console.log(out.join('\n'));
};
C.show = (cx, { pos }) => {
    const { d } = need(cx); const key = pos[0] || fail('show <issue|step|release>'); const st = steps(d);
    if (d.releases[key]) {
        const r = d.releases[key];
        console.log(JSON.stringify({ ...r, steps: undefined }));
        for (const s of r.steps) console.log(`  ${s.key} ${s.st} · ${d.issues.filter(i => i.at === s.key).map(i => i.id).join(' ') || '-'}${s.landed ? ' · landed ' + JSON.stringify(s.landed) : ''}`);
        if (!st.has(key)) return;
    }
    if (st.has(key)) {
        const { r, s } = st.get(key);
        console.log(`${s.key} ${s.st} in ${r.key} (${r.st}, ${r.type})${s.needs.length ? ' needs ' + s.needs.join(',') : ''}${s.tasks.length ? ' tasks ' + s.tasks.join(',') : ''}`);
        console.log(stepText(d, s));
        for (const i of d.issues.filter(x => x.at === s.key)) console.log('  ' + issueLine(d, i, st).slice(0, 200));
        return;
    }
    const a = Object.entries(d.archive).flatMap(([k, x]) => (x.issues || []).filter(i => idsOf(i).includes(key)).map(i => ({ k, i })))[0];
    if (a) { console.log(`archived in ${a.k}: ${JSON.stringify(a.i.closed)}\n${[a.i.head, a.i.origin, a.i.rule, a.i.sites, a.i.what, a.i.fix].join('|')}`); return; }
    const i = issue(d, key);
    console.log(issueLine(d, i, st));
    console.log(`at ${i.at || (i.tail ? 'tail' : 'triage')}${i.at ? ' (' + st.get(i.at).r.key + ' ' + st.get(i.at).r.st + ')' : ''}${i.why ? ' · ' + i.why : ''}${i.deps?.length ? ' · deps ' + i.deps.join(',') : ''}`);
};
C.render = (cx, { opt }) => {
    const { sha, d } = need(cx);
    const views = { roadmap: renderRoadmap(d), problems: renderProblems(d) };
    if (opt.out) {
        for (const [k, f] of Object.entries(VIEWS)) { const p = path.join(opt.out, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, views[k]); }
        console.log(`rendered to ${opt.out}`); return;
    }
    if (!opt.write) fail('render --out <dir> (preview) or --write (planning/, guarded)');
    const b = budgets(cx), why = [];
    for (const [k, f] of Object.entries(VIEWS)) {
        const p = path.join(cx.planning, f), cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
        if (cur !== null && cur !== views[k] && sha1(cur) !== d.meta.lastRender[k]) why.push(`${f} was edited by hand since the last render: lc absorb first`);
        if (b[k] && Math.ceil(views[k].length / 1024) > b[k]) why.push(`${f} would be ${Math.ceil(views[k].length / 1024)} KB over its budget ${b[k]} KB: close paid issues or prune first`);
    }
    if (why.length) fail(why.join('\n'));
    for (const [k, f] of Object.entries(VIEWS)) fs.writeFileSync(path.join(cx.planning, f), views[k]);
    d.meta.lastRender = { roadmap: sha1(views.roadmap), problems: sha1(views.problems) };
    write(cx, sha, d, 'lc render', 'planning views written');
};
C.absorb = (cx, { opt }) => { // hand edits of problems.md (agents' habit) become data; deletions are refused
    const { sha, d } = need(cx);
    const p = parseProblems(fs.readFileSync(path.join(cx.planning, VIEWS.problems), 'utf8'));
    const mine = new Map(d.issues.map(i => [i.id, i])), theirs = new Map(p.issues.map(i => [i.id, i]));
    const gone = [...mine.keys()].filter(id => !theirs.has(id)), added = [], edited = [];
    for (const t of p.issues) {
        const m = mine.get(t.id);
        if (!m) { added.push(t); continue; }
        const f = ['head', 'origin', 'rule', 'sites', 'what', 'fix'].filter(k => m[k] !== t[k]);
        if (f.length) edited.push([m, t, f]);
    }
    for (const id of gone) console.log(`deleted by hand: ${id} (refused: lc land / lc drop close an issue)`);
    for (const t of added) console.log(`new: ${t.id} ${t.sec} ${t.legacy}`);
    for (const [m, , f] of edited) console.log(`edited: ${m.id} ${f.join(',')}`);
    if (!opt.apply) { console.log(`${added.length} new, ${edited.length} edited, ${gone.length} deleted; --apply to take them`); return; }
    if (gone.length) fail('deleted lines must be restored or closed through lc first');
    for (const [m, t, f] of edited) for (const k of f) m[k] = t[k];
    const sec = new Set(d.meta.sections.map(s => s.key));
    for (const t of added) {
        if (!sec.has(t.sec)) fail(`${t.id}: new section ${t.sec} needs the maintainer`);
        const m = t.legacy.match(/^\[r(\w+)\]/);
        d.issues.push({ ...t, legacy: undefined, ord: Math.max(0, ...d.issues.filter(i => i.sec === t.sec).map(i => i.ord)) + 1, hint: m ? m[1] : undefined, tail: t.legacy === '[tail]' || undefined, why: 'absorbed from problems.md' });
    }
    write(cx, sha, d, `lc absorb: ${added.length} new, ${edited.length} edited`);
};
function nextId(d, prefix) { const ids = allIds(d); let n = 1; for (const x of ids) { const m = x.match(new RegExp(`^${esc(prefix)}-(\\d+)$`)); if (m) n = Math.max(n, +m[1] + 1); } return `${prefix}-${n}`; }
C.add = (cx, { opt }) => {
    const { sha, d } = need(cx);
    const sec = one(opt, 'sec', 'section'); if (!d.meta.sections.find(s => s.key === sec)) fail(`sections: ${d.meta.sections.map(s => s.key).join(' ')}`);
    const id = opt.id ? String(opt.id) : nextId(d, opt.prefix ? String(opt.prefix) : 'DT');
    if (allIds(d).has(id)) fail(`${id} exists (ids are never reused)`);
    const i = { id, head: id, sec, ord: Math.max(0, ...d.issues.filter(x => x.sec === sec).map(x => x.ord)) + 1, at: null, origin: one(opt, 'origin', 'who date'), rule: one(opt, 'rule', 'rule#'), sites: one(opt, 'sites', 'file:line'), what: one(opt, 'what', 'what is wrong → impact'), fix: one(opt, 'fix', 'fix'), deps: many(opt.deps) };
    if (!i.deps.length) delete i.deps;
    if (opt.tail) i.tail = true;
    d.issues.push(i);
    if (opt.to) place(d, i, String(opt.to), opt); else if (!i.tail) i.why = 'new';
    write(cx, sha, d, `lc add ${id}${opt.to ? ' → ' + opt.to : ''}`, `${id} ${i.at ? 'in ' + i.at : i.tail ? 'tail' : 'triage'}`);
};
function place(d, i, target, opt) { // the one assignment rule; refuses what needs the maintainer
    const st = steps(d), from = i.at;
    if (target === 'triage' || target === 'tail') { i.at = null; i.tail = target === 'tail' || undefined; i.why = opt.reason ? String(opt.reason) : `moved from ${from || 'triage'}`; }
    else {
        const x = st.get(target) || fail(`no step ${target}`);
        if (x.r.st === 'frozen' && !opt.decision) fail(`release ${x.r.key} is frozen (scope closed): --decision <id> to add`);
        if (x.s.st === 'landed') fail(`step ${target} has landed; its issues are fixed set`);
        for (const rule of rulesFor(d, i, x.r)) {
            if (!opt.decision) fail(`${i.id} is ${i.sec}; ${rule.decision} keeps that in ${rule.only.join('/')}: --decision <id> to override`);
            i.overrides = [...new Set([...(i.overrides || []), rule.decision])];
        }
        i.at = target; delete i.tail; delete i.why; delete i.hint;
    }
    delete i.tagx;
    if (opt.decision && !d.decisions.find(x => x.id === opt.decision)) fail(`unknown decision ${opt.decision}`);
    const old = from && st.get(from);
    if (old && old.s.key !== i.at) for (const x of idsOf(i)) old.s.title = old.s.title.replace(new RegExp(`(, ${esc(x)}(?![\\w-]?\\w))|((?<![\\w-])${esc(x)}, )|((?<![\\w-])${esc(x)}(?![\\w-]?\\w))`), '');
}
C.assign = (cx, { pos, opt }) => {
    const { sha, d } = need(cx); const target = one(opt, 'to', 'step|triage|tail');
    if (!pos.length) fail('assign <id...> --to <step|triage|tail>');
    for (const id of pos) place(d, issue(d, id), target, opt);
    write(cx, sha, d, `lc assign ${pos.join(' ')} → ${target}${opt.decision ? ' (' + opt.decision + ')' : ''}${opt.reason ? '\n\n' + opt.reason : ''}`, `${pos.length} → ${target}`);
};
C.place = (cx, { opt }) => { // automatic placement: only where exactly one step fits; the rest stays in triage
    const { sha, d } = need(cx); const st = steps(d), plan = [];
    for (const i of d.issues.filter(x => !x.at && !x.tail)) {
        const open = [...st.values()].filter(({ r, s }) => r.st !== 'frozen' && s.st !== 'landed');
        let c = open.filter(({ s }) => idsOf(i).some(x => mentions(s.title, x))), how = 'named by the row';
        if (!c.length && i.hint) { c = open.filter(({ r, s }) => r.group === i.hint && d.issues.some(j => j.at === s.key && j.sec === i.sec)); how = `group ${i.hint}, same section`; }
        if (c.length === 1 && rulesFor(d, i, c[0].r).length === 0) plan.push([i, c[0].s.key, how]);
        else console.log(`${i.id} stays: ${c.length ? 'candidates ' + c.map(x => x.s.key).join(', ') : 'no candidate'}${c.length === 1 ? ' (needs a decision)' : ''}`);
    }
    for (const [i, k, how] of plan) console.log(`${i.id} → ${k} (${how})`);
    if (!opt.apply || !plan.length) { if (!opt.apply) console.log(`${plan.length} placeable; --apply to place`); return; }
    for (const [i, k] of plan) place(d, i, k, {});
    write(cx, sha, d, `lc place: ${plan.map(([i, k]) => i.id + '→' + k).join(' ')}`);
};
C.dep = (cx, { pos, opt }) => { // lc dep <id> --on a,b | --clear: an issue's dependencies; check refuses cycles and later deps
    const { sha, d } = need(cx); const i = issue(d, pos[0] || fail('dep <id> --on <ids> | --clear'));
    const known = allIds(d);
    if (opt.clear) delete i.deps;
    else { const on = many(opt.on); if (!on.length) fail('--on <ids>'); for (const x of on) if (!known.has(x)) fail(`unknown ${x}`); i.deps = [...new Set([...(i.deps || []), ...on])]; }
    write(cx, sha, d, `lc dep ${i.id} ${opt.clear ? 'cleared' : 'on ' + i.deps.join(',')}`);
};
C.drop = (cx, { pos, opt }) => {
    const { sha, d } = need(cx); const i = issue(d, pos[0] || fail('drop <id> --reason <why> (--decision <id> | --rule0 | --fixed-by <slug>)'));
    const reason = one(opt, 'reason', 'why');
    const closed = { how: 'dropped', reason, at: cx.now };
    if (opt.decision) { if (!d.decisions.find(x => x.id === opt.decision)) fail(`unknown decision ${opt.decision}`); closed.decision = opt.decision; }
    else if (opt.rule0) closed.how = 'not-worth-it';
    else if (opt['fixed-by']) { const t = task(cx, String(opt['fixed-by'])); if (!t.evidence?.landed) fail(`${opt['fixed-by']} has not landed`); onRemote(cx, t.evidence.landed.head, t.evidence.landed.branch, opt); closed.how = 'fixed'; closed.slug = t.slug; closed.head = t.evidence.landed.head; }
    else fail('a drop names --decision, --rule0 or --fixed-by');
    archiveIssue(d, i, i.at ? steps(d).get(i.at).r.key : 'triage', closed);
    write(cx, sha, d, `lc drop ${i.id}: ${closed.how}\n\n${reason}`, `${i.id} closed (${closed.how})`);
};
function archiveIssue(d, i, rel, closed) {
    const st = steps(d), old = i.at && st.get(i.at);
    if (old) for (const x of idsOf(i)) old.s.title = old.s.title.replace(new RegExp(`(, ${esc(x)}(?![\\w-]?\\w))|((?<![\\w-])${esc(x)}, )|((?<![\\w-])${esc(x)}(?![\\w-]?\\w))`), '');
    d.issues = d.issues.filter(x => x !== i);
    const a = d.archive[rel] ||= {};
    (a.issues ||= []).push({ ...i, tag: tagFor(d, i, st), closed });
}
C.decide = (cx, { opt }) => {
    const { sha, d } = need(cx);
    const id = `M${Math.max(0, ...d.decisions.map(x => +x.id.slice(1))) + 1}`;
    d.decisions.push({ id, date: one(opt, 'date', 'YYYY-MM-DD'), text: one(opt, 'text', 'the decision as said') });
    write(cx, sha, d, `lc decide ${id}`, id);
};
C.release = (cx, { pos, opt }) => { // release add <key> | release set <key>
    const { sha, d } = need(cx); const [verb, key] = pos;
    if (verb === 'add') {
        if (d.releases[key] || d.archive[key]) fail(`release ${key} exists`);
        const group = one(opt, 'group', 'roadmap group'); if (!d.meta.groups.find(g => g.key === group)) fail(`unknown group ${group}`);
        d.releases[key] = { key, group, order: Number(one(opt, 'order', 'number')), type: one(opt, 'type', 'fix|arch|feature|...'), st: 'planned', title: opt.title ? String(opt.title) : key, branch: null, base: null, head: null, decisions: many(opt.decisions), cap: null, gates: {}, steps: [] };
    } else if (verb === 'set') {
        const r = release(d, key);
        if (opt.cap !== undefined) { r.cap = { issues: Number(opt.cap) }; if (!opt.decision) fail('a cap is the maintainer\'s: --decision <id>'); r.decisions = [...new Set([...r.decisions, String(opt.decision)])]; }
        if (opt.order !== undefined) { if (!opt.decision) fail('order is the maintainer\'s: --decision <id>'); r.order = Number(opt.order); r.decisions = [...new Set([...r.decisions, String(opt.decision)])]; }
        if (opt.type !== undefined) { if (r.st !== 'planned') fail('type changes only while planned'); r.type = String(opt.type); }
    } else fail('release add <key> --group --order --type | release set <key> [--cap N|--order N --decision id] [--type T]');
    write(cx, sha, d, `lc release ${verb} ${key}`);
};
C.step = (cx, { pos, opt }) => { // step add <release> --key --title [--P --S --who --needs]
    const { sha, d } = need(cx); const [verb, rk] = pos;
    if (verb !== 'add') fail('step add <release> --key <k> --title <t> [--P --S --who --needs a,b]');
    const r = release(d, rk); if (r.st === 'frozen') fail(`${rk} is frozen`);
    r.steps.push({ key: one(opt, 'key', 'step key'), title: one(opt, 'title', 'row text'), P: opt.P ? String(opt.P) : '', S: opt.S ? String(opt.S) : '', who: opt.who ? String(opt.who) : '', needs: many(opt.needs), st: 'planned', tasks: [], landed: null });
    write(cx, sha, d, `lc step add ${rk} ${opt.key}`);
};
C.open = (cx, { pos, opt }) => {
    const { sha, d } = need(cx); const r = release(d, pos[0] || fail('open <release> --branch <b> --base <sha>'));
    if (r.st !== 'planned') fail(`${r.key} is ${r.st}`);
    const branch = one(opt, 'branch', 'integration branch'), base = cx.tryGit(['rev-parse', '--verify', one(opt, 'base', 'sha') + '^{commit}']) || fail('unknown base');
    const tip = cx.tryGit(['rev-parse', '--verify', `refs/heads/${branch}`]) || fail(`branch ${branch} does not exist locally`);
    if (!cx.ok(['merge-base', '--is-ancestor', base, tip])) fail(`base ${base.slice(0, 9)} is not on ${branch}`);
    const st = steps(d);
    const waits = r.steps.flatMap(s => s.needs).filter(k => st.has(k) && st.get(k).r !== r && st.get(k).s.st !== 'landed');
    if (waits.length) fail(`${r.key} needs ${[...new Set(waits)].join(', ')} landed first`);
    Object.assign(r, { st: 'open', branch, base, openedAt: cx.now });
    write(cx, sha, d, `lc open ${r.key} on ${branch} from ${base.slice(0, 9)}`, `${r.key} open on ${branch}`);
};
C.start = (cx, { pos, opt }) => {
    const { sha, d } = need(cx); const { r, s } = step(d, pos[0] || fail('start <step> --task <V5.1 slug>'));
    if (r.st !== 'open') fail(`${r.key} is ${r.st}; open it first`);
    if (s.st === 'landed') fail(`${s.key} has landed`);
    const st = steps(d); const waits = s.needs.filter(k => st.has(k) && st.get(k).s.st !== 'landed');
    if (waits.length) fail(`${s.key} needs ${waits.join(', ')} landed first`);
    const slug = one(opt, 'task', 'V5.1 slug'), t = task(cx, slug);
    for (const { s: o } of st.values()) if (o !== s && o.tasks.includes(slug)) fail(`${slug} already belongs to ${o.key}`);
    if (!cx.ok(['merge-base', '--is-ancestor', t.base, `refs/heads/${r.branch}`])) console.log(`note: ${slug} base ${t.base.slice(0, 9)} is not on ${r.branch} yet`);
    s.st = 'active'; s.tasks = [...new Set([...s.tasks, slug])];
    write(cx, sha, d, `lc start ${s.key} with ${slug}`, `${s.key} active (${slug})`);
};
C.land = (cx, { pos, opt }) => {
    const { sha, d } = need(cx); const { r, s } = step(d, pos[0] || fail('land <step> [--task slug] [--keep id,...] | --decision id --ref <evidence>'));
    if (r.st !== 'open') fail(`${r.key} is ${r.st}`);
    if (s.st === 'landed') fail(`${s.key} has landed`);
    if (opt.decision) { // a step with no code (a measurement, a world test) closes on its evidence and a maintainer decision
        if (!d.decisions.find(x => x.id === opt.decision)) fail(`unknown decision ${opt.decision}`);
        s.landed = { decision: String(opt.decision), ref: one(opt, 'ref', 'evidence'), head: cx.tryGit(['rev-parse', `refs/heads/${r.branch}`]), at: cx.now };
    } else {
        const slug = opt.task ? String(opt.task) : s.tasks.at(-1) || fail(`${s.key} has no task; lc start first`);
        if (!s.tasks.includes(slug)) fail(`${slug} is not a task of ${s.key}`);
        const t = task(cx, slug), l = t.evidence?.landed || fail(`${slug}: no record-land in V5.1`);
        if (l.branch !== r.branch) fail(`${slug} landed on ${l.branch}, ${r.key} integrates ${r.branch}`);
        if (t.evidence?.review?.result !== 'pass' || !sameSha(t.evidence?.ready?.head, l.reviewedHead)) fail(`${slug}: review/ready evidence does not cover the landed head`);
        onRemote(cx, l.head, r.branch, opt);
        s.landed = { slug, head: l.head, tree: l.tree, ci: (t.evidence.ciRuns || []).filter(x => sameSha(x.head, l.reviewedHead)).map(x => x.id), at: cx.now };
    }
    s.st = 'landed';
    for (const id of many(opt.keep)) { const i = issue(d, id); if (i.at !== s.key) fail(`${id} is not in ${s.key}`); place(d, i, 'triage', { reason: `kept open when ${s.key} landed` }); }
    write(cx, sha, d, `lc land ${s.key}${s.landed.slug ? ' by ' + s.landed.slug + ' ' + s.landed.head.slice(0, 9) : ' by ' + s.landed.decision}`, `${s.key} landed; ${d.issues.filter(i => i.at === s.key).length} issues close with ${r.key}`);
};
C.defer = (cx, { pos, opt }) => { // a step not done moves whole to another release; its issues follow by key
    const { sha, d } = need(cx); const { r, s } = step(d, pos[0] || fail('defer <step> --to <release> --reason <why>'));
    const to = release(d, one(opt, 'to', 'release')), reason = one(opt, 'reason', 'why');
    if (s.st === 'landed') fail(`${s.key} has landed`);
    if (to === r) fail('same release');
    if (to.st === 'frozen') fail(`${to.key} is frozen`);
    r.steps = r.steps.filter(x => x !== s);
    to.steps.push({ ...s, st: to.st === 'planned' ? 'planned' : s.st, carried: [...(s.carried || []), { from: r.key, reason, at: cx.now }] });
    write(cx, sha, d, `lc defer ${s.key} ${r.key} → ${to.key}\n\n${reason}`, `${s.key} → ${to.key}`);
};
C.freeze = (cx, { pos, opt }) => {
    const { sha, d } = need(cx); const r = release(d, pos[0] || fail('freeze <release> [--head sha]'));
    if (r.st !== 'open') fail(`${r.key} is ${r.st}`);
    const left = r.steps.filter(s => s.st !== 'landed');
    if (left.length) fail(`not landed: ${left.map(s => s.key).join(', ')} (land or defer them)`);
    const head = cx.tryGit(['rev-parse', '--verify', (opt.head ? String(opt.head) : `refs/heads/${r.branch}`) + '^{commit}']) || fail('unknown head');
    onRemote(cx, head, r.branch, opt);
    for (const s of r.steps) if (s.landed.head && !cx.ok(['merge-base', '--is-ancestor', s.landed.head, head])) fail(`${s.key} ${s.landed.head.slice(0, 9)} is not in ${head.slice(0, 9)}`);
    Object.assign(r, { st: 'frozen', head, frozenAt: cx.now });
    write(cx, sha, d, `lc freeze ${r.key} at ${head.slice(0, 9)}`, `${r.key} frozen at ${head.slice(0, 9)}`);
};
C.gate = (cx, { pos, opt }) => { // the gate's own evidence comes from V5.1 (ci) or the run's run.json; the verdict stays with its reviewer
    const { sha, d } = need(cx); const r = release(d, pos[0]); const g = pos[1];
    const want = d.meta.gates[r.type] || d.meta.gates.default;
    if (!want.includes(g)) fail(`${r.type} releases need gates ${want.join(', ')}`);
    if (r.st !== 'frozen') fail(`gates are recorded on the frozen head; ${r.key} is ${r.st}`);
    const rec = { at: cx.now };
    if (opt.waive) { rec.waived = one(opt, 'decision', 'decision id'); if (!d.decisions.find(x => x.id === rec.waived)) fail(`unknown decision ${rec.waived}`); rec.reason = one(opt, 'reason', 'why'); }
    else if (g === 'ci') {
        const t = task(cx, one(opt, 'task', 'V5.1 slug holding the release CI'));
        const runs = (t.evidence?.ciRuns || []).filter(x => sameSha(x.head, r.head));
        if (!runs.length) fail(`${t.slug} has no CI run on ${r.head.slice(0, 9)}`);
        Object.assign(rec, { task: t.slug, runs: runs.map(x => x.id) });
    } else if (g === 'trace' || g === 'ab') {
        const runs = many(opt.run); if (!runs.length) fail('--run <run dir> (repeatable)');
        for (const x of runs) if (!sameSha(runSha(cx, x), r.head)) fail(`run ${x} is not of ${r.head.slice(0, 9)}`);
        Object.assign(rec, { runs: runs.map(x => path.basename(x)), verdict: one(opt, 'verdict', 'report path or text with the verdict') });
    } else rec.ref = one(opt, 'ref', 'evidence');
    r.gates[g] = rec;
    write(cx, sha, d, `lc gate ${r.key} ${g}${rec.waived ? ' waived by ' + rec.waived : ''}`, `${r.key} ${g} ✓`);
};
C.close = (cx, { pos, opt }) => {
    const { sha, d } = need(cx); const r = release(d, pos[0] || fail('close <release>'));
    if (r.st !== 'frozen') fail(`${r.key} is ${r.st}; freeze it first`);
    const want = d.meta.gates[r.type] || d.meta.gates.default, missing = want.filter(g => !r.gates[g]);
    if (missing.length) fail(`gates missing: ${missing.join(', ')}`);
    const keys = new Set(r.steps.map(s => s.key)), paid = d.issues.filter(i => keys.has(i.at));
    for (const i of paid) { const s = r.steps.find(x => x.key === i.at); archiveIssue(d, i, r.key, { how: 'landed', step: s.key, slug: s.landed.slug, decision: s.landed.decision, head: s.landed.head, release: r.key, at: cx.now }); }
    delete d.releases[r.key];
    (d.archive[r.key] ||= {}).manifest = { ...r, st: 'closed', closedAt: cx.now };
    d.archive[r.key].issues ||= [];
    write(cx, sha, d, `lc close ${r.key}: ${paid.length} issues archived`, `${r.key} closed; ${paid.length} issues archived`);
};
C.push = (cx) => {
    const { sha } = need(cx);
    cx.git(['push', '-q', cx.remote, `${cx.ref}:${cx.ref}`]);
    cx.tryGit(['update-ref', `refs/remotes/${cx.remote}/${cx.ref.replace(/^refs\/heads\//, '')}`, sha]);
    console.log(`pushed ${sha.slice(0, 9)} to ${cx.remote}`);
};
C.get = (cx, { pos }) => { // for scripts: lc get <release> branch|head|base|st
    const { d } = need(cx); const r = release(d, pos[0]); const v = r[pos[1]];
    if (v === undefined || v === null) fail(`${pos[0]} has no ${pos[1]}`);
    console.log(v);
};
C.help = () => console.log(`lc status | check | show <id|step|release> | get <release> <field>
issues:   add --sec --origin --rule --sites --what --fix [--prefix|--id] [--to step] [--deps] [--tail]
          assign <id...> --to <step|triage|tail> [--decision M] | place [--apply] | dep <id> --on ids|--clear | drop <id> --reason (--decision|--rule0|--fixed-by slug)
releases: release add|set | step add <rel> | open <rel> --branch --base | start <step> --task <slug> | land <step> [--keep ids]
          defer <step> --to <rel> --reason | freeze <rel> | gate <rel> <ci|trace|ab|report> ... | close <rel>
views:    render --out <dir> | render --write | absorb [--apply]      data: import [--dry-run] | decide | push`);

function main(argv) {
    const [cmd, ...rest] = argv; const a = parseArgs(rest);
    const f = C[cmd || 'help'] || fail(`unknown command ${cmd}; lc help`);
    if (cmd === 'help' || !cmd) return f();
    f(context(a.opt), a);
}
module.exports = { main, context, load, save, check, parseProblems, parseRoadmap, renderProblems, renderRoadmap, Refusal };
if (require.main === module) {
    try { main(process.argv.slice(2)); }
    catch (e) { if (e instanceof Refusal) { console.error('lc: ' + e.message); process.exitCode = 2; } else throw e; }
}
