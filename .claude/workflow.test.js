'use strict';
// Isolated contract tests. Fake Git, runner, gh and filesystem; no network/game writes.
const source=require('node:fs').readFileSync(__dirname+'/workflow.js','utf8').replace(/^#![^\n]*\n/,'');
const execute=new Function('require','process','__dirname','console',source);
const store=new Map(), base='a'.repeat(40), head='b'.repeat(40), landed='c'.repeat(40), other='d'.repeat(40);
let current=head;
const pathFake={resolve:(...x)=>x.join('/').replaceAll('/./','/').replace(/\/[^/]+\/\.\./g,''),join:(...x)=>x.join('/').replace(/\/+/g,'/'),basename:x=>x.split('/').at(-1)};
const fsFake={existsSync:()=>true,readdirSync:p=>p.endsWith('/tests')?['test_basic.js','test_geodata.js']:['routes.md'],readFileSync:p=>store.get(p)||'policy',mkdirSync(){},writeFileSync:(p,v)=>store.set(p,v),renameSync:(a,b)=>{store.set(b,store.get(a));store.delete(a);}};
const gh=id=>({headSha:id==='4'?other:head,headBranch:id==='2'?'tests/b/test_geodata':'ci-b',status:'completed',conclusion:'success',url:'https://example.invalid/run',workflowName:id==='2'?'Picked tests':'PR checks',jobs:id==='2'?[{name:'Plan',conclusion:'success'},{name:'Tests (1/1)',conclusion:'success'}]:Array.from({length:12},(_,i)=>({name:'Node tests ('+(id==='3'?1:i+1)+'/12)',conclusion:'success'}))});
const exec=(p,a)=>{
    if(p==='git'){
        if(a[0]==='status'||a[0]==='merge-base')return '';
        if(a[0]==='rev-parse'){
            if(a.includes('--git-common-dir'))return '/git';
            if(a[1]==='--verify')return base;
            if(a[1]==='HEAD')return current;
            if(a[1].endsWith('^{tree}'))return a[1].startsWith(other)?'other-tree':'same-tree';
        }
        if(a[0]==='diff')return 'M\tsrc/foo.js';
    }
    if(p==='gh')return JSON.stringify(gh(a[2]));
    if(p==='node'){
        if(a[0].endsWith('tests-for.js'))return 'test_basic.js\ntest_geodata.js';
        if(a[0].endsWith('rules-check.js'))return 'ok';
        if(a.includes('--geodata')||a.some(x=>x.startsWith('--only=')))return 'tests/test_geodata.js';
        return 'tests/test_basic.js';
    }
    if(p==='npm')return 'ok';
    throw Error('unexpected '+p+' '+a.join(' '));
};
const req=x=>x==='node:fs'?fsFake:x==='node:path'?pathFake:x==='node:crypto'?{createHash:()=>({update(){},digest:()=>'policy-hash'})}:x==='node:child_process'?{execFileSync:exec}:null;
function cmd(...args){
    const proc={argv:['node','workflow.js',...args],execPath:'node',pid:1,exitCode:0},logs=[];
    execute(req,proc,'/home/.claude',{log:x=>logs.push(String(x)),error:x=>logs.push(String(x))});
    return {code:proc.exitCode,log:logs.join('\n')};
}
function expect(label,result,code,contains){
    if(result.code!==code||!result.log.includes(contains))throw Error(label+' failed '+JSON.stringify(result));
    console.log('PASS '+label);
}
expect('start',cmd('start','x','--base','main','--risk','standard'),0,'policy-hash');
store.set('/brief.json',JSON.stringify({base,symptom:'bad',evidence:['trace'],cause:{status:'guess',explanation:'hypothesis'}}));
expect('guess',cmd('record-brief','x','--file','/brief.json'),0,'false');
expect('guess blocks',cmd('verify','x'),1,'hypothesis');
store.set('/brief.json',JSON.stringify({base,symptom:'bad',evidence:['trace'],owner:'foo',scope:['src/foo.js'],nonGoals:[],acceptance:['fixed'],tests:['test_basic.js','test_geodata.js'],regressions:['test_basic.js'],cause:{status:'verified',explanation:'cause',evidence:['trace 1']}}));
expect('verified',cmd('record-brief','x','--file','/brief.json'),0,'true');
expect('review',cmd('record-review','x','--result','pass','--evidence','review'),0,'');
expect('duplicate shards refused',cmd('record-ci','x','--run','3'),1,'distinct');
expect('wrong SHA refused',cmd('record-ci','x','--run','4'),1,'exact task SHA');
expect('full CI',cmd('record-ci','x','--run','1'),0,'');
expect('full CI does not replace rules',cmd('ready','x'),1,'Mechanical rules-check missing');
expect('rules',cmd('verify','x','--rules'),0,'ok');
expect('regression required',cmd('ready','x'),1,'Missing old-code');
expect('regression',cmd('record-regression','x','--test','test_basic.js','--old',base,'--evidence','old fail new pass'),0,'');
expect('geodata gap',cmd('ready','x'),1,'test_geodata.js');
expect('picked CI',cmd('record-ci','x','--run','2'),0,'');
expect('ready',cmd('ready','x'),0,'"taskReady": true');
current=other;expect('different tree rejected',cmd('record-land','x'),1,'differs');
current=landed;expect('same tree receipt',cmd('record-land','x'),0,'reviewedHead');
current=head;expect('blocked review invalidates ready',cmd('record-review','x','--result','blocked','--evidence','new blocker'),0,'');
current=landed;expect('no stale landing',cmd('record-land','x'),1,'No ready receipt');
