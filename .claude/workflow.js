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
const digest = () => {
    const h = crypto.createHash('sha256');
    for (const file of ['CLAUDE.md', '.claude/workflow.js','planning/tests-for.js','planning/rules-check.js','planning/hygiene.js','.claude/prune-branches.sh', ...fs.readdirSync(path.join(home,'.claude/workflow')).filter(x => x.endsWith('.md')).sort().map(x => '.claude/workflow/' + x)]) {
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
    if (!b || b.base !== state.base || !nonempty(b.symptom) || !strings(b.evidence)) fail('Brief needs exact base, symptom/goal and evidence refs.');
    if (state.kind === 'fix' && b.cause?.status === 'guess' && nonempty(b.cause.explanation)) return;
    if (!nonempty(b.owner) || !strings(b.scope) ||
        !strings(b.acceptance) || !strings(b.evidence) || !strings(b.tests) || !Array.isArray(b.nonGoals) ||
        !b.nonGoals.every(nonempty)) fail('Brief needs exact base, symptom/goal, owner, scope, acceptance, evidence refs, tests and nonGoals.');
    if (state.kind === 'fix' && (!b.cause || !['guess','verified'].includes(b.cause.status) ||
        !nonempty(b.cause.explanation))) fail('Fix brief requires cause {status: guess|verified, explanation}.');
    if (state.kind === 'fix' && b.cause.status === 'verified' && (!strings(b.cause.evidence) || !strings(b.regressions) || !b.regressions.every(t=>b.tests.map(norm).includes(norm(t))))) fail('Verified cause needs evidence handles and regression tests listed in tests.');
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
    const critical = files.some(x => /(^database\/|^data\/Bots\/|^src\/Database\.js$|Situations\.js$|worker|migration|TableFingerprint|scripts\/generate|scripts\/perf)/i.test(x));
    if (critical) warnings.push('Critical surface: require critical route and integration/release gates.');
    return { files, tests: [...selected].sort(), normal: [...normal].sort(),
        geodataOnly: [...selected].filter(t=>!normal.has(t)).sort(),
        optionalGeodata: [...selected].filter(t=>normal.has(t)&&geo.has(t)).sort(),
        domains: domains.map(x=>x[2]), warnings, critical,
        preferredCI: selected.size>96 || warnings.length ? 'PR checks + uncovered Picked tests' : 'Picked tests or PR checks' };
}
function main() {
    if (!command || !slug || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) fail('Usage: workflow.js <start|status|record-brief|verify|record-regression|record-review|record-ci|ready|record-land|record-rebase|close> <slug> [options]');
    if (!fs.existsSync(path.join(root,'package.json')) || !fs.existsSync(path.join(root,'src'))) fail('Use a real L2Solo game checkout, not the workflow snapshot.');
    const stateDir = path.join(git('rev-parse','--path-format=absolute','--git-common-dir'),'l2solo-workflow');
    fs.mkdirSync(stateDir,{recursive:true});
    const file = path.join(stateDir,slug+'.json');
    const save = state => { if (!['ready','record-land'].includes(command)) delete state.evidence.ready; const tmp=file+'.'+process.pid+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(state,null,2)+'\n',{flag:'wx'}); fs.renameSync(tmp,file); };
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
    const state=JSON.parse(fs.readFileSync(file,'utf8'));
    if (command === 'status') { console.log(JSON.stringify({...state,policyCurrent:state.policy===digest(),head:sha()},null,2)); return; }
    if (state.closed) fail('Task closed: '+state.closed.reason+'; use a new slug for new evidence.');
    // Closing a refuted guess adds no evidence to build on, so a record started under an older
    // policy can still be closed (its policy is noted, not re-pinned).
    if (command === 'close') {
        if (!flag('--refuted') || state.kind!=='fix' || state.brief?.cause?.status!=='guess' || !opt('--evidence')) fail('close requires a guess fix, --refuted and --evidence <reference>.');
        state.closed={reason:'refuted',evidence:opt('--evidence'),policyCurrent:state.policy===digest(),at:now()};
        save(state); console.log(JSON.stringify(state.closed)); return;
    }
    if (state.policy!==digest()) fail('Policy digest changed; coordinator must re-evaluate and create a fresh task record.');
    if (command === 'record-brief') {
        const p=opt('--file');
        if (!p) fail('record-brief requires --file <brief.json>');
        const brief=JSON.parse(fs.readFileSync(path.resolve(p),'utf8'));
        validateBrief(brief,state);
        state.brief=brief; state.evidence={}; save(state);
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
        // The same change moved onto another base (a restack or reorder): the review judged this
        // diff, so it carries; old-code evidence carries only when the base did not change the task's
        // files. SHA receipts (CI, rules, checks, ready) never carry.
        const pid=patchId(state.base,oldHead);
        if(pid && pid===patchId(newBase,newHead)) {
            try { git('merge-base','--is-ancestor',newBase,newHead); } catch { fail('New head does not contain the new base.'); }
            const paths=files(state.base,oldHead);
            const sameOldCode=!git('diff','--name-only',state.base,newBase,'--',...paths);
            const previous={base:state.base,head:oldHead,brief:state.brief,evidence:state.evidence,at:now()};
            const carried={};
            if(state.evidence.review?.head===oldHead) carried.review={...state.evidence.review,head:newHead,carriedFrom:oldHead,patchId:pid};
            if(sameOldCode) carried.regressions=(state.evidence.regressions||[]).filter(r=>r.head===oldHead&&r.old===state.base).map(r=>({...r,head:newHead,old:newBase,carriedFrom:oldHead}));
            const brief={...state.brief,base:newBase,evidence:[...state.brief.evidence,'Restack (same patch '+pid.slice(0,12)+'): '+reason]};
            state.base=newBase;state.brief=brief;validateBrief(brief,state);
            (state.rebases ||= []).push({previous,newBase,newHead,reason,patchId:pid,sameOldCode,at:now()});
            state.evidence=carried;save(state);
            console.log(JSON.stringify({base:newBase,head:newHead,samePatch:true,carried:Object.keys(carried),oldCodeEvidence:sameOldCode?'carried':'re-run (the base changed the task files)',note:'Run CI and rules on the new head.'},null,2));return;
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
        state.base=newBase;state.brief=brief;validateBrief(brief,state);
        (state.rebases ||= []).push({previous,newBase,newHead,reason,at:now()});
        state.evidence={};save(state);
        console.log(JSON.stringify({base:newBase,head:newHead,priorEvidenceArchived:true,ready:false,note:'Re-run tests, rules, regression and review against new base/head.'},null,2));return;
    }
    // A squash lands on the integration branch, whose history need not hold the task base (a
    // review-fix task on a topic branch): the receipt is the reviewed tree, not the ancestry.
    if (command === 'record-land') {
        const ref=opt('--ref');
        if (!ref || ref.startsWith('-')) fail('record-land requires --ref <integration ref> (fetch it first: the landing is what the integration branch holds).');
        const receipt=state.evidence.ready;
        if (!receipt || !receipt.head) fail('No ready receipt; run ready on the reviewed task checkout first.');
        const head=git('rev-parse','--verify',ref+'^{commit}');
        if (git('rev-parse',head+'^{tree}')!==git('rev-parse',receipt.head+'^{tree}')) fail('The integration ref '+ref+' ('+head.slice(0,9)+') does not hold the verified tree; push or fetch first, do not transfer evidence.');
        state.evidence.landed={ref,head,reviewedHead:receipt.head,tree:git('rev-parse',head+'^{tree}'),at:now()};
        save(state); console.log(JSON.stringify(state.evidence.landed,null,2)); return;
    }
    clean();
    try { git('merge-base','--is-ancestor',state.base,'HEAD'); } catch { fail('Task base is not an ancestor of HEAD.'); }
    const head=sha();
    if (head===state.base) fail('No committed task changes yet.');
    if (command === 'record-regression') {
        const test=opt('--test'), old=opt('--old'), evidence=opt('--evidence');
        if (!test || !old || !evidence || !state.brief.regressions?.map(norm).includes(norm(test))) fail('record-regression requires a brief test, --old <base SHA>, --evidence <old expected failure and new pass reference>.');
        if (old!==state.base) fail('Old-code evidence must identify the task base SHA.');
        state.evidence.regressions=(state.evidence.regressions||[]).filter(r=>r.head===head && r.test!==norm(test));
        state.evidence.regressions.push({head,old,test:norm(test),evidence,at:now()}); save(state); return;
    }
    if (command === 'verify') {
        if(flag('--dev')||flag('--dev-local')){
            const dev=devPlan(state.base,state.brief);
            console.log(JSON.stringify({base:state.base,head,...dev},null,2));
            if(flag('--dev-local')){
                if(!dev.local.length||dev.local.length>8) fail('Dev-local needs 1-8 non-geodata tests; use Picked CI.');
                console.log(run(process.execPath,[path.join(root,'scripts/run-tests.js'),'--only='+dev.local.join(','),'--keep-going']));
                state.evidence.local={head,at:now(),tests:dev.local};save(state);
            }
            return;
        }
        const plan=select(state.base,state.brief);
        const {normal,tests,...details}=plan;
        const pickedAfterFull=[...plan.geodataOnly,...plan.optionalGeodata.map(t=>'+'+t)];
        console.log(JSON.stringify({base:state.base,head,risk:state.risk,...details,normalCount:normal.length,testCount:tests.length,pickedAfterFull,
            listCommitRecommended:Buffer.byteLength('tests/'+head+'/'+pickedAfterFull.join(','))>240,...(flag('--show-tests')?{tests}:{})},null,2));
        if (plan.critical && state.risk!=='critical') fail('Escalate to critical route before verification.');
        if (flag('--raw-geodata')) {
            const test=norm(opt('--test')||'');
            if(!plan.optionalGeodata.includes(test)) fail('Choose one selected optional-geodata test with --test.');
            // Explicit local command; caller must provide raw map and avoid concurrent perf/trace.
            console.log(run(process.execPath,[path.join(root,'scripts/run-tests.js'),'--geodata','--only='+test,'--keep-going']));
            state.evidence.rawGeodata=(state.evidence.rawGeodata||[]).filter(r=>r.head===head&&r.test!==test);
            state.evidence.rawGeodata.push({head,test,at:now()}); save(state); return;
        }
        if (flag('--rules')) {
            console.log(run(process.execPath,[path.join(home,'planning/rules-check.js'),state.base+'..HEAD','--root',root]));
            state.evidence.rules={head,at:now()}; save(state); return;
        }
        if (flag('--check')) {
            // The gates Picked tests does not run: syntax, table freshness, the mechanical rules.
            console.log(run('npm',['run','check']));
            console.log(run(process.execPath,[path.join(home,'planning/rules-check.js'),state.base+'..HEAD','--root',root]));
            state.evidence.check={head,at:now()}; state.evidence.rules={head,at:now()}; save(state); return;
        }
        if (!flag('--local')) return;
        if (plan.warnings.length || plan.tests.length>8) fail('Selection needs coordinator/CI; no broad local test run.');
        const only=plan.tests.join(',');
        const runner=path.join(root,'scripts/run-tests.js');
        const needs=run(process.execPath,[runner,'--only='+only,'--needs-geodata']);
        if (needs!=='false') fail('Geodata or unknown test requirements; use CI.');
        console.log(run('npm',['run','check']));
        console.log(run(process.execPath,[path.join(home,'planning/rules-check.js'),state.base+'..HEAD','--root',root]));
        console.log(run(process.execPath,[runner,'--only='+only,'--keep-going']));
        state.evidence.local={head,at:now(),tests:plan.tests}; state.evidence.check={head,at:now()}; state.evidence.rules={head,at:now()}; save(state); return;
    }
    if (command === 'record-review') {
        const result=opt('--result'), evidence=opt('--evidence');
        if (!['pass','blocked'].includes(result) || !evidence) fail('record-review requires --result pass|blocked --evidence <reference>');
        state.evidence.review={head,result,evidence,selectionAcknowledged:flag('--selection-ack'),at:now()}; save(state); return;
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
                if (git('rev-list','--parents','-n','1',ci.headSha).split(/\s+/).length===2 && git('rev-parse',ci.headSha+'^')===head && git('diff','--name-only',head,ci.headSha)==='ci-tests.txt') ci.headSha=head;
            } catch { /* not a list commit of HEAD: refused below */ }
        }
        if (ci.headSha!==head || ci.status!=='completed' || ci.conclusion!=='success' || !['PR checks','Picked tests'].includes(ci.workflowName)) fail('CI must be successful, completed, expected workflow and exact task SHA.');
        // A green run proves only what it ran. PR checks: all 12 shards (GitHub sometimes creates fewer jobs).
        // Picked tests: the files it ran (its branch tests/<sha>/<a,b> or the list commit's ci-tests.txt) cover the selection.
        const plan=select(state.base,state.brief);
        let covered;
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
                    state.evidence.rawGeodata=(state.evidence.rawGeodata||[]).filter(r=>r.head===head&&!rawAsked.has(r.test));
                    for (const t of rawAsked) state.evidence.rawGeodata.push({head,test:t,source:'ci',run:id,at:now()});
                } finally { fs.rmSync(dir,{recursive:true,force:true}); }
            }
            const count=Math.min(12,Math.ceil(actual.length/8));
            const jobs=ci.jobs||[];
            if (!jobs.some(j=>j.name==='Plan' && j.conclusion==='success')) fail('Picked tests missing successful Plan job.');
            const passed=new Set(jobs.filter(j=>j.conclusion==='success').map(j=>j.name));
            for(let i=1;i<=count;i++) if(!passed.has('Tests ('+i+'/'+count+')')) fail('Picked tests missing successful shard '+i+'/'+count);
            covered=actual.sort();
        }
        state.evidence.ciRuns=(state.evidence.ciRuns||[]).filter(r=>r.head===head && r.id!==id);
        state.evidence.ciRuns.push({head,id,runSha:listSha,url:ci.url,workflow:ci.workflowName,tests:covered,at:now()});
        save(state); return;
    }
    if (command === 'ready') {
        const plan=select(state.base,state.brief), e=state.evidence;
        const reasons=[];
        if (plan.critical && state.risk!=='critical') reasons.push('Critical surface requires escalation.');
        if (e.review?.head!==head || e.review.result!=='pass') reasons.push('No passing scoped review for HEAD.');
        const runs=(e.ciRuns||[]).filter(r=>r.head===head);
        const full=runs.some(r=>r.workflow==='PR checks');
        const covered=new Set([...runs.flatMap(r=>r.tests),...(e.local?.head===head?e.local.tests:[])]);
        const missing=plan.tests.filter(t=>!covered.has(t));
        const raw=new Set((e.rawGeodata||[]).filter(r=>r.head===head).map(r=>r.test));
        const missingRaw=plan.optionalGeodata.filter(t=>!raw.has(t));
        if(missingRaw.length) reasons.push('Missing optional raw-geodata evidence: '+missingRaw.join(', '));
        if (missing.length) reasons.push('Missing '+missing.length+' selected tests: '+missing.slice(0,20).join(', ')+(missing.length>20?' ... (verify --show-tests)':''));
        if (!plan.tests.length && !full) reasons.push('Empty selection requires full CI.');
        if (plan.warnings.length && (!full || !e.review?.selectionAcknowledged)) reasons.push('Uncertain selection needs full CI and explicit review --selection-ack.');
        if (e.rules?.head!==head) reasons.push('Mechanical rules-check missing for HEAD (verify --rules).');
        if (e.check?.head!==head && !full) reasons.push('Syntax/table check missing (verify --check or PR checks).');
        if (state.risk==='critical' && !full) reasons.push('Critical task requires full PR checks on its SHA.');
        if (state.kind==='fix') {
            const proven=new Set((e.regressions||[]).filter(r=>r.head===head && r.old===state.base).map(r=>r.test));
            const missingRegression=state.brief.regressions.map(norm).filter(t=>!proven.has(t));
            if(missingRegression.length) reasons.push('Missing old-code failure/new-code pass evidence: '+missingRegression.join(', '));
        }
        if (!reasons.length) { e.ready={head,at:now(),policy:state.policy}; save(state); }
        else if(e.ready) { delete e.ready; save(state); }
        console.log(JSON.stringify({head,taskReady:!reasons.length,reasons,selectionWarnings:plan.warnings,releaseGate:'Full CI on integration head and existing release gates still required.'},null,2));
        if (reasons.length) process.exitCode=1; return;
    }
    fail('Unknown command: '+command);
}
try { main(); } catch(e) { console.error(e.stderr?.toString().trim() || e.message); process.exitCode=1; }
