#!/usr/bin/env node
'use strict';
// Read-only offline trace reports. No live server, DB writes, network or guessed causes.
const fs=require('node:fs'), path=require('node:path');
const phases=new Set(['funding','purchase_goal','buy_request','native_funding','buy_ad_reconcile','plan_compute']);
const order=(a,b)=>a.at-b.at||a.ordinal-b.ordinal;
const evidence=r=>({file:r.file,line:r.line,at:r.at,thread:r.thread,bot:r.bot,kind:r.kind,name:r.name,phase:r.phase,reason:r.reason,decision:r.decision,answer:r.answer,was:r.was,caller:r.caller,woke:r.woke,wishKey:r.wishKey,item:r.item,synthetic:r.synthetic,synthetic:r.synthetic});
const inc=(m,k)=>m.set(k,(m.get(k)||0)+1);
const ranked=(m,n)=>[...m].sort((a,b)=>b[1]-a[1]||String(a[0]).localeCompare(String(b[0]))).slice(0,n).map(([key,count])=>({key,count}));
const positive=n=>Number.isSafeInteger(n)&&n>0;
function *readRows(dir,quality) {
    const base=path.join(dir,'decision-trace.jsonl');
    const files=[...Array(8)].map((_,i)=>7-i).map(i=>base+(i?'.'+i:'')).filter(p=>fs.existsSync(p));
    if(!files.length)throw Error('No decision trace in '+dir);
    let ordinal=0;
    for(const file of files) {
        quality.files.push(path.basename(file));
        const before=fs.statSync(file);
        if(before.size>33*1024*1024)throw Error('Unexpected oversized trace file: '+file);
        const lines=fs.readFileSync(file,'utf8').split('\n');
        for(let i=0;i<lines.length;i++){
            if(!lines[i].trim())continue;
            let row;try{row=JSON.parse(lines[i]);}catch{quality.malformed++;continue;}
            if(row?.type==='decision_trace_header'){quality.headers++;continue;}
            if(!row||!Number.isFinite(row.at)||typeof row.kind!=='string'){quality.invalid++;continue;}
            yield {...row,file:path.basename(file),line:i+1,ordinal:ordinal++};
        }
        const after=fs.statSync(file);
        if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Error('Trace changed during read; use a completed run snapshot.');
    }
}
function analyze(rows,opt,quality={files:[],headers:0,malformed:0,invalid:0}){
    const limit=opt.limit||50, kinds=new Map(), groups=new Map(), bots=new Set(), details=new Set();
    let min=Infinity,max=-Infinity,total=0,matched=0,detailCount=0,retained=0;
    const restart=[], cap=500000, builds=new Map();
    const keep=(key,row)=>{
        if(++retained>cap)throw Error('More than 500000 matching records; narrow --from/--to, --bot or --decision.');
        if(!groups.has(key))groups.set(key,[]);
        groups.get(key).push(row);
    };
    for(const r of rows){
        if(r.at<(opt.from??-Infinity)||r.at>(opt.to??Infinity))continue;
        total++;min=Math.min(min,r.at);max=Math.max(max,r.at);
        if(positive(r.bot))bots.add(r.bot);
        if(r.kind==='detail'){detailCount++;if(positive(r.bot))details.add(r.bot);}
        if(r.kind==='restart')restart.push(r.at);
        // A refusal raise names no step; the bot's latest build answer before it does (refusals).
        if(opt.query==='refusals'&&r.kind==='decided'&&r.decision==='build'&&positive(r.bot)&&typeof r.answer==='string'){
            if(!builds.has(r.bot))builds.set(r.bot,[]);builds.get(r.bot).push(r);}
        if(opt.bot!==undefined&&r.bot!==opt.bot&&!(opt.query==='timeline'&&r.kind==='meeting'&&r.target===opt.bot))continue;
        if(opt.query==='census'){
            inc(kinds,JSON.stringify([r.kind,r.phase??r.decision??r.name??null]));matched++;
        }else if(opt.query==='timeline'){
            if(!opt.all&&r.kind==='detail'&&['wish_alternative','wish_need'].includes(r.phase))continue;
            if(opt.decision&&r.decision!==opt.decision)continue;
            matched++;keep('timeline',r);
        }else if(opt.query==='funding'){
            if(r.kind==='detail'&&phases.has(r.phase)){matched++;keep('funding',r);}
        }else if(opt.query==='refusals'){
            // Explicit observed signatures, not a diagnosis of root cause.
            if(!positive(r.bot)||!((r.kind==='raise'&&r.name==='goal_failed'&&r.reason==='impossible')||
                (r.kind==='detail'&&r.phase==='purchase_goal'&&['funding_short','impossible'].includes(r.reason))))continue;
            // Missing step identifiers remain unknown; do not present them as a proven same-step loop.
            const step=r.wishKey??(r.item!==undefined?'item:'+r.item:null);
            matched++;keep(JSON.stringify([r.bot,r.kind,r.name??r.phase,r.reason,step]),r);
        }else if(opt.query==='flips'){
            if(r.kind!=='decided'||!positive(r.bot)||typeof r.decision!=='string'||!(typeof r.answer==='string'||r.answer===null)||(opt.decision&&r.decision!==opt.decision))continue;
            matched++;keep(JSON.stringify([r.bot,r.decision]),r);
        }
    }
    const qualityNotes=['Observed records only; trace can drop records, and detail is sampled (~1/64 bots). Missing records are not proof of absence.','Rates use observed trace span, not configured runtime or active-bot hours.'];
    if(quality.malformed||quality.invalid)qualityNotes.push('Malformed/invalid records skipped; investigate completeness.');
    if(restart.length)qualityNotes.push('Worker restart recorded; sequences spanning restart are excluded for flips.');
    let result;
    if(opt.query==='census'){
        result={counts:ranked(kinds,limit).map(x=>{const [kind,name]=JSON.parse(x.key);return {kind,name,count:x.count};}),distinctGroups:kinds.size};
    }else if(opt.query==='timeline'||opt.query==='funding'){
        const list=(groups.get(opt.query)||[]).sort(order);
        result={matched:list.length,truncated:list.length>limit,records:list.slice(-limit).map(r=>{
            const {ordinal,...rest}=r;return rest;
        })};
    }else if(opt.query==='refusals'){
        const out=[];
        for(const [key,list] of groups){
            list.sort(order);
            let left=0,peak=0,peakStart=0,peakEnd=0;
            for(let right=0;right<list.length;right++){
                while(list[right].at-list[left].at>=60000)left++;
                if(right-left+1>peak){peak=right-left+1;peakStart=left;peakEnd=right;}
            }
            const [bot,kind,event,reason,step]=JSON.parse(key);
            // The build answers in force at the peak's refusals (latest build at or before each), most frequent first.
            const answers=new Map(), own=(builds.get(bot)||[]).sort(order);
            if(step===null&&own.length)for(let i=peakStart,j=0;i<=peakEnd;i++){
                while(j+1<own.length&&own[j+1].at<=list[i].at)j++;
                if(own[j].at<=list[i].at)inc(answers,own[j].answer);
            }
            const buildAnswers=ranked(answers,3);
            out.push({bot,kind,event,reason,step,stepKnown:step!==null,buildAnswers,count:list.length,peakPer60s:peak,
                candidate:peak>(opt.threshold??5),first:evidence(list[0]),peakEvidence:[evidence(list[peakStart]),evidence(list[peakEnd])]});
        }
        result={threshold:opt.threshold??5,groups:out.length,entries:out.sort((a,b)=>b.peakPer60s-a.peakPer60s||b.count-a.count).slice(0,limit)};
    }else if(opt.query==='flips'){
        const out=[], resets=restart.sort((a,b)=>a-b);
        for(const [key,list] of groups){
            list.sort(order);let a=null,b=null,changes=0,flips=0,ri=0;const examples=[];
            const answer=x=>x===null||x===undefined?'(none)':String(x);
            for(const raw of list){
                const row={...raw,answer:answer(raw.answer)};
                while(ri<resets.length&&resets[ri]<=row.at){a=b=null;ri++;}
                // The first observed record of a segment carries the answer it replaced (was).
                if(!b&&raw.was!==undefined&&answer(raw.was)!==row.answer)b={...raw,answer:answer(raw.was),synthetic:'was'};
                if(b?.answer===row.answer)continue;
                if(b)changes++;
                if(a&&a.answer===row.answer&&b.answer!==row.answer){
                    flips++;if(examples.length<3)examples.push([a,b,row].map(evidence));
                }
                a=b;b=row;
            }
            const [bot,decision]=JSON.parse(key);
            if(changes||flips)out.push({bot,decision,changes,flips,examples});
        }
        result={groups:groups.size,entries:out.sort((a,b)=>b.flips-a.flips||b.changes-a.changes).slice(0,limit),definition:'Consecutive distinct observed answers A-B-A for same bot/decision; repeated equal answers collapsed; not a defect verdict.'};
    }else throw Error('Unknown query: '+opt.query);
    return {query:opt.query,window:{from:opt.from??null,to:opt.to??null,observedFrom:total?min:null,observedTo:total?max:null,observedHours:total?(max-min)/3600000:0},quality:{...quality,records:total,observedBots:bots.size,detailRecords:detailCount,detailBots:details.size,notes:qualityNotes},matched,...result};
}
function options(argv){
    const [run,query,...rest]=argv;
    if(!run||!['census','timeline','refusals','flips','funding'].includes(query))throw Error('Usage: run-query.js <completed-run-dir> <census|timeline|refusals|flips|funding> [--bot ID] [--decision NAME] [--from ISO|epoch-ms] [--to ISO|epoch-ms] [--limit N] [--threshold N] [--all]');
    const opt={query,limit:query==='timeline'||query==='funding'?50:10};
    const stamp=x=>/^\d+$/.test(x)?Number(x):Date.parse(x);
    for(let i=0;i<rest.length;i++){
        const k=rest[i];if(k==='--all'){opt.all=true;continue;}
        if(!['--bot','--decision','--from','--to','--limit','--threshold'].includes(k)||!rest[i+1]||rest[i+1].startsWith('--'))throw Error('Invalid option '+k);
        const v=rest[++i], key=k.slice(2);opt[key]=['from','to'].includes(key)?stamp(v):key==='decision'?v:Number(v);
    }
    if(!positive(opt.limit)||opt.limit>1000||opt.bot!==undefined&&!positive(opt.bot)||opt.threshold!==undefined&&!positive(opt.threshold)||opt.from!==undefined&&!Number.isFinite(opt.from)||opt.to!==undefined&&!Number.isFinite(opt.to)||(opt.from??-Infinity)>(opt.to??Infinity))throw Error('Invalid numeric option/window');
    if(opt.decision&&!['timeline','flips'].includes(query))throw Error('--decision is only valid for timeline/flips');
    if(opt.threshold!==undefined&&query!=='refusals')throw Error('--threshold is only valid for refusals');
    if(opt.all&&query!=='timeline')throw Error('--all is only valid for timeline');
    if(['timeline','funding'].includes(query)&&opt.bot===undefined)throw Error(query+' requires --bot');
    return {dir:path.join(path.resolve(run),'logs'),opt};
}
function main(){
    const {dir,opt}=options(process.argv.slice(2)), quality={files:[],headers:0,malformed:0,invalid:0};
    const result=analyze(readRows(dir,quality),opt,quality);
    console.log(JSON.stringify(result,null,2));
}
if(require.main===module){try{main();}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={analyze,readRows,options};
