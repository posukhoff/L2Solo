'use strict';
// Behaviour of lc on a throwaway repo: import is lossless, guards refuse what needs the maintainer or evidence,
// a release runs open → start → land → freeze → gates → close and its issues reach the archive.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LC = path.join(__dirname, 'lc.js');
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', LC_NOW: '2026-11-12T00:00:00Z' });

const PROBLEMS = `# Problems: fixture
Line: id|origin|rule|sites|what|fix|tag
## Failures that show (rule 8)
S3|pass 11-03|8|\`A.js\` 1|drop never acked|ack|[r3]
DT-44 (= A-11)|audit 11-07|2|\`B.js\` 2 \`x|y\`|retry 30 s|event|[r1b]
## Parties
DT-49|run 11-09|1|\`C.js\`|party stay on main|worker|[r1b]
DT-114|planner 11-09|8|\`D.js\`|no clan evidence|worker|[r1b]
## Economy (redesign)
RM-45|run 11-09|0|\`E.js\`|shots never restocked|price rule|[r2]
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
## 3. Server
| Item | P | S | Who |
|---|---|---|---|
| Cold command dropped: S3 | low | mid | |
## Large, own plan
- Components: plan.md.
`;
const SEED = { decisions: [{ id: 'M1', date: '2026-11-07', text: 'no economy work outside the redesign' }], rules: [{ sec: 'economy', only: ['2', 'large'], decision: 'M1' }], releases: { '2': ['M1'] } };

function world() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-'));
    const repo = path.join(dir, 'game'), fork = path.join(dir, 'fork.git'), wf = path.join(dir, 'wf'), runs = path.join(dir, 'runs');
    const sh = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    fs.mkdirSync(path.join(repo, 'planning/architecture'), { recursive: true }); fs.mkdirSync(wf); fs.mkdirSync(runs);
    execFileSync('git', ['init', '-q', '--bare', fork]);
    sh(['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(repo, 'planning/architecture/problems.md'), PROBLEMS);
    fs.writeFileSync(path.join(repo, 'planning/roadmap.md'), ROADMAP);
    fs.writeFileSync(path.join(repo, 'planning/hygiene.js'), "const ALLOWED = { 'roadmap.md': 12, 'architecture/problems.md': 108 };\n");
    fs.writeFileSync(path.join(repo, 'game.js'), '1\n');
    sh(['add', 'game.js']); sh(['commit', '-q', '-m', 'base']);
    sh(['remote', 'add', 'fork', fork]);
    const seed = path.join(dir, 'seed.json'); fs.writeFileSync(seed, JSON.stringify(SEED));
    const env = { ...process.env, LC_WORKFLOW_DIR: wf, LC_RUNS: runs };
    const lc = (...args) => { try { return { code: 0, out: execFileSync(process.execPath, [LC, ...args, '--repo', repo], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { code: e.status, out: (e.stdout || '') + (e.stderr || '') }; } };
    const ok = (...args) => { const r = lc(...args); assert.strictEqual(r.code, 0, `lc ${args.join(' ')}: ${r.out}`); return r.out; };
    const no = (re, ...args) => { const r = lc(...args); assert.notStrictEqual(r.code, 0, `lc ${args.join(' ')} should refuse`); assert.match(r.out, re); return r.out; };
    return { dir, repo, wf, runs, sh, lc, ok, no, seed };
}
// a V5.1 task that landed `head` on `branch` with review, ready and CI on that head
function landedTask(w, slug, base, head, branch) {
    fs.writeFileSync(path.join(w.wf, slug + '.json'), JSON.stringify({ slug, base, evidence: { review: { head, result: 'pass' }, ready: { head }, ciRuns: [{ head, id: '9' + slug.length }], landed: { remote: 'fork', branch, head, reviewedHead: head, tree: 't' } } }));
}
function commit(w, branch, text) {
    w.sh(['checkout', '-q', branch]); fs.writeFileSync(path.join(w.repo, 'game.js'), text); w.sh(['commit', '-qam', text]);
    return w.sh(['rev-parse', 'HEAD']);
}

test('import renders both planning files back byte for byte and runs once', () => {
    const w = world();
    assert.match(w.ok('import', '--decisions', w.seed), /imported 5 issues, 5 releases; placed 5, triage 0/);
    w.no(/import runs once/, 'import');
    const out = path.join(w.dir, 'out');
    w.ok('render', '--out', out);
    assert.strictEqual(fs.readFileSync(path.join(out, 'architecture/problems.md'), 'utf8'), PROBLEMS);
    assert.strictEqual(fs.readFileSync(path.join(out, 'roadmap.md'), 'utf8'), ROADMAP);
    assert.match(w.ok('check'), /0 errors/);
    assert.match(w.ok('show', 'A-11'), /at 1b\.1/);
});

test('guards: economy outside its release, unknown deps, cycles, reused ids, drops without reason', () => {
    const w = world(); w.ok('import', '--decisions', w.seed);
    w.no(/M1 keeps that in 2\/large/, 'assign', 'RM-45', '--to', '3.cold-command-dropped');
    w.ok('assign', 'RM-45', '--to', '3.cold-command-dropped', '--decision', 'M1');
    w.no(/depends on unknown/, 'add', '--sec', 'parties', '--origin', 'x', '--rule', '1', '--sites', 's', '--what', 'w', '--fix', 'f', '--deps', 'NOPE-1');
    w.ok('add', '--sec', 'parties', '--origin', 'x', '--rule', '1', '--sites', 's', '--what', 'w', '--fix', 'f', '--id', 'DT-200', '--deps', 'DT-49', '--to', '1b.2');
    w.no(/queued later/, 'add', '--sec', 'parties', '--origin', 'x', '--rule', '1', '--sites', 's', '--what', 'w', '--fix', 'f', '--id', 'DT-201', '--deps', 'DT-200', '--to', '1b.1');
    w.ok('dep', 'DT-49', '--on', 'DT-44');
    w.no(/dependency cycle DT-44 → DT-49 → DT-44|dependency cycle DT-49 → DT-44 → DT-49/, 'dep', 'DT-44', '--on', 'DT-49');
    w.no(/exists \(ids are never reused\)/, 'add', '--sec', 'parties', '--origin', 'x', '--rule', '1', '--sites', 's', '--what', 'w', '--fix', 'f', '--id', 'A-11');
    w.no(/names --decision, --rule0 or --fixed-by/, 'drop', 'S3', '--reason', 'gone');
    w.ok('drop', 'S3', '--reason', 'not worth a line', '--rule0');
    w.no(/exists/, 'add', '--sec', 'failures', '--origin', 'x', '--rule', '1', '--sites', 's', '--what', 'w', '--fix', 'f', '--id', 'S3');
    assert.match(w.ok('show', 'S3'), /archived in 3: .*not-worth-it/);
});

test('a moved writer loses: a save on a stale base is refused and writes nothing', () => {
    const w = world(); w.ok('import', '--decisions', w.seed);
    const { context, load, save, Refusal } = require('./lc.js');
    const cx = context({ repo: w.repo });
    const stale = load(cx);
    w.ok('assign', 'S3', '--to', 'tail');
    const moved = w.sh(['rev-parse', 'refs/heads/ivan/lifecycle-data']);
    stale.d.issues.find(i => i.id === 'RM-45').at = null;
    assert.throws(() => save(cx, stale.sha, stale.d, 'stale write'), e => e instanceof Refusal && /moved while this command ran/.test(e.message));
    assert.strictEqual(w.sh(['rev-parse', 'refs/heads/ivan/lifecycle-data']), moved);
});

test('a release from open to close: evidence from V5.1, runs from run.json, issues archived, a deferred step carried', () => {
    const w = world(); w.ok('import', '--decisions', w.seed);
    const base = w.sh(['rev-parse', 'HEAD']);
    w.sh(['branch', 'ivan/batch-1b1', base]);
    w.no(/needs 1b\.1 landed first/, 'open', '1b.2', '--branch', 'ivan/batch-1b1', '--base', base);
    w.ok('open', '1b.1', '--branch', 'ivan/batch-1b1', '--base', base);
    w.no(/no record/, 'start', '1b.1', '--task', 'p1');
    const head = commit(w, 'ivan/batch-1b1', 'parties on the worker');
    landedTask(w, 'p1', base, head, 'ivan/batch-1b1');
    w.ok('start', '1b.1', '--task', 'p1');
    w.no(/not on fork\/ivan\/batch-1b1|unknown/, 'land', '1b.1');
    w.sh(['push', '-q', 'fork', 'ivan/batch-1b1']);
    w.ok('land', '1b.1', '--keep', 'DT-49');
    assert.match(w.ok('show', 'DT-49'), /at triage .*kept open when 1b\.1 landed/);
    w.ok('assign', 'DT-49', '--to', '1b.2');
    w.no(/gates are recorded on the frozen head/, 'gate', '1b.1', 'report', '--ref', 'r.md');
    w.ok('freeze', '1b.1');
    w.no(/frozen \(scope closed\)/, 'assign', 'S3', '--to', '1b.1');
    w.no(/gates missing: ci, trace, ab, report/, 'close', '1b.1');
    w.no(/no record/, 'gate', '1b.1', 'ci', '--task', 'nope');
    landedTask(w, 'rel-ci', base, head, 'ivan/batch-1b1');
    w.ok('gate', '1b.1', 'ci', '--task', 'rel-ci');
    const run = (name, sha, dirty = false) => { fs.mkdirSync(path.join(w.runs, name)); fs.writeFileSync(path.join(w.runs, name, 'run.json'), JSON.stringify({ sha: sha.slice(0, 9), dirty })); return name; };
    w.no(/is not of/, 'gate', '1b.1', 'trace', '--run', run('old', base), '--verdict', 'v.md');
    w.no(/dirty tree/, 'gate', '1b.1', 'trace', '--run', run('dirty', head, true), '--verdict', 'v.md');
    w.ok('gate', '1b.1', 'trace', '--run', run('final', head), '--verdict', 'gate3.md');
    w.ok('gate', '1b.1', 'ab', '--run', run('ab-cold', head), '--run', run('ab-hot', head), '--verdict', 'ab.md');
    w.no(/unknown decision/, 'gate', '1b.1', 'report', '--waive', '--decision', 'M9', '--reason', 'r');
    w.ok('gate', '1b.1', 'report', '--ref', 'report.md');
    assert.match(w.ok('close', '1b.1'), /1b\.1 closed; 1 issues archived/);
    assert.match(w.ok('show', 'DT-44'), /archived in 1b\.1: .*"how":"landed".*"slug":"p1"/);
    w.no(/closed: archive/, 'open', '1b.1', '--branch', 'x', '--base', base);
    // 1b.2 may open now (its need landed and closed); a step not done is carried to 2 with its issues
    w.sh(['branch', 'ivan/batch-1b2', head]);
    w.ok('open', '1b.2', '--branch', 'ivan/batch-1b2', '--base', head);
    w.no(/not landed: 1b\.2/, 'freeze', '1b.2');
    w.ok('defer', '1b.2', '--to', '2', '--reason', 'clan aggregate waits for the economy release');
    assert.match(w.ok('show', 'DT-114'), /at 1b\.2 \(2 planned\)/);
    assert.match(w.ok('show', 'DT-49'), /at 1b\.2 \(2 planned\)/);
    assert.match(w.ok('check'), /0 errors/);
    const st = w.ok('status');
    assert.match(st, /1b\.2 open feature|1b\.2 open arch/);
    assert.match(st, /views roadmap 1\/12 KB · problems 1\/108 KB/);
});

test('views: hand edits are absorbed, never overwritten; deletions refused', () => {
    const w = world(); w.ok('import', '--decisions', w.seed);
    const pf = path.join(w.repo, 'planning/architecture/problems.md');
    fs.writeFileSync(pf, PROBLEMS.replace('## Parties\n', '## Parties\nDT-300|review 11-12|8|`F.js`|new thing|fix|[r1b]\n'));
    w.no(/edited by hand since the last render/, 'render', '--write');
    assert.match(w.ok('absorb'), /new: DT-300 parties \[r1b\]/);
    w.ok('absorb', '--apply');
    assert.match(w.ok('place'), /DT-300 → 1b\.1 \(group 1b, same section\)|DT-300 stays/);
    fs.writeFileSync(pf, PROBLEMS.replace(/^S3\|.*\n/m, ''));
    w.no(/deleted lines must be restored/, 'absorb', '--apply');
});
