#!/usr/bin/env node
'use strict';
// lc: L2Solo issue and release lifecycle. One git ref holds the open issues, one manifest per release, the
// maintainer's decisions and the archive; planning/roadmap.md and planning/architecture/problems.md
// are rendered from it. A write is one commit: checked against the fork's copy, moved by compare-and-swap
// (`update-ref new old`), then pushed without force; a refused push undoes the local move. V5.1 task records are read
// as evidence, never written. lc never pushes to origin and never opens a PR. No server, database, scheduler or lock.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

class Refusal extends Error {}
const fail = msg => { throw new Refusal(msg); };
const firstLine = e => String(e.stderr || e.message || e).trim().split('\n')[0];

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
const list = v => v === undefined || v === true ? [] : [].concat(v).map(String);
const one = (opt, k, what) => { const v = opt[k]; if (v === undefined || v === true || Array.isArray(v)) fail(`--${k} <${what}> required`); return String(v); };

function context(opt) {
    const repo = path.resolve(opt.repo || process.env.LC_REPO || process.cwd());
    const git = (args, input) => execFileSync('git', args, { cwd: repo, input, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['pipe', 'pipe', 'pipe'] }).replace(/\n$/, '');
    const tryGit = args => { try { return git(args); } catch { return null; } };
    const ok = args => { try { git(args); return true; } catch { return false; } };
    const common = path.resolve(repo, git(['rev-parse', '--git-common-dir']));
    const primary = path.dirname(common);
    const ref = opt['data-ref'] || process.env.LC_REF || 'refs/heads/ivan/lifecycle-data';
    const remote = opt.remote || process.env.LC_REMOTE || 'fork';
    return {
        repo, git, tryGit, ok, ref, remote,
        tracking: `refs/remotes/${remote}/${ref.replace(/^refs\/heads\//, '')}`,
        offline: process.env.LC_OFFLINE === '1',
        workflowDir: process.env.LC_WORKFLOW_DIR || path.join(common, 'l2solo-workflow'),
        workflowJs: process.env.LC_WORKFLOW_JS || path.join(primary, '.claude/workflow.js'),
        planning: path.resolve(opt.planning || process.env.LC_PLANNING || path.join(primary, 'planning')),
        runs: process.env.LC_RUNS || path.join(primary, 'tmp/perf/runs'),
        now: process.env.LC_NOW || new Date().toISOString()
    };
}
const rev = (cx, x) => cx.tryGit(['rev-parse', '--verify', '-q', x + '^{commit}']);

// ---------- remote truth: ls-remote names the tip, a fetch that fails or disagrees refuses ----------
function remoteTip(cx, ref, remote = cx.remote) {
    let out;
    try { out = cx.git(['ls-remote', remote, ref]); } catch (e) { fail(`cannot read ${remote} ${ref}: ${firstLine(e)}`); }
    const line = out.split('\n').find(l => l.endsWith('\t' + ref));
    return line ? line.split('\t')[0] : null;
}
function fetchTip(cx, branch, remote = cx.remote) {
    const tip = remoteTip(cx, `refs/heads/${branch}`, remote) || fail(`${remote} has no ${branch}`);
    try { cx.git(['fetch', '-q', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]); }
    catch (e) { fail(`fetch ${remote}/${branch} failed (${firstLine(e)}); a stale copy is not evidence`); }
    if (rev(cx, `refs/remotes/${remote}/${branch}`) !== tip) fail(`${remote}/${branch} moved during the command; run it again`);
    return tip;
}
function onRemote(cx, head, branch) {
    const tip = fetchTip(cx, branch);
    if (!cx.ok(['merge-base', '--is-ancestor', head, tip])) fail(`${head.slice(0, 9)} is not on ${cx.remote}/${branch} (${tip.slice(0, 9)})`);
    return tip;
}

// ---------- storage: plain files on a git ref ----------
const jsonl = s => (s || '').split('\n').filter(Boolean).map(l => JSON.parse(l));
const lines = arr => arr.map(x => JSON.stringify(x)).join('\n') + (arr.length ? '\n' : '');
function manifestText(r) { // one step per line keeps diffs one line per change
    const { steps, ...head } = r;
    return JSON.stringify(head, null, 1).replace(/\n}$/, `,\n "steps": [\n${steps.map(s => '  ' + JSON.stringify(s)).join(',\n')}\n ]\n}`) + '\n';
}
function load(cx) {
    const sha = rev(cx, cx.ref);
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
    upgrade(d);
    return { sha, d };
}
const PROFILES = { // what a gate run must be (release.md "Releases"; testing.md traced runs)
    trace: { sides: [{ scenario: 'script', script: 'tests/e2e/online-player.js', minutes: 30 }], artifacts: ['run.json', 'server.log', 'summary.json', 'logs', 'world.sqlite'] },
    ab: { sides: [{ scenario: 'script', script: 'tests/e2e/online-player.js', minutes: 30 }, { scenario: 'hot', minutes: 20 }], diagnostics: true, artifacts: ['run.json', 'server.log', 'summary.json', 'logs'] }
};
const DEFAULT_BUDGETS = { rc: 2048, pack: 12288, rowIssues: 25 }; // context per role (bytes) and a row's issue count before it is called broad
const budgetsOf = d => ({ ...DEFAULT_BUDGETS, ...(d.meta.budgets || {}) });
function upgrade(d) { // data written by older lc versions
    const m = d.meta;
    if ((m.version || 1) < 2) {
        for (const k of Object.keys(m.lastRender || {})) if (typeof m.lastRender[k] === 'string') m.lastRender[k] = { cur: m.lastRender[k], prev: null };
        m.profiles ||= PROFILES; m.placement ||= [];
        for (const i of d.issues) { delete i.hint; if (i.overrides) i.overrides = i.overrides.filter(x => typeof x === 'string'); }
        m.version = 2;
    }
    if (m.version < 3) { m.budgets ||= { ...DEFAULT_BUDGETS }; m.cutover ??= false; m.version = 3; }
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
function fresh(cx, base) { // the fork's copy is the shared truth: act only on top of it
    if (cx.offline) return;
    const tip = remoteTip(cx, cx.ref);
    if (tip && tip !== base && !(base && cx.ok(['merge-base', '--is-ancestor', tip, base])))
        fail(`${cx.remote} holds lifecycle data this copy has not seen (${tip.slice(0, 9)}); lc sync, then run the command again`);
}
function save(cx, base, d, msg, extra) {
    const secAt = new Map(d.meta.sections.map((s, i) => [s.key, i]));
    d.issues.sort((a, b) => secAt.get(a.sec) - secAt.get(b.sec) || a.ord - b.ord);
    const { errors } = check(d);
    if (errors.length) fail('refused, invariants would break:\n  ' + errors.slice(0, 20).join('\n  '));
    fresh(cx, base);
    const args = ['commit-tree', writeTree(cx, encode(d, extra)), '-m', msg];
    if (base) args.push('-p', base);
    const commit = cx.git(args, '');
    try { cx.git(['update-ref', '-m', 'lc', cx.ref, commit, base || '0'.repeat(40)]); }
    catch { fail(`${cx.ref} moved while this command ran; nothing written, run it again`); }
    if (!cx.offline) {
        try { cx.git(['push', '-q', cx.remote, `${commit}:${cx.ref}`]); cx.tryGit(['update-ref', cx.tracking, commit]); }
        catch (e) {
            if (base) cx.tryGit(['update-ref', cx.ref, base, commit]); else cx.tryGit(['update-ref', '-d', cx.ref, commit]);
            fail(`push to ${cx.remote} refused (${firstLine(e)}); nothing written; lc sync`);
        }
    }
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
const norm = x => path.basename(String(x).replace(/^\+/, '')).replace(/^(test_)?/, 'test_').replace(/(\.js)?$/, '.js');
const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');
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
const NOTE = '(?: \\([^)]*\\))?'; // an id may carry a note: "ECO-10 (bid worth)"
const stripMention = (s, ids) => { for (const x of ids) s.title = s.title.replace(new RegExp(`(, ${esc(x)}${NOTE}(?![\\w-]?\\w))|((?<![\\w-])${esc(x)}${NOTE}, )|((?<![\\w-])${esc(x)}${NOTE}(?![\\w-]?\\w))`), ''); };
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
const ACTIONS = ['rule-override', 'scope-add', 'cap', 'order', 'land-no-code', 'drop', 'split', 'publish', 'gates', 'placement-rule']; // every action lc checks
const rulesFor = (d, i, r) => (d.meta.rules || []).filter(x => x.sec === i.sec && r && !x.only.includes(r.group));
// A decision authorizes only the actions it names, on the subjects it names (issue, step, release, value, ...).
const allows = (dec, action, subject) => (dec?.allows || []).some(a => a.action === action && Object.entries(a).every(([k, v]) => k === 'action' || String(subject[k]) === String(v)));
function authorize(d, id, action, subject) {
    if (!id || id === true) fail(`${action} ${JSON.stringify(subject)} needs --decision <id> that allows it`);
    const dec = d.decisions.find(x => x.id === id) || fail(`unknown decision ${id}`);
    if (!allows(dec, action, subject)) fail(`${id} does not allow ${action} ${JSON.stringify(subject)}`);
    return id;
}
const overridden = (d, i, rule) => (i.overrides || []).some(id => allows(d.decisions.find(x => x.id === id), 'rule-override', { issue: i.id, rule: rule.decision }));

// ---------- growth: why the working context is large, each cause with its owner action; nothing is cut ----------
const ticks = t => [...String(t).matchAll(/`([^`]+)`/g)].map(m => m[1].trim());
const modules = t => [...new Set([...ticks(t), ...String(t).split(/[\s,;()]+/)].map(x => (x.match(/^([A-Z][A-Za-z0-9]{3,})(?![A-Za-z0-9])/) || [])[1]).filter(Boolean))];
const member = x => /^[A-Za-z][\w]{3,}\.[a-z_]\w{2,}$/.test(x) && !/\.(c?js|json|md|ini|sql)$/.test(x); // `Module.method`, not a file name
const rulesOf = i => new Set(String(i.rule).split(/[,\s]+/).filter(Boolean));
function duplicates(d) { // open pairs sharing an exact quoted member (`Module.method`) and a rule number; a module alone or a name shared by more than 6 is not evidence
    const by = new Map();
    for (const i of d.issues) for (const t of new Set(ticks(i.sites).filter(member))) (by.get(t) || by.set(t, []).get(t)).push(i);
    const pairs = new Map();
    for (const [t, xs] of [...by].sort()) if (xs.length > 1 && xs.length <= 6)
        for (let a = 0; a < xs.length; a++) for (let b = a + 1; b < xs.length; b++) {
            if (![...rulesOf(xs[a])].some(r => rulesOf(xs[b]).has(r))) continue;
            const k = [xs[a].id, xs[b].id].sort().join(' ~ '); if (!pairs.has(k)) pairs.set(k, t);
        }
    return [...pairs].map(([k, t]) => `${k} (\`${t}\`)`);
}
function sameName(d, sites, except) { // open issues quoting one of these exact code names
    const mine = new Set(ticks(sites).filter(x => !/\s/.test(x) && /[A-Za-z]{4,}/.test(x)));
    return d.issues.filter(i => i !== except && ticks(i.sites).some(t => mine.has(t))).map(i => `${i.id} (\`${ticks(i.sites).find(t => mine.has(t))}\`)`);
}
function staleIds(cx) { // code names planning/architecture/check.js finds gone, on problems.md lines
    const f = path.join(cx.planning, 'architecture/check.js'), pf = path.join(cx.planning, VIEWS.problems);
    if (!fs.existsSync(f) || !fs.existsSync(pf)) return null;
    let out = '';
    try { out = execFileSync(process.execPath, [f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { out = String(e.stdout || ''); }
    const L = fs.readFileSync(pf, 'utf8').split('\n');
    return [...new Set(out.split('\n').map(l => l.match(/^problems\.md:(\d+)/)).filter(Boolean).map(m => (L[+m[1] - 1] || '').split(/[| ]/)[0]).filter(Boolean))];
}
function growth(d, cx) {
    const st = steps(d), b = budgetsOf(d);
    return {
        triage: d.issues.filter(i => !i.at && !i.tail).map(i => i.id),
        tails: dueTails(d).due.map(i => i.id),
        duplicates: duplicates(d),
        broad: [...st.values()].map(({ s }) => [s.key, d.issues.filter(i => i.at === s.key).length]).filter(([, n]) => n > b.rowIssues).map(([k, n]) => `${k} ${n}`),
        waiting: d.issues.filter(i => i.resolved).map(i => i.id),
        stale: cx ? staleIds(cx) : null
    };
}
const growthLine = g => `growth: triage ${g.triage.length} (place) · tails due ${g.tails.length} (assign or drop) · possible duplicates ${g.duplicates.length} (decide) · rows over budget ${g.broad.length} (split is a decision) · resolved waiting close ${g.waiting.length}${g.stale ? ` · stale names ${g.stale.length} (refresh or close)` : ''}`;

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
            else count.set(x.r.key, (count.get(x.r.key) || 0) + 1);
            if (i.resolved && (!x || x.s.st !== 'landed')) E.push(`${i.id}: resolved but its step has not landed`);
        } else if (i.resolved) E.push(`${i.id}: resolved outside a step`);
        if (i.tagx) W.push(`${i.id}: legacy tag ${i.tagx}, its step says ${tagFor(d, { ...i, tagx: undefined }, st)}`);
        for (const o of i.overrides || []) if (!decs.has(o)) E.push(`${i.id}: override by unknown decision ${o}`);
        for (const dep of i.deps || []) {
            if (!seen.has(dep)) { E.push(`${i.id}: depends on unknown ${dep}`); continue; }
            const j = byId.get(dep); if (!j) continue; // archived = paid
            const ri = relOf(i), rj = relOf(j);
            if (ri && !rj) W.push(`${i.id} (${ri.key}) depends on ${dep} in triage`);
            if (ri && rj && rj.order > ri.order) E.push(`${i.id} (${ri.key}) depends on ${dep} queued later (${rj.key})`);
        }
        for (const rule of rulesFor(d, i, relOf(i))) if (!overridden(d, i, rule)) W.push(`${i.id}: ${i.sec} issue in ${relOf(i).key}; ${rule.decision} keeps it in ${rule.only.join('/')}`);
    }
    for (const c of cycles(new Map(d.issues.map(i => [i.id, (i.deps || []).filter(x => byId.has(x))])))) E.push(`dependency cycle ${c}`);
    for (const r of Object.values(d.releases)) if (r.cap?.issues && (count.get(r.key) || 0) > r.cap.issues) E.push(`release ${r.key}: ${count.get(r.key)} issues over its cap ${r.cap.issues}`);
    for (const p of d.meta.placement || []) if (!st.has(p.to) || !allows(d.decisions.find(x => x.id === p.decision), 'placement-rule', { to: p.to })) E.push(`placement rule to ${p.to}: no such step or not allowed by ${p.decision}`);
    for (const { s } of st.values()) for (const id of (s.title.match(/[A-Za-z][\w-]*\d[\w-]*/g) || [])) {
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

// ---------- import: today's planning files → data, proven lossless by rendering them back byte for byte ----------
function parseProblems(text) {
    const L = text.replace(/\n$/, '').split('\n'), head = [], sections = [], issues = [];
    let sec = null, ord = 0;
    for (const l of L) {
        if (l.startsWith('## ')) { const w = l.slice(3).toLowerCase().match(/[a-z]+/g); const key = sections.some(x => x.key === w[0]) ? w.slice(0, 2).join('-') : w[0]; sec = { key, title: l }; sections.push(sec); ord = 0; continue; }
        if (!sec) { head.push(l); continue; }
        const f = splitCells(l);
        if (f.length !== 7) fail(`problems.md: not a 7-field line in ${sec.title}: ${l.slice(0, 80)}`);
        issues.push({ id: f[0].split(' ')[0], head: f[0], sec: sec.key, ord: ++ord, at: null, origin: f[1], rule: f[2], sites: f[3], what: f[4], fix: f[5], legacy: f[6] });
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
    const d = { meta: { version: 3, budgets: { ...DEFAULT_BUDGETS }, cutover: false, problemsHead: p.head, problemsTail: p.tail, sections: p.sections, roadmapHead: r.head, roadmapTail: r.tail, groups: r.groups, rules: [], placement: [], profiles: PROFILES, gates: { default: ['ci', 'trace', 'ab', 'report'], plan: [] }, lastRender: {} }, issues: [], decisions: [], releases: r.releases, archive: {} };
    if (opt.decisions) {
        const seed = JSON.parse(fs.readFileSync(opt.decisions, 'utf8'));
        d.decisions = seed.decisions; d.meta.rules = seed.rules || [];
        for (const [k, ids] of Object.entries(seed.releases || {})) if (d.releases[k]) d.releases[k].decisions = ids;
    }
    const st = steps(d), report = { placed: 0, triage: [], legacy: [] };
    for (const i of p.issues) {
        const hits = [...st.values()].filter(({ s }) => idsOf(i).some(x => mentions(s.title, x)));
        if (hits.length === 1) { i.at = hits[0].s.key; report.placed++; }
        else if (!hits.length && i.legacy === '[tail]') i.tail = true;
        else { i.why = hits.length ? `named by ${hits.map(h => h.s.key).join(', ')}` : 'named by no roadmap row'; report.triage.push(`${i.id}: ${i.why}`); }
        if (tagFor(d, i, st) !== i.legacy) { i.tagx = i.legacy; report.legacy.push(`${i.id} ${i.legacy}`); }
        delete i.legacy;
        d.issues.push(i);
    }
    const back = { problems: renderProblems(d), roadmap: renderRoadmap(d) };
    for (const [k, text] of [['problems', ptext], ['roadmap', rtext]]) if (back[k] !== text) {
        const a = back[k].split('\n'), b = text.split('\n'); const n = a.findIndex((x, j) => x !== b[j]);
        fail(`import is not lossless for ${k} at line ${n + 1}:\n  data: ${String(a[n]).slice(0, 160)}\n  file: ${String(b[n]).slice(0, 160)}`);
    }
    d.meta.lastRender = { problems: { cur: sha1(ptext), prev: null }, roadmap: { cur: sha1(rtext), prev: null } };
    return { d, p, report, originals: { 'import/problems.md': ptext, 'import/roadmap.md': rtext } };
}

// ---------- evidence readers (V5.1 records, run directories, verdict files) ----------
function task(cx, slug) {
    const f = path.join(cx.workflowDir, slug + '.json');
    if (!fs.existsSync(f)) fail(`V5.1 task ${slug}: no record at ${f}`);
    return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function runInfo(cx, ref) { // provenance of one perf run: its own run.json resolved to a full commit here
    const dir = fs.existsSync(ref) ? ref : path.join(cx.runs, ref), base = path.basename(dir);
    const f = path.join(dir, 'run.json');
    if (!fs.existsSync(f)) fail(`run ${base}: no run.json`);
    const r = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!r.sha || !/^[0-9a-f]{7,40}$/.test(r.sha)) fail(`run ${base}: run.json names no commit`);
    if (!base.includes(r.sha.slice(0, 9))) fail(`run ${base}: its directory does not name its commit ${r.sha.slice(0, 9)}`);
    const full = rev(cx, r.sha) || fail(`run ${base}: ${r.sha} is not one known commit here`);
    if (r.dirty !== false) fail(`run ${base} was made from a dirty or unknown tree`);
    if (r.exitCode !== 0) fail(`run ${base} exited ${r.exitCode}`);
    const minutes = (Date.parse(r.windowEnd) - Date.parse(r.windowStart)) / 60000;
    if (!(minutes > 0)) fail(`run ${base}: no measured window`);
    return { dir, base, full, sha9: full.slice(0, 9), scenario: r.scenario, script: r.script || null, minutes, diagnostics: !!r.diagnostics, save: r.save?.id || null };
}
function needArtifacts(run, names) { const miss = names.filter(n => !fs.existsSync(path.join(run.dir, n))); if (miss.length) fail(`run ${run.base}: missing ${miss.join(', ')}`); }
const fits = (run, side) => run.scenario === side.scenario && (!side.script || run.script === side.script) && run.minutes >= side.minutes - 0.5;
function evidenceFile(f, mustName, label) { // a file names what it judges; its hash is kept so a later swap shows
    if (!f || f === true || !fs.existsSync(String(f))) fail(`${label}: file ${f} not found`);
    const text = fs.readFileSync(String(f), 'utf8');
    for (const n of mustName) if (!text.includes(n)) fail(`${label} ${path.basename(String(f))} does not name ${n}`);
    return { file: path.resolve(String(f)), sha256: sha256(String(f)), text };
}
function verdictOf(v, label) {
    const m = v.text.match(/^\s*verdict:\s*(pass|fail)\b/im) || fail(`${label}: no "verdict: pass|fail" line`);
    if (m[1].toLowerCase() !== 'pass') fail(`${label}: verdict is ${m[1]}`);
}

// ---------- commands ----------
const C = {};
const write = (cx, base, d, msg, out) => { const c = save(cx, base, d, msg); if (out) console.log(out); console.log(`lc ${c.slice(0, 9)}`); return c; };
function need(cx) { const { sha, d } = load(cx); if (!sha) fail(`no data at ${cx.ref}; run lc import first`); return { sha, d }; }

C.import = (cx, { opt }) => {
    if (opt.compare) return compareImport(cx, opt);
    if (load(cx).sha) fail(`${cx.ref} exists; import runs once (lc import --compare checks it against planning/)`);
    const { d, report, originals } = importPlanning(cx, opt);
    if (opt['dry-run']) { console.log(JSON.stringify({ issues: d.issues.length, placed: report.placed, triage: report.triage, legacy: report.legacy }, null, 1)); return; }
    const c = save(cx, null, d, `lc import from ${cx.planning}\n\nlossless: both views render back byte for byte; originals kept in this commit under import/`, originals);
    console.log(`imported ${d.issues.length} issues, ${Object.keys(d.releases).length} releases; placed ${report.placed}, triage ${report.triage.length}, legacy tags ${report.legacy.length}\nlc ${c.slice(0, 9)}`);
};
function compareImport(cx, opt) { // a fresh parse of planning/ against the data: every id, alias, field; deps and decisions listed
    const { d } = need(cx);
    const fresh = parseProblems(fs.readFileSync(path.join(cx.planning, VIEWS.problems), 'utf8'));
    const mine = new Map(d.issues.map(i => [i.id, i])), theirs = new Map(fresh.issues.map(i => [i.id, i]));
    const out = { planning: fresh.issues.length, data: d.issues.length, archived: Object.values(d.archive).reduce((n, a) => n + (a.issues || []).length, 0), missingInData: [], onlyInData: [], fieldDiffs: [], aliasDiffs: [], tagDiffs: [], deps: [], decisions: d.decisions.length };
    const st = steps(d);
    for (const [id, t] of theirs) {
        const m = mine.get(id);
        if (!m) { out.missingInData.push(id); continue; }
        for (const k of ['head', 'origin', 'rule', 'sites', 'what', 'fix']) if (m[k] !== t[k]) out.fieldDiffs.push(`${id}.${k}`);
        if (aliasIds(m).join() !== aliasIds(t).join()) out.aliasDiffs.push(id);
        if (tagFor(d, m, st) !== t.legacy) out.tagDiffs.push(`${id} ${t.legacy} → ${tagFor(d, m, st)}`);
    }
    for (const id of mine.keys()) if (!theirs.has(id)) out.onlyInData.push(id);
    for (const i of d.issues) if (i.deps?.length) out.deps.push(`${i.id} ← ${i.deps.join(',')}`);
    if (opt.decisions) { const seed = JSON.parse(fs.readFileSync(opt.decisions, 'utf8')); out.decisionsMissing = seed.decisions.filter(x => !d.decisions.find(y => y.id === x.id && y.text === x.text)).map(x => x.id); }
    out.roadmapSame = renderRoadmap(d) === fs.readFileSync(path.join(cx.planning, VIEWS.roadmap), 'utf8');
    out.problemsSame = renderProblems(d) === fs.readFileSync(path.join(cx.planning, VIEWS.problems), 'utf8');
    console.log(JSON.stringify(out, null, 1));
    if (out.missingInData.length || out.fieldDiffs.length || out.aliasDiffs.length) process.exitCode = 1;
}
C.check = (cx) => {
    const { d } = need(cx); const { errors, warnings } = check(d);
    for (const e of errors) console.log('ERROR ' + e);
    for (const w of warnings) console.log('warn  ' + w);
    const g = growth(d, cx);
    for (const x of g.duplicates) console.log('dup?  ' + x);
    for (const x of g.broad) console.log('broad ' + x);
    for (const x of g.stale || []) console.log('stale ' + x);
    console.log(growthLine(g));
    console.log(`${errors.length} errors, ${warnings.length} warnings`);
    if (errors.length) process.exitCode = 1;
};
C.status = (cx) => {
    const { sha, d } = need(cx); const { errors, warnings } = check(d);
    const tracking = rev(cx, cx.tracking);
    const triage = d.issues.filter(i => !i.at && !i.tail).length, st = steps(d);
    const out = [`lc ${sha.slice(0, 9)} ${tracking === sha ? 'on ' + cx.remote : cx.remote + ' copy differs: lc sync'} · open ${d.issues.length} · triage ${triage} · ${errors.length} errors · ${warnings.length} warnings`];
    const rels = Object.values(d.releases).sort((a, b) => a.order - b.order);
    for (const r of rels.filter(live)) {
        const wanted = d.meta.gates[r.type] || d.meta.gates.default;
        const done = r.steps.filter(s => s.st === 'landed').length;
        const unresolved = d.issues.filter(i => st.get(i.at)?.r === r && st.get(i.at).s.st === 'landed' && !i.resolved).length;
        out.push(`${r.key} ${r.st} ${r.type} ${r.branch}${r.head ? ' @' + r.head.slice(0, 9) : ''} · steps ${done}/${r.steps.length} landed · unresolved ${unresolved} · gates ${wanted.map(g => g + (r.gates[g] ? '✓' : '·')).join(' ')}`);
        for (const s of r.steps.filter(x => x.st !== 'landed')) out.push(`  ${s.key} ${s.st}${s.tasks.length ? ' ' + s.tasks.at(-1) : ''} · ${d.issues.filter(i => i.at === s.key).length} issues${s.needs.length ? ' · needs ' + s.needs.join(',') : ''}`);
    }
    for (const r of rels.filter(x => x.st === 'planned' && x.group !== 'large').slice(0, 3)) {
        const n = d.issues.filter(i => st.get(i.at)?.r === r).length;
        const blocked = r.steps.flatMap(s => s.needs).filter(k => st.has(k) && st.get(k).s.st !== 'landed');
        out.push(`next ${r.key} ${r.type} · ${r.steps.length} steps · ${n} issues${r.cap?.issues ? '/' + r.cap.issues : ''}${blocked.length ? ' · waits ' + [...new Set(blocked)].join(',') : ''}`);
    }
    for (const [k, a] of Object.entries(d.archive)) if (a.manifest && !a.manifest.published) out.push(`${k} validated, not published (origin needs the maintainer's authorization)`);
    const size = { roadmap: renderRoadmap(d).length, problems: renderProblems(d).length };
    out.push('views ' + Object.keys(VIEWS).map(k => `${k} ${Math.ceil(size[k] / 1024)} KB`).join(' · ') + (d.meta.cutover ? '' : ' (shadow: planning files are the source)'));
    out.push(growthLine(growth(d, cx)));
    for (const e of errors.slice(0, 3)) out.push('ERROR ' + e);
    console.log(out.join('\n'));
};
function packOf(d, key) { // an agent's context for a step or release: header + body lines, deterministic, nothing cut
    const st = steps(d), dec = new Map(d.decisions.map(x => [x.id, x]));
    const archived = id => Object.entries(d.archive).flatMap(([k, a]) => (a.issues || []).filter(i => idsOf(i).includes(id)).map(i => `${id} archived in ${k}: ${i.closed?.how}`))[0];
    const decLines = ids => [...new Set(ids)].filter(x => dec.has(x)).sort((a, b) => +a.slice(1) - +b.slice(1)).map(x => `decision ${x} ${dec.get(x).date}: ${dec.get(x).text}`);
    if (d.releases[key] && !(st.has(key) && d.releases[key].steps.length === 1)) {
        const r = d.releases[key];
        return { header: [JSON.stringify({ ...r, steps: undefined })], body: [...r.steps.map(s => `  ${s.key} ${s.st} · ${d.issues.filter(i => i.at === s.key).map(i => i.id + (i.resolved ? '✓' : '')).join(' ') || '-'}${s.landed ? ' · landed ' + JSON.stringify(s.landed) : ''}`), ...decLines(r.decisions || [])] };
    }
    const { r, s } = st.get(key);
    const mine = d.issues.filter(x => x.at === s.key);
    const deps = [...new Set(mine.flatMap(i => i.deps || []))].filter(x => !mine.some(i => idsOf(i).includes(x)));
    return {
        header: [`${s.key} ${s.st} in ${r.key} (${r.st}, ${r.type})${s.needs.length ? ' needs ' + s.needs.join(',') : ''}${s.tasks.length ? ' tasks ' + s.tasks.join(',') : ''}`, stepText(d, s)],
        body: [...mine.map(i => issueLine(d, i, st) + (i.why ? `  [${i.why}]` : '')),
            ...deps.map(x => { const j = d.issues.find(i => idsOf(i).includes(x)); return j ? `dep ${issueLine(d, j, st)}` : `dep ${archived(x) || x + ' unknown'}`; }),
            ...decLines([...(r.decisions || []), ...mine.flatMap(i => i.overrides || [])])]
    };
}
function pages(header, body, budget) { // greedy pages within the budget; a line longer than a page gets a page of its own
    const room = Math.max(256, budget - header.join('\n').length - 120), out = [[]]; let used = 0;
    for (const l of body) { if (out.at(-1).length && used + l.length + 1 > room) { out.push([]); used = 0; } out.at(-1).push(l); used += l.length + 1; }
    return out;
}
C.show = (cx, { pos, opt }) => { // lc show <issue|step|release> [--page N] [--role rc|pack]: the paged context pack
    const { d } = need(cx); const key = pos[0] || fail('show <issue|step|release> [--page N]'); const st = steps(d);
    if (d.releases[key] || st.has(key)) {
        const { header, body } = packOf(d, key), b = budgetsOf(d), budget = opt.role === 'rc' ? b.rc : b.pack;
        const ps = pages(header, body, budget), n = Math.min(Math.max(1, Number(opt.page) || 1), ps.length);
        const first = ps.slice(0, n - 1).reduce((a, p) => a + p.length, 0);
        console.log(header.join('\n'));
        if (ps.length > 1) console.log(`page ${n}/${ps.length} · lines ${first + 1}-${first + ps[n - 1].length} of ${body.length}${n < ps.length ? ` · next: lc show ${key} --page ${n + 1}` : ''}`);
        for (const l of ps[n - 1]) console.log(l.startsWith('  ') ? l : '  ' + l.slice(0, 4000));
        if (ps.length > 1 && n === 1) console.log(growthLine(growth(d)));
        return;
    }
    if (d.archive[key]?.manifest) { console.log(JSON.stringify({ ...d.archive[key].manifest, steps: d.archive[key].manifest.steps.map(s => s.key) })); return; }
    const a = Object.entries(d.archive).flatMap(([k, x]) => (x.issues || []).filter(i => idsOf(i).includes(key)).map(i => ({ k, i })))[0];
    if (a) { console.log(`archived in ${a.k}: ${JSON.stringify(a.i.closed)}\n${[a.i.head, a.i.origin, a.i.rule, a.i.sites, a.i.what, a.i.fix].join('|')}`); return; }
    const i = issue(d, key);
    console.log(issueLine(d, i, st));
    console.log(`at ${i.at || (i.tail ? 'tail' : 'triage')}${i.at ? ' (' + st.get(i.at).r.key + ' ' + st.get(i.at).r.st + ')' : ''}${i.why ? ' · ' + i.why : ''}${i.deps?.length ? ' · deps ' + i.deps.join(',') : ''}${i.overrides?.length ? ' · overrides ' + i.overrides.join(',') : ''}${i.resolved ? ' · resolved ' + JSON.stringify(i.resolved) : ''}`);
};
C.render = (cx, { opt }) => {
    const { sha, d } = need(cx);
    const views = { roadmap: renderRoadmap(d), problems: renderProblems(d) };
    if (opt.out) {
        for (const [k, f] of Object.entries(VIEWS)) { const p = path.join(String(opt.out), f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, views[k]); }
        console.log(`rendered to ${opt.out}`); return;
    }
    if (opt.check) { // hygiene's freshness test: after the cutover the planning views must equal the render
        if (!d.meta.cutover) { console.log('shadow: planning files are the source until the cutover; nothing to check'); return; }
        const stale = Object.entries(VIEWS).filter(([k, f]) => { const p = path.join(cx.planning, f); return !fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== views[k]; }).map(([, f]) => f);
        if (stale.length) fail(`not the lc render: ${stale.join(', ')} (run lc render --write; a hand edit is first redone through lc add/edit/drop)`);
        console.log('planning views equal the lc render'); return;
    }
    if (!opt.write) fail('render --out <dir> (preview), --check, or --write (planning/, guarded)');
    const b = budgets(cx), why = [], notes = [], last = d.meta.lastRender || {};
    for (const [k, f] of Object.entries(VIEWS)) {
        const p = path.join(cx.planning, f), cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
        const known = [sha1(views[k]), last[k]?.cur, last[k]?.prev].filter(Boolean); // a half-finished earlier render is not a hand edit
        if (cur !== null && !known.includes(sha1(cur))) {
            if (opt['overwrite-' + k]) { const keep = path.join(os.tmpdir(), `${k}.hand.${Date.now()}.md`); fs.writeFileSync(keep, cur); notes.push(`hand-edited ${k}.md kept at ${keep}; ${k === 'roadmap' ? 'rows live in lc (step add/set)' : 'issues live in lc (add, edit, drop)'}`); }
            else why.push(k === 'roadmap' ? `${f} was edited by hand: its rows live in lc (lc step add/set, lc assign); then lc render --write --overwrite-roadmap replaces the file (the hand copy is kept)` : `${f} was edited by hand since the last render: its issues live in lc (lc add, lc edit, lc drop); then lc render --write --overwrite-problems replaces the file (the hand copy is kept)`);
        }
        if (b[k] != null && Math.ceil(views[k].length / 1024) > b[k]) notes.push(`${f} is ${Math.ceil(views[k].length / 1024)} KB, over the old ${b[k]} KB budget: a grep index, not reading; agents read lc show`);
    }
    if (why.length) fail(why.join('\n'));
    fresh(cx, sha); // views from a copy the fork has moved past are not written
    const tmp = {}; // new files first, data next, renames last: a failure leaves either the old state or a re-runnable one
    try { for (const [k, f] of Object.entries(VIEWS)) { tmp[k] = path.join(cx.planning, f) + '.lc-new'; fs.writeFileSync(tmp[k], views[k]); } }
    catch (e) { for (const t of Object.values(tmp)) fs.rmSync(t, { force: true }); fail(`cannot write planning files (${firstLine(e)}); nothing changed`); }
    const unchanged = Object.keys(VIEWS).every(k => last[k]?.cur === sha1(views[k])) && d.meta.cutover;
    if (!unchanged) {
        d.meta.cutover = true;
        d.meta.lastRender = Object.fromEntries(Object.keys(VIEWS).map(k => [k, { cur: sha1(views[k]), prev: last[k]?.cur === sha1(views[k]) ? last[k]?.prev ?? null : last[k]?.cur ?? null }]));
        try { save(cx, sha, d, 'lc render'); } catch (e) { for (const t of Object.values(tmp)) fs.rmSync(t, { force: true }); throw e; }
    }
    try { for (const [k, f] of Object.entries(VIEWS)) fs.renameSync(tmp[k], path.join(cx.planning, f)); }
    catch (e) { fail(`data recorded, a planning file was not replaced (${firstLine(e)}); run lc render --write again`); }
    for (const n of notes) console.log('note  ' + n);
    if (notes.length) console.log(growthLine(growth(d, cx)));
    console.log('planning views written');
};
C.edit = (cx, { pos, opt }) => { // an open issue's text, alias and note; its place is assign's, its end is resolve/drop's
    const { sha, d } = need(cx); const i = issue(d, pos[0] || fail('edit <id> [--origin|--rule|--sites|--what|--fix <text>] [--alias <id>] [--why <note>]'));
    const done = [];
    for (const k of ['origin', 'rule', 'sites', 'what', 'fix']) if (opt[k] !== undefined) { const v = one(opt, k, 'text'); if (v !== i[k]) { i[k] = v; done.push(k); } }
    if (opt.alias !== undefined) {
        const a = one(opt, 'alias', 'id'); if (!isId(a)) fail(`--alias is an id, not ${a}`);
        if (allIds(d).has(a)) fail(`${a} exists (ids are never reused)`);
        i.head = /\(=\s*[^)]*\)/.test(i.head) ? i.head.replace(/\(=\s*([^)]*)\)/, (m, l) => `(= ${l.trim()}, ${a})`) : `${i.head} (= ${a})`;
        done.push(`alias ${a}`);
    }
    if (opt.why !== undefined) { i.why = one(opt, 'why', 'note'); done.push('why'); }
    if (!done.length) fail('edit names a field that changes: --origin, --rule, --sites, --what, --fix, --alias or --why');
    if (done.includes('sites')) for (const x of sameName(d, i.sites, i)) console.log(`same code name: ${x} (possible duplicate: lc show it; merging is a decision)`);
    write(cx, sha, d, `lc edit ${i.id}: ${done.join(', ')}`, `${i.id} edited (${done.join(', ')})`);
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
    for (const x of sameName(d, i.sites, i)) console.log(`same code name: ${x} (possible duplicate: lc show it; merging is a decision)`);
    d.issues.push(i);
    if (opt.to) place(d, i, String(opt.to), opt); else if (!i.tail) i.why = 'new';
    write(cx, sha, d, `lc add ${id}${opt.to ? ' → ' + opt.to : ''}`, `${id} ${i.at ? 'in ' + i.at : i.tail ? 'tail' : 'triage'}`);
};
function place(d, i, target, opt) { // the one assignment rule; refuses what needs the maintainer
    const st = steps(d), from = i.at;
    if (i.resolved) fail(`${i.id} is resolved in ${i.at}; it closes with its release`);
    if (target === 'triage' || target === 'tail') { i.at = null; i.tail = target === 'tail' || undefined; i.why = opt.reason ? String(opt.reason) : `moved from ${from || 'triage'}`; }
    else {
        const x = st.get(target) || fail(`no step ${target}`);
        if (x.r.st === 'frozen') authorize(d, opt.decision, 'scope-add', { release: x.r.key, issue: i.id });
        if (x.s.st === 'landed') fail(`step ${target} has landed; its issues are a fixed set`);
        for (const rule of rulesFor(d, i, x.r)) {
            if (overridden(d, i, rule)) continue;
            i.overrides = [...new Set([...(i.overrides || []), authorize(d, opt.decision, 'rule-override', { issue: i.id, rule: rule.decision })])];
        }
        i.at = target; delete i.tail; if (!/^investigation/.test(i.why || '')) delete i.why; // an investigation note stays until V5.2 verifies the cause
    }
    delete i.tagx;
    for (const { s } of st.values()) if (s.key !== i.at) stripMention(s, idsOf(i)); // a row names only what it holds
}
C.assign = (cx, { pos, opt }) => {
    const { sha, d } = need(cx); const target = one(opt, 'to', 'step|triage|tail');
    if (!pos.length) fail('assign <id...> --to <step|triage|tail>');
    for (const id of pos) place(d, issue(d, id), target, opt);
    write(cx, sha, d, `lc assign ${pos.join(' ')} → ${target}${opt.decision ? ' (' + opt.decision + ')' : ''}${opt.reason ? '\n\n' + opt.reason : ''}`, `${pos.length} → ${target}`);
};
C.place = (cx, { opt }) => { // only explicit, unambiguous placement: one row names the issue, or one maintainer rule matches
    const { sha, d } = need(cx); const st = steps(d), plan = [];
    const open = [...st.values()].filter(({ r, s }) => r.st !== 'frozen' && s.st !== 'landed');
    for (const i of d.issues.filter(x => !x.at && !x.tail)) {
        const named = open.filter(({ s }) => idsOf(i).some(x => mentions(s.title, x))).map(x => x.s.key);
        const ruled = (d.meta.placement || []).filter(p => (!p.sec || p.sec === i.sec) && (!p.prefix || i.id.startsWith(p.prefix))).map(p => p.to);
        const c = [...new Set([...named, ...ruled])];
        const x = c.length === 1 && st.get(c[0]);
        if (x && rulesFor(d, i, x.r).every(rule => overridden(d, i, rule))) plan.push([i, c[0], named.length ? 'named by its row' : 'placement rule']);
        else console.log(`${i.id} stays: ${c.length ? 'candidates ' + c.join(', ') : 'no explicit row or rule'}${c.length === 1 ? ' (a decision rule blocks it)' : ''}`);
    }
    for (const [i, k, how] of plan) console.log(`${i.id} → ${k} (${how})`);
    if (!opt.apply || !plan.length) { if (!opt.apply) console.log(`${plan.length} placeable; --apply to place`); return; }
    for (const [i, k] of plan) place(d, i, k, {});
    write(cx, sha, d, `lc place: ${plan.map(([i, k]) => i.id + '→' + k).join(' ')}`);
};
C.dep = (cx, { pos, opt }) => { // lc dep <id> --on a,b | --clear: check refuses cycles and dependencies queued later
    const { sha, d } = need(cx); const i = issue(d, pos[0] || fail('dep <id> --on <ids> | --clear'));
    const known = allIds(d);
    if (opt.clear) delete i.deps;
    else { const on = many(opt.on); if (!on.length) fail('--on <ids>'); for (const x of on) if (!known.has(x)) fail(`unknown ${x}`); i.deps = [...new Set([...(i.deps || []), ...on])]; }
    write(cx, sha, d, `lc dep ${i.id} ${opt.clear ? 'cleared' : 'on ' + i.deps.join(',')}`);
};
C.split = (cx, { pos, opt }) => { // one problem holding two mechanisms becomes two ids; the old id, aliases and history stay
    const { sha, d } = need(cx); const i = issue(d, pos[0] || fail('split <id> --decision M --sites --what --fix [--rule] [--id] [--to step] --keep-sites --keep-what --keep-fix [--keep-rule]'));
    authorize(d, opt.decision, 'split', { issue: i.id });
    if (i.resolved) fail(`${i.id} is resolved`);
    const id = opt.id ? String(opt.id) : nextId(d, i.id.replace(/-\d+[a-z]?$/, ''));
    if (allIds(d).has(id)) fail(`${id} exists (ids are never reused)`);
    const n = { id, head: id, sec: opt.sec ? String(opt.sec) : i.sec, ord: i.ord + 0.5, at: null, origin: `${i.origin}; split from ${i.id} (${opt.decision})`, rule: opt.rule ? String(opt.rule) : i.rule, sites: one(opt, 'sites', 'the new part\'s sites'), what: one(opt, 'what', 'the new part'), fix: one(opt, 'fix', 'the new part\'s fix'), from: i.id };
    if (!opt['keep-sites'] || !opt['keep-what'] || !opt['keep-fix']) fail(`--keep-sites, --keep-what and --keep-fix say what ${i.id} keeps`);
    for (const k of ['sites', 'what', 'fix', 'rule']) if (opt[`keep-${k}`] !== undefined) i[k] = one(opt, `keep-${k}`, `${i.id}'s ${k}`);
    delete i.tagx;
    d.issues.push(n);
    const secOrd = d.issues.filter(x => x.sec === n.sec).sort((a, b) => a.ord - b.ord); secOrd.forEach((x, k) => { x.ord = k + 1; });
    const named = opt.to && steps(d).get(String(opt.to));
    if (named && mentions(named.s.title, i.id)) named.s.title = named.s.title.replace(new RegExp(`(?<![\\w-])${esc(i.id)}${NOTE}(?![\\w-]?\\w)`), id); // the row names the part it now holds
    if (opt.to) place(d, n, String(opt.to), opt); else n.why = `split from ${i.id}`;
    if (opt['keep-to']) place(d, i, String(opt['keep-to']), opt);
    write(cx, sha, d, `lc split ${i.id} → ${i.id} + ${id} (${opt.decision})`, `${i.id} kept, ${id} new${n.at ? ' in ' + n.at : ''}`);
};
C.drop = (cx, { pos, opt }) => {
    const { sha, d } = need(cx); const i = issue(d, pos[0] || fail('drop <id> --reason <why> (--decision <id> | --rule0 | --fixed-by <slug>)'));
    const reason = one(opt, 'reason', 'why');
    const closed = { how: 'dropped', reason, at: cx.now };
    if (opt.decision) closed.decision = authorize(d, String(opt.decision), 'drop', { issue: i.id });
    else if (opt.rule0) { // rule 0 clears triage and planned work; what a landed step or a frozen release holds needs its result
        const x = i.at && steps(d).get(i.at);
        if (x && (x.s.st === 'landed' || x.r.st === 'frozen')) fail(`${i.id} is in ${x.s.st === 'landed' ? 'landed step ' + x.s.key : 'frozen release ' + x.r.key}: it needs its result (lc resolve) or a decision, not --rule0`);
        closed.how = 'not-worth-it';
    }
    else if (opt['fixed-by']) {
        const t = task(cx, String(opt['fixed-by'])), l = t.evidence?.landed || fail(`${opt['fixed-by']} has not landed`);
        if (!idsOf(i).some(x => mentions(JSON.stringify(t.brief || {}), x))) fail(`${t.slug}'s brief does not name ${i.id}`);
        onRemote(cx, l.head, l.branch); Object.assign(closed, { how: 'fixed', slug: t.slug, head: l.head });
    } else fail('a drop names --decision, --rule0 or --fixed-by');
    archiveIssue(d, i, i.at ? steps(d).get(i.at).r.key : 'triage', closed);
    write(cx, sha, d, `lc drop ${i.id}: ${closed.how}\n\n${reason}`, `${i.id} closed (${closed.how})`);
};
function archiveIssue(d, i, rel, closed) {
    const st = steps(d);
    const tag = tagFor(d, i, st);
    for (const { s } of st.values()) stripMention(s, idsOf(i));
    d.issues = d.issues.filter(x => x !== i);
    ((d.archive[rel] ||= {}).issues ||= []).push({ ...i, tag, closed });
}
C.decide = (cx, { opt }) => { // --allow "action=assign,issue=RC-2,to=3.x" (repeatable): what the decision authorizes
    const { sha, d } = need(cx);
    const id = `M${Math.max(0, ...d.decisions.map(x => +x.id.slice(1))) + 1}`;
    const allowsList = list(opt.allow).map(s => Object.fromEntries(s.split(',').map(kv => { const [k, ...v] = kv.split('='); return [k.trim(), v.join('=').trim()]; })));
    for (const a of allowsList) if (!ACTIONS.includes(a.action)) fail(`--allow action is one of ${ACTIONS.join(', ')}: ${JSON.stringify(a)}`);
    d.decisions.push({ id, date: one(opt, 'date', 'YYYY-MM-DD'), text: one(opt, 'text', 'the decision as said'), ...(allowsList.length ? { allows: allowsList } : {}) });
    write(cx, sha, d, `lc decide ${id}: ${opt.text}`, id);
};
C.gates = (cx, { pos, opt }) => { // lc gates <type> ci,trace,... --decision M: the gates a release type must pass
    const { sha, d } = need(cx); const [type, names] = pos;
    if (!type || !names) fail('gates <type> <gate,...> --decision M');
    authorize(d, opt.decision, 'gates', { type });
    const g = many(names); const known = ['ci', 'trace', 'ab', 'behaviour', 'report'];
    for (const x of g) if (!known.includes(x)) fail(`known gates: ${known.join(', ')}`);
    if (type !== 'plan') for (const x of ['ci', 'trace', 'ab', 'report']) if (!g.includes(x)) fail(`a code release keeps the existing gate ${x}`);
    d.meta.gates[type] = g;
    write(cx, sha, d, `lc gates ${type} ${g.join(',')} (${opt.decision})`);
};
C.release = (cx, { pos, opt }) => { // release add <key> | release set <key>
    const { sha, d } = need(cx); const [verb, key] = pos;
    if (verb === 'add') {
        if (d.releases[key] || d.archive[key]) fail(`release ${key} exists`);
        const group = one(opt, 'group', 'roadmap group'); if (!d.meta.groups.find(g => g.key === group)) fail(`unknown group ${group}`);
        d.releases[key] = { key, group, order: Number(one(opt, 'order', 'number')), type: one(opt, 'type', 'fix|arch|feature|...'), st: 'planned', title: opt.title ? String(opt.title) : key, branch: null, base: null, head: null, decisions: many(opt.decisions), cap: null, gates: {}, steps: [] };
    } else if (verb === 'set') {
        const r = release(d, key);
        if (opt.cap !== undefined) { r.cap = { issues: Number(opt.cap) }; r.decisions = [...new Set([...r.decisions, authorize(d, opt.decision, 'cap', { release: key, value: opt.cap })])]; }
        if (opt.order !== undefined) { r.order = Number(opt.order); r.decisions = [...new Set([...r.decisions, authorize(d, opt.decision, 'order', { release: key, value: opt.order })])]; }
        if (opt.type !== undefined) { if (r.st !== 'planned') fail('type changes only while planned'); r.type = String(opt.type); }
    } else if (verb === 'drop') { // an empty planned release (its steps moved or dropped) leaves the roadmap
        const r = release(d, key), reason = one(opt, 'reason', 'why');
        if (r.st !== 'planned' || r.steps.length) fail(`${key} is ${r.st} with ${r.steps.length} steps: only an empty planned release drops`);
        delete d.releases[key];
        return write(cx, sha, d, `lc release drop ${key}\n\n${reason}`, `${key} dropped`);
    } else fail('release add <key> --group --order --type | release set <key> [--cap N|--order N] --decision id | [--type T] | release drop <key> --reason');
    write(cx, sha, d, `lc release ${verb} ${key}`);
};
C.step = (cx, { pos, opt }) => { // step add <release> | step set <step> | step move <step> --to <release> --reason
    const { sha, d } = need(cx); const [verb, k] = pos;
    if (verb === 'add') {
        const r = release(d, k); if (r.st === 'frozen') fail(`${k} is frozen`);
        const key = one(opt, 'key', 'step key'); if (steps(d).has(key) || archivedSteps(d).has(key)) fail(`step ${key} exists`);
        r.steps.push({ key, title: one(opt, 'title', 'row text'), P: opt.P ? String(opt.P) : '', S: opt.S ? String(opt.S) : '', who: opt.who ? String(opt.who) : '', needs: many(opt.needs), st: 'planned', tasks: [], landed: null });
        return write(cx, sha, d, `lc step add ${k} ${key}`);
    }
    if (verb === 'move') return C.defer(cx, { pos: [k], opt });
    if (verb === 'drop') { // a planned row with nothing left in it (its issues closed or moved) leaves the roadmap
        const { r, s } = step(d, k); const reason = one(opt, 'reason', 'why');
        if (s.st !== 'planned' || r.st === 'frozen') fail(`${k} is ${s.st} in a ${r.st} release`);
        const held = d.issues.filter(i => i.at === k); if (held.length) fail(`${k} still holds ${held.map(i => i.id).join(', ')}`);
        r.steps = r.steps.filter(x => x !== s);
        return write(cx, sha, d, `lc step drop ${k}\n\n${reason}`, `${k} dropped`);
    }
    if (verb !== 'set') fail('step add <release> --key --title [--P --S --who --needs] | step set <step> [--title --P --S --who --needs a,b|none --before <step>] | step move <step> --to <release> --reason | step drop <step> --reason');
    const { r, s } = step(d, k);
    if (r.st === 'frozen' || s.st === 'landed') fail(`${k} is fixed (${r.st}, ${s.st})`);
    for (const f of ['title', 'P', 'S', 'who']) if (opt[f] !== undefined) s[f] = opt[f] === true ? '' : String(opt[f]);
    if (opt.needs !== undefined) s.needs = opt.needs === 'none' ? [] : many(opt.needs);
    if (opt.before) { const j = r.steps.findIndex(x => x.key === opt.before); if (j < 0) fail(`${opt.before} is not in ${r.key}`); r.steps = r.steps.filter(x => x !== s); r.steps.splice(r.steps.findIndex(x => x.key === opt.before), 0, s); }
    write(cx, sha, d, `lc step set ${k}`);
};
C.open = (cx, { pos, opt }) => {
    const { sha, d } = need(cx); const r = release(d, pos[0] || fail('open <release> --branch <b> --base <sha>'));
    if (r.st !== 'planned') fail(`${r.key} is ${r.st}`);
    const branch = one(opt, 'branch', 'integration branch'), base = rev(cx, one(opt, 'base', 'sha')) || fail('unknown base');
    const tip = fetchTip(cx, branch);
    if (!cx.ok(['merge-base', '--is-ancestor', base, tip])) fail(`base ${base.slice(0, 9)} is not on ${cx.remote}/${branch}`);
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
    s.st = 'active'; s.tasks = [...new Set([...s.tasks, slug])];
    const chain = modules((t.brief?.cause?.chain || []).join(' ')); // V5.2 brief: the verified cause's chain of handles
    for (const i of d.issues.filter(x => x.at !== s.key && modules(x.sites).some(m => chain.includes(m))).slice(0, 10))
        console.log(`same cause?: ${i.id} at ${i.at || 'triage'} names ${modules(i.sites).find(m => chain.includes(m))} from ${slug}'s cause chain`);
    write(cx, sha, d, `lc start ${s.key} with ${slug}`, `${s.key} active (${slug})`);
};
C.land = (cx, { pos, opt }) => {
    const { sha, d } = need(cx); const { r, s } = step(d, pos[0] || fail('land <step> [--task slug] [--keep id,...] | --decision id --ref <evidence>'));
    if (r.st !== 'open') fail(`${r.key} is ${r.st}`);
    if (s.st === 'landed') fail(`${s.key} has landed`);
    if (opt.decision) { // a step with no code (a measurement, a world test) closes on its evidence and a decision that names it
        authorize(d, String(opt.decision), 'land-no-code', { step: s.key });
        s.landed = { decision: String(opt.decision), ref: one(opt, 'ref', 'evidence'), head: fetchTip(cx, r.branch), at: cx.now };
    } else {
        const slug = opt.task ? String(opt.task) : s.tasks.at(-1) || fail(`${s.key} has no task; lc start first`);
        if (!s.tasks.includes(slug)) fail(`${slug} is not a task of ${s.key}`);
        const t = task(cx, slug), l = t.evidence?.landed || fail(`${slug}: no record-land in V5.1`);
        if (l.branch !== r.branch) fail(`${slug} landed on ${l.branch}, ${r.key} integrates ${r.branch}`);
        if (t.evidence?.review?.result !== 'pass' || t.evidence?.review?.head !== l.reviewedHead || t.evidence?.ready?.head !== l.reviewedHead) fail(`${slug}: review/ready evidence does not cover the landed head`);
        onRemote(cx, l.head, r.branch);
        s.landed = { slug, head: l.head, reviewedHead: l.reviewedHead, tree: l.tree, ci: (t.evidence.ciRuns || []).filter(x => x.head === l.reviewedHead).map(x => x.id), at: cx.now };
    }
    s.st = 'landed';
    for (const id of many(opt.keep)) { const i = issue(d, id); if (i.at !== s.key) fail(`${id} is not in ${s.key}`); place(d, i, 'triage', { reason: `kept open when ${s.key} landed` }); }
    const left = d.issues.filter(i => i.at === s.key).length;
    write(cx, sha, d, `lc land ${s.key}${s.landed.slug ? ' by ' + s.landed.slug + ' ' + s.landed.head.slice(0, 9) : ' by ' + s.landed.decision}`, `${s.key} landed; ${left} issues each need lc resolve before ${r.key} closes`);
};
C.resolve = (cx, { pos, opt }) => { // each issue's own result, several ids at once: all are proven or nothing is written
    const { sha, d } = need(cx); if (!pos.length) fail('resolve <id...> --test <file> | --run <dir> --verdict <file>');
    for (const id of pos) resolveOne(cx, d, issue(d, id), opt);
    write(cx, sha, d, `lc resolve ${pos.join(', ')} by ${opt.test ? 'test' : 'run'}`, `${pos.join(', ')} resolved`);
};
function resolveOne(cx, d, i, opt) { // a regression test of a task of the issue's step, or a run whose verdict names the issue
    const x = steps(d).get(i.at) || fail(`${i.id} is in no step`);
    if (x.s.st !== 'landed') fail(`${x.s.key} has not landed`);
    if (opt.test) {
        if (!x.s.landed.slug) fail(`${x.s.key} landed without a V5.1 task; resolve by --run`);
        // A step holds several fixes, each with its own task: any task of the step whose landing the step's landed
        // head contains can carry an issue's result (the landing task is tried first).
        const test = norm(opt.test), why = []; let hit;
        for (const slug of new Set([x.s.landed.slug, ...(x.s.tasks || [])])) {
            let t; try { t = task(cx, slug); } catch (e) { why.push(`${slug}: ${e.message}`); continue; }
            const l = t.evidence?.landed;
            if (!l || l.branch !== x.r.branch || !cx.ok(['merge-base', '--is-ancestor', l.head, x.s.landed.head])) { why.push(`${slug} did not land in ${x.s.key}'s head`); continue; }
            const reg = (t.evidence.regressions || []).find(g => norm(g.test) === test && g.head === l.reviewedHead && g.old === t.base);
            if (!reg) { why.push(`${slug} has no old-fails/new-passes evidence for ${test} on its landed head`); continue; }
            if (!idsOf(i).some(id => mentions(JSON.stringify(t.brief || {}), id))) { why.push(`${slug}'s brief does not name ${i.id}`); continue; }
            hit = { slug, reg }; break;
        }
        if (!hit) fail(why.join('; '));
        i.resolved = { how: 'test', slug: hit.slug, test, head: x.s.landed.head, evidence: hit.reg.evidence, at: cx.now };
    } else if (opt.run) {
        const run = runInfo(cx, String(opt.run));
        if (!cx.ok(['merge-base', '--is-ancestor', x.s.landed.head, run.full])) fail(`run ${run.base} is of ${run.sha9}, which does not contain ${x.s.key}'s landing`);
        const v = evidenceFile(opt.verdict, [run.base], `verdict for ${i.id}`);
        if (!idsOf(i).some(id => new RegExp(`^\\s*${esc(id)}\\b.*\\b(resolved|fixed)\\b`, 'im').test(v.text))) fail(`verdict ${path.basename(v.file)} has no "${i.id}: resolved" line`);
        i.resolved = { how: 'run', run: run.base, head: run.full, verdict: v.file, verdictSha256: v.sha256, at: cx.now };
    } else fail('resolve needs --test or --run with --verdict');
}
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
C.freeze = (cx, { pos }) => { // the frozen head is the fork's actual tip, nothing older
    const { sha, d } = need(cx); const r = release(d, pos[0] || fail('freeze <release>'));
    if (r.st !== 'open') fail(`${r.key} is ${r.st}`);
    const left = r.steps.filter(s => s.st !== 'landed');
    if (left.length) fail(`not landed: ${left.map(s => s.key).join(', ')} (land or defer them)`);
    const head = fetchTip(cx, r.branch);
    const local = rev(cx, `refs/heads/${r.branch}`);
    if (local && local !== head) fail(`local ${r.branch} ${local.slice(0, 9)} differs from ${cx.remote} ${head.slice(0, 9)}`);
    for (const s of r.steps) if (s.landed.head && !cx.ok(['merge-base', '--is-ancestor', s.landed.head, head])) fail(`${s.key} ${s.landed.head.slice(0, 9)} is not in ${head.slice(0, 9)}`);
    Object.assign(r, { st: 'frozen', head, frozenAt: cx.now });
    write(cx, sha, d, `lc freeze ${r.key} at ${head.slice(0, 9)}`, `${r.key} frozen at ${head.slice(0, 9)}`);
};
function ciComplete(cx, r, slug, root) { // "CI is complete" has one owner, workflow.js `ready`; lc reads its verdict on the frozen head
    const t = task(cx, slug), head = r.head;
    if (!root || root === true) fail('--root <worktree at the frozen head> lets the workflow name the selection');
    let out;
    try { out = execFileSync(process.execPath, [cx.workflowJs, 'ready', slug, '--root', String(root)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { out = String(e.stdout || ''); if (!out.includes('"ci"')) fail(`workflow ready ${slug} failed: ${firstLine(e)}`); } // exit 1 = not task-ready; the ci part is still reported
    let v; try { v = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)); } catch { fail(`workflow ready ${slug}: unreadable answer`); }
    if (!v.ci) fail(`workflow ready ${slug} reports no ci part (workflow.js older than this lc)`);
    if (v.head !== head) fail(`workflow ready ran on ${String(v.head).slice(0, 9)}, not the frozen head ${head.slice(0, 9)}`);
    if (!v.ci.rules) fail(`${slug}: rules-check is not on ${head.slice(0, 9)}`);
    if (!v.ci.full) fail(`${slug}: no full PR checks on ${head.slice(0, 9)}`);
    if (v.ci.missing.length) fail(`${slug}: CI misses ${v.ci.missing.slice(0, 8).join(', ')}${v.ci.missing.length > 8 ? ' …' : ''}`);
    if (v.ci.missingRaw.length) fail(`${slug}: raw-geodata evidence misses ${v.ci.missingRaw.slice(0, 8).join(', ')}`);
    return { task: slug, runs: (t.evidence?.ciRuns || []).filter(x => x.head === head).map(x => x.id) };
}
C.gate = (cx, { pos, opt }) => { // each gate's evidence is checked against the frozen head; no decision waives a code gate
    const { sha, d } = need(cx); const r = release(d, pos[0]); const g = pos[1];
    const want = d.meta.gates[r.type] || d.meta.gates.default;
    if (!want.includes(g)) fail(`${r.type} releases need gates ${want.join(', ')}`);
    if (r.st !== 'frozen') fail(`gates are recorded on the frozen head; ${r.key} is ${r.st}`);
    if (opt.waive || opt.decision) fail('code gates are not waived; record the evidence (a pre-existing miss belongs in the verdict)');
    const rec = { at: cx.now }, sha9 = r.head.slice(0, 9), prof = d.meta.profiles || PROFILES;
    if (g === 'ci') Object.assign(rec, ciComplete(cx, r, one(opt, 'task', 'V5.1 slug holding the release CI'), opt.root));
    else if (g === 'trace') {
        const run = runInfo(cx, one(opt, 'run', 'run dir'));
        if (run.full !== r.head) fail(`run ${run.base} is of ${run.full.slice(0, 9)}, not the frozen head ${sha9}`);
        if (!fits(run, prof.trace.sides[0])) fail(`run ${run.base}: ${run.scenario} ${run.script || ''} ${run.minutes.toFixed(1)} min is not the trace profile ${JSON.stringify(prof.trace.sides[0])}`);
        needArtifacts(run, prof.trace.artifacts);
        const cov = evidenceFile(opt.coverage, [sha9], 'coverage'), inv = evidenceFile(opt.invariants, [sha9], 'invariants'), v = evidenceFile(opt.verdict, [run.base, sha9], 'verdict');
        verdictOf(v, 'trace verdict');
        Object.assign(rec, { run: run.base, head: run.full, save: run.save, coverage: { file: cov.file, sha256: cov.sha256 }, invariants: { file: inv.file, sha256: inv.sha256 }, verdict: { file: v.file, sha256: v.sha256 } });
    } else if (g === 'ab') {
        const B = many(opt.run).map(x => runInfo(cx, x)), A = many(opt['base-run']).map(x => runInfo(cx, x));
        if (!B.length || !A.length) fail('--run <B side, repeatable> and --base-run <A side, repeatable>');
        for (const x of B) if (x.full !== r.head) fail(`B run ${x.base} is of ${x.sha9}, not the frozen head ${sha9}`);
        for (const x of A) if (x.full === r.head) fail(`A run ${x.base} is of the frozen head`); // A is the version players have (release.md): any other commit
        const all = [...B, ...A];
        if (new Set(all.map(x => x.save)).size !== 1 || !all[0].save) fail('A/B runs must share one named save');
        for (const x of all) { needArtifacts(x, prof.ab.artifacts); if (prof.ab.diagnostics && !x.diagnostics) fail(`run ${x.base}: diagnostics off`); }
        for (const side of prof.ab.sides) {
            if (!B.some(x => fits(x, side))) fail(`no B run fits ${JSON.stringify(side)}`);
            if (!A.some(x => fits(x, side))) fail(`no A run fits ${JSON.stringify(side)}`);
        }
        const v = evidenceFile(opt.verdict, [sha9, ...all.map(x => x.base)], 'verdict');
        verdictOf(v, 'A/B verdict');
        Object.assign(rec, { runs: B.map(x => x.base), base: A.map(x => x.base), save: all[0].save, verdict: { file: v.file, sha256: v.sha256 } });
    } else if (g === 'behaviour') {
        const ab = r.gates.ab || fail('behaviour is judged on the recorded A/B: gate ab first');
        const v = evidenceFile(opt.verdict, [sha9, ...ab.runs], 'behaviour verdict');
        if (!/^\s*behaviour:\s*preserved\b/im.test(v.text)) fail('behaviour verdict has no "behaviour: preserved" line');
        Object.assign(rec, { verdict: { file: v.file, sha256: v.sha256 } });
    } else {
        const f = evidenceFile(opt.ref, [r.key, sha9], 'report');
        Object.assign(rec, { file: f.file, sha256: f.sha256 });
    }
    r.gates[g] = rec;
    write(cx, sha, d, `lc gate ${r.key} ${g}`, `${r.key} ${g} ✓`);
};
C.close = (cx, { pos, opt }) => { // validated, not published: closing grants no push to origin and no PR
    const { sha, d } = need(cx); const r = release(d, pos[0] || fail('close <release> [--carry <step|triage>]'));
    if (r.st !== 'frozen') fail(`${r.key} is ${r.st}; freeze it first`);
    const want = d.meta.gates[r.type] || d.meta.gates.default, missing = want.filter(g => !r.gates[g]);
    if (missing.length) fail(`gates missing: ${missing.join(', ')}`);
    const keys = new Set(r.steps.map(s => s.key));
    const mine = d.issues.filter(i => keys.has(i.at)), unresolved = mine.filter(i => !i.resolved);
    if (unresolved.length && !opt.carry) fail(`unresolved: ${unresolved.map(i => i.id).join(', ')} (lc resolve each, or --carry <step|triage> to move them on)`);
    for (const i of unresolved) {
        const to = String(opt.carry);
        if (to !== 'triage' && keys.has(to)) fail('carry them out of the closing release');
        i.at = null; place(d, i, to, { reason: `unresolved when ${r.key} closed` }); i.why ||= `unresolved when ${r.key} closed`;
    }
    for (const i of mine.filter(x => x.resolved)) { const s = r.steps.find(x => x.key === i.at); archiveIssue(d, i, r.key, { how: 'landed', step: s.key, slug: s.landed.slug, decision: s.landed.decision, head: s.landed.head, release: r.key, resolved: i.resolved, at: cx.now }); }
    delete d.releases[r.key];
    (d.archive[r.key] ||= {}).manifest = { ...r, st: 'validated', validatedAt: cx.now, published: null };
    d.archive[r.key].issues ||= [];
    write(cx, sha, d, `lc close ${r.key}: validated, ${mine.length - unresolved.length} issues archived, ${unresolved.length} carried`, `${r.key} validated (not published); ${mine.length - unresolved.length} archived, ${unresolved.length} carried`);
};
C.publish = (cx, { pos, opt }) => { // records a publication someone made with the maintainer's authorization; lc pushes nothing to origin
    const { sha, d } = need(cx); const k = pos[0] || fail('publish <release> --decision M --branch <origin branch>');
    const m = d.archive[k]?.manifest || fail(`${k} is not validated`);
    if (m.published) fail(`${k} was recorded published`);
    const dec = authorize(d, opt.decision, 'publish', { release: k });
    const remote = opt['to-remote'] ? String(opt['to-remote']) : 'origin', branch = one(opt, 'branch', 'origin branch');
    const tip = fetchTip(cx, branch, remote);
    if (!cx.ok(['merge-base', '--is-ancestor', m.head, tip])) fail(`${remote}/${branch} ${tip.slice(0, 9)} does not contain ${k}'s head ${m.head.slice(0, 9)}`);
    m.published = { remote, branch, tip, decision: dec, at: cx.now };
    write(cx, sha, d, `lc publish ${k}: ${remote}/${branch} ${tip.slice(0, 9)} (${dec})`, `${k} recorded published`);
};
function dueTails(d) { // [tail]/triage lines whose origin predates the close of the release two back (planning.md)
    const closes = Object.values(d.archive).map(a => a.manifest?.validatedAt).filter(Boolean).sort();
    const tails = d.issues.filter(i => !i.at);
    if (closes.length < 2) return { tails, due: [], reason: 'fewer than two validated releases' };
    const cut = new Date(closes.at(-2)), last = new Date(closes.at(-1));
    const dateOf = o => { const m = o.match(/(?<![\d-])(\d{1,2})-(\d{2})(?![\d-])/); if (!m) return null; const dt = new Date(Date.UTC(cut.getUTCFullYear(), +m[1] - 1, +m[2])); if (dt > last) dt.setUTCFullYear(dt.getUTCFullYear() - 1); return dt; };
    return { tails, due: tails.filter(i => { const t = dateOf(i.origin); return t && t < cut; }), reason: `origin before ${cut.toISOString().slice(0, 10)}` };
}
C.tails = (cx) => {
    const { d } = need(cx); const { tails, due, reason } = dueTails(d);
    for (const i of due) console.log(`${i.id} ${i.origin} due: move to a row (lc assign) or drop (lc drop --rule0)`);
    console.log(`${due.length} due of ${tails.length} (${reason})`);
};
C.placement = (cx, { opt }) => { // lc placement --to <step> [--sec s] [--prefix p] --decision M: an explicit maintainer rule for place
    const { sha, d } = need(cx); const to = one(opt, 'to', 'step');
    if (!steps(d).has(to)) fail(`no step ${to}`);
    const rule = { to, decision: authorize(d, opt.decision, 'placement-rule', { to }) };
    if (opt.sec) rule.sec = String(opt.sec); if (opt.prefix) rule.prefix = String(opt.prefix);
    if (!rule.sec && !rule.prefix) fail('a rule names --sec or --prefix');
    d.meta.placement = [...(d.meta.placement || []), rule];
    write(cx, sha, d, `lc placement ${JSON.stringify(rule)}`);
};
C.sync = (cx) => { // brings this copy and the fork's together without force; a divergence is kept aside, never lost
    const local = rev(cx, cx.ref), tip = remoteTip(cx, cx.ref);
    if (!tip) { if (!local) fail('no lifecycle data here or on the fork'); cx.git(['push', '-q', cx.remote, `${local}:${cx.ref}`]); cx.tryGit(['update-ref', cx.tracking, local]); console.log(`pushed ${local.slice(0, 9)}`); return; }
    try { cx.git(['fetch', '-q', cx.remote, `+${cx.ref}:${cx.tracking}`]); } catch (e) { fail(`fetch failed: ${firstLine(e)}`); }
    if (rev(cx, cx.tracking) !== tip) fail(`${cx.remote} moved during sync; run it again`);
    if (!local) { cx.git(['update-ref', cx.ref, tip, '0'.repeat(40)]); console.log(`took ${tip.slice(0, 9)}`); return; }
    if (local === tip) { console.log(`in sync at ${tip.slice(0, 9)}`); return; }
    if (cx.ok(['merge-base', '--is-ancestor', local, tip])) { cx.git(['update-ref', cx.ref, tip, local]); console.log(`fast-forwarded to ${tip.slice(0, 9)}`); return; }
    if (cx.ok(['merge-base', '--is-ancestor', tip, local])) { cx.git(['push', '-q', cx.remote, `${local}:${cx.ref}`]); cx.tryGit(['update-ref', cx.tracking, local]); console.log(`pushed ${local.slice(0, 9)}`); return; }
    const aside = `refs/lc/conflict/${cx.now.replace(/[^0-9]/g, '').slice(0, 14)}`;
    cx.git(['update-ref', aside, local]); cx.git(['update-ref', cx.ref, tip, local]);
    console.log(`diverged: this copy's commits are kept at ${aside}; data now at the fork's ${tip.slice(0, 9)}. Run these again:`);
    console.log(cx.git(['log', '--reverse', '--format=  %s', `${tip}..${aside}`]));
    process.exitCode = 3;
};
C.push = (cx) => C.sync(cx);
C.get = (cx, { pos }) => { // for scripts: lc get <release> branch|head|base|st
    const { d } = need(cx); const r = d.releases[pos[0]] || d.archive[pos[0]]?.manifest || fail(`no release ${pos[0]}`); const v = r[pos[1]];
    if (v === undefined || v === null) fail(`${pos[0]} has no ${pos[1]}`);
    console.log(typeof v === 'object' ? JSON.stringify(v) : v);
};
C.help = () => console.log(`lc status | check | show <id|step|release> | get <release> <field> | tails
issues:   add --sec --origin --rule --sites --what --fix [--prefix|--id] [--to step] [--deps] [--tail] | split <id> --decision M …
          assign <id...> --to <step|triage|tail> [--decision M] | place [--apply] | dep <id> --on ids|--clear | drop <id> --reason (--decision|--rule0|--fixed-by)
          edit <id> [--origin|--rule|--sites|--what|--fix <text>] [--alias <id>] [--why <note>]
releases: release add|set|drop | step add|set|move|drop | open <rel> --branch --base | start <step> --task <slug> | land <step> [--keep ids]
          resolve <id...> --test|--run --verdict | show <step|release> [--page N] [--role rc] | defer <step> --to <rel> --reason | freeze <rel> | gate <rel> <ci|trace|ab|behaviour|report> … | close <rel> [--carry]
          publish <rel> --decision M --branch <origin branch>   (records a publication; lc never pushes origin)
views:    render --out <dir> | render --check | render --write [--overwrite-roadmap|--overwrite-problems]      data: import [--dry-run|--compare] | decide --allow | gates | placement | sync`);

function main(argv) {
    const [cmd, ...rest] = argv; const a = parseArgs(rest);
    const f = C[cmd || 'help'] || fail(`unknown command ${cmd}; lc help`);
    if (cmd === 'help' || !cmd) return f();
    f(context(a.opt), a);
}
module.exports = { main, context, load, save, check, dueTails, parseProblems, parseRoadmap, renderProblems, renderRoadmap, Refusal };
if (require.main === module) {
    try { main(process.argv.slice(2)); }
    catch (e) { if (e instanceof Refusal) { console.error('lc: ' + e.message); process.exitCode = 2; } else throw e; }
}
