#!/usr/bin/env node
'use strict';
// Read-only reports over a completed run's server.log and perf timeline. No server, no writes.
// server.log lines carry no timestamp: a line's time is the window between the summary lines
// around it, mapped to the perf timeline's summaries (verified by the activations counter).
const fs=require('node:fs'),path=require('node:path');
const ACT=/^BotPopulation :: requested activation for (\S+) reason=(\S+) activity=(\S+) plan=(\S+) spot=(\S+) loc=(-?\d+),(-?\d+),(-?\d+) playerDist=(\S+) ready=(\S+)$/;
const COOL=/^BotPopulation :: cooled (\S+) reason=(\S+)$/;
const SUMMARY=/^BotPopulation :: summary (.*)$/;
// ANSI colour codes wrap some lines.
const plain=s=>s.replace(/\x1b\[[0-9;]*m/g,'').trim();
function timeline(run){
    const dirs=fs.readdirSync(run,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>path.join(run,d.name));
    const files=dirs.flatMap(d=>fs.readdirSync(d).filter(f=>/^timeline-.*\.jsonl$/.test(f)).map(f=>path.join(d,f))).sort();
    const rows=[];
    for(const f of files)for(const l of fs.readFileSync(f,'utf8').split('\n')){if(!l.trim())continue;try{rows.push(JSON.parse(l));}catch{}}
    return {files:files.map(f=>path.relative(run,f)),summaries:rows.filter(r=>r.type==='summary'&&r.reason!=='start')};
}
function readLog(run){
    const file=path.join(run,'server.log');
    if(!fs.existsSync(file))throw Error('No server.log in '+run);
    const lines=fs.readFileSync(file,'utf8').split('\n'), acts=[], cools=[], summaries=[];
    lines.forEach((raw,i)=>{
        const l=plain(raw);let m;
        if((m=ACT.exec(l)))acts.push({line:i+1,name:m[1],reason:m[2],activity:m[3],plan:m[4],spot:m[5],loc:[+m[6],+m[7],+m[8]],playerDist:Number(m[9]),ready:m[10]});
        else if((m=COOL.exec(l)))cools.push({line:i+1,name:m[1],reason:m[2]});
        else if((m=SUMMARY.exec(l)))summaries.push({line:i+1,fields:Object.fromEntries(m[1].split(' ').map(x=>x.split('=')).filter(x=>x.length===2))});
    });
    return {acts,cools,summaries};
}
// Each server.log summary is the timeline summary at the same position when their activation
// deltas agree; else times stay unknown.
function windows(log,tl){
    const ok=log.summaries.length>0&&log.summaries.length<=tl.summaries.length&&log.summaries.every((s,k)=>
        Number(s.fields.activations)===Number(tl.summaries[k]?.population?.metrics?.delta?.activations));
    const at=k=>ok&&k>=0&&k<log.summaries.length?tl.summaries[k].t:null;
    const win=line=>{let k=0;while(k<log.summaries.length&&log.summaries[k].line<line)k++;return {after:at(k-1),before:at(k)};};
    return {verified:ok,win};
}
function activations(run,o){
    const log=readLog(run),tl=timeline(run),{verified,win}=windows(log,tl);
    const near=o.near?([x,y])=>Math.hypot(x-o.near[0],y-o.near[1])<=o.radius:()=>true;
    const acts=log.acts.filter(a=>near(a.loc)&&(!o.name||a.name===o.name));
    const count=(rows,f)=>Object.entries(rows.reduce((m,r)=>(m[f(r)]=(m[f(r)]||0)+1,m),{})).sort((a,b)=>b[1]-a[1]).slice(0,o.limit);
    // Where bodies appear: 1000-unit cells (a gatekeeper landing shows as one dense cell).
    const cells=count(acts,a=>Math.round(a.loc[0]/1000)*1000+','+Math.round(a.loc[1]/1000)*1000);
    const byName=new Map();
    for(const a of acts){if(!byName.has(a.name))byName.set(a.name,[]);byName.get(a.name).push({event:'activated',line:a.line,spot:a.spot,plan:a.plan,loc:a.loc.join(','),...win(a.line)});}
    for(const c of log.cools)if(byName.has(c.name))byName.get(c.name).push({event:'cooled',line:c.line,reason:c.reason,...win(c.line)});
    const repeats=[...byName].map(([name,ev])=>({name,activations:ev.filter(e=>e.event==='activated').length,events:ev.sort((a,b)=>a.line-b.line)}))
        .filter(r=>r.activations>=2).sort((a,b)=>b.activations-a.activations);
    return {query:'activations',source:'server.log',timeMapped:verified,timelineFiles:tl.files,filter:{near:o.near||null,radius:o.radius||null,name:o.name||null},
        total:log.acts.length,matched:acts.length,cooled:log.cools.length,byReason:count(acts,a=>a.reason),byPlan:count(acts,a=>a.plan),
        playerDist:{under1600:acts.filter(a=>a.playerDist<1600).length,under6000:acts.filter(a=>a.playerDist<6000).length},
        cells,repeatedBots:repeats.length,repeats:repeats.slice(0,o.limit),
        notes:['Lines come only with developerDiagnostics on; names, not ids (resolve with db-query custody).','Times are windows between summaries (~30 s), mapped to the perf timeline only when the activation deltas agree.']};
}
function counters(run,o){
    const tl=timeline(run);
    if(!tl.summaries.length)throw Error('No perf timeline summaries under '+run);
    const series=o.keys.map(key=>({key,points:tl.summaries.map(s=>{
        const m=s.population?.metrics;const total=m?.counters?.[key]??s.population?.[key]??null;
        return {t:s.t,total,delta:m?.delta?.[key]??null};
    })}));
    return {query:'counters',source:tl.files,summaries:tl.summaries.length,
        series:series.map(s=>({key:s.key,first:s.points[0],last:s.points.at(-1),peakDelta:s.points.reduce((p,x)=>x.delta!==null&&(p===null||x.delta>p.delta)?x:p,null),points:o.points?s.points:undefined})),
        notes:['Totals are population.metrics.counters (else population.<key>); deltas are per summary window.']};
}
function args(argv){
    const [run,query,...rest]=argv;
    if(!run||!['activations','counters'].includes(query))throw Error('Usage: log-query.js <completed-run-dir> activations [--near X,Y --radius R] [--name N] [--limit N] | counters --keys a,b [--points]');
    const o={run:path.resolve(run),query,limit:10};
    for(let i=0;i<rest.length;i++){
        const k=rest[i];if(k==='--points'){o.points=true;continue;}
        const v=rest[++i];if(!v||v.startsWith('--'))throw Error('Invalid option '+k);
        if(k==='--near')o.near=v.split(',').map(Number);else if(k==='--radius')o.radius=Number(v);else if(k==='--name')o.name=v;
        else if(k==='--limit')o.limit=Number(v);else if(k==='--keys')o.keys=v.split(',').filter(Boolean);else throw Error('Invalid option '+k);
    }
    if(o.near&&(o.near.length!==2||!o.near.every(Number.isFinite)||!(o.radius>0)))throw Error('--near X,Y needs --radius R');
    if(!Number.isSafeInteger(o.limit)||o.limit<1||o.limit>200)throw Error('Limit must be 1-200');
    if(query==='counters'&&!o.keys?.length)throw Error('counters requires --keys');
    return o;
}
function main(){const o=args(process.argv.slice(2));console.log(JSON.stringify(o.query==='activations'?activations(o.run,o):counters(o.run,o),null,2));}
if(require.main===module){try{main();}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={args,activations,counters,readLog,timeline,windows,plain};
