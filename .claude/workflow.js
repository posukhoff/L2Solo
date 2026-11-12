#!/usr/bin/env node
'use strict';
// Local task evidence; never writes game code, pushes, merges, or starts a server.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const home = path.resolve(__dirname, '..');
const [command, slug, ...args] = process.argv.slice(2);
const opt = key => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
const flag = key => args.includes(key);
const root = path.resolve(opt('--root') || home);
const run = (program, argv, cwd = root) => execFileSync(program, argv, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore','pipe','pipe'] }).trim();
const git = (...argv) => run('git', argv);
// The stable patch-id of a task's change (base..head): equal ids are the same change on any base.
const patchId = (a, b) => execFileSync('git', ['patch-id', '--stable'], { cwd: root, encoding: 'utf8', input: execFileSync('git', ['diff', '--no-renames', a, b], { cwd: root, maxBuffer: 64 * 1024 * 1024 }) }).trim().split(/\s+/)[0] || '';
const fail = msg => { throw new Error(msg); };
// The same tree on the same base is the same change: evidence taken on one commit holds on another commit with its tree
// (a task's commits folded into one at landing; the branch head a release freezes). Commit messages are not in a tree:
// the land tool checks the folded message itself.
const trees = new Map(), treeOf = h => { if (!trees.has(h)) { let t = ''; try { t = git('rev-parse', h + '^{tree}'); } catch { /* unknown commit: its own evidence only */ } trees.set(h, t); } return trees.get(h); };
const sameChange = (a, b) => a === b || (!!a && !!b && treeOf(a) !== '' && treeOf(a) === treeOf(b));
const digest = () => {
    const h = crypto.createHash('sha256');
    // Only what defines evidence: the CLI and its two contracts. Entry point, references, hygiene and cleanup scripts
    // change without voiding open task records.
    for (const file of ['.claude/workflow.js','.claude/workflow/evidence.md','.claude/workflow/routes.md']) {
        h.update(file + '\0'); h.update(fs.readFileSync(path.join(home,file)));
    }
    return h.digest('hex');
};
const clean = () => { if (git('status','--porcelain')) fail('Commit or set aside changes first; evidence must refer to a clean SHA.'); };
const sha = () => git('rev-parse','HEAD');
const now = () => new Date().toISOString();
const riskOrder = ['fast','standard','critical'];
const domainPatterns = [
    [/(combat|attack|skill|effect|damage|pvp|raid)/i, /(combat|attack|skill|effect|damage|pvp|raid)/i, 'combat'],
    [/(econom|market|trade|craft|inventory|gear|item|shop|adena|warehouse)/i, /(econom|market|trade|craft|inventory|gear|item|shop|adena|warehouse)/i, 'economy'],
    [/(population|activation|placement|hot|cold|worker|situations|party|clan)/i, /(activation|placement|hot_cold|worker|situations|party|clan|population)/i, 'population'],
    [/(database|sqlite|persist|save|migration)/i, /(database|sqlite|persist|save|migration)/i, 'persistence']
];
// A leading + (Picked tests' raw-map mark) is not part of the file name.
const norm = x => path.basename(String(x).replace(/^\+/,'')).replace(/^\+/,'').replace(/^(test_)?/,'test_').replace(/(\.js)?$/,'.js');
const nonempty = x => typeof x === 'string' && x.trim().length > 0;
const strings = x => Array.isArray(x) && x.length > 0 && x.every(nonempty);
function validateBrief(b, state) {
    if (!b || b.base !== state.base || !nonempty(b.symptom) || !strings(b.evidence)) fail('Brief needs exact base, symptom (for a feature or chore: the goal, in the same field) and evidence refs.');
    if (state.kind === 'fix' && b.cause?.status === 'guess' && nonempty(b.cause.explanation)) return;
    if (!nonempty(b.owner) || !strings(b.scope) ||
        !strings(b.evidence) || !strings(b.tests) || !Array.isArray(b.nonGoals) ||
        !b.nonGoals.every(nonempty)) fail('Brief needs exact base, symptom/goal, owner, scope, evidence refs, tests and nonGoals.');
    // Acceptance is pinned: each line names the test of this brief, or the run/trace record, that shows it.
    const tests = b.tests.map(norm), pin = a => /^(run|trace):\s*\S/.test(a.by) || tests.includes(norm(a.by.trim().split(/\s+/)[0].replace(/:$/,'')));
    if (!Array.isArray(b.acceptance) || !b.acceptance.length || !b.acceptance.every(a => a && nonempty(a.expect) && nonempty(a.by) && pin(a)))
        fail('Brief acceptance: each line is {"expect": <what a player or the server shows>, "by": <a test listed in tests, or "run: <record>" / "trace: <record>">}.');
    // The architecture-map entries the task changes ("<file>.md: <entry>"), or one "none: <reason>".
    const mapFile = x => (/^([\w-]+\.md):\s*\S/.exec(x) || [])[1];
    if (!strings(b.map) || !(b.map.length === 1 && /^none:\s*\S/.test(b.map[0]) || b.map.every(x => mapFile(x) && fs.existsSync(path.join(home,'planning/architecture',mapFile(x))))))
        fail('Brief map: the architecture-map entries the task changes, each "<file>.md: <entry>" for a file in planning/architecture, or one "none: <reason>".');
    // Small fixes ride by name (planning.md "Small fixes"): at most 4, each its lc issue id and the one source file it changes.
    if (b.smallFixes !== undefined && !(Array.isArray(b.smallFixes) && b.smallFixes.length <= 4 && b.smallFixes.every(f => f && /^[\w.-]+$/.test(f.id || '') && nonempty(f.file)) && new Set(b.smallFixes.map(f => f.id)).size === b.smallFixes.length))
        fail('Brief smallFixes: at most 4, each {"id": <lc issue id>, "file": <the one source file it changes>}, no id twice.');
    if (state.kind === 'fix' && (!b.cause || !['guess','verified'].includes(b.cause.status) ||
        !nonempty(b.cause.explanation))) fail('Fix brief requires cause {status: guess|verified, explanation}.');
    if (state.kind === 'fix' && b.cause.status === 'verified' && (!strings(b.cause.evidence) || !strings(b.regressions) || !b.regressions.every(t=>b.tests.map(norm).includes(norm(t))))) fail('Verified cause needs evidence handles and regression tests listed in tests.');
    if (state.kind === 'fix' && b.cause.status === 'verified' && (!Array.isArray(b.cause.chain) || b.cause.chain.length < 2 || !b.cause.chain.every(nonempty))) fail('Verified cause needs cause.chain: at least 2 non-empty strings (first = where the symptom shows, last = first wrong decision or broken invariant with handle).');
    if (state.kind === 'fix' && b.cause.status === 'verified' && !/^(fixed here|left as \S+ because \S.*)$/.test(String(b.cause.deeper || '').trim())) fail('Verified cause needs cause.deeper: "fixed here", or "left as <lc id> because <the deeper cause is replaced by a planned release | needs its own critical task>" (evidence.md "Cause gate").');
    if (state.kind === 'fix' && b.cause.status === 'verified' && !strings(b.cause.excluded)) fail('Verified cause needs cause.excluded: at least 1 non-empty string (alternative ruled out with handle, or "none plausible: reason").');
}
// Advisory feedback only; never replaces the integration selection.
function devPlan(base, brief) {
    const runner=path.join(root,'scripts/run-tests.js');
    const normal=new Set(run(process.execPath,[runner,'--list']).split('\n').filter(Boolean).map(norm));
    const geo=new Set(run(process.execPath,[runner,'--geodata','--list']).split('\n').filter(Boolean).map(norm));
    const direct=run(process.execPath,[path.join(home,'planning/tests-for.js'),base+'..HEAD','--root',root,'--depth','0']).split('\n').filter(x=>/^test_.*\.js$/.test(x));
    const tests=[...new Set([...brief.tests.map(norm),...direct])].sort();
    const unsupported=tests.filter(x=>!normal.has(x)&&!geo.has(x));
    if(unsupported.length) fail('Dev test not in runner: '+unsupported.join(', '));
    return {tests,raw:tests.filter(x=>geo.has(x)),local:tests.filter(x=>normal.has(x)&&!geo.has(x)),note:'Development feedback only. Full verify/ready requirements unchanged.'};
}
function select(base, brief) {
    const changes = git('diff','--name-status','--no-renames',base,'HEAD').split('\n').filter(Boolean);
    const files = changes.map(x => x.split('\t').at(-1));
    const list = fs.readdirSync(path.join(root,'tests')).filter(x => /^test_.*\.js$/.test(x));
    const raw = run(process.execPath,[path.join(home,'planning/tests-for.js'),base+'..HEAD','--root',root,'--depth','2']);
    const selected = new Set(raw.split('\n').filter(x => /^test_.*\.js$/.test(x)));
    const domains = domainPatterns.filter(([p]) => files.some(x => p.test(x)));
    for (const [,p] of domains) for (const name of list) if (p.test(name)) selected.add(name);
    // Only files the runner knows (scripts/run-tests.js lists): a notRunTests file or a stray name fails --only.
    const runner = path.join(root,'scripts/run-tests.js');
    const normal = new Set(run(process.execPath,[runner,'--list']).split('\n').filter(Boolean).map(x => path.basename(x)));
    const geo = new Set(run(process.execPath,[runner,'--geodata','--list']).split('\n').filter(Boolean).map(x => path.basename(x)));
    const suite = new Set([...normal,...geo]);
    for (const t of brief?.tests || []) {
        if (!suite.has(norm(t))) fail('Brief test not in runner: '+t);
        selected.add(norm(t));
    }
    for (const name of [...selected]) if (!suite.has(name)) selected.delete(name);
    const warnings = [];
    if (changes.some(x => /^D\t/.test(x))) warnings.push('Deleted file: inspect former callers and tests.');
    if (files.some(x => !x.endsWith('.js'))) warnings.push('Non-JS data/config change: add relevant tests explicitly.');
    if (!selected.size) warnings.push('No selected tests: explain why or provide additional tests.');
    // A test file's name is not a surface: only code, data and scripts escalate.
    const critical = files.some(x => !x.startsWith('tests/') && /(^database\/|^data\/Bots\/|^src\/Database\.js$|Situations\.js$|worker|migration|TableFingerprint|scripts\/generate|scripts\/perf)/i.test(x));
    // A critical surface is a route check (verify and ready refuse a lower route), not a selection doubt: it asks no ack.
    return { files, tests: [...selected].sort(), normal: [...normal].sort(),
        geodataOnly: [...selected].filter(t=>!normal.has(t)).sort(),
        optionalGeodata: [...selected].filter(t=>normal.has(t)&&geo.has(t)).sort(),
        domains: domains.map(x=>x[2]), warnings, critical,
        // A generated table, its generator or its fingerprint: the pair of builder and reader shows only on the whole built table.
        table: files.some(x => !x.startsWith('tests/') && /(^data\/Bots\/|scripts\/generate|TableFingerprint)/.test(x)) };
}
// What ready asks of CI on HEAD: the task's own selection, green. record-review asks the same before the first review of
// a generated-table task. The full suite is not a task's evidence: it runs on the integration branch head after each
// landing (the land tool starts it and refuses a landing onto a head that is not green) and the release gate reads `full`
// on the frozen head. In release 1b.0f both tests a task's full run failed on were inside that task's selection.
function ciGaps(plan, e, head) {
    const runs=(e.ciRuns||[]).filter(r=>sameChange(r.head,head)), full=runs.some(r=>r.workflow==='PR checks');
    const covered=new Set(runs.flatMap(r=>r.tests)), missing=plan.tests.filter(t=>!covered.has(t));
    const raw=new Set((e.rawGeodata||[]).filter(r=>sameChange(r.head,head)).map(r=>r.test)), missingRaw=plan.optionalGeodata.filter(t=>!raw.has(t));
    const reasons=[];
    if (missingRaw.length) reasons.push('Missing optional raw-geodata evidence: '+missingRaw.join(', '));
    if (missing.length) reasons.push('Missing '+missing.length+' selected tests: '+missing.slice(0,20).join(', ')+(missing.length>20?' ... (verify --show-tests)':''));
    return { full, missing, missingRaw, reasons };
}
// A review answers the 16 hard rules (0-15) and the deeper-cause question, one line each:
//   <rule|cause> ok <evidence> | na <reason> | violation <file:line> <what> | left <lc id[,id]> [M<n>] <reason>
// A later round answers only what changed: its lines replace the earlier answers. Other lines of the file are ignored.
const RULES = [...Array(16).keys()].map(String).concat('cause');
// Rules whose own text lets a named lc issue stand; a violation of any other rule stands only with a maintainer decision.
const LEAVABLE = new Set(['2','4','15','cause']);
function reviewLines(text) {
    const lines = {};
    for (const l of text.split('\n')) {
        const m = /^\s*(?:[-*]\s*)?(?:rule\s*)?(\d{1,2}|cause)[.:)]?\s+(ok|na|n\/a|violation|left)\b[:\s]*(.*)$/i.exec(l);
        if (!m || !RULES.includes(m[1].toLowerCase())) continue;
        const key = m[1].toLowerCase(), verdict = m[2].toLowerCase().replace('n/a','na'), rest = m[3].trim();
        if (lines[key]) fail('Review table answers '+key+' twice.');
        if (!rest) fail('Review table '+key+' '+verdict+': add its '+({ok:'evidence',na:'reason',violation:'file:line (or "commit <sha>")'}[verdict]||'lc issue id and reason')+'.');
        const row = { verdict, text: rest };
        if (verdict === 'violation' && !/\S+:\d+|\bcommit [0-9a-f]{7,40}\b/.test(rest)) fail('Review table '+key+' violation: name file:line (or "commit <sha>" for a commit message).');
        if (verdict === 'left') {
            const [ids, ...words] = rest.split(/\s+/), why = words.join(' ');
            row.ids = ids.split(',').filter(Boolean); row.decision = (/\bM\d+\b/.exec(why) || [])[0] || null;
            if (!row.ids.length || !why.replace(/\bM\d+\b/,'').trim()) fail('Review table '+key+' left: "<lc id[,id]> [M<n>] <reason>".');
            if (!LEAVABLE.has(key) && !row.decision) fail('Review table '+key+' left: a violation of this rule stands only with a maintainer decision (M<n> from lc decide).');
        }
        lines[key] = row;
    }
    return lines;
}
// Each small fix named in the brief is one commit of the task, its id in the subject, changing its one source file
// (tests beside it); one a review took out has no commit.
function smallFixProblems(base, brief, takenOut) {
    const fixes = brief.smallFixes || [], out = [];
    if (!fixes.length) return out;
    const commits = git('log','--format=%H%x09%s',base+'..HEAD').split('\n').filter(Boolean).map(l => l.split('\t'));
    for (const f of fixes) {
        const named = new RegExp('(^|[^\\w-])'+f.id.replace(/\./g,'\\.')+'($|[^\\w-])'), mine = commits.filter(c => named.test(c[1] || ''));
        if ((takenOut || []).includes(f.id)) { if (mine.length) out.push('Small fix '+f.id+' was taken out by the review but its commit is still in the task.'); continue; }
        if (mine.length !== 1) { out.push('Small fix '+f.id+': '+mine.length+' commits carry its id (one commit each, id in the subject).'); continue; }
        const files = git('diff-tree','--no-commit-id','--name-only','-r',mine[0][0]).split('\n').filter(x => x && !x.startsWith('tests/') && x !== 'scripts/run-tests.js');
        if (files.length !== 1 || files[0] !== f.file) out.push('Small fix '+f.id+': its commit changes '+(files.join(', ') || 'no source file')+', the brief names '+f.file+'.');
    }
    return out;
}
function main() {
    if (!command || !slug || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) fail('Usage: workflow.js <start|status|record-brief|verify|record-regression|record-review|record-ci|ready|record-land|record-rebase|record-retro|close> <slug> [options]');
    if (!fs.existsSync(path.join(root,'package.json')) || !fs.existsSync(path.join(root,'src'))) fail('Use a real L2Solo game checkout, not the workflow snapshot.');
    const stateDir = path.join(git('rev-parse','--path-format=absolute','--git-common-dir'),'l2solo-workflow');
    fs.mkdirSync(stateDir,{recursive:true});
    const file = path.join(stateDir,slug+'.json');
    // A command writes only its own change onto the record as it is now, never the copy it read at start: a long
    // command (verify --check, record-ci) would otherwise undo what another command recorded meanwhile. A command that
    // replaces what the evidence stands on (brief, rebase, close, ready) refuses when the record changed under it.
    let raw0, brief0;
    const save = (change, whole) => {
        const raw=fs.readFileSync(file,'utf8'); let s=state;
        if (raw!==raw0) {
            s=JSON.parse(raw);
            if (whole || s.closed || s.base!==state.base || s.policy!==state.policy || JSON.stringify(s.brief)!==brief0) fail('The task record changed while this command ran'+(whole?'':' (brief, base, policy or close)')+': run it again.');
        }
        change(s);
        // A CI run added for the same head takes nothing from readiness (the landed head's full run is recorded after ready).
        if (!['ready','record-land','record-ci'].includes(command)) delete s.evidence.ready;
        const tmp=file+'.'+process.pid+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(s,null,2)+'\n',{flag:'wx'}); fs.renameSync(tmp,file);
    };
    if (command === 'start') {
        const risk=opt('--risk'), baseRef=opt('--base');
        if (!riskOrder.includes(risk) || !baseRef || baseRef.startsWith('-')) fail('start requires --base <ref> --risk fast|standard|critical');
        const base=git('rev-parse','--verify',baseRef+'^{commit}');
        const kind=opt('--kind') || 'fix';
        if (!['fix','feature','chore'].includes(kind)) fail('Invalid --kind.');
        const state={slug,base,risk,kind,policy:digest(),created:now(),evidence:{} };
        fs.writeFileSync(file,JSON.stringify(state,null,2)+'\n',{flag:'wx'});
        console.log(JSON.stringify(state,null,2)); return;
    }
    // Retro candidates: one append-only log beside the task states. A retro is due on a critical
    // process violation, one cause seen twice, or five open candidates.
    const retroFile = path.join(stateDir,'retro.jsonl');
    const retro = () => {
        let bad = 0;
        const rows = (fs.existsSync(retroFile) ? fs.readFileSync(retroFile,'utf8').split('\n').filter(Boolean) : []).flatMap(l => { try { return [JSON.parse(l)]; } catch { bad++; return []; } });
        if (bad) console.log('retro.jsonl: '+bad+' unreadable line(s) skipped');
        const done = new Set(rows.flatMap(r => r.processed || []));
        const open = rows.filter(r => r.id && !done.has(r.id)), count = {};
        for (const r of open) count[r.cause] = (count[r.cause] || 0) + 1;
        const critical = open.find(r => r.critical), repeated = Object.keys(count).find(k => count[k] >= 2);
        const due = critical ? 'critical process violation #'+critical.id : repeated ? 'cause '+repeated+' seen '+count[repeated]+' times' : open.length >= 5 ? open.length+' open candidates' : '';
        return { rows, open, due };
    };
    const retroCheck = () => { const { due } = retro(); if (due) console.log('RETRO DUE: '+due+' (one narrow Retro agent, then record-retro --processed)'); };
    if (command === 'record-retro') {
        const { rows, open } = retro(), processed = opt('--processed');
        if (processed) {
            const ids = processed === 'all' ? open.map(r => r.id) : processed.split(',').map(Number);
            if (!nonempty(opt('--result')) || !ids.length || ids.some(id => !open.some(r => r.id === id))) fail('record-retro --processed <ids|all> needs open candidate ids and --result <saved retro>.');
            fs.appendFileSync(retroFile, JSON.stringify({ processed: ids, result: opt('--result'), slug, at: now() })+'\n');
        } else {
            const cause = String(opt('--cause') || '').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''), minutes = opt('--minutes');
            if (!cause || !nonempty(opt('--text'))) fail('record-retro requires --cause <systemic cause key> --text <consequence | proposed guard>.');
            if (flag('--useless-run') && !/^\d+$/.test(minutes || '')) fail('--useless-run requires --minutes <blocked development minutes>.');
            const row = { id: rows.filter(r => r.id).length + 1, slug, cause, text: opt('--text'), critical: flag('--critical'), at: now() };
            if (flag('--useless-run')) Object.assign(row, { uselessRun: true, minutes: Number(minutes) });
            fs.appendFileSync(retroFile, JSON.stringify(row)+'\n');
            console.log('Retro candidate #'+row.id);
        }
        retroCheck(); return;
    }
    const state=JSON.parse(raw0=fs.readFileSync(file,'utf8'));
    brief0=JSON.stringify(state.brief);
    if (command === 'status') { console.log(JSON.stringify({...state,policyCurrent:state.policy===digest(),head:sha()},null,2)); return; }
    if (state.closed) fail('Task closed: '+state.closed.reason+'; use a new slug for new evidence.');
    // Closing a refuted guess adds no evidence to build on, so a record started under an older
    // policy can still be closed (its policy is noted, not re-pinned).
    // A task given up or moved (to another slug, release or decision) closes the same way on any kind, until it lands.
    if (command === 'close') {
        const abandoned=flag('--abandoned');
        if (!opt('--evidence') || !(abandoned ? !state.evidence?.landed : flag('--refuted') && state.kind==='fix' && state.brief?.cause?.status==='guess')) fail('close requires --evidence <reference> and --refuted (a guess fix) or --abandoned (a task that has not landed: where its work went or why it stopped).');
        const closed={reason:abandoned?'abandoned':'refuted',evidence:opt('--evidence'),policyCurrent:state.policy===digest(),at:now()};
        save(s=>{s.closed=closed;},true); console.log(JSON.stringify(closed)); retroCheck(); return;
    }
    if (state.policy!==digest()) fail('Policy digest changed; coordinator must re-evaluate and create a fresh task record.');
    if (command === 'record-brief') {
        const p=opt('--file');
        if (!p) fail('record-brief requires --file <brief.json>');
        const brief=JSON.parse(fs.readFileSync(path.resolve(p),'utf8'));
        validateBrief(brief,state);
        save(s=>{s.brief=brief;s.evidence={};},true);
        console.log(JSON.stringify({slug,briefRecorded:true,implementationAllowed:state.kind!=='fix'||brief.cause.status==='verified'},null,2)); return;
    }
    if (!state.brief) fail('Record a task brief first (record-brief).');
    validateBrief(state.brief,state);
    if (state.kind==='fix' && state.brief.cause.status!=='verified') fail('Cause is a hypothesis. Verify it before implementation/verification.');

    // Update the task's base after a coordinator-reviewed rebase. Never transfer SHA receipts.
    if (command === 'record-rebase') {
        clean();
        if(state.evidence.landed) fail('Already landed; start a new task.');
        const baseRef=opt('--base'),fromRef=opt('--from-head'),reason=opt('--evidence');
        if(!baseRef||!fromRef||baseRef.startsWith('-')||fromRef.startsWith('-')||!nonempty(reason)) fail('record-rebase requires --base <new parent> --from-head <old tip> --evidence <cause/owner/scope recheck>');
        const newBase=git('rev-parse','--verify',baseRef+'^{commit}');
        const oldHead=git('rev-parse','--verify',fromRef+'^{commit}');
        const newHead=sha();
        if(newBase===state.base||newHead===newBase||oldHead===state.base||newHead===oldHead) fail('Expected a changed base and nonempty rebased task.');
        const files=(a,b)=>git('diff','--name-only','--no-renames',a,b).split('\n').filter(Boolean).sort();
        // The same change moved onto another base (a restack or reorder) whose commits left the task's
        // files unchanged: the review and the old-code evidence judged the same code, so they carry.
        // When the base changed those files nothing carries (the context moved). SHA receipts never carry.
        const pid=patchId(state.base,oldHead);
        if(pid && pid===patchId(newBase,newHead)) {
            try { git('merge-base','--is-ancestor',newBase,newHead); } catch { fail('New head does not contain the new base.'); }
            const paths=files(state.base,oldHead);
            const sameOldCode=!git('diff','--name-only',state.base,newBase,'--',...paths);
            const previous={base:state.base,head:oldHead,brief:state.brief,evidence:state.evidence,at:now()};
            const touched=sameOldCode?[]:git('diff','--name-only',state.base,newBase,'--',...paths).split('\n').filter(Boolean);
            const carried={};
            if(sameOldCode&&state.evidence.review?.head===oldHead) carried.review={...state.evidence.review,head:newHead,carriedFrom:oldHead,patchId:pid};
            if(sameOldCode) carried.regressions=(state.evidence.regressions||[]).filter(r=>r.head===oldHead&&r.old===state.base).map(r=>({...r,head:newHead,old:newBase,carriedFrom:oldHead}));
            const brief={...state.brief,base:newBase,evidence:[...state.brief.evidence,'Restack (same patch '+pid.slice(0,12)+'): '+reason]};
            validateBrief(brief,{...state,base:newBase});
            save(s=>{s.base=newBase;s.brief=brief;(s.rebases ||= []).push({previous,newBase,newHead,reason,patchId:pid,sameOldCode,touched,at:now()});s.evidence=carried;},true);
            console.log(JSON.stringify({base:newBase,head:newHead,samePatch:true,carried:Object.keys(carried),baseChangedTaskFiles:touched,note:sameOldCode?'Run CI and rules on the new head.':'The new base changed the task files: review them in the new context, old-code evidence, CI and rules again.'},null,2));return;
        }
        try {
            git('merge-base','--is-ancestor',state.base,oldHead);
            git('merge-base','--is-ancestor',state.base,newBase);
            git('merge-base','--is-ancestor',newBase,newHead);
        } catch { fail('Rebase ancestry not established; use a new task/brief.'); }
        if(JSON.stringify(files(state.base,oldHead))!==JSON.stringify(files(newBase,newHead))) fail('Task paths changed during rebase; replan and record a new brief.');
        const previous={base:state.base,head:oldHead,brief:state.brief,evidence:state.evidence,at:now()};
        const brief={...state.brief,base:newBase,evidence:[...state.brief.evidence,'Rebase recheck: '+reason]};
        if(brief.cause?.status==='verified') brief.cause={...brief.cause,evidence:[...brief.cause.evidence,'Rebase recheck: '+reason]};
        validateBrief(brief,{...state,base:newBase});
        save(s=>{s.base=newBase;s.brief=brief;(s.rebases ||= []).push({previous,newBase,newHead,reason,at:now()});s.evidence={};},true);
        console.log(JSON.stringify({base:newBase,head:newHead,priorEvidenceArchived:true,ready:false,note:'Re-run tests, rules, regression and review against new base/head.'},null,2));return;
    }
    // A squash lands on the integration branch, whose history need not hold the task base (a
    // review-fix task on a topic branch): the receipt is the reviewed tree, not the ancestry.
    if (command === 'record-land') {
        const remote=opt('--remote'), branch=opt('--branch');
        if (!remote || !branch || remote.startsWith('-') || branch.startsWith('-')) fail('record-land requires --remote <name> --branch <integration branch>: the landing is what the remote branch holds.');
        const receipt=state.evidence.ready;
        if (!receipt || !receipt.head) fail('No ready receipt; run ready on the reviewed task checkout first.');
        const line=git('ls-remote',remote,'refs/heads/'+branch).split('\n').find(l=>l.endsWith('\trefs/heads/'+branch));
        const head=line?.split('\t')[0];
        if (!/^[0-9a-f]{40}$/.test(head||'')) fail('Remote '+remote+' has no branch '+branch+'.');
        try { git('cat-file','-e',head+'^{commit}'); } catch { fail('Remote head '+head.slice(0,9)+' is not fetched; fetch it, do not transfer evidence.'); }
        if (git('rev-parse',head+'^{tree}')!==git('rev-parse',receipt.head+'^{tree}')) fail('Remote '+remote+'/'+branch+' ('+head.slice(0,9)+') does not hold the verified tree; push first, do not transfer evidence.');
        const landed={remote,branch,head,reviewedHead:receipt.head,tree:git('rev-parse',head+'^{tree}'),at:now()};
        save(s=>{s.evidence.landed=landed;},true); console.log(JSON.stringify(landed,null,2)); retroCheck(); return;
    }
    clean();
    try { git('merge-base','--is-ancestor',state.base,'HEAD'); } catch { fail('Task base is not an ancestor of HEAD.'); }
    const head=sha();
    if (head===state.base) fail('No committed task changes yet.');
    if (command === 'record-regression') {
        const test=opt('--test'), old=opt('--old'), evidence=opt('--evidence');
        if (!test || !old || !evidence || !state.brief.regressions?.map(norm).includes(norm(test))) fail('record-regression requires a brief test, --old <base SHA>, --evidence <old expected failure and new pass reference>.');
        if (old!==state.base) fail('Old-code evidence must identify the task base SHA.');
        save(s=>{s.evidence.regressions=(s.evidence.regressions||[]).filter(r=>sameChange(r.head,head) && r.test!==norm(test));
            s.evidence.regressions.push({head,old,test:norm(test),evidence,at:now()});}); return;
    }
    if (command === 'verify') {
        if (flag('--local')) fail('verify --local was removed: --dev-local gives feedback, CI gives evidence.');
        if(flag('--dev')||flag('--dev-local')){
            const dev=devPlan(state.base,state.brief);
            console.log(JSON.stringify({base:state.base,head,...dev},null,2));
            if(flag('--dev-local')){
                if(!dev.local.length||dev.local.length>8) fail('Dev-local needs 1-8 non-geodata tests; use Picked CI.');
                // Feedback only: nothing is recorded, so it can never count toward ready.
                console.log(run(process.execPath,[path.join(root,'scripts/run-tests.js'),'--only='+dev.local.join(','),'--keep-going']));
            }
            return;
        }
        const plan=select(state.base,state.brief);
        const {normal,tests,...details}=plan;
        // The Picked tests list that alone covers the task: its whole selection, a raw-map file marked with +.
        const picked=[...tests.filter(t=>!plan.optionalGeodata.includes(t)),...plan.optionalGeodata.map(t=>'+'+t)];
        if (flag('--picked-list')) { console.log(picked.join('\n')); return; }
        console.log(JSON.stringify({base:state.base,head,risk:state.risk,...details,normalCount:normal.length,testCount:tests.length,pickedCount:picked.length,pickedList:'verify <slug> --picked-list (ci-dispatch.sh sends it as one tests/list-<sha9> commit)',...(flag('--show-tests')?{tests}:{})},null,2));
        if (plan.critical && state.risk!=='critical') fail('Escalate to critical route before verification.');
        if (flag('--raw-geodata')) {
            const test=norm(opt('--test')||'');
            if(!plan.optionalGeodata.includes(test)) fail('Choose one selected optional-geodata test with --test.');
            // Explicit local command; caller must provide raw map and avoid concurrent perf/trace.
            console.log(run(process.execPath,[path.join(root,'scripts/run-tests.js'),'--geodata','--only='+test,'--keep-going']));
            save(s=>{s.evidence.rawGeodata=(s.evidence.rawGeodata||[]).filter(r=>sameChange(r.head,head)&&r.test!==test);
                s.evidence.rawGeodata.push({head,test,at:now()});}); return;
        }
        if (flag('--rules')) {
            console.log(run(process.execPath,[path.join(home,'planning/rules-check.js'),state.base+'..HEAD','--root',root]));
            save(s=>{s.evidence.rules={head,at:now()};}); return;
        }
        if (flag('--check')) {
            // Syntax and table freshness (Picked tests do not run them; PR checks does) and the mechanical rules (CI does not).
            // CI=true makes check-tables refuse stale tables as CI does; on a bare working copy it only warns.
            console.log(execFileSync('npm',['run','check'],{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe'],env:{...process.env,CI:'true'}}).trim());
            console.log(run(process.execPath,[path.join(home,'planning/rules-check.js'),state.base+'..HEAD','--root',root]));
            save(s=>{s.evidence.rules={head,at:now(),check:true};}); return;
        }
        return;
    }
    if (command === 'record-review') {
        const result=opt('--result'), evidence=opt('--evidence'), rulesFile=opt('--rules');
        if (!['pass','blocked'].includes(result) || !evidence || !rulesFile) fail('record-review requires --result pass|blocked --evidence <reference> --rules <file holding the review table> [--taken-out <small fix ids>] [--selection-ack]');
        const lines=reviewLines(fs.readFileSync(path.resolve(rulesFile),'utf8'));
        if (!Object.keys(lines).length) fail('No review table line in '+rulesFile+' ("<rule|cause> ok|na|violation|left ...").');
        const takenOut=(opt('--taken-out')||'').split(',').filter(Boolean);
        const unknown=takenOut.filter(id=>!(state.brief.smallFixes||[]).some(f=>f.id===id));
        if (unknown.length) fail('--taken-out names no small fix of the brief: '+unknown.join(', '));
        const plan=select(state.base,state.brief);
        save(s=>{
            const prior=s.evidence.review, table={...(prior?.table||{}),...lines};
            // The builder and the reader of a generated table were once reviewed on pieces: two rounds and three builds later
            // the whole table failed its own reader. The first review therefore waits for CI on the built table.
            const gaps=!prior && plan.table ? ciGaps(plan,s.evidence,head).reasons : [];
            if (gaps.length) fail('This task changes a generated table, its generator or its fingerprint: its first review is recorded only after CI passed on HEAD, so the real reader has run over the whole built table (record-ci). '+gaps.join(' '));
            const missing=RULES.filter(k=>!table[k]);
            if (missing.length) fail((prior?.table?'':'The first review of a brief answers every rule. ')+'Review table has no answer for: '+missing.join(', '));
            const standing=RULES.filter(k=>table[k].verdict==='violation');
            if (result==='pass' && standing.length) fail('A pass with a standing violation ('+standing.join(', ')+'): fix it, or answer it "left" with its lc issue.');
            if (result==='blocked' && !standing.length) fail('A blocked review names the rule each blocker breaks: at least one violation line.');
            const round=(prior?.round||0)+1;
            s.evidence.review={head,result,evidence,round,table,takenOut:[...new Set([...(prior?.takenOut||[]),...takenOut])],selectionAcknowledged:flag('--selection-ack'),at:now()};
            // Every round is kept as it was given; a new brief or a rebase clears the evidence, not this history.
            (s.reviews ||= []).push({head,result,evidence,lines,takenOut,at:now()});
            if (result==='blocked' && round>=2) console.log('Two review rounds blocked: the task stops for a coordinator decision.');
        });
        return;
    }
    if (command === 'record-ci') {
        const id=opt('--run');
        if (!/^\d+$/.test(id||'')) fail('record-ci requires numeric --run <id>');
        const ci=JSON.parse(run('gh',['run','view',id,'-R','posukhoff/L2Solo','--json','headSha,headBranch,status,conclusion,url,workflowName,jobs']));
        const listSha=ci.headSha;
        // A long Picked tests list runs on a throwaway child commit that adds only ci-tests.txt (testing.md): it tests HEAD.
        if (ci.headSha!==head && ci.workflowName==='Picked tests') {
            try {
                git('fetch','-q','fork',ci.headSha);
                if (git('rev-list','--parents','-n','1',ci.headSha).split(/\s+/).length===2 && sameChange(git('rev-parse',ci.headSha+'^'),head) && git('diff','--name-only',head,ci.headSha)==='ci-tests.txt') ci.headSha=head;
            } catch { /* not a list commit of HEAD: refused below */ }
        }
        // A run on another commit with HEAD's tree (the folded commit the branch holds) tested this change.
        if (ci.headSha!==head) { try { git('cat-file','-e',ci.headSha+'^{commit}'); } catch { try { git('fetch','-q','fork',ci.headSha); } catch { /* unknown commit: refused below */ } } }
        if (!sameChange(ci.headSha,head) || ci.status!=='completed' || ci.conclusion!=='success' || !['PR checks','Picked tests'].includes(ci.workflowName)) fail('CI must be successful, completed, expected workflow and exact task SHA (or a commit with the same tree).');
        // A green run proves only what it ran. PR checks: all 12 shards (GitHub sometimes creates fewer jobs).
        // Picked tests: the files it ran (its branch tests/<sha>/<a,b> or the list commit's ci-tests.txt) cover the selection.
        const plan=select(state.base,state.brief);
        let covered, rawProven=null;
        if (ci.workflowName==='PR checks') {
            const shards=new Set((ci.jobs||[]).filter(j => /^Node tests \((?:[1-9]|1[0-2])\/12\)$/.test(j.name) && j.conclusion==='success').map(j=>j.name));
            if (shards.size!==12) fail(`PR checks ran ${shards.size} of 12 distinct test shards successfully.`);
            covered=plan.normal; // PR checks excludes mandatory raw-geodata files; never call this "all".
        } else {
            const fromBranch=String(ci.headBranch||'').split('/').slice(2).join('/');
            const text=fromBranch || run('git',['show',listSha+':ci-tests.txt']).replace(/#.*$/gm,'');
            const names=text.split(/[\s,]+/).filter(Boolean);
            const ran=new Set(names.map(norm)), rawAsked=new Set(names.filter(x=>x.startsWith('+')).map(norm));
            if (!String(ci.headBranch).startsWith('tests/') || !ran.size) fail('Invalid Picked tests ref/list.');
            const runner=path.join(root,'scripts/run-tests.js');
            const listed=run(process.execPath,[runner,'--only='+names.join(','),'--list']).split('\n').filter(Boolean);
            const actual=listed.map(norm);
            if (rawAsked.size) {
                // The runner keeps the + of a raw-map file (its CI plan hands it on); a runner without it lost the mode.
                const kept=new Set(listed.filter(x=>x.startsWith('+')).map(norm));
                const lost=[...rawAsked].filter(t=>!kept.has(t));
                if (lost.length) fail('Runner at HEAD does not keep the raw-map mark for: '+lost.join(', '));
                // A raw-map receipt per shard (artifact raw-geodata-<n>): the file ran with the map present and passed.
                const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'l2-raw-'));
                try {
                    run('gh',['run','download',id,'-R','posukhoff/L2Solo','-p','raw-geodata-*','-D',dir]);
                    const receipts=[];
                    const walk=d=>{for(const f of fs.readdirSync(d)){const p=path.join(d,f);if(fs.statSync(p).isDirectory())walk(p);else if(f.endsWith('.json'))receipts.push(JSON.parse(fs.readFileSync(p,'utf8')));}};
                    walk(dir);
                    const proven=new Set();
                    for (const r of receipts) {
                        // The receipt must name the commit the run tested (GITHUB_SHA): none or another is no evidence.
                        if (r.sha!==listSha) fail('Raw-map receipt names '+(r.sha?'another commit: '+r.sha:'no commit')+'; expected '+listSha+'.');
                        for (const f of r.files||[]) if (f.status==='passed' && f.skipRaw==='0' && f.geodataFiles>0) proven.add(norm(f.test));
                    }
                    const missing=[...rawAsked].filter(t=>!proven.has(t));
                    if (missing.length) fail('No raw-map receipt (map present, passed) for: '+missing.join(', '));
                    rawProven=rawAsked;
                } finally { fs.rmSync(dir,{recursive:true,force:true}); }
            }
            const count=Math.min(12,Math.ceil(actual.length/8));
            const jobs=ci.jobs||[];
            if (!jobs.some(j=>j.name==='Plan' && j.conclusion==='success')) fail('Picked tests missing successful Plan job.');
            const passed=new Set(jobs.filter(j=>j.conclusion==='success').map(j=>j.name));
            for(let i=1;i<=count;i++) if(!passed.has('Tests ('+i+'/'+count+')')) fail('Picked tests missing successful shard '+i+'/'+count);
            covered=actual.sort();
        }
        save(s=>{
            const ev=s.evidence;
            if (rawProven) { ev.rawGeodata=(ev.rawGeodata||[]).filter(r=>sameChange(r.head,head)&&!rawProven.has(r.test)); for (const t of rawProven) ev.rawGeodata.push({head,test:t,source:'ci',run:id,at:now()}); }
            ev.ciRuns=(ev.ciRuns||[]).filter(r=>sameChange(r.head,head) && r.id!==id);
            ev.ciRuns.push({head,id,runSha:listSha,url:ci.url,workflow:ci.workflowName,tests:covered,at:now()});
        }); return;
    }
    if (command === 'ready') {
        const plan=select(state.base,state.brief), e=state.evidence;
        const reasons=[];
        if (plan.critical && state.risk!=='critical') reasons.push('Critical surface requires escalation.');
        if (!sameChange(e.review?.head,head) || e.review.result!=='pass') reasons.push('No passing scoped review for HEAD.');
        const table=e.review?.table||{};
        if (sameChange(e.review?.head,head) && RULES.some(k=>!table[k] || table[k].verdict==='violation')) reasons.push('Review table: an unanswered rule or a standing violation.');
        reasons.push(...smallFixProblems(state.base,state.brief,e.review?.takenOut));
        const {full,missing,missingRaw,reasons:ciReasons}=ciGaps(plan,e,head);
        reasons.push(...ciReasons);
        if (plan.warnings.length && !e.review?.selectionAcknowledged) reasons.push('Uncertain selection needs explicit review --selection-ack.');
        if (!sameChange(e.rules?.head,head)) reasons.push('Mechanical rules-check missing for HEAD (verify --check).');
        else if (!e.rules.check && !full) reasons.push('Syntax and table check missing for HEAD: verify --check (Picked tests do not run it; a full PR checks run on HEAD does).');
        if (state.kind==='fix') {
            const proven=new Set((e.regressions||[]).filter(r=>sameChange(r.head,head) && r.old===state.base).map(r=>r.test));
            const missingRegression=state.brief.regressions.map(norm).filter(t=>!proven.has(t));
            if(missingRegression.length) reasons.push('Missing old-code failure/new-code pass evidence: '+missingRegression.join(', '));
        }
        if (!reasons.length) save(s=>{s.evidence.ready={head,at:now(),policy:state.policy};},true);
        else if(e.ready) save(s=>{delete s.evidence.ready;},true);
        // What the review let stand, for lc land to check against its issues and decisions.
        const left=RULES.filter(k=>table[k]?.verdict==='left').map(k=>({rule:k,ids:table[k].ids,decision:table[k].decision}));
        console.log(JSON.stringify({head,taskReady:!reasons.length,reasons,left,map:state.brief.map,ci:{full,missing,missingRaw,rules:sameChange(e.rules?.head,head)},selectionWarnings:plan.warnings,releaseGate:'Full CI on integration head and existing release gates still required.'},null,2));
        retroCheck();
        if (reasons.length) process.exitCode=1; return;
    }
    fail('Unknown command: '+command);
}
try { main(); } catch(e) { console.error(e.stderr?.toString().trim() || e.message); process.exitCode=1; }
