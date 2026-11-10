'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {activations,counters,args}=require('./log-query');
// Real shapes (9d6bf579a hot run): untimed server.log lines, some ANSI-coloured; perf timeline summaries.
const run=fs.mkdtempSync(path.join(os.tmpdir(),'l2-log-'));
try{
 const act=(n,x,y,d)=>`\x1b[32mBotPopulation :: requested activation for ${n} reason=near_player activity=hunting plan=hunting spot=13_30 loc=${x},${y},-3700 playerDist=${d} ready=yes\x1b[0m`;
 fs.writeFileSync(path.join(run,'server.log'),[
  'BotPopulation :: summary hot=1 activations=2 lateInViewActivations=0',
  act('Dom',82700,183560,5200),act('Far',10000,10000,9000),
  'BotPopulation :: cooled Dom reason=policy',
  'BotPopulation :: summary hot=1 activations=1 lateInViewActivations=1',
  act('Dom',82690,183540,5210),''].join('\n'));
 fs.mkdirSync(path.join(run,'rec'));
 const s=(t,a,total)=>JSON.stringify({type:'summary',t,reason:'summary',population:{improvementRetired:3,metrics:{counters:{activations:total},delta:{activations:a}}}});
 fs.writeFileSync(path.join(run,'rec','timeline-1.jsonl'),[JSON.stringify({type:'summary',t:'T0',reason:'start'}),s('T1',2,2),s('T2',1,3)].join('\n'));
 const a=activations(run,{limit:10,near:[82684,183551],radius:1600});
 assert.equal(a.timeMapped,true);assert.equal(a.total,3);assert.equal(a.matched,2);
 assert.deepEqual(a.repeats[0].events.map(e=>[e.event,e.estimatedWindow.notBefore,e.estimatedWindow.notAfter]),[['activated','T1','T2'],['cooled','T1','T2'],['activated','T2',null]]);
 const c=counters(run,{keys:['activations','improvementRetired']});
 assert.deepEqual([c.series[0].last.total,c.series[0].peakDelta.delta,c.series[1].last.total],[3,2,3]);
 // A summary that does not match the timeline leaves times unknown instead of guessing.
 fs.writeFileSync(path.join(run,'rec','timeline-1.jsonl'),[s('T1',5,5),s('T2',1,6)].join('\n'));
 const u=activations(run,{limit:10});assert.equal(u.timeMapped,false);assert.equal(u.repeats[0].events[0].estimatedWindow.notBefore,null);
 fs.writeFileSync(path.join(run,'rec','timeline-1.jsonl'),[s('T1',2,2),s('T2',1,3)].join('\n'));
 fs.writeFileSync(path.join(run,'server.log'),fs.readFileSync(path.join(run,'server.log'),'utf8').replace('activations=1 lateInViewActivations=1','activations=1 lateInViewActivations=1 cooldowns=4'));
 const t2=JSON.parse(fs.readFileSync(path.join(run,'rec','timeline-1.jsonl'),'utf8').split('\n')[1]);t2.population.metrics.delta.cooldowns=5;
 fs.writeFileSync(path.join(run,'rec','timeline-1.jsonl'),[s('T1',2,2),JSON.stringify(t2)].join('\n'));
 assert.equal(activations(run,{limit:10}).timeMapped,false,'one disagreeing shared counter refuses the mapping');
 assert.throws(()=>args([run,'counters']),/requires --keys/);assert.throws(()=>args([run,'activations','--near','1,2']),/radius/);
 console.log('PASS server.log activations, cooled pairs, timeline-mapped windows, counters series and refusal of an unverified mapping');
}finally{fs.rmSync(run,{recursive:true,force:true});}
