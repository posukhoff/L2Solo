'use strict';
// Isolated contract tests. Fake Git, runner, gh and filesystem; no network/game writes.
const source=require('node:fs').readFileSync(__dirname+'/workflow.js','utf8').replace(/^#![^\n]*\n/,'');
const execute=new Function('require','process','__dirname','console','Buffer',source);
const store=new Map(), base='a'.repeat(40), head='b'.repeat(40), landed='c'.repeat(40), other='d'.repeat(40);
let optionalRaw=false, receiptMode='ok', runnerDropsPlus=false, receiptSha='head';
let changed='src/foo.js', gitLog='', treeFiles={}, onNpm=null;
let current=head, notAncestor=false, rebasePathsMatch=true, samePatch=false, baseTouchesTask=true, pidSeq=0, remoteHead=landed, remoteFetched=true;
const pathFake={resolve:(...x)=>x.join('/').replaceAll('/./','/').replace(/\/[^/]+\/\.\./g,''),join:(...x)=>x.join('/').replace(/\/+/g,'/'),basename:x=>x.split('/').at(-1)};
const fsFake={existsSync:p=>!String(p).includes('nosuch')&&(!String(p).endsWith('.jsonl')||store.has(p)),appendFileSync:(p,v)=>store.set(p,(store.get(p)||'')+v),mkdtempSync:()=>'/tmp/raw',statSync:p=>({isDirectory:()=>p==='/tmp/raw/raw-geodata-1'}),rmSync(){},readdirSync:p=>p.endsWith('/tests')?['test_basic.js','test_geodata.js']:p==='/tmp/raw'?['raw-geodata-1']:p==='/tmp/raw/raw-geodata-1'?['raw-geodata-receipt.json']:['routes.md'],readFileSync:p=>store.get(p)||'policy',mkdirSync(){},writeFileSync:(p,v)=>store.set(p,v),renameSync:(a,b)=>{store.set(b,store.get(a));store.delete(a);}};
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
        if(a[0]==='log')return gitLog;
        if(a[0]==='diff-tree')return treeFiles[a.at(-1)]||'';
        if(a[0]==='patch-id')return samePatch?'pid-same x':'pid-'+(pidSeq++)+' x';
        if(a[0]==='diff'&&a.includes('--')&&!baseTouchesTask)return '';
        if(a[0]==='diff')return a.includes('--name-only')?(a.includes(other)&&!rebasePathsMatch?'src/other.js':'src/foo.js'):'M\t'+changed;
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
    if(p==='npm'){if(onNpm)onNpm();return 'ok';}
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
const fullTable=over=>[...Array(16).keys(),'cause'].map(k=>over?.[k]||k+' ok evidence for '+k).join('\n');
store.set('/table.txt','Review of x\n'+fullTable());
store.set('/blocked.txt','3 violation src/foo.js:1 a guard at the call site');
expect('start',cmd('start','x','--base','main','--risk','standard'),0,'policy-hash');
store.set('/brief.json',JSON.stringify({base,symptom:'bad',evidence:['trace'],cause:{status:'guess',explanation:'hypothesis'}}));
expect('guess',cmd('record-brief','x','--file','/brief.json'),0,'false');
expect('guess blocks',cmd('verify','x'),1,'hypothesis');
store.set('/brief.json',JSON.stringify({base,symptom:'bad',evidence:['trace'],owner:'foo',scope:['src/foo.js'],nonGoals:[],acceptance:[{expect:'fixed',by:'test_basic.js'}],map:['none: no owner or path changes'],tests:['test_basic.js','test_geodata.js'],regressions:['test_basic.js'],cause:{status:'verified',explanation:'cause',chain:['shows at a.js:1','first wrong decision b.js:2'],excluded:['none plausible: single path'],evidence:['trace 1']}}));
const verifiedBrief=cause=>JSON.stringify({base,symptom:'bad',evidence:['trace'],owner:'foo',scope:['src/foo.js'],nonGoals:[],acceptance:[{expect:'fixed',by:'test_basic.js'}],map:['none: no owner or path changes'],tests:['test_basic.js'],regressions:['test_basic.js'],cause});
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
store.set('/chore.json',JSON.stringify({base,symptom:'tidy',evidence:['note'],owner:'foo',scope:['src/foo.js'],nonGoals:[],acceptance:[{expect:'done',by:'run: tidy-1'}],map:['combat.md: Hit core'],tests:['test_basic.js']}));
expect('chore brief needs no chain',cmd('record-brief','chore1','--file','/chore.json'),0,'true');

expect('review',cmd('record-review','x','--result','pass','--rules','/table.txt','--evidence','review'),0,'');
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
expect('ready reports the ci part lc reads',cmd('ready','x'),0,'"ci": {');
const land=()=>cmd('record-land','x','--remote','fork','--branch','batch');
expect('landing names the remote branch',cmd('record-land','x'),1,'requires --remote');
remoteHead='';expect('a missing remote branch is refused',land(),1,'has no branch');
remoteHead=other;expect('a remote holding another tree is refused (a stale local ref cannot pass)',land(),1,'does not hold the verified tree');
remoteHead=landed;remoteFetched=false;expect('an unfetched remote head is refused',land(),1,'is not fetched');remoteFetched=true;
notAncestor=true;expect('same tree receipt on a squash outside the base history',land(),0,'reviewedHead');notAncestor=false;
{const l=JSON.parse(store.get('/git/l2solo-workflow/x.json')).evidence.landed;if(l.head!==landed||l.remote!=='fork'||l.branch!=='batch')throw Error('landing must record the remote head');}
console.log('PASS landing records the remote branch head');
current=head;expect('blocked review invalidates ready',cmd('record-review','x','--result','blocked','--rules','/blocked.txt','--evidence','new blocker'),0,'');
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
store.set('/brief.json',JSON.stringify({base,symptom:'bad',evidence:['trace'],owner:'foo',scope:['src/foo.js'],nonGoals:[],acceptance:[{expect:'fixed',by:'test_basic.js'}],map:['none: no owner or path changes'],tests:['test_basic.js'],regressions:['test_basic.js'],cause:{status:'verified',explanation:'cause',chain:['shows at a.js:1','first wrong decision b.js:2'],excluded:['none plausible: single path'],evidence:['trace 1']}}));
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
if(JSON.parse(store.get('/git/l2solo-workflow/rawci.json')).evidence.local)throw Error('dev-local must record nothing');
console.log('PASS dev-local records nothing toward ready');
expect('the removed --local path says so',cmd('verify','rawci','--local'),1,'--local was removed');
expect('rawci review',cmd('record-review','rawci','--result','pass','--rules','/table.txt','--evidence','r'),0,'');
expect('rawci check and rules',cmd('verify','rawci','--check'),0,'ok');
expect('rawci regression',cmd('record-regression','rawci','--test','test_basic.js','--old',base,'--evidence','old fail new pass'),0,'');
expect('rawci picked map test',cmd('record-ci','rawci','--run','2'),0,'');
{const r=cmd('ready','rawci'),v=JSON.parse(r.log.slice(r.log.indexOf('{'),r.log.lastIndexOf('}')+1));
 if(r.code!==1||v.reasons.length!==1||!v.reasons[0].includes('Full PR checks on HEAD required')||v.ci.missing.length)throw Error('Picked tests covering the whole selection must still need full PR checks: '+r.log);}
console.log('PASS picked tests covering the whole selection are not ready without full PR checks');
expect('rawci full CI',cmd('record-ci','rawci','--run','1'),0,'');
expect('full PR checks complete it',cmd('ready','rawci'),0,'"taskReady": true');
changed='tests/test_cold_worker_routing.js';
expect('a test named after a critical surface does not escalate',cmd('verify','rawci'),0,'"critical": false');
changed='src/ColdWorker.js';
expect('a critical source file still escalates',cmd('verify','rawci'),1,'Escalate to critical');
expect('critical start',cmd('start','crit','--base','main','--risk','critical'),0,'policy-hash');
expect('critical brief',cmd('record-brief','crit','--file','/brief.json'),0,'true');
expect('a critical surface on the critical route raises no selection warning',cmd('verify','crit'),0,'"warnings": []');
changed='src/foo.js';
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
expect('move review',cmd('record-review','mv','--result','pass','--rules','/table.txt','--evidence','r1'),0,'');
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
expect('move2 review',cmd('record-review','mv2','--result','pass','--rules','/table.txt','--evidence','r1'),0,'');
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
// A corrupt retro line is skipped and reported; ready and close still work.
store.set('/git/l2solo-workflow/retro.jsonl',(store.get('/git/l2solo-workflow/retro.jsonl')||'')+'{not json\n');
expect('ready skips and reports a corrupt retro line',cmd('ready','mv2'),1,'retro.jsonl: 1 unreadable line(s) skipped');
expect('retro-check close skips and reports a corrupt line',cmd('start','rtd','--base','main','--risk','standard'),0,'policy-hash');
expect('retro-check guess',cmd('record-brief','rtd','--file','/guess.json'),0,'false');
expect('close survives a corrupt retro line',cmd('close','rtd','--refuted','--evidence','proof'),0,'unreadable line(s) skipped');

expect('close needs its reason',cmd('close','mv','--evidence','x'),1,'--refuted (a guess fix) or --abandoned');
expect('a verified task that has not landed closes as abandoned',cmd('close','mv','--abandoned','--evidence','moved to release 2 by M35'),0,'"reason":"abandoned"');
expect('an abandoned task takes no more evidence',cmd('verify','mv','--rules'),1,'Task closed: abandoned');
expect('a landed task is not abandoned',cmd('close','x','--abandoned','--evidence','no'),1,'has not landed');
// Brief: acceptance pinned to a test or a run record, map entries named, small fixes by id and file.
current=head;changed='src/foo.js';optionalRaw=false;samePatch=false;baseTouchesTask=true;
const briefWith=over=>JSON.stringify({base,symptom:'bad',evidence:['trace'],owner:'foo',scope:['src/foo.js'],nonGoals:[],acceptance:[{expect:'fixed',by:'test_basic.js'}],map:['none: no owner or path changes'],tests:['test_basic.js'],regressions:['test_basic.js'],cause:okCause,...over});
const tryBrief=(label,over,code,text)=>{store.set('/b.json',briefWith(over));expect(label,cmd('record-brief','tb','--file','/b.json'),code,text);};
expect('table start',cmd('start','tb','--base','main','--risk','standard'),0,'policy-hash');
tryBrief('acceptance as bare text refused',{acceptance:['fixed']},1,'Brief acceptance');
tryBrief('acceptance pinned by a test outside the brief refused',{acceptance:[{expect:'fixed',by:'test_other.js'}]},1,'Brief acceptance');
tryBrief('acceptance pinned by a run record accepted',{acceptance:[{expect:'seen in the release run',by:'run: perf-20261112'}]},0,'true');
tryBrief('acceptance pinned by a test with its case accepted',{acceptance:[{expect:'fixed',by:'test_basic.js: two bots at one counter'}]},0,'true');
tryBrief('a brief without map refused',{map:undefined},1,'Brief map');
tryBrief('a map entry in a file that is not in the map refused',{map:['nosuch.md: Hit core']},1,'Brief map');
tryBrief('none beside a real entry refused',{map:['none: nothing','combat.md: Hit core']},1,'Brief map');
tryBrief('a map entry accepted',{map:['combat.md: Hit core','limits.md: Turn length']},0,'true');
tryBrief('five small fixes refused',{smallFixes:[1,2,3,4,5].map(n=>({id:'DT-'+n,file:'src/a.js'}))},1,'Brief smallFixes');
tryBrief('a small fix without its file refused',{smallFixes:[{id:'DT-1'}]},1,'Brief smallFixes');
tryBrief('small fixes accepted',{smallFixes:[{id:'DT-1',file:'src/foo.js'},{id:'DT-12',file:'src/bar.js'}]},0,'true');

// Review table: 17 answers on the first round, later rounds replace lines, a violation blocks a pass, every round kept.
const review=(result,text,...more)=>{store.set('/r.txt',text);return cmd('record-review','tb','--result',result,'--rules','/r.txt','--evidence','rev',...more);};
expect('a review without its table refused',cmd('record-review','tb','--result','pass','--evidence','rev'),1,'--rules');
expect('a file with no table line refused',review('pass','all fine'),1,'No review table line');
expect('a first review missing a rule refused',review('pass',fullTable().replace(/^7 .*\n/m,'')),1,'no answer for: 7');
expect('a rule answered twice refused',review('pass',fullTable()+'\n7 ok again'),1,'answers 7 twice');
expect('an ok without evidence refused',review('pass',fullTable({5:'5 ok'})),1,'add its evidence');
expect('a violation without file:line refused',review('blocked',fullTable({3:'3 violation the guard'})),1,'name file:line');
expect('a pass with a standing violation refused',review('pass',fullTable({3:'3 violation src/foo.js:9 guard at the call site'})),1,'standing violation (3)');
expect('a blocked review without a violation refused',review('blocked',fullTable()),1,'at least one violation line');
expect('a rule left without a maintainer decision refused',review('pass',fullTable({11:'11 left DT-9 the test pins a field'})),1,'maintainer decision');
expect('a left without its reason refused',review('pass',fullTable({4:'4 left DT-9'})),1,'<lc id[,id]>');
expect('round 1 blocked',review('blocked',fullTable({3:'Rule 3: violation src/foo.js:9 guard at the call site',4:'4 left DT-9,DT-10 the cold copy stays',11:'11 left DT-11 M41 the old test stays',cause:'cause n/a a feature'}),'--taken-out','DT-12'),0,'');
expect('taking out an id the brief does not name refused',review('pass','3 ok fixed','--taken-out','DT-99'),1,'names no small fix');
expect('round 2 answers only what changed',review('pass','3 ok fixed in the owner, src/foo.js:20'),0,'');
{const st=JSON.parse(store.get('/git/l2solo-workflow/tb.json')),t=st.evidence.review.table;
 if(st.reviews.length!==2||Object.keys(st.reviews[1].lines).join()!=='3'||st.reviews[0].result!=='blocked')throw Error('every round must be kept as given');
 if(st.evidence.review.round!==2||t[3].verdict!=='ok'||t[4].ids.join()!=='DT-9,DT-10'||t[11].decision!=='M41'||t.cause.verdict!=='na'||st.evidence.review.takenOut.join()!=='DT-12')throw Error('table not merged: '+JSON.stringify(st.evidence.review));}
console.log('PASS the table merges rounds and every round is kept');
expect('a second blocked round says the task stops',review('blocked','6 violation src/foo.js:30 a scan per tick'),0,'coordinator decision');
expect('a standing violation keeps ready shut',cmd('ready','tb'),1,'No passing scoped review');
expect('round 4 pass',review('pass','6 ok sliced, src/foo.js:30'),0,'');

// Small fixes: one commit each with the id in its subject and only the named source file; a taken-out one has none.
gitLog='c1\tCount the failure (DT-1)\nc2\tUnrelated work for DT-120';treeFiles={c1:'src/foo.js\ntests/test_basic.js'};
{const r=cmd('ready','tb'),v=JSON.parse(r.log.slice(r.log.indexOf('{'),r.log.lastIndexOf('}')+1));
 if(v.reasons.some(x=>x.includes('Small fix')))throw Error('a small fix in its own commit and a taken-out one without a commit must pass: '+r.log);
 if(v.left.length!==2||v.left[0].ids.join()!=='DT-9,DT-10'||v.left[1].decision!=='M41'||v.map[0]!=='none: no owner or path changes')throw Error('ready must print what was left and the map entries: '+r.log);}
console.log('PASS small-fix commits match the brief; ready prints the left issues and the map entries');
gitLog='c1\tCount the failure (DT-1)\nc3\tDrop the stale count (DT-12)';
expect('a taken-out small fix still committed is refused',cmd('ready','tb'),1,'DT-12 was taken out');
gitLog='c2\tUnrelated work for DT-120';
expect('a small fix without its commit is refused',cmd('ready','tb'),1,'Small fix DT-1: 0 commits');
gitLog='c1\tCount the failure (DT-1)';treeFiles={c1:'src/foo.js\nsrc/bar.js'};
expect('a small-fix commit touching a second source file is refused',cmd('ready','tb'),1,'its commit changes src/foo.js, src/bar.js');
gitLog='';treeFiles={};

// Two commands on one slug: the slow one writes only its own change; one that replaces the basis refuses.
expect('lw start',cmd('start','lw','--base','main','--risk','standard'),0,'policy-hash');
expect('lw brief',cmd('record-brief','lw','--file','/brief.json'),0,'true');
onNpm=()=>{onNpm=null;const r=cmd('record-review','lw','--result','pass','--rules','/table.txt','--evidence','during check');if(r.code)throw Error('inner review failed '+r.log);};
expect('a review recorded while verify --check runs',cmd('verify','lw','--check'),0,'ok');
{const e=JSON.parse(store.get('/git/l2solo-workflow/lw.json')).evidence;
 if(e.review?.evidence!=='during check'||e.rules?.head!==head)throw Error('the slow command must keep the review recorded under it: '+JSON.stringify(e));}
console.log('PASS a slow command keeps what another command recorded meanwhile');
onNpm=()=>{onNpm=null;const r=cmd('record-brief','lw','--file','/brief.json');if(r.code)throw Error('inner brief failed '+r.log);};
{const before=store.get('/brief.json');store.set('/brief.json',briefWith({symptom:'another symptom',tests:['test_basic.js','test_geodata.js']}));
 expect('a brief replaced while verify --check runs refuses the receipt',cmd('verify','lw','--check'),1,'changed while this command ran');store.set('/brief.json',before);}
if(JSON.parse(store.get('/git/l2solo-workflow/lw.json')).evidence.rules)throw Error('no receipt may be written onto a replaced brief');
console.log('PASS a receipt is not written onto a brief replaced under the command');
