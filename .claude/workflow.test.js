'use strict';
// Isolated contract tests. Fake Git, runner, gh and filesystem; no network/game writes.
const source=require('node:fs').readFileSync(__dirname+'/workflow.js','utf8').replace(/^#![^\n]*\n/,'');
const execute=new Function('require','process','__dirname','console','Buffer',source);
const store=new Map(), base='a'.repeat(40), head='b'.repeat(40), landed='c'.repeat(40), other='d'.repeat(40);
let optionalRaw=false, receiptMode='ok', runnerDropsPlus=false, receiptSha='head';
let current=head, notAncestor=false, rebasePathsMatch=true, samePatch=false, baseTouchesTask=true, pidSeq=0, remoteHead=landed, remoteFetched=true;
const pathFake={resolve:(...x)=>x.join('/').replaceAll('/./','/').replace(/\/[^/]+\/\.\./g,''),join:(...x)=>x.join('/').replace(/\/+/g,'/'),basename:x=>x.split('/').at(-1)};
const fsFake={existsSync:p=>!String(p).endsWith('.jsonl')||store.has(p),appendFileSync:(p,v)=>store.set(p,(store.get(p)||'')+v),mkdtempSync:()=>'/tmp/raw',statSync:p=>({isDirectory:()=>p==='/tmp/raw/raw-geodata-1'}),rmSync(){},readdirSync:p=>p.endsWith('/tests')?['test_basic.js','test_geodata.js']:p==='/tmp/raw'?['raw-geodata-1']:p==='/tmp/raw/raw-geodata-1'?['raw-geodata-receipt.json']:['routes.md'],readFileSync:p=>store.get(p)||'policy',mkdirSync(){},writeFileSync:(p,v)=>store.set(p,v),renameSync:(a,b)=>{store.set(b,store.get(a));store.delete(a);}};
const gh=id=>({headSha:id==='4'?other:head,headBranch:id==='2'?'tests/b/test_geodata':id==='6'?'tests/b/+test_basic':'ci-b',status:'completed',conclusion:'success',url:'https://example.invalid/run',workflowName:id==='2'||id==='6'?'Picked tests':'PR checks',jobs:id==='2'||id==='6'?[{name:'Plan',conclusion:'success'},{name:'Tests (1/1)',conclusion:'success'}]:Array.from({length:12},(_,i)=>({name:'Node tests ('+(id==='3'?1:i+1)+'/12)',conclusion:'success'}))});
const exec=(p,a)=>{
    if(p==='git'){
        if(a[0]==='status')return '';
        if(a[0]==='merge-base'){if(current===landed&&notAncestor)throw Error('not ancestor');return '';}
        if(a[0]==='rev-parse'){
            if(a.includes('--git-common-dir'))return '/git';
            if(a[1]==='--verify')return a[2].startsWith('new-parent')?other:a[2].startsWith('old-topic')?head:a[2].startsWith('int-landed')?landed:a[2].startsWith('int-other')?other:base;
            if(a[1]==='HEAD')return current;
            if(a[1].endsWith('^{tree}'))return a[1].startsWith(other)?'other-tree':'same-tree';
        }
        if(a[0]==='ls-remote')return remoteHead?remoteHead+'\trefs/heads/'+a[2].replace('refs/heads/','')+'\n'+remoteHead+'\trefs/heads/'+a[2].replace('refs/heads/','')+'-other':'';
        if(a[0]==='cat-file'){if(!remoteFetched)throw Error('missing object');return '';}
        if(a[0]==='patch-id')return samePatch?'pid-same x':'pid-'+(pidSeq++)+' x';
        if(a[0]==='diff'&&a.includes('--')&&!baseTouchesTask)return '';
        if(a[0]==='diff')return a.includes('--name-only')?(a.includes(other)&&!rebasePathsMatch?'src/other.js':'src/foo.js'):'M\tsrc/foo.js';
    }
    if(p==='gh'&&a[1]==='download'){
        const files=receiptMode==='noMap'?[{test:'tests/test_basic.js',skipRaw:'1',geodataFiles:0,status:'passed'}]:[{test:'tests/test_basic.js',skipRaw:'0',geodataFiles:142,status:'passed'}];
        const receipt={files};if(receiptSha==='head')receipt.sha=head;else if(receiptSha==='null')receipt.sha=null;else if(receiptSha==='other')receipt.sha=other;
        store.set('/tmp/raw/raw-geodata-1/raw-geodata-receipt.json',JSON.stringify(receipt));return '';
    }
    if(p==='gh')return JSON.stringify(gh(a[2]));
    if(p==='node'){
        if(a[0].endsWith('tests-for.js'))return 'test_basic.js\ntest_geodata.js';
        if(a[0].endsWith('rules-check.js'))return 'ok';
        if(a.includes('--geodata')&&a.includes('--list'))return optionalRaw?'tests/test_geodata.js\ntests/test_basic.js':'tests/test_geodata.js';
        if(a.includes('--geodata')&&a.some(x=>x.startsWith('--only=')))return 'raw pass';
        const only=a.find(x=>x.startsWith('--only='));
        if(only&&only.includes('+test_basic'))return runnerDropsPlus?'tests/test_basic.js':'+tests/test_basic.js';
        if(a.some(x=>x.startsWith('--only=')))return 'tests/test_geodata.js';
        return 'tests/test_basic.js';
    }
    if(p==='npm')return 'ok';
    throw Error('unexpected '+p+' '+a.join(' '));
};
const req=x=>x==='node:os'?{tmpdir:()=>'/tmp'}:x==='node:fs'?fsFake:x==='node:path'?pathFake:x==='node:crypto'?{createHash:()=>({update(){},digest:()=>'policy-hash'})}:x==='node:child_process'?{execFileSync:exec}:null;
function cmd(...args){
    const proc={argv:['node','workflow.js',...args],execPath:'node',pid:1,exitCode:0},logs=[];
    execute(req,proc,'/home/.claude',{log:x=>logs.push(String(x)),error:x=>logs.push(String(x))},Buffer);
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
store.set('/brief.json',JSON.stringify({base,symptom:'bad',evidence:['trace'],owner:'foo',scope:['src/foo.js'],nonGoals:[],acceptance:['fixed'],tests:['test_basic.js','test_geodata.js'],regressions:['test_basic.js'],cause:{status:'verified',explanation:'cause',chain:['shows at a.js:1','first wrong decision b.js:2'],excluded:['none plausible: single path'],evidence:['trace 1']}}));
const verifiedBrief=cause=>JSON.stringify({base,symptom:'bad',evidence:['trace'],owner:'foo',scope:['src/foo.js'],nonGoals:[],acceptance:['fixed'],tests:['test_basic.js'],regressions:['test_basic.js'],cause});
const okCause={status:'verified',explanation:'cause',chain:['shows at a.js:1','first wrong decision b.js:2'],excluded:['none plausible: single path'],evidence:['trace 1']};
store.set('/nochain.json',verifiedBrief({...okCause,chain:undefined}));
expect('verified fix without chain refused',cmd('record-brief','x','--file','/nochain.json'),1,'cause.chain');
store.set('/onechain.json',verifiedBrief({...okCause,chain:['only one']}));
expect('verified fix with a one-link chain refused',cmd('record-brief','x','--file','/onechain.json'),1,'cause.chain');
store.set('/noexcl.json',verifiedBrief({...okCause,excluded:undefined}));
expect('verified fix without excluded refused',cmd('record-brief','x','--file','/noexcl.json'),1,'cause.excluded');
store.set('/okcause.json',verifiedBrief(okCause));
expect('verified fix with chain and excluded accepted',cmd('record-brief','x','--file','/okcause.json'),0,'true');
expect('verified',cmd('record-brief','x','--file','/brief.json'),0,'true');
expect('chore start',cmd('start','chore1','--base','main','--risk','fast','--kind','chore'),0,'policy-hash');
store.set('/chore.json',JSON.stringify({base,symptom:'tidy',evidence:['note'],owner:'foo',scope:['src/foo.js'],nonGoals:[],acceptance:['done'],tests:['test_basic.js']}));
expect('chore brief needs no chain',cmd('record-brief','chore1','--file','/chore.json'),0,'true');

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
const land=()=>cmd('record-land','x','--remote','fork','--branch','batch');
expect('landing names the remote branch',cmd('record-land','x'),1,'requires --remote');
remoteHead='';expect('a missing remote branch is refused',land(),1,'has no branch');
remoteHead=other;expect('a remote holding another tree is refused (a stale local ref cannot pass)',land(),1,'does not hold the verified tree');
remoteHead=landed;remoteFetched=false;expect('an unfetched remote head is refused',land(),1,'is not fetched');remoteFetched=true;
notAncestor=true;expect('same tree receipt on a squash outside the base history',land(),0,'reviewedHead');notAncestor=false;
{const l=JSON.parse(store.get('/git/l2solo-workflow/x.json')).evidence.landed;if(l.head!==landed||l.remote!=='fork'||l.branch!=='batch')throw Error('landing must record the remote head');}
console.log('PASS landing records the remote branch head');
current=head;expect('blocked review invalidates ready',cmd('record-review','x','--result','blocked','--evidence','new blocker'),0,'');
expect('no stale landing',land(),1,'No ready receipt');

current=head;optionalRaw=true;
expect('optional raw map not covered by ordinary CI',cmd('ready','x'),1,'Missing optional raw-geodata evidence');
expect('explicit raw map test',cmd('verify','x','--raw-geodata','--test','test_basic.js'),0,'raw pass');
expect('raw map evidence recorded',cmd('status','x'),0,'"rawGeodata"');
expect('refuted start',cmd('start','refuted','--base','main','--risk','standard'),0,'policy-hash');
store.set('/guess.json',JSON.stringify({base,symptom:'bad',evidence:['trace'],cause:{status:'guess',explanation:'hypothesis'}}));
expect('refuted guess',cmd('record-brief','refuted','--file','/guess.json'),0,'false');
expect('refuted close',cmd('close','refuted','--refuted','--evidence','proof'),0,'refuted');
expect('closed blocks verification',cmd('verify','refuted'),1,'Task closed');
expect('closed blocks rewrite',cmd('record-brief','refuted','--file','/guess.json'),1,'Task closed');
expect('stale start',cmd('start','stale','--base','main','--risk','standard'),0,'policy-hash');
expect('stale guess',cmd('record-brief','stale','--file','/guess.json'),0,'false');
store.set('/home/.claude/../.claude/workflow/routes.md','changed policy');
{const st=JSON.parse(store.get('/git/l2solo-workflow/stale.json'));st.policy='older-policy';store.set('/git/l2solo-workflow/stale.json',JSON.stringify(st));}
expect('a refuted guess under an older policy can still be closed',cmd('close','stale','--refuted','--evidence','proof'),0,'"policyCurrent":false');

// Raw-map CI: a Picked +name run counts only with a receipt of a map-present pass, through a runner that kept the mark.
current=head;optionalRaw=true;
expect('raw ci start',cmd('start','rawci','--base','main','--risk','standard'),0,'policy-hash');
store.set('/brief.json',JSON.stringify({base,symptom:'bad',evidence:['trace'],owner:'foo',scope:['src/foo.js'],nonGoals:[],acceptance:['fixed'],tests:['test_basic.js'],regressions:['test_basic.js'],cause:{status:'verified',explanation:'cause',chain:['shows at a.js:1','first wrong decision b.js:2'],excluded:['none plausible: single path'],evidence:['trace 1']}}));
expect('raw ci brief',cmd('record-brief','rawci','--file','/brief.json'),0,'true');
receiptMode='noMap';expect('a green run without the map is no raw evidence',cmd('record-ci','rawci','--run','6'),1,'No raw-map receipt');
receiptMode='ok';runnerDropsPlus=true;expect('a runner that drops the mark is refused',cmd('record-ci','rawci','--run','6'),1,'does not keep the raw-map mark');
runnerDropsPlus=false;
receiptSha='missing';expect('a receipt without a commit is refused',cmd('record-ci','rawci','--run','6'),1,'names no commit');
receiptSha='null';expect('a receipt with a null commit is refused',cmd('record-ci','rawci','--run','6'),1,'names no commit');
receiptSha='other';expect('a receipt of another commit is refused',cmd('record-ci','rawci','--run','6'),1,'another commit');
receiptSha='head';expect('raw map receipt recorded',cmd('record-ci','rawci','--run','6'),0,'');
expect('raw ci evidence in status',cmd('status','rawci'),0,'"source": "ci"');

current=head;optionalRaw=false;
expect('dev feedback only',cmd('verify','rawci','--dev'),0,'Development feedback only');
expect('dev-local runs non-map tests',cmd('verify','rawci','--dev-local'),0,'test_basic.js');
expect('integration plan retains map tests',cmd('verify','rawci'),0,'pickedAfterFull');
current=landed;
expect('rebase needs explicit recheck',cmd('record-rebase','rawci','--base','new-parent','--from-head','old-topic'),1,'requires');
rebasePathsMatch=false;
expect('rebase changed task scope refused',cmd('record-rebase','rawci','--base','new-parent','--from-head','old-topic','--evidence','checked owner and cause'),1,'Task paths changed');
rebasePathsMatch=true;
expect('rebase records new base',cmd('record-rebase','rawci','--base','new-parent','--from-head','old-topic','--evidence','checked owner and cause'),0,'"priorEvidenceArchived": true');
const rebased=JSON.parse(store.get('/git/l2solo-workflow/rawci.json'));
if(rebased.base!==other||rebased.brief.base!==other||Object.keys(rebased.evidence).length||!rebased.rebases[0].previous.evidence.rawGeodata)throw Error('rebase did not archive and clear evidence');
console.log('PASS rebase clears old SHA evidence and retains history');
expect('rebased task not ready without fresh proof',cmd('ready','rawci'),1,'No passing scoped review');

// A restack of the same change (equal patch-id) carries the review; old-code evidence carries only
// when the new base left the task's files unchanged; SHA receipts never carry.
current=head;samePatch=false;baseTouchesTask=true;
expect('move start',cmd('start','mv','--base','main','--risk','standard'),0,'policy-hash');
expect('move brief',cmd('record-brief','mv','--file','/brief.json'),0,'true');
expect('move review',cmd('record-review','mv','--result','pass','--evidence','r1'),0,'');
expect('move regression',cmd('record-regression','mv','--test','test_basic.js','--old',base,'--evidence','old fail'),0,'');
current=landed;samePatch=true;
expect('same patch on a base that changed the task files',cmd('record-rebase','mv','--base','new-parent','--from-head','old-topic','--evidence','restack'),0,'"baseChangedTaskFiles"');
{const st=JSON.parse(store.get('/git/l2solo-workflow/mv.json'));
 if(Object.keys(st.evidence).length)throw Error('nothing may carry when the base changed the task files: '+Object.keys(st.evidence));
 if(!st.rebases.at(-1).touched.length)throw Error('the changed task files must be named');}
console.log('PASS a base that changed the task files carries no review, old-code evidence or CI');
expect('that task needs a new review',cmd('ready','mv'),1,'No passing scoped review');
current=head;samePatch=false;
expect('move2 start',cmd('start','mv2','--base','main','--risk','standard'),0,'policy-hash');
expect('move2 brief',cmd('record-brief','mv2','--file','/brief.json'),0,'true');
expect('move2 review',cmd('record-review','mv2','--result','pass','--evidence','r1'),0,'');
expect('move2 regression',cmd('record-regression','mv2','--test','test_basic.js','--old',base,'--evidence','old fail'),0,'');
current=landed;samePatch=true;baseTouchesTask=false;
expect('untouched task files carry review and old-code evidence',cmd('record-rebase','mv2','--base','new-parent','--from-head','old-topic','--evidence','restack'),0,'"baseChangedTaskFiles": []');
{const st=JSON.parse(store.get('/git/l2solo-workflow/mv2.json'));
 if(st.evidence.review?.head!==landed||st.evidence.review.carriedFrom!==head)throw Error('review not carried to the new head');
 if(st.evidence.regressions?.[0]?.old!==other||st.evidence.regressions[0].head!==landed)throw Error('regression not carried to the new base/head');
 if(st.evidence.ciRuns||st.evidence.rules)throw Error('SHA receipts must not carry');}
console.log('PASS same patch on an unchanged context carries review and old-code evidence, never SHA receipts');
expect('carried task still needs CI and rules',cmd('ready','mv2'),1,'Mechanical rules-check missing');
samePatch=false;baseTouchesTask=true;

// Retro candidates: due on a critical violation, one cause twice, or five open; processing clears.
const notDue=(label,r)=>{if(r.code!==0||r.log.includes('RETRO DUE'))throw Error(label+' failed '+JSON.stringify(r));console.log('PASS '+label);};
const retro=(...a)=>cmd('record-retro','rt',...a);
notDue('one candidate is not due',retro('--cause','Run without cause analysis','--text','rerun for statistics | guard: cause first'));
expect('a candidate needs a cause and text',retro('--cause','x'),1,'requires --cause');
expect('the same cause twice is due',retro('--cause','run without cause-analysis!','--text','again'),0,'RETRO DUE: cause run-without-cause-analysis seen 2 times');
expect('processing needs a saved result',retro('--processed','all'),1,'--result');
notDue('processed candidates clear the trigger',retro('--processed','all','--result','tmp/retro-1.md'));
for(const c of ['a','b','c'])notDue('distinct cause '+c+' is not due',retro('--cause',c,'--text','t'));
expect('a useless run needs its blocked minutes',retro('--cause','d','--text','t','--useless-run'),1,'--minutes');
notDue('four open candidates are not due',retro('--cause','d','--text','t','--useless-run','--minutes','25'));
if(!store.get('/git/l2solo-workflow/retro.jsonl').includes('"minutes":25'))throw Error('useless run minutes not kept');
expect('five open candidates are due',retro('--cause','e','--text','t'),0,'RETRO DUE: 5 open candidates');
notDue('processing by ids clears',retro('--processed','3,4,5,6,7','--result','tmp/retro-2.md'));
expect('a processed id cannot be processed again',retro('--processed','3','--result','r'),1,'open candidate ids');
expect('a critical violation is due at once',retro('--cause','f','--text','t','--critical'),0,'RETRO DUE: critical process violation #8');
expect('retro start',cmd('start','rtc','--base','main','--risk','standard'),0,'policy-hash');
expect('retro guess',cmd('record-brief','rtc','--file','/guess.json'),0,'false');
expect('close reports a due retro',cmd('close','rtc','--refuted','--evidence','proof'),0,'RETRO DUE: critical');
expect('ready reports a due retro',cmd('ready','mv2'),1,'RETRO DUE: critical');
notDue('cleared',retro('--processed','all','--result','tmp/retro-3.md'));
{const r=cmd('ready','mv2');if(r.log.includes('RETRO DUE'))throw Error('ready must be quiet when nothing is due');console.log('PASS ready is quiet when nothing is due');}
