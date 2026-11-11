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
    const stub = path.join(dir, 'workflow-stub.js'); // V5.1 `verify` stand-in: prints the selection a test sets
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
    w.no(/names --decision, --rule0 or --fixed-by/, 'drop', 'S3', '--reason', 'gone');
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
    fs.writeFileSync(w.plan, JSON.stringify({ head, geodataOnly: ['test_geo.js', 'test_geo2.js'], optionalGeodata: ['test_raw.js'] }));
    w.no(/Picked tests miss test_geo2\.js/, 'gate', '1b.1', 'ci', '--task', 'rel-ci', '--root', w.repo);
    fs.writeFileSync(w.plan, JSON.stringify({ head, geodataOnly: ['test_geo.js'], optionalGeodata: ['test_raw.js', 'test_raw2.js'] }));
    w.no(/raw-geodata evidence misses test_raw2\.js/, 'gate', '1b.1', 'ci', '--task', 'rel-ci', '--root', w.repo);
    fs.writeFileSync(w.plan, JSON.stringify({ head: w.base, geodataOnly: [], optionalGeodata: [] }));
    w.no(/not the frozen head/, 'gate', '1b.1', 'ci', '--task', 'rel-ci', '--root', w.repo);
    const noPr = landedTask(w, 'rel-ci2', w.base, head, 'ivan/batch-1b1'); noPr.evidence.ciRuns = noPr.evidence.ciRuns.filter(x => x.workflow !== 'PR checks'); fs.writeFileSync(path.join(w.wf, 'rel-ci2.json'), JSON.stringify(noPr));
    w.no(/no full PR checks/, 'gate', '1b.1', 'ci', '--task', 'rel-ci2', '--root', w.repo);
    const oldRules = landedTask(w, 'rel-ci3', w.base, head, 'ivan/batch-1b1', [], { rules: { head: w.base } });
    w.no(/rules-check is not on/, 'gate', '1b.1', 'ci', '--task', 'rel-ci3', '--root', w.repo); assert.ok(oldRules);
    fs.writeFileSync(w.plan, JSON.stringify({ head, geodataOnly: ['test_geo.js'], optionalGeodata: ['test_raw.js'] }));
    w.ok('gate', '1b.1', 'ci', '--task', 'rel-ci', '--root', w.repo);
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
    const a9 = w.base.slice(0, 9), a1 = run(w, `${a9}-script-ab`, { sha: w.base }), a2 = run(w, `${a9}-hot-ab`, { sha: w.base, scenario: 'hot', minutes: 20 });
    const abv = file(w, 'ab.md', `${s9} ${b1} ${b2} ${a1} ${a2}\nverdict: pass\n`);
    w.no(/no A run fits.*hot/, 'gate', '1b.1', 'ab', '--run', b1, '--run', b2, '--base-run', a1, '--verdict', abv);
    const a3 = run(w, `${a9}-hot-other-save`, { sha: w.base, scenario: 'hot', minutes: 20, save: 'save-2' });
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

test('close: an issue without its own result blocks the close or is carried, never archived', () => {
    const w = world(); w.ok('import', '--decisions', w.seed);
    openAndLand(w, { ids: ['DT-44'] });
    w.no(/brief does not name DT-49/, 'resolve', 'DT-49', '--test', 'test_fix.js');
    w.ok('resolve', 'DT-44', '--test', 'test_fix.js');
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
    w.no(/edited by hand since the last render/, 'render', '--write');
    assert.match(w.ok('absorb'), /new: DT-300 parties \[r1b\]/);
    w.ok('absorb', '--apply');
    assert.match(w.ok('place'), /DT-300 stays: no explicit row or rule/);
    assert.match(w.ok('show', 'DT-300'), /\|\[r1b\]\nat triage/);
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
    fs.writeFileSync(pf, PROBLEMS.replace(/^S3\|.*\n/m, ''));
    w.no(/deleted lines must be restored/, 'absorb', '--apply');
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
    w.ok('step', 'move', '1b.2', '--to', '2', '--reason', 'waits for the economy');
    assert.match(w.ok('show', 'DT-114'), /at 1b\.2 \(2 planned\)/);
    const { dueTails } = require('./lc.js');
    const d = { issues: [{ id: 'DT-90', origin: 'run 10-01', at: null, tail: true }, { id: 'DT-91', origin: 'run 11-20', at: null, tail: true }], archive: { a: { manifest: { validatedAt: '2026-11-10T00:00:00Z' } } } };
    assert.strictEqual(dueTails(d).due.length, 0);
    d.archive.b = { manifest: { validatedAt: '2026-11-25T00:00:00Z' } };
    assert.deepStrictEqual(dueTails(d).due.map(i => i.id), ['DT-90']);
});

test('the V5.1 task ledger: landed, landed by patch-id, superseded, abandoned, release gate; records untouched', () => {
    const w = world(); w.ok('import', '--decisions', w.seed);
    w.sh(['branch', 'ivan/batch-9', w.base]);
    const h1 = commit(w, 'ivan/batch-9', 'fix a');
    landedTask(w, 'dt201c', w.base, h1, 'ivan/batch-9');
    w.sh(['branch', 'wf-test', w.base]); const ht = commit(w, 'wf-test', 'workflow test'); landedTask(w, 'v3-clitest2', w.base, ht, 'wf-test');
    fs.writeFileSync(path.join(w.wf, 'dt201.json'), JSON.stringify({ slug: 'dt201', base: w.base, created: '2026-11-11T00:00:00Z', evidence: {} }));
    w.sh(['checkout', '-q', '-b', 'side', w.base]); fs.writeFileSync(path.join(w.repo, 'game.js'), 'fix a'); w.sh(['commit', '-qam', 'same change elsewhere']);
    const same = w.sh(['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(w.wf, 'other-name.json'), JSON.stringify({ slug: 'other-name', base: w.base, created: '2026-11-13T00:00:00Z', evidence: { review: { head: same } } }));
    fs.writeFileSync(path.join(w.wf, 'n-shaman.json'), JSON.stringify({ slug: 'n-shaman', base: w.base, created: '2026-11-10T00:00:00Z', evidence: {} }));
    fs.writeFileSync(path.join(w.wf, 'release-1b-ci.json'), JSON.stringify({ slug: 'release-1b-ci', base: w.base, created: '2026-11-12T00:00:00Z', evidence: {} }));
    const before = fs.readdirSync(w.wf).map(f => fs.readFileSync(path.join(w.wf, f), 'utf8')).join();
    const out = w.ok('tasks', '--verbose', '--apply');
    assert.match(out, /dt201 superseded by dt201c/);
    assert.match(out, /other-name landed by dt201c · same patch-id/);
    assert.match(out, /n-shaman abandoned/);
    assert.match(out, /release-1b-ci release-gate/);
    assert.match(out, /dt201c landed · record-land ivan\/batch-9 .* on an integration branch/);
    assert.match(out, /v3-clitest2 landed-test · .* on no integration branch/);
    assert.strictEqual(fs.readdirSync(w.wf).map(f => fs.readFileSync(path.join(w.wf, f), 'utf8')).join(), before);
    assert.match(w.sh(['show', 'refs/heads/ivan/lifecycle-data:tasks.jsonl']), /"slug":"dt201","class":"superseded"/);
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
