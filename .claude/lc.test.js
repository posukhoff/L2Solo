'use strict';
// Behaviour of lc on throwaway repos with a bare "fork" (and "origin"): import is lossless; every refusal named in
// the 11-12 audit (P0/P1) refuses; a release runs open → land → resolve → freeze → gates → close (validated, not
// published) and its issues reach the archive with their own results.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LC = path.join(__dirname, 'lc.js');
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', LC_NOW: '2026-11-12T00:00:00Z' });
delete process.env.LC_OFFLINE;

const PROBLEMS = `# Problems: fixture
Line: id|origin|rule|sites|what|fix|tag
## Failures that show (rule 8)
S3|pass 11-03|8|\`A.js\` 1|drop never acked|ack|[r3]
DT-90|run 10-01|8|\`G.js\`|old tail|fix|[tail]
DT-44 (= A-11)|audit 11-07|2|\`B.js\` 2 \`x|y\`|retry 30 s|event|[r1b]
## Parties
DT-49|run 11-09|1|\`C.js\`|party stay on main|worker|[r1b]
DT-114|planner 11-09|8|\`D.js\`|no clan evidence|worker|[r1b]
## Economy (redesign)
RM-45|run 11-09|0|\`E.js\`|shots never restocked|price rule|[r2]
ECO-10|map 11-03|1,2|\`Own.js\`; \`Worth.js\`|own move no event; worth read two ways|situation; one worth|[r3] own move, [r2] bid worth
`;
const ROADMAP = `# Roadmap: fixture
legend line
## 1b. Parties
| Item | P | S | Who |
|---|---|---|---|
| 1b.1 architecture, parties on the worker: DT-44, DT-49 | mid | **high** | |
| 1b.2 architecture, needs 1b.1: clan aggregate (DT-114) | mid | **high** | ivan |
## 2. Economy
| Item | P | S | Who |
|---|---|---|---|
| FIRST: shots: RM-45 | **high** | low | |
| Design inputs: ECO-10 (bid worth) | mid | mid | |
## 3. Server
| Item | P | S | Who |
|---|---|---|---|
| Cold command dropped: S3 | low | mid | |
| Situation raises: ECO-10 (own move) | low | mid | |
## Large, own plan
- Components: plan.md.
`;
const SEED = { decisions: [{ id: 'M1', date: '2026-11-07', text: 'no economy work outside the redesign' }], rules: [{ sec: 'economy', only: ['2', 'large'], decision: 'M1' }], releases: { '2': ['M1'] } };

function world() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-'));
    const repo = path.join(dir, 'game'), fork = path.join(dir, 'fork.git'), origin = path.join(dir, 'origin.git'), wf = path.join(dir, 'wf'), runs = path.join(dir, 'runs');
    const sh = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    fs.mkdirSync(path.join(repo, 'planning/architecture'), { recursive: true }); fs.mkdirSync(wf); fs.mkdirSync(runs);
    execFileSync('git', ['init', '-q', '--bare', fork]); execFileSync('git', ['init', '-q', '--bare', origin]);
    sh(['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(repo, 'planning/architecture/problems.md'), PROBLEMS);
    fs.writeFileSync(path.join(repo, 'planning/roadmap.md'), ROADMAP);
    fs.writeFileSync(path.join(repo, 'planning/hygiene.js'), "const ALLOWED = { 'roadmap.md': 12, 'architecture/problems.md': 108 };\n");
    fs.writeFileSync(path.join(repo, 'game.js'), '1\n');
    sh(['add', 'game.js']); sh(['commit', '-q', '-m', 'base']);
    sh(['remote', 'add', 'fork', fork]); sh(['remote', 'add', 'origin', origin]);
    const seed = path.join(dir, 'seed.json'); fs.writeFileSync(seed, JSON.stringify(SEED));
    const stub = path.join(dir, 'workflow-stub.js'); // `workflow.js ready` stand-in for refusal cases; the contract test below runs the real workflow.js
    fs.writeFileSync(stub, "process.stdout.write(require('fs').readFileSync(process.env.LC_STUB_PLAN, 'utf8'));\n");
    const plan = path.join(dir, 'plan.json');
    const env = { ...process.env, LC_WORKFLOW_DIR: wf, LC_RUNS: runs, LC_WORKFLOW_JS: stub, LC_STUB_PLAN: plan };
    const lc = (...args) => { try { return { code: 0, out: execFileSync(process.execPath, [LC, ...args, '--repo', repo], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { code: e.status, out: (e.stdout || '') + (e.stderr || '') }; } };
    const ok = (...args) => { const r = lc(...args); assert.strictEqual(r.code, 0, `lc ${args.join(' ')}: ${r.out}`); return r.out; };
    const no = (re, ...args) => { const r = lc(...args); assert.notStrictEqual(r.code, 0, `lc ${args.join(' ')} should refuse: ${r.out}`); assert.match(r.out, re); return r.out; };
    const w = { dir, repo, fork, origin, wf, runs, sh, lc, ok, no, seed, plan, env };
    w.base = sh(['rev-parse', 'HEAD']);
    w.decide = (text, ...allow) => ok('decide', '--date', '2026-11-12', '--text', text, ...allow.flatMap(a => ['--allow', a])).match(/^(M\d+)$/m)[1];
    return w;
}
function commit(w, branch, text) {
    w.sh(['checkout', '-q', branch]); fs.writeFileSync(path.join(w.repo, 'game.js'), text); w.sh(['commit', '-qam', text]);
    return w.sh(['rev-parse', 'HEAD']);
}
// a V5.1 task that landed `head` on `branch`: review, ready, CI, regression evidence; its brief names `ids`
function landedTask(w, slug, base, head, branch, ids = [], extra = {}) {
    const rec = { slug, base, created: '2026-11-12T01:00:00Z', brief: { symptom: `fixes ${ids.join(' ')}`, regressions: ['test_fix.js'] },
        evidence: { review: { head, result: 'pass' }, ready: { head }, rules: { head }, regressions: [{ head, old: base, test: 'test_fix.js', evidence: 'old fails, new passes' }],
            ciRuns: [{ head, id: '901', workflow: 'PR checks', tests: ['test_a.js'] }, { head, id: '902', workflow: 'Picked tests', tests: ['test_geo.js'] }],
            rawGeodata: [{ head, test: 'test_raw.js' }], landed: { remote: 'fork', branch, head, reviewedHead: head, tree: 't' }, ...extra } };
    fs.writeFileSync(path.join(w.wf, slug + '.json'), JSON.stringify(rec));
    return rec;
}
function run(w, name, o) {
    const dir = path.join(w.runs, name); fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    const start = Date.parse('2026-11-12T01:00:00Z');
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ sha: o.sha.slice(0, 9), dirty: o.dirty ?? false, scenario: o.scenario || 'script', script: o.scenario === 'hot' ? null : 'tests/e2e/online-player.js', diagnostics: o.diagnostics ?? true, save: { id: o.save || 'save-1' }, windowStart: new Date(start).toISOString(), windowEnd: new Date(start + (o.minutes || 30) * 60000).toISOString(), exitCode: o.exitCode ?? 0 }));
    for (const f of o.artifacts || ['server.log', 'summary.json', 'world.sqlite']) fs.writeFileSync(path.join(dir, f), 'x');
    return name;
}
const file = (w, name, text) => { const f = path.join(w.dir, name); fs.writeFileSync(f, text); return f; };
// open 1b.1 on a pushed branch, land one task by p1, return its head
function openAndLand(w, { ids = ['DT-44', 'DT-49'] } = {}) {
    w.sh(['branch', 'ivan/batch-1b1', w.base]); w.sh(['push', '-q', 'fork', 'ivan/batch-1b1']);
    w.ok('open', '1b.1', '--branch', 'ivan/batch-1b1', '--base', w.base);
    const head = commit(w, 'ivan/batch-1b1', 'parties on the worker');
    landedTask(w, 'p1', w.base, head, 'ivan/batch-1b1', ids);
    w.ok('start', '1b.1', '--task', 'p1');
    w.sh(['push', '-q', 'fork', 'ivan/batch-1b1']);
    w.ok('land', '1b.1');
    return head;
}

test('import is lossless, runs once, and a re-import compares clean: ids, aliases, fields, tags', () => {
    const w = world();
    assert.match(w.ok('import', '--decisions', w.seed), /imported 7 issues, 5 releases; placed 5, triage 1, legacy tags 1/);
    w.no(/import runs once/, 'import');
    const out = path.join(w.dir, 'out'); w.ok('render', '--out', out);
    assert.strictEqual(fs.readFileSync(path.join(out, 'architecture/problems.md'), 'utf8'), PROBLEMS);
    assert.strictEqual(fs.readFileSync(path.join(out, 'roadmap.md'), 'utf8'), ROADMAP);
    const cmp = JSON.parse(w.ok('import', '--compare', '--decisions', w.seed));
    assert.deepStrictEqual([cmp.planning, cmp.data, cmp.missingInData.length, cmp.fieldDiffs.length, cmp.aliasDiffs.length, cmp.tagDiffs.length, cmp.decisionsMissing.length, cmp.problemsSame, cmp.roadmapSame], [7, 7, 0, 0, 0, 0, 0, true, true]);
    assert.match(w.ok('show', 'A-11'), /at 1b\.1/);
});

test('decisions authorize only what they name; rules, deps, cycles, ids and drops refuse', () => {
    const w = world(); w.ok('import', '--decisions', w.seed);
    const vague = w.decide('economy fixes are fine');
    w.no(/--allow action is one of/, 'decide', '--date', '2026-11-12', '--text', 'x', '--allow', 'action=archive-anything,issue=S3');
    w.no(/needs --decision/, 'assign', 'RM-45', '--to', '3.cold-command-dropped');
    w.no(/M\d+ does not allow rule-override/, 'assign', 'RM-45', '--to', '3.cold-command-dropped', '--decision', vague);
    const m = w.decide('RM-45 technical part may sit in 3', 'action=rule-override,issue=RM-45,rule=M1');
    w.ok('assign', 'RM-45', '--to', '3.cold-command-dropped', '--decision', m);
    assert.doesNotMatch(w.ok('check'), /RM-45: economy issue/);
    w.no(/depends on unknown|unknown NOPE-1/, 'dep', 'DT-49', '--on', 'NOPE-1');
    w.ok('dep', 'DT-49', '--on', 'DT-44');
    w.no(/dependency cycle/, 'dep', 'DT-44', '--on', 'DT-49');
    w.ok('add', '--sec', 'parties', '--origin', 'x', '--rule', '1', '--sites', 's', '--what', 'w', '--fix', 'f', '--id', 'DT-200', '--deps', 'DT-49', '--to', '1b.2');
    w.no(/queued later/, 'add', '--sec', 'parties', '--origin', 'x', '--rule', '1', '--sites', 's', '--what', 'w', '--fix', 'f', '--id', 'DT-201', '--deps', 'DT-200', '--to', '1b.1');
    w.no(/ids are never reused/, 'add', '--sec', 'parties', '--origin', 'x', '--rule', '1', '--sites', 's', '--what', 'w', '--fix', 'f', '--id', 'A-11');
    w.no(/names --decision, --rule0, --gone or --fixed-by/, 'drop', 'S3', '--reason', 'gone');
    w.no(/does not allow drop/, 'drop', 'S3', '--reason', 'gone', '--decision', vague);
    w.ok('drop', 'S3', '--reason', 'not worth a line', '--rule0');
    w.no(/exists/, 'add', '--sec', 'failures', '--origin', 'x', '--rule', '1', '--sites', 's', '--what', 'w', '--fix', 'f', '--id', 'S3');
    assert.match(w.ok('show', 'S3'), /archived in 3: .*not-worth-it/);
    w.no(/does not allow cap/, 'release', 'set', '1b.1', '--cap', '1', '--decision', vague);
    const cap = w.decide('caps', 'action=cap,release=1b.1,value=2');
    w.ok('release', 'set', '1b.1', '--cap', '2', '--decision', cap);
    w.no(/over its cap 2/, 'assign', 'DT-114', '--to', '1b.1');
});

test('writers: a stale base, a fork that moved, a refused push and a divergence never overwrite', () => {
    const w = world(); w.ok('import', '--decisions', w.seed);
    const { context, load, save, Refusal } = require('./lc.js');
    const cx = context({ repo: w.repo });
    const stale = load(cx);
    w.ok('assign', 'DT-90', '--to', 'tail');
    stale.d.issues.find(i => i.id === 'RM-45').why = 'x';
    assert.throws(() => save(cx, stale.sha, stale.d, 'stale write'), e => e instanceof Refusal && /has not seen|moved while/.test(e.message));
    // another machine writes to the fork
    const other = path.join(w.dir, 'other'); execFileSync('git', ['clone', '-q', w.fork, other]);
    execFileSync('git', ['fetch', '-q', 'origin', 'refs/heads/ivan/lifecycle-data:refs/heads/ivan/lifecycle-data'], { cwd: other });
    for (const f of ['planning/architecture', 'planning']) fs.mkdirSync(path.join(other, f), { recursive: true });
    execFileSync(process.execPath, [LC, 'assign', 'DT-114', '--to', 'triage', '--repo', other, '--remote', 'origin'], { env: w.env, stdio: 'pipe' });
    w.no(/holds lifecycle data this copy has not seen/, 'assign', 'DT-49', '--to', 'triage');
    assert.match(w.ok('sync'), /fast-forwarded/);
    w.ok('assign', 'DT-49', '--to', 'triage');
    // an offline write and a fork write diverge: sync keeps this copy's commit aside, takes the fork's, forces nothing
    execFileSync(process.execPath, [LC, 'sync', '--repo', other, '--remote', 'origin'], { env: w.env, stdio: 'pipe' });
    execFileSync(process.execPath, [LC, 'assign', 'DT-49', '--to', '1b.1', '--repo', other, '--remote', 'origin'], { env: w.env, stdio: 'pipe' });
    execFileSync(process.execPath, [LC, 'assign', 'DT-44', '--to', 'triage', '--repo', w.repo], { env: { ...w.env, LC_OFFLINE: '1' }, stdio: 'pipe' });
    const forkTip = execFileSync('git', ['rev-parse', 'refs/heads/ivan/lifecycle-data'], { cwd: w.fork, encoding: 'utf8' }).trim();
    const r = w.lc('sync'); assert.strictEqual(r.code, 3); assert.match(r.out, /diverged: .*refs\/lc\/conflict\/.*\n\s+lc assign DT-44 → triage/s);
    assert.strictEqual(w.sh(['rev-parse', 'refs/heads/ivan/lifecycle-data']), forkTip);
    assert.strictEqual(execFileSync('git', ['rev-parse', 'refs/heads/ivan/lifecycle-data'], { cwd: w.fork, encoding: 'utf8' }).trim(), forkTip);
    // a refused push undoes the local move
    fs.writeFileSync(path.join(w.fork, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n'); fs.chmodSync(path.join(w.fork, 'hooks/pre-receive'), 0o755);
    const before = w.sh(['rev-parse', 'refs/heads/ivan/lifecycle-data']);
    w.no(/push to fork refused.*nothing written/, 'assign', 'RM-45', '--to', 'tail');
    assert.strictEqual(w.sh(['rev-parse', 'refs/heads/ivan/lifecycle-data']), before);
});

test('a release end to end: per-issue results, complete CI, run provenance, behaviour, validated not published', () => {
    const w = world(); w.ok('import', '--decisions', w.seed);
    const g = w.decide('arch releases also confirm behaviour', 'action=gates,type=arch');
    w.ok('gates', 'arch', 'ci,trace,ab,behaviour,report', '--decision', g);
    w.no(/keeps the existing gate trace/, 'gates', 'arch', 'ci,ab,report', '--decision', g);
    w.no(/needs 1b\.1 landed first|fork has no/, 'open', '1b.2', '--branch', 'ivan/batch-1b1', '--base', w.base);
    const head = openAndLand(w);
    const s9 = head.slice(0, 9);
    w.no(/gates are recorded on the frozen head/, 'gate', '1b.1', 'report', '--ref', 'x');
    w.ok('resolve', 'DT-44', '--test', 'test_fix.js');
    w.no(/no old-fails\/new-passes evidence for test_other\.js/, 'resolve', 'DT-49', '--test', 'test_other.js');
    run(w, `${s9}-script-final`, { sha: head });
    w.no(/has no "DT-49: resolved" line/, 'resolve', 'DT-49', '--run', `${s9}-script-final`, '--verdict', file(w, 'v0.md', `${s9}-script-final\nverdict: pass\n`));
    w.ok('resolve', 'DT-49', '--run', `${s9}-script-final`, '--verdict', file(w, 'v1.md', `${s9}-script-final\nDT-49: resolved, party stays decided on the worker\n`));
    w.ok('freeze', '1b.1');
    w.no(/needs --decision/, 'assign', 'S3', '--to', '1b.1');
    w.no(/not waived/, 'gate', '1b.1', 'report', '--ref', 'r.md', '--waive', '--decision', g);
    // CI completeness, as V5.1 selects it
    landedTask(w, 'rel-ci', w.base, head, 'ivan/batch-1b1');
    const ready = ci => fs.writeFileSync(w.plan, JSON.stringify({ head, taskReady: false, reasons: [], ci: { full: true, rules: true, missing: [], missingRaw: [], ...ci } }, null, 2) + '\nRETRO DUE: x\n');
    ready({ missing: ['test_geo2.js'] }); w.no(/CI misses test_geo2\.js/, 'gate', '1b.1', 'ci', '--task', 'rel-ci', '--root', w.repo);
    ready({ missingRaw: ['test_raw2.js'] }); w.no(/raw-geodata evidence misses test_raw2\.js/, 'gate', '1b.1', 'ci', '--task', 'rel-ci', '--root', w.repo);
    ready({ full: false }); w.no(/no full PR checks/, 'gate', '1b.1', 'ci', '--task', 'rel-ci', '--root', w.repo);
    ready({ rules: false }); w.no(/rules-check is not on/, 'gate', '1b.1', 'ci', '--task', 'rel-ci', '--root', w.repo);
    fs.writeFileSync(w.plan, JSON.stringify({ head: w.base, ci: { full: true, rules: true, missing: [], missingRaw: [] } })); w.no(/not the frozen head/, 'gate', '1b.1', 'ci', '--task', 'rel-ci', '--root', w.repo);
    fs.writeFileSync(w.plan, JSON.stringify({ head, taskReady: true })); w.no(/reports no ci part/, 'gate', '1b.1', 'ci', '--task', 'rel-ci', '--root', w.repo);
    ready({}); w.ok('gate', '1b.1', 'ci', '--task', 'rel-ci', '--root', w.repo);
    // trace: provenance, profile, artifacts, evidence files that name the run
    const cov = file(w, 'cov.txt', `coverage ${s9}`), inv = file(w, 'inv.json', `{"run":"${s9}"}`);
    const tv = file(w, 'tv.md', `${s9}-script-final ${s9}\nverdict: pass\n`);
    run(w, `${w.base.slice(0, 9)}-script-old`, { sha: w.base });
    w.no(/not the frozen head/, 'gate', '1b.1', 'trace', '--run', `${w.base.slice(0, 9)}-script-old`, '--coverage', cov, '--invariants', inv, '--verdict', tv);
    run(w, `${s9}-script-dirty`, { sha: head, dirty: true });
    w.no(/dirty/, 'gate', '1b.1', 'trace', '--run', `${s9}-script-dirty`, '--coverage', cov, '--invariants', inv, '--verdict', tv);
    run(w, `${s9}-script-short`, { sha: head, minutes: 12 });
    w.no(/is not the trace profile/, 'gate', '1b.1', 'trace', '--run', `${s9}-script-short`, '--coverage', cov, '--invariants', inv, '--verdict', tv);
    run(w, `${s9}-script-noworld`, { sha: head, artifacts: ['server.log', 'summary.json'] });
    w.no(/missing world\.sqlite/, 'gate', '1b.1', 'trace', '--run', `${s9}-script-noworld`, '--coverage', cov, '--invariants', inv, '--verdict', tv);
    run(w, 'misnamed-script', { sha: head });
    w.no(/does not name its commit/, 'gate', '1b.1', 'trace', '--run', 'misnamed-script', '--coverage', cov, '--invariants', inv, '--verdict', tv);
    w.no(/verdict tv2\.md does not name/, 'gate', '1b.1', 'trace', '--run', `${s9}-script-final`, '--coverage', cov, '--invariants', inv, '--verdict', file(w, 'tv2.md', 'verdict: pass\n'));
    w.no(/verdict is fail/, 'gate', '1b.1', 'trace', '--run', `${s9}-script-final`, '--coverage', cov, '--invariants', inv, '--verdict', file(w, 'tv3.md', `${s9}-script-final ${s9}\nverdict: fail\n`));
    w.no(/invariants inv2\.json does not name/, 'gate', '1b.1', 'trace', '--run', `${s9}-script-final`, '--coverage', cov, '--invariants', file(w, 'inv2.json', '{}'), '--verdict', tv);
    w.ok('gate', '1b.1', 'trace', '--run', `${s9}-script-final`, '--coverage', cov, '--invariants', inv, '--verdict', tv);
    // A/B: both scenarios on both sides, one save, diagnostics, A an ancestor
    const b1 = run(w, `${s9}-script-ab`, { sha: head }), b2 = run(w, `${s9}-hot-ab`, { sha: head, scenario: 'hot', minutes: 20 });
    const old = w.sh(['commit-tree', w.sh(['rev-parse', w.base + '^{tree}']), '-p', w.base, '-m', 'the version players have: not an ancestor of the head']);
    const a9 = old.slice(0, 9), a1 = run(w, `${a9}-script-ab`, { sha: old }), a2 = run(w, `${a9}-hot-ab`, { sha: old, scenario: 'hot', minutes: 20 });
    const abv = file(w, 'ab.md', `${s9} ${b1} ${b2} ${a1} ${a2}\nverdict: pass\n`);
    w.no(/no A run fits.*hot/, 'gate', '1b.1', 'ab', '--run', b1, '--run', b2, '--base-run', a1, '--verdict', abv);
    const a3 = run(w, `${a9}-hot-other-save`, { sha: old, scenario: 'hot', minutes: 20, save: 'save-2' });
    w.no(/share one named save/, 'gate', '1b.1', 'ab', '--run', b1, '--run', b2, '--base-run', a1, '--base-run', a3, '--verdict', abv);
    w.ok('gate', '1b.1', 'ab', '--run', b1, '--run', b2, '--base-run', a1, '--base-run', a2, '--verdict', abv);
    w.no(/no "behaviour: preserved" line/, 'gate', '1b.1', 'behaviour', '--verdict', file(w, 'bh0.md', `${s9} ${b1} ${b2}\n`));
    w.ok('gate', '1b.1', 'behaviour', '--verdict', file(w, 'bh.md', `${s9} ${b1} ${b2}\nbehaviour: preserved\n`));
    w.no(/gates missing: report/, 'close', '1b.1');
    w.no(/report r\.md does not name/, 'gate', '1b.1', 'report', '--ref', file(w, 'r.md', 'release report'));
    w.ok('gate', '1b.1', 'report', '--ref', file(w, 'r2.md', `release 1b.1 at ${s9}`));
    assert.match(w.ok('close', '1b.1'), /1b\.1 validated \(not published\); 2 archived, 0 carried/);
    assert.match(w.ok('show', 'DT-44'), /archived in 1b\.1: .*"how":"landed".*"resolved":\{"how":"test"/);
    assert.match(w.ok('status'), /1b\.1 validated, not published/);
    w.no(/needs --decision/, 'publish', '1b.1', '--branch', 'develop');
    const pub = w.decide('publish 1b.1', 'action=publish,release=1b.1');
    w.no(/origin has no develop/, 'publish', '1b.1', '--decision', pub, '--branch', 'develop');
    w.sh(['push', '-q', 'origin', 'ivan/batch-1b1:refs/heads/develop']);
    w.ok('publish', '1b.1', '--decision', pub, '--branch', 'develop');
    assert.doesNotMatch(w.ok('status'), /validated, not published/);
    assert.strictEqual(w.sh(['rev-parse', 'refs/heads/develop'], w.origin), head);
});

test('resolve: any task of the step that landed inside its head carries an issue\'s result; one that landed elsewhere does not', () => {
    const w = world(); w.ok('import', '--decisions', w.seed);
    w.sh(['branch', 'ivan/batch-1b1', w.base]); w.sh(['push', '-q', 'fork', 'ivan/batch-1b1']);
    w.ok('open', '1b.1', '--branch', 'ivan/batch-1b1', '--base', w.base);
    const h1 = commit(w, 'ivan/batch-1b1', 'first fix');
    landedTask(w, 'p1', w.base, h1, 'ivan/batch-1b1', ['DT-44']);
    w.ok('start', '1b.1', '--task', 'p1');
    w.sh(['branch', 'side', w.base]); const hs = commit(w, 'side', 'a fix that never reached the branch');
    landedTask(w, 'p3', w.base, hs, 'ivan/batch-1b1', ['DT-49']);
    w.ok('start', '1b.1', '--task', 'p3');
    const h2 = commit(w, 'ivan/batch-1b1', 'second fix');
    landedTask(w, 'p2', h1, h2, 'ivan/batch-1b1', []);
    w.ok('start', '1b.1', '--task', 'p2');
    w.sh(['push', '-q', 'fork', 'ivan/batch-1b1']);
    w.ok('land', '1b.1');
    w.ok('resolve', 'DT-44', '--test', 'test_fix.js');
    assert.match(w.ok('show', 'DT-44'), /"slug":"p1"|p1/);
    w.no(/p3 did not land in 1b\.1's head/, 'resolve', 'DT-49', '--test', 'test_fix.js');
});

test('close: an issue without its own result blocks the close or is carried, never archived', () => {
    const w = world(); w.ok('import', '--decisions', w.seed);
    openAndLand(w, { ids: ['DT-44'] });
    w.no(/brief does not name DT-49/, 'resolve', 'DT-49', '--test', 'test_fix.js');
    w.no(/brief does not name DT-49/, 'resolve', 'DT-44', 'DT-49', '--test', 'test_fix.js'); // several ids: one unproven writes none
    assert.doesNotMatch(w.ok('status'), /resolved waiting close 1/);
    w.ok('resolve', 'DT-44', '--test', 'test_fix.js');
    w.no(/landed step 1b\.1: it needs its result .* not --rule0/, 'drop', 'DT-49', '--reason', 'not worth it', '--rule0');
    w.ok('freeze', '1b.1');
    const { context, load, save } = require('./lc.js');
    const cx = context({ repo: w.repo }); const { sha, d } = load(cx); // gates present: this test is about issues
    for (const g of ['ci', 'trace', 'ab', 'report']) d.releases['1b.1'].gates[g] = { at: 'x' };
    save(cx, sha, d, 'test: gates set');
    w.no(/unresolved: DT-49/, 'close', '1b.1');
    assert.match(w.ok('close', '1b.1', '--carry', '1b.2'), /1 archived, 1 carried/);
    assert.match(w.ok('show', 'DT-49'), /at 1b\.2/);
    assert.match(w.ok('show', 'DT-44'), /archived in 1b\.1/);
});

test('remote truth: a failed fetch or a moved fork is not taken from a stale copy', () => {
    const w = world(); w.ok('import', '--decisions', w.seed);
    w.sh(['branch', 'ivan/batch-1b1', w.base]); w.sh(['push', '-q', 'fork', 'ivan/batch-1b1']);
    w.ok('open', '1b.1', '--branch', 'ivan/batch-1b1', '--base', w.base);
    const head = commit(w, 'ivan/batch-1b1', 'work'); landedTask(w, 'p1', w.base, head, 'ivan/batch-1b1', ['DT-44', 'DT-49']);
    w.ok('start', '1b.1', '--task', 'p1');
    w.sh(['push', '-q', 'fork', 'ivan/batch-1b1']); w.sh(['fetch', '-q', 'fork']);
    // someone replaces the fork branch with a history that lacks the landing; the local tracking copy still has it
    w.sh(['push', '-q', '--force', 'fork', `${w.base}:refs/heads/ivan/batch-1b1`]);
    w.no(/is not on fork\/ivan\/batch-1b1/, 'land', '1b.1');
    w.sh(['push', '-q', '--force', 'fork', `${head}:refs/heads/ivan/batch-1b1`]);
    const url = w.sh(['remote', 'get-url', 'fork']); w.sh(['remote', 'set-url', 'fork', path.join(w.dir, 'gone.git')]);
    w.no(/cannot read fork/, 'land', '1b.1');
    w.sh(['remote', 'set-url', 'fork', url]);
    w.ok('land', '1b.1');
    w.ok('resolve', 'DT-44', '--test', 'test_fix.js'); w.ok('resolve', 'DT-49', '--test', 'test_fix.js');
    commit(w, 'ivan/batch-1b1', 'local only, not pushed');
    w.no(/local ivan\/batch-1b1 .* differs from fork/, 'freeze', '1b.1');
});

test('views: render --write refuses hand edits and a failed data write, leaving files as they were; size only warns', () => {
    const w = world(); w.ok('import', '--decisions', w.seed);
    const pf = path.join(w.repo, 'planning/architecture/problems.md');
    w.ok('render', '--write'); assert.strictEqual(fs.readFileSync(pf, 'utf8'), PROBLEMS);
    fs.writeFileSync(pf, PROBLEMS.replace('## Parties\n', '## Parties\nDT-300|review 11-12|8|`F.js`|new thing|fix|[r1b]\n'));
    w.no(/edited by hand since the last render: its issues live in lc .*--overwrite-problems/, 'render', '--write');
    w.ok('add', '--sec', 'parties', '--origin', 'review 11-12', '--rule', '8', '--sites', '`F.js`', '--what', 'new thing', '--fix', 'fix', '--id', 'DT-300');
    const kept = w.ok('render', '--write', '--overwrite-problems').match(/hand-edited problems\.md kept at (\S+);/)[1];
    assert.match(fs.readFileSync(kept, 'utf8'), /DT-300\|review 11-12/); // the hand copy is kept, the file is the render
    assert.match(fs.readFileSync(pf, 'utf8'), /DT-300\|review 11-12\|8\|`F\.js`\|new thing\|fix\|/);
    assert.match(w.ok('place'), /DT-300 stays: no explicit row or rule/);
    assert.match(w.ok('show', 'DT-300'), /\nat triage/);
    const rule = w.decide('new party lines go to 1b.2', 'action=placement-rule,to=1b.2');
    w.ok('placement', '--to', '1b.2', '--sec', 'parties', '--decision', rule);
    assert.match(w.ok('place', '--apply'), /DT-300 → 1b\.2 \(placement rule\)/);
    // a data write that fails (the fork moved) leaves the planning files untouched and no temp files
    const other = path.join(w.dir, 'o'); execFileSync('git', ['clone', '-q', w.fork, other]);
    execFileSync('git', ['fetch', '-q', 'origin', 'refs/heads/ivan/lifecycle-data:refs/heads/ivan/lifecycle-data'], { cwd: other });
    execFileSync(process.execPath, [LC, 'assign', 'RM-45', '--to', 'tail', '--repo', other, '--remote', 'origin'], { env: w.env, stdio: 'pipe' });
    const before = fs.readFileSync(pf, 'utf8');
    w.no(/has not seen/, 'render', '--write');
    assert.strictEqual(fs.readFileSync(pf, 'utf8'), before);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(pf)).filter(f => f.endsWith('.lc-new')), []);
    w.ok('sync'); w.ok('render', '--write');
    assert.match(fs.readFileSync(pf, 'utf8'), /DT-300\|.*\[r1b\]/);
    fs.writeFileSync(path.join(w.repo, 'planning/hygiene.js'), "const ALLOWED = { 'roadmap.md': 12, 'architecture/problems.md': 0 };\n");
    assert.match(w.ok('render', '--write'), /note  architecture\/problems\.md is 1 KB, over the old 0 KB budget[\s\S]*growth: triage/); // size warns, never blocks
    fs.writeFileSync(pf, fs.readFileSync(pf, 'utf8').replace(/^S3\|.*\n/m, '')); // a line deleted by hand closes nothing
    w.no(/edited by hand since the last render/, 'render', '--write');
    w.ok('render', '--write', '--overwrite-problems');
    assert.match(fs.readFileSync(pf, 'utf8'), /^S3\|/m);
});

test('edit changes an open issue\'s text, alias and note through lc; an id is never reused and nothing else moves', () => {
    const w = world(); w.ok('import', '--decisions', w.seed);
    w.no(/edit names a field that changes/, 'edit', 'DT-44');
    w.no(/no open issue NOPE-1/, 'edit', 'NOPE-1', '--what', 'x');
    const before = w.ok('show', 'DT-44');
    assert.match(w.ok('edit', 'DT-44', '--what', 'party forms twice → two leaders', '--fix', 'one owner of the raise', '--alias', 'RV-9', '--why', 'cause found 11-12: the second raise'), /DT-44 edited \(what, fix, alias RV-9, why\)/);
    const after = w.ok('show', 'RV-9'); // the alias finds the issue
    assert.match(after, /^DT-44 \(= [^)]*RV-9\)\|/m); assert.match(after, /\|party forms twice → two leaders\|one owner of the raise\|/); assert.match(after, /cause found 11-12/);
    assert.strictEqual(after.match(/\nat (\S+)/)[1], before.match(/\nat (\S+)/)[1]); // its place is assign's
    w.no(/RV-9 exists \(ids are never reused\)/, 'edit', 'DT-49', '--alias', 'RV-9');
    w.no(/--alias is an id/, 'edit', 'DT-49', '--alias', 'not an id');
    w.ok('render', '--write');
    assert.match(fs.readFileSync(path.join(w.repo, 'planning/architecture/problems.md'), 'utf8'), /^DT-44 \(= [^)]*RV-9\)\|.*two leaders/m);
});

test('split keeps the old id, aliases and history; steps are reset and reordered; tails come due two releases on', () => {
    const w = world(); w.ok('import', '--decisions', w.seed);
    const vague = w.decide('split things');
    w.no(/does not allow split/, 'split', 'ECO-10', '--decision', vague, '--sites', 'x', '--what', 'x', '--fix', 'x', '--keep-sites', 'y', '--keep-what', 'y', '--keep-fix', 'y');
    const sp = w.decide('split ECO-10 by mechanism', 'action=split,issue=ECO-10', 'action=rule-override,issue=ECO-10,rule=M1');
    w.ok('split', 'ECO-10', '--decision', sp, '--rule', '1', '--sites', '`Worth.js`', '--what', 'worth read two ways', '--fix', 'one worth', '--to', '2.design-inputs',
        '--keep-rule', '2', '--keep-sites', '`Own.js`', '--keep-what', 'own move no event', '--keep-fix', 'situation', '--keep-to', '3.situation-raises');
    assert.match(w.ok('show', 'ECO-10'), /ECO-10\|map 11-03\|2\|`Own\.js`\|own move no event\|situation\|\[r3\]/);
    assert.match(w.ok('show', 'ECO-11'), /ECO-11\|map 11-03; split from ECO-10 \(M\d+\)\|1\|`Worth\.js`\|worth read two ways\|one worth\|\[r2\]/);
    assert.match(w.ok('check'), /0 errors/);
    const o1 = path.join(w.dir, 'o1'); w.ok('render', '--out', o1);
    const r1 = fs.readFileSync(path.join(o1, 'roadmap.md'), 'utf8');
    assert.match(r1, /\| Design inputs: ECO-11 \|/); assert.match(r1, /\| Situation raises: ECO-10 \(own move\) \|/);
    assert.match(w.sh(['log', '--format=%s', '-1', 'refs/heads/ivan/lifecycle-data']), /lc split ECO-10 → ECO-10 \+ ECO-11/);
    w.ok('step', 'set', '3.situation-raises', '--before', '3.cold-command-dropped', '--P', 'mid');
    const out = path.join(w.dir, 'o2'); w.ok('render', '--out', out);
    const rm = fs.readFileSync(path.join(out, 'roadmap.md'), 'utf8');
    assert.ok(rm.indexOf('Situation raises') < rm.indexOf('Cold command dropped') && /Situation raises: ECO-10 \(own move\) \| mid/.test(rm));
    w.no(/1b\.2 is planned with 1 steps: only an empty planned release drops/, 'release', 'drop', '1b.2', '--reason', 'merged into 2');
    w.ok('step', 'move', '1b.2', '--to', '2', '--reason', 'waits for the economy');
    assert.match(w.ok('release', 'drop', '1b.2', '--reason', 'its one step moved to 2'), /1b\.2 dropped/); // an emptied release leaves the roadmap
    w.no(/no live or planned release 1b\.2/, 'release', 'drop', '1b.2', '--reason', 'again');
    assert.doesNotMatch(w.ok('status'), /next 1b\.2 /);
    assert.match(w.ok('show', 'DT-114'), /at 1b\.2 \(2 planned\)/);
    const { dueTails } = require('./lc.js');
    const d = { issues: [{ id: 'DT-90', origin: 'run 10-01', at: null, tail: true }, { id: 'DT-91', origin: 'run 11-20', at: null, tail: true }], archive: { a: { manifest: { validatedAt: '2026-11-10T00:00:00Z' } } } };
    assert.strictEqual(dueTails(d).due.length, 0);
    d.archive.b = { manifest: { validatedAt: '2026-11-25T00:00:00Z' } };
    assert.deepStrictEqual(dueTails(d).due.map(i => i.id), ['DT-90']);
    // a debt or gap that a reader confirmed is due two releases after the confirmation, not its origin; a confirmation moves nothing else
    d.issues.push({ id: 'DT-92', origin: 'run 10-01', kind: 'debt', seen: 'p1 planner 11-12', at: null, tail: true }, { id: 'DT-93', origin: 'run 10-01', kind: 'gap', seen: 'pass 10-05', at: null, tail: true }, { id: 'DT-94', origin: 'run 10-01', kind: 'bug', seen: 'p1 planner 11-12', at: null, tail: true });
    assert.deepStrictEqual(dueTails(d).due.map(i => i.id), ['DT-90', 'DT-93', 'DT-94']);
});

test('context, not files: show pages a step within its budget and loses no line; growth is diagnosed, never cut', () => {
    const w = world(); w.ok('import', '--decisions', w.seed);
    for (let n = 0; n < 12; n++) w.ok('add', '--sec', 'parties', '--origin', 'x 11-11', '--rule', '9', '--sites', `\`Mod${n}.js\``, '--what', 'w'.repeat(120), '--fix', 'f', '--id', `DT-${400 + n}`, '--to', '1b.1');
    const { context, load, save } = require('./lc.js');
    const cx = context({ repo: w.repo }); let { sha, d } = load(cx);
    d.meta.budgets = { rc: 600, pack: 900, rowIssues: 5 }; save(cx, sha, d, 'test: small budgets');
    const p1 = w.ok('show', '1b.1');
    const m = p1.match(/page 1\/(\d+) · lines 1-(\d+) of (\d+) · next: lc show 1b\.1 --page 2/); assert.ok(m, p1);
    const seen = []; for (let n = 1; n <= +m[1]; n++) seen.push(...w.ok('show', '1b.1', '--page', String(n)).split('\n').filter(l => /^\s+(DT-\d+|decision)/.test(l)).map(l => l.trim().split('|')[0]));
    assert.strictEqual(seen.length, +m[3]); assert.strictEqual(new Set(seen).size, seen.length); // every line once, none cut away
    assert.match(p1, /growth: .*rows over budget 1/);
    assert.ok(w.ok('show', '1b.1', '--role', 'rc').split('\n').length < p1.split('\n').length + 1);
    const chk = w.ok('check'); assert.match(chk, /broad 1b\.1 14/);
    // the same quoted code name on intake and in check; nothing merged
    w.ok('add', '--sec', 'failures', '--origin', 'x', '--rule', '2,8', '--sites', '`PartyHuntingAssembly.wait` 21', '--what', 'w', '--fix', 'f', '--id', 'DT-499');
    assert.match(w.ok('add', '--sec', 'failures', '--origin', 'x', '--rule', '2', '--sites', '`PartyHuntingAssembly.wait` 25', '--what', 'w', '--fix', 'f', '--id', 'DT-500'), /same code name: DT-499 \(`PartyHuntingAssembly\.wait`\)/);
    assert.match(w.ok('check'), /dup\?  DT-499 ~ DT-500 \(`PartyHuntingAssembly\.wait`\)/);
    assert.match(w.ok('show', 'DT-499'), /DT-499/); assert.match(w.ok('show', 'DT-500'), /DT-500/); // both stay open
});

test('render --check: nothing to check in shadow; after the cutover a hand edit is not the render', () => {
    const w = world(); w.ok('import', '--decisions', w.seed);
    assert.match(w.ok('render', '--check'), /shadow/);
    w.ok('render', '--write');
    assert.match(w.ok('render', '--check'), /equal the lc render/);
    fs.appendFileSync(path.join(w.repo, 'planning/roadmap.md'), '- hand line\n');
    w.no(/not the lc render: roadmap\.md/, 'render', '--check');
});

test('start names open issues that share a module with the V5.2 brief cause chain', () => {
    const w = world(); w.ok('import', '--decisions', w.seed);
    w.ok('add', '--sec', 'parties', '--origin', 'x', '--rule', '1', '--sites', '`PartyStay.decide` 20', '--what', 'w', '--fix', 'f', '--id', 'DT-600');
    w.sh(['branch', 'ivan/batch-1b1', w.base]); w.sh(['push', '-q', 'fork', 'ivan/batch-1b1']);
    w.ok('open', '1b.1', '--branch', 'ivan/batch-1b1', '--base', w.base);
    const rec = landedTask(w, 'p1', w.base, w.base, 'ivan/batch-1b1', ['DT-44']);
    rec.brief.cause = { status: 'verified', explanation: 'x', chain: ['PartyStay.js:10 symptom', 'PartyStay.decide 20 decides on main'], excluded: ['none plausible: x'] };
    fs.writeFileSync(path.join(w.wf, 'p1.json'), JSON.stringify(rec));
    assert.match(w.ok('start', '1b.1', '--task', 'p1'), /same cause\?: DT-600 at triage names PartyStay from p1's cause chain/);
});

test('a hand-edited roadmap.md is replaced only on --overwrite-roadmap and its copy kept; an investigation note survives a move', () => {
    const w = world(); w.ok('import', '--decisions', w.seed); w.ok('render', '--write');
    const rf = path.join(w.repo, 'planning/roadmap.md');
    fs.appendFileSync(rf, '| Row by an agent | low | low | |\n');
    w.no(/rows live in lc .*--overwrite-roadmap/, 'render', '--write');
    const out = w.ok('render', '--write', '--overwrite-roadmap');
    assert.strictEqual(fs.readFileSync(rf, 'utf8'), ROADMAP);
    assert.match(fs.readFileSync(out.match(/kept at (\S+);/)[1], 'utf8'), /Row by an agent/);
    w.ok('edit', 'DT-49', '--why', 'investigation: cause unverified');
    w.ok('assign', 'DT-49', '--to', '1b.2');
    assert.match(w.ok('show', 'DT-49'), /at 1b\.2 .* investigation: cause unverified/);
});

test('kinds: a bug says what is seen; one write sets many; list, near and seen read and stamp; --gone names where and spares a landed step', () => {
    const w = world(); w.ok('import', '--decisions', w.seed);
    const add = (id, sites, what, ...more) => w.lc('add', '--sec', 'parties', '--origin', 'x 11-12', '--rule', '4', '--sites', sites, '--what', what, '--fix', 'f', '--id', id, ...more);
    assert.match(add('DT-700', '`PartyStay.decide` 20', 'two leaders', '--kind', 'bug').out, /a bug says what a player or the server sees/);
    assert.match(add('DT-700', '`PartyStay.decide` 20', 'two leaders', '--kind', 'chore').out, /kinds: bug risk missing debt gap/);
    assert.strictEqual(add('DT-700', '`PartyStay.decide` 20', 'party forms twice → two leaders', '--kind', 'bug').code, 0);
    assert.strictEqual(add('DT-701', '`PartyStay.leave` 44', 'nine written twice', '--kind', 'debt', '--tail').code, 0);
    assert.strictEqual(add('DT-702', '`Elsewhere.run` 1', 'no counter').code, 0); // a kind is not required yet
    w.no(/kind <bug\|risk\|missing\|debt\|gap> <id\.\.\.>/, 'kind', 'chore', 'DT-702');
    w.no(/no open issue NOPE-1/, 'kind', 'gap', 'DT-702', 'NOPE-1');
    const before = w.sh(['rev-parse', 'ivan/lifecycle-data']);
    assert.match(w.ok('kind', 'risk', 'DT-702', 'DT-49'), /note {2}DT-702: a risk without what is seen[\s\S]*2 → risk/);
    assert.strictEqual(w.sh(['rev-list', '--count', `${before}..ivan/lifecycle-data`]), '1'); // one write for the lot
    w.no(/already risk/, 'kind', 'risk', 'DT-702');
    assert.match(w.ok('status'), /kinds bug 1 · risk 2 · missing 0 · debt 1 · gap 0 · none \d+/);
    assert.match(w.ok('kind'), /without what is seen 2: DT-49 DT-702/);
    const bugs = w.ok('list', '--kind', 'bug'); assert.match(bugs, /^bug DT-700\|/m); assert.match(bugs, /\n1 of \d+\n$/);
    assert.match(w.ok('list', '--kind', 'none', '--sec', 'parties'), /^- DT-114\|/m);
    assert.match(w.ok('list', '--at', 'tail', '--kind', 'debt'), /^debt DT-701\|[\s\S]*\n1 of /);
    const near = w.ok('near', 'DT-700'); // the same module, not the issue itself, not another module
    assert.match(near, /^debt DT-701\|/m); assert.doesNotMatch(near, /DT-700\||DT-702\|/); assert.match(near, /1 near PartyStay: /);
    assert.match(w.ok('near', 'Elsewhere'), /^risk DT-702\|[\s\S]*1 near Elsewhere/);
    w.no(/--by <who date> required/, 'seen', 'DT-701');
    assert.match(w.ok('seen', 'DT-701', 'DT-702', '--by', 'p1 planner 11-12'), /2 confirmed by p1 planner 11-12/);
    assert.match(w.ok('show', 'DT-701'), /· kind debt · seen p1 planner 11-12/);
    assert.match(w.ok('near', 'DT-700'), /^debt \(seen p1 planner 11-12\) DT-701\|/m);
    assert.match(w.ok('list', '--unseen', '--kind', 'risk'), /\n1 of /);
    w.no(/--gone names the file:line or the `code name`/, 'drop', 'DT-701', '--reason', 'one constant now', '--gone', 'looked');
    assert.match(w.ok('drop', 'DT-701', '--reason', 'one constant now', '--gone', 'PartyStay.js:44'), /DT-701 closed \(gone\)/);
    assert.match(w.ok('show', 'DT-701'), /archived in triage: .*"how":"gone".*"where":"PartyStay\.js:44"/);
    w.ok('assign', 'DT-700', 'DT-702', '--to', '1b.2'); // a release opens only when every bug and risk has one
    openAndLand(w);
    w.no(/DT-44 is in landed step 1b\.1: it needs its result \(lc resolve\) or a decision, not --gone/, 'drop', 'DT-44', '--reason', 'x', '--gone', '`B.js`');
    w.ok('render', '--write'); // a kind changes no view line
    assert.match(fs.readFileSync(path.join(w.repo, 'planning/architecture/problems.md'), 'utf8'), /^DT-700\|x 11-12\|4\|/m);
});

test('assembling: bugs lead the fix queue and leave it when their step lands; open refuses an unplaced bug; a fix release shows its limit; a step over four issues starts only with a plan', () => {
    const w = world(); w.ok('import', '--decisions', w.seed);
    const add = (id, ...more) => w.ok('add', '--sec', 'parties', '--origin', 'x 11-12', '--rule', '4', '--sites', `\`Mod${id.slice(3)}.run\` 1`, '--what', 'w → seen', '--fix', 'f', '--id', id, ...more);
    const at = (now, ...args) => execFileSync(process.execPath, [LC, ...args, '--repo', w.repo], { env: { ...w.env, LC_NOW: now }, encoding: 'utf8' });
    assert.match(w.ok('next'), /^fix queue 0\n/);
    add('DT-801', '--kind', 'risk', '--to', '1b.2'); add('DT-800', '--kind', 'bug'); add('DT-802', '--kind', 'debt', '--to', '1b.1'); // the risk is older than the bug
    const n = w.ok('next');
    assert.match(n, /^fix queue 2: DT-800 bug no release · DT-801 risk 1b\.2\n/); // bugs first; a placed one is queued, not loose
    assert.match(n, /next planned 1b\.1 arch\n {2}1b\.1 · 3 issues · no kind 2 · not confirmed 3 · debt or gap 1\n/);
    assert.match(n, /before 1b\.1 opens:\n {2}- a fix release for DT-800 /); assert.match(n, /- confirm 1b\.1's 3 issues/); assert.doesNotMatch(n, /ready to open|debt and gap/);
    assert.match(w.ok('status'), /\nfix queue 2: DT-800 bug no release/);
    for (const b of ['ivan/batch-1b0', 'ivan/batch-1b1']) { w.sh(['branch', b, w.base]); w.sh(['push', '-q', 'fork', b]); }
    w.no(/1 bugs or risks have no release: DT-800; a fix release takes them first/, 'open', '1b.1', '--branch', 'ivan/batch-1b1', '--base', w.base);
    w.ok('release', 'add', '1b.0', '--group', '1b', '--order', '0', '--type', 'fix'); w.ok('step', 'add', '1b.0', '--key', '1b.0', '--title', 'fixes: DT-800'); w.ok('assign', 'DT-800', '--to', '1b.0');
    w.ok('open', '1b.0', '--branch', 'ivan/batch-1b0', '--base', w.base);
    assert.match(w.ok('next'), /\n1b\.0 open fix · 0 h · 0\/1 steps landed\n/); // inside its limit: nothing said
    assert.match(at('2026-11-13T02:00:00Z', 'next'), /\n1b\.0 open fix · 26 h · 0\/1 steps landed · at its limit \(6 landed steps or 24 h\)/);
    const head = commit(w, 'ivan/batch-1b0', 'the fix'); landedTask(w, 'f1', w.base, head, 'ivan/batch-1b0', ['DT-800']);
    w.ok('start', '1b.0', '--task', 'f1'); w.sh(['push', '-q', 'fork', 'ivan/batch-1b0']); w.ok('land', '1b.0');
    assert.match(w.ok('next'), /^fix queue 1: DT-801 risk 1b\.2\n/); // a landed step holds it: it waits for its result, not for a release
    w.ok('open', '1b.1', '--branch', 'ivan/batch-1b1', '--base', w.base);
    add('DT-803', '--to', '1b.1'); // DT-44, DT-49, DT-802, DT-803: four is one task
    landedTask(w, 'p1', w.base, w.base, 'ivan/batch-1b1', ['DT-44']); landedTask(w, 'p2', w.base, w.base, 'ivan/batch-1b1', ['DT-49']); landedTask(w, 'p3', w.base, w.base, 'ivan/batch-1b1', ['DT-49']);
    assert.match(w.ok('start', '1b.1', '--task', 'p1'), /1b\.1 active \(p1\)/);
    add('DT-804', '--to', '1b.1'); // five
    w.no(/1b\.1 holds 5 issues, over the 4 of one task: split it .* or name its plan/, 'start', '1b.1', '--task', 'p2');
    w.no(/no planning\/target-architecture\/parties\.md/, 'step', 'set', '1b.1', '--plan', 'target-architecture/parties.md');
    fs.mkdirSync(path.join(w.repo, 'planning/target-architecture'), { recursive: true }); fs.writeFileSync(path.join(w.repo, 'planning/target-architecture/parties.md'), 'order of commits\n');
    w.no(/no planning\/\.\.\/game\.js/, 'step', 'set', '1b.1', '--plan', '../game.js'); // a plan is a planning file
    w.ok('step', 'set', '1b.1', '--plan', 'target-architecture/parties.md');
    assert.match(w.ok('start', '1b.1', '--task', 'p2'), /1b\.1 active \(p2\)/);
    w.ok('step', 'set', '1b.1', '--plan', 'none'); w.no(/1b\.1 holds 5 issues/, 'start', '1b.1', '--task', 'p3');
    // the next planned release is ready when its issues have a kind and a confirmation and triage is empty; its debt is a count, not a task
    const mine = w.ok('list', '--at', '1b.2').split('\n').filter(l => l.includes('|')).map(l => l.split('|')[0].split(' ')[1]);
    const triage = w.ok('list', '--at', 'triage').split('\n').filter(l => l.includes('|')).map(l => l.split('|')[0].split(' ')[1]);
    if (triage.length) w.ok('assign', ...triage, '--to', 'tail');
    w.ok('kind', 'debt', ...mine.filter(id => id !== 'DT-801')); w.ok('seen', ...mine, '--by', 'pass 11-12');
    const ready = w.ok('next'); assert.match(ready, /\n {2}1b\.2 · \d+ issues · no kind 0 · not confirmed 0 · debt or gap \d+/); assert.match(ready, /\n1b\.2: ready to open\n$/);
    assert.match(w.lc('near', 'DT-9999').out, /DT-9999: no open issue there/); // a mistyped id is not a module name
});

test('unfreeze: a frozen release takes the fix its final runs asked for only by a decision; the old head and gates become history and the new tip is frozen', () => {
    const w = world(); w.ok('import', '--decisions', w.seed);
    const old = openAndLand(w); w.ok('freeze', '1b.1');
    w.no(/1b\.1 is frozen/, 'step', 'add', '1b.1', '--key', '1b.1b', '--title', 'stuck party');
    w.no(/unfreeze \{"release":"1b\.1"\} needs --decision/, 'unfreeze', '1b.1', '--reason', 'A\/B: one stuck party');
    const other = w.decide('unfreeze another', 'action=unfreeze,release=2');
    w.no(new RegExp(`${other} does not allow unfreeze`), 'unfreeze', '1b.1', '--decision', other, '--reason', 'x');
    const m = w.decide('the A/B showed a stuck party: fix it in 1b.1', 'action=unfreeze,release=1b.1');
    w.no(/--reason <what the final runs showed> required/, 'unfreeze', '1b.1', '--decision', m);
    assert.match(w.ok('unfreeze', '1b.1', '--decision', m, '--reason', 'A/B: one stuck party'), /1b\.1 open again/);
    w.no(/1b\.1 is open/, 'unfreeze', '1b.1', '--decision', m, '--reason', 'again');
    w.no(/gates are recorded on the frozen head; 1b\.1 is open/, 'gate', '1b.1', 'report', '--file', 'x');
    assert.strictEqual(w.ok('get', '1b.1', 'st').trim(), 'open'); w.no(/1b\.1 has no head/, 'get', '1b.1', 'head'); assert.strictEqual(w.ok('get', '1b.1', 'gates').trim(), '{}');
    const thawed = JSON.parse(w.ok('get', '1b.1', 'thawed'));
    assert.strictEqual(thawed.length, 1); assert.strictEqual(thawed[0].head, old); assert.strictEqual(thawed[0].decision, m); assert.match(thawed[0].reason, /stuck party/);
    w.ok('step', 'add', '1b.1', '--key', '1b.1b', '--title', 'stuck party');
    w.ok('add', '--sec', 'parties', '--origin', 'ab 11-12', '--rule', '3', '--sites', '`SpotContest.step` 3', '--what', 'a party leaves an empty camp → it stands', '--fix', 'f', '--id', 'DT-900', '--kind', 'bug', '--to', '1b.1b');
    w.no(/not landed: 1b\.1b/, 'freeze', '1b.1'); // the fix lands before the release freezes again
    const head = commit(w, 'ivan/batch-1b1', 'the stuck party fix'); landedTask(w, 'p2', old, head, 'ivan/batch-1b1', ['DT-900']);
    w.ok('start', '1b.1b', '--task', 'p2'); w.sh(['push', '-q', 'fork', 'ivan/batch-1b1']); w.ok('land', '1b.1b');
    assert.match(w.ok('freeze', '1b.1'), new RegExp(`1b\\.1 frozen at ${head.slice(0, 9)}`));
    assert.strictEqual(w.ok('get', '1b.1', 'head').trim(), head);
});

test('contract: records written by the real workflow.js pass lc land, resolve and gate ci', () => {
    const w = world(); w.ok('import', '--decisions', w.seed);
    // a minimal game checkout and policy home the real workflow.js accepts
    const home = path.join(w.dir, 'home'), put = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
    for (const f of ['workflow.js', 'workflow/evidence.md', 'workflow/routes.md']) put(path.join(home, '.claude', f), fs.readFileSync(path.join(__dirname, f)));
    put(path.join(home, 'planning/tests-for.js'), "console.log('test_basic.js');\n"); put(path.join(home, 'planning/rules-check.js'), "console.log('ok');\n");
    put(path.join(w.repo, 'package.json'), '{}'); put(path.join(w.repo, 'src/foo.js'), '1\n'); put(path.join(w.repo, 'tests/test_basic.js'), '\n');
    put(path.join(w.repo, 'scripts/run-tests.js'), "const a = process.argv; console.log(a.includes('--needs-geodata') ? 'false' : a.includes('--geodata') ? '' : 'tests/test_basic.js');\n");
    w.sh(['add', '-A']); w.sh(['commit', '-qm', 'game base']); const base = w.sh(['rev-parse', 'HEAD']);
    const bin = path.join(w.dir, 'bin'), ghJson = path.join(w.dir, 'gh.json'); put(path.join(bin, 'gh'), '#!/bin/sh\ncat "$GH_FAKE"\n'); fs.chmodSync(path.join(bin, 'gh'), 0o755);
    const wfEnv = { ...w.env, PATH: bin + path.delimiter + process.env.PATH, GH_FAKE: ghJson };
    const wf = (...a) => { try { return execFileSync(process.execPath, [path.join(home, '.claude/workflow.js'), ...a, '--root', w.repo], { env: wfEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { assert.fail(`workflow ${a.join(' ')}: ${e.stdout}${e.stderr}`); } };
    Object.assign(w.env, { LC_WORKFLOW_DIR: path.join(w.repo, '.git/l2solo-workflow'), LC_WORKFLOW_JS: path.join(home, '.claude/workflow.js'), PATH: wfEnv.PATH, GH_FAKE: ghJson });
    w.sh(['branch', 'ivan/batch-1b1', base]); w.sh(['push', '-q', 'fork', 'ivan/batch-1b1']);
    w.ok('open', '1b.1', '--branch', 'ivan/batch-1b1', '--base', base);
    wf('start', 'p1', '--base', base, '--risk', 'standard', '--kind', 'fix');
    w.sh(['checkout', '-q', 'ivan/batch-1b1']); fs.writeFileSync(path.join(w.repo, 'src/foo.js'), '2\n'); w.sh(['commit', '-qam', 'fix']); const head = w.sh(['rev-parse', 'HEAD']);
    const brief = path.join(w.dir, 'brief.json');
    fs.writeFileSync(brief, JSON.stringify({ base, symptom: 'DT-44 and DT-49: forming retries', owner: 'forming', scope: ['src/foo.js'], acceptance: ['a'], evidence: ['trace'], tests: ['test_basic.js'], regressions: ['test_basic.js'], nonGoals: [],
        cause: { status: 'verified', explanation: 'x', evidence: ['src/foo.js:1'], chain: ['src/foo.js:1 symptom', 'src/foo.js:1 first wrong decision'], excluded: ['none plausible: one line'] } }));
    wf('record-brief', 'p1', '--file', brief); wf('verify', 'p1', '--rules');
    wf('record-regression', 'p1', '--test', 'test_basic.js', '--old', base, '--evidence', 'old fails at :1, new passes');
    fs.writeFileSync(ghJson, JSON.stringify({ headSha: head, headBranch: 'ci-x', status: 'completed', conclusion: 'success', url: 'u', workflowName: 'PR checks', jobs: Array.from({ length: 12 }, (_, n) => ({ name: `Node tests (${n + 1}/12)`, conclusion: 'success' })) }));
    wf('record-ci', 'p1', '--run', '7'); wf('record-review', 'p1', '--result', 'pass', '--evidence', 'review ok');
    assert.match(wf('ready', 'p1'), /"taskReady": true/);
    w.sh(['push', '-q', 'fork', 'ivan/batch-1b1']); wf('record-land', 'p1', '--remote', 'fork', '--branch', 'ivan/batch-1b1');
    w.ok('start', '1b.1', '--task', 'p1'); w.ok('land', '1b.1');
    assert.match(w.ok('resolve', 'DT-44', 'DT-49', '--test', 'test_basic.js'), /DT-44, DT-49 resolved/); // one command for a step's issues
    w.ok('freeze', '1b.1');
    assert.match(w.ok('gate', '1b.1', 'ci', '--task', 'p1', '--root', w.repo), /1b\.1 ci ✓/);
    assert.match(w.ok('get', '1b.1', 'gates'), /"ci":\{"at":"[^"]+","task":"p1","runs":\["7"\]\}/);
});
