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
const fail = msg => { throw new Error(msg); };
const digest = () => {
    const h = crypto.createHash('sha256');
    for (const file of ['CLAUDE.md', ...fs.readdirSync(path.join(home,'.claude/workflow')).filter(x => x.endsWith('.md')).sort().map(x => '.claude/workflow/' + x)]) {
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
function select(base) {
    const changes = git('diff','--name-status','--no-renames',base,'HEAD').split('\n').filter(Boolean);
    const files = changes.map(x => x.split('\t').at(-1));
    const list = fs.readdirSync(path.join(root,'tests')).filter(x => /^test_.*\.js$/.test(x));
    const raw = run(process.execPath,[path.join(home,'planning/tests-for.js'),base+'..HEAD','--root',root,'--depth','2']);
    const selected = new Set(raw.split('\n').filter(x => /^test_.*\.js$/.test(x)));
    const domains = domainPatterns.filter(([p]) => files.some(x => p.test(x)));
    for (const [,p] of domains) for (const name of list) if (p.test(name)) selected.add(name);
    const warnings = [];
    if (changes.some(x => /^D\t/.test(x))) warnings.push('Deleted file: inspect former callers and tests.');
    if (files.some(x => !x.endsWith('.js'))) warnings.push('Non-JS data/config change: add relevant tests explicitly.');
    if (!selected.size) warnings.push('No selected tests: explain why or provide additional tests.');
    const critical = files.some(x => /(^database\/|^data\/Bots\/|^src\/Database\.js$|Situations\.js$|worker|migration|TableFingerprint|scripts\/generate|scripts\/perf)/i.test(x));
    if (critical) warnings.push('Critical surface: require critical route and integration/release gates.');
    return { files, tests: [...selected].sort(), domains: domains.map(x=>x[2]), warnings, critical };
}
function main() {
    if (!command || !slug || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) fail('Usage: workflow.js <start|status|verify|record-review|record-ci|ready> <slug> [options]');
    if (!fs.existsSync(path.join(root,'package.json')) || !fs.existsSync(path.join(root,'src'))) fail('Use a real L2Solo game checkout, not the workflow snapshot.');
    const stateDir = path.join(git('rev-parse','--path-format=absolute','--git-common-dir'),'l2solo-workflow');
    fs.mkdirSync(stateDir,{recursive:true});
    const file = path.join(stateDir,slug+'.json');
    const save = state => { const tmp=file+'.'+process.pid+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(state,null,2)+'\n',{flag:'wx'}); fs.renameSync(tmp,file); };
    if (command === 'start') {
        const risk=opt('--risk'), baseRef=opt('--base');
        if (!riskOrder.includes(risk) || !baseRef || baseRef.startsWith('-')) fail('start requires --base <ref> --risk fast|standard|critical');
        const base=git('rev-parse','--verify',baseRef+'^{commit}');
        const state={slug,base,risk,policy:digest(),created:now(),evidence:{}};
        fs.writeFileSync(file,JSON.stringify(state,null,2)+'\n',{flag:'wx'});
        console.log(JSON.stringify(state,null,2)); return;
    }
    const state=JSON.parse(fs.readFileSync(file,'utf8'));
    if (command === 'status') { console.log(JSON.stringify({...state,policyCurrent:state.policy===digest(),head:sha()},null,2)); return; }
    if (state.policy!==digest()) fail('Policy digest changed; coordinator must re-evaluate and create a fresh task record.');
    clean();
    try { git('merge-base','--is-ancestor',state.base,'HEAD'); } catch { fail('Task base is not an ancestor of HEAD.'); }
    const head=sha();
    if (head===state.base) fail('No committed task changes yet.');
    if (command === 'verify') {
        const plan=select(state.base);
        console.log(JSON.stringify({head,risk:state.risk,...plan},null,2));
        if (plan.critical && state.risk!=='critical') fail('Escalate to critical route before verification.');
        if (!flag('--local')) return;
        if (plan.warnings.length || plan.tests.length>8) fail('Selection needs coordinator/CI; no broad local test run.');
        const only=plan.tests.join(',');
        const runner=path.join(root,'scripts/run-tests.js');
        const needs=run(process.execPath,[runner,'--only='+only,'--needs-geodata']);
        if (needs!=='false') fail('Geodata or unknown test requirements; use CI.');
        console.log(run('npm',['run','check']));
        console.log(run(process.execPath,[path.join(home,'planning/rules-check.js'),state.base+'..HEAD','--root',root]));
        console.log(run(process.execPath,[runner,'--only='+only,'--keep-going']));
        state.evidence.local={head,at:now(),tests:plan.tests}; save(state); return;
    }
    if (command === 'record-review') {
        const result=opt('--result'), evidence=opt('--evidence');
        if (!['pass','blocked'].includes(result) || !evidence) fail('record-review requires --result pass|blocked --evidence <reference>');
        state.evidence.review={head,result,evidence,at:now()}; save(state); return;
    }
    if (command === 'record-ci') {
        const id=opt('--run');
        if (!/^\d+$/.test(id||'')) fail('record-ci requires numeric --run <id>');
        const ci=JSON.parse(run('gh',['run','view',id,'-R','posukhoff/L2Solo','--json','headSha,status,conclusion,url,workflowName']));
        if (ci.headSha!==head || ci.status!=='completed' || ci.conclusion!=='success' || !['PR checks','Picked tests'].includes(ci.workflowName)) fail('CI must be successful, completed, expected workflow and exact task SHA.');
        state.evidence.ci={head,id,url:ci.url,workflow:ci.workflowName,at:now()}; save(state); return;
    }
    if (command === 'ready') {
        const plan=select(state.base), e=state.evidence;
        const reasons=[];
        if (plan.critical && state.risk!=='critical') reasons.push('Critical surface requires escalation.');
        if (e.review?.head!==head || e.review.result!=='pass') reasons.push('No passing scoped review for HEAD.');
        if (e.local?.head!==head && e.ci?.head!==head) reasons.push('No successful tests recorded for HEAD.');
        if (plan.warnings.length && e.ci?.head!==head) reasons.push('Uncertain selection needs CI and explicit coordinator review.');
        if (state.risk==='critical' && (e.ci?.head!==head || e.ci.workflow!=='PR checks')) reasons.push('Critical task requires full PR checks on its SHA.');
        console.log(JSON.stringify({head,taskReady:!reasons.length,reasons,selectionWarnings:plan.warnings,releaseGate:'Full CI on integration head and existing release gates still required.'},null,2));
        if (reasons.length) process.exitCode=1; return;
    }
    fail('Unknown command: '+command);
}
try { main(); } catch(e) { console.error(e.stderr?.toString().trim() || e.message); process.exitCode=1; }
