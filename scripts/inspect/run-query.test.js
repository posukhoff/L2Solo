'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {analyze,readRows,options}=require('./run-query');
let ordinal=0;
const r=(at,fields)=>({at,ordinal:ordinal++,file:'decision-trace.jsonl',line:ordinal,...fields});
const rows=[
 r(1000,{kind:'decided',bot:1,decision:'hunt_spot',answer:'A'}),
 r(3000,{kind:'decided',bot:1,decision:'hunt_spot',answer:'B'}),
 r(2000,{kind:'decided',bot:1,decision:'hunt_spot',answer:'A'}),
 r(4000,{kind:'decided',bot:1,decision:'hunt_spot',answer:'A'}),
 r(5000,{kind:'detail',bot:1,phase:'funding',wallet:100,reserve:20}),
 r(6000,{kind:'detail',bot:1,phase:'wish_need'}),
 r(7000,{kind:'meeting',bot:2,target:1}),
 ...[1,2,3,4,5,6].map(i=>r(10000+i*1000,{kind:'raise',bot:1,name:'goal_failed',reason:'impossible',wishKey:'item:90'})),
 r(17000,{kind:'raise',bot:2,name:'goal_failed',reason:'impossible'}),
 r(90000,{kind:'raise',bot:1,name:'goal_failed',reason:'impossible',wishKey:'item:90'})
];
const q=(query,opt={})=>analyze(rows,{query,...opt});
assert.equal(q('flips').entries[0].flips,1);
assert.equal(q('flips').entries[0].changes,2);
assert.equal(q('refusals').entries[0].peakPer60s,6);
assert.equal(q('refusals').entries[0].candidate,true);
assert.equal(q('refusals').entries[1].stepKnown,false);
assert.equal(q('funding',{bot:1}).records[0].wallet,100);
assert.equal(q('timeline',{bot:1}).records.some(x=>x.phase==='wish_need'),false);
assert.equal(q('timeline',{bot:1}).records.some(x=>x.target===1),true);
assert.equal(q('timeline',{bot:1,limit:2}).truncated,true);
assert.equal(q('census',{from:1000,to:3000}).quality.records,3);
assert.equal(analyze([r(1,{kind:'decided',bot:1,decision:'x',answer:'A'}),r(2,{kind:'decided',bot:1,decision:'x',answer:'B'}),r(3,{kind:'restart'}),r(4,{kind:'decided',bot:1,decision:'x',answer:'A'})],{query:'flips'}).entries[0].flips,0);
assert.throws(()=>options(['/tmp/run','timeline']),/requires --bot/);
assert.throws(()=>options(['/tmp/run','census','--limit','0']),/Invalid/);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'l2-query-'));
try{
 fs.writeFileSync(path.join(dir,'decision-trace.jsonl.1'),'{"type":"decision_trace_header"}\n{"at":1,"kind":"raise","bot":1}\n');
 fs.writeFileSync(path.join(dir,'decision-trace.jsonl'),'{"at":2,"kind":"decided","bot":1}\nbroken\n{"bad":true}\n');
 const quality={files:[],headers:0,malformed:0,invalid:0};
 const out=analyze(readRows(dir,quality),{query:'census'},quality);
 assert.equal(out.quality.records,2);assert.equal(out.quality.malformed,1);assert.equal(out.quality.invalid,1);assert.equal(out.quality.headers,1);assert.deepEqual(out.quality.files,['decision-trace.jsonl.1','decision-trace.jsonl']);
}finally{fs.rmSync(dir,{recursive:true,force:true});}
console.log('PASS trace census, timeline, refusal windows, flips, funding, rotation and input validation');
