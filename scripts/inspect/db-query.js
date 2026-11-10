#!/usr/bin/env node
'use strict';
// Offline, read-only SQLite reports. Requires Node >=22.13 with node:sqlite.
const fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const positive=n=>Number.isSafeInteger(n)&&n>0;
function args(argv){
    const [run,query,...rest]=argv;
    if(!run||!['market','custody'].includes(query))throw Error('Usage: db-query.js <completed-run-dir> market --from <epoch-ms|ISO> --to <epoch-ms|ISO> [--limit N] [--item ID] | custody --bot ID[,ID] [--limit N]');
    const o={run:path.resolve(run),query,limit:10};
    for(let i=0;i<rest.length;i++){
        const k=rest[i],v=rest[++i];
        if(!['--from','--to','--limit','--item','--bot'].includes(k)||!v||v.startsWith('--'))throw Error('Invalid option '+k);
        if(k==='--bot')o.bots=[...new Set(v.split(',').map(Number))];
        else if(k==='--from'||k==='--to')o[k.slice(2)]=/^\d+$/.test(v)?Number(v):Date.parse(v);
        else o[k.slice(2)]=Number(v);
    }
    if(!positive(o.limit)||o.limit>100)throw Error('Limit must be 1–100');
    if(query==='market'){
        if(!Number.isSafeInteger(o.from)||!Number.isSafeInteger(o.to)||o.from<0||o.from>o.to||o.bots||o.item!==undefined&&!positive(o.item))throw Error('Market requires valid --from and --to, optional --item.');
    }else if(!o.bots?.length||o.bots.length>100||!o.bots.every(positive)||o.from!==undefined||o.to!==undefined||o.item!==undefined)throw Error('Custody requires --bot ID[,ID], maximum 100 IDs.');
    return o;
}
// A completed snapshot is opened immutable (SQLite then touches no -shm/-wal file, not even the
// wal-index mtime). Immutable reads only the main file, so a snapshot whose -wal still holds
// pages is refused instead of read stale: checkpoint a copy first.
function open(run,file){
    const dbPath=path.join(run,file);
    if(!fs.existsSync(dbPath))throw Error('Missing snapshot: '+dbPath);
    const wal=dbPath+'-wal';
    if(fs.existsSync(wal)&&fs.statSync(wal).size>0)throw Error('Snapshot WAL not empty ('+wal+'): checkpoint a copy of the run before querying.');
    const db=new DatabaseSync('file:'+encodeURI(dbPath).replace(/\?/g,'%3F').replace(/#/g,'%23')+'?immutable=1',{readOnly:true});
    db.exec('PRAGMA query_only=ON');
    return db;
}
const all=(db,sql,...params)=>db.prepare(sql).all(...params);
function market(db,o){
    const item=o.item===undefined?'':' AND selfId=?';
    const params=[o.from,o.to,...(o.item===undefined?[]:[o.item]),o.limit];
    // An NPC trade records a placeholder name ('Item <id>'): rows group by item id, the name is any real one.
    const name=t=>"COALESCE((SELECT n.itemName FROM market_trades n WHERE n.selfId="+t+".selfId AND n.itemName NOT LIKE 'Item %' LIMIT 1),MAX("+t+".itemName))";
    const totals=all(db,'SELECT t.selfId,'+name('t')+' AS itemName,t.channel,t.sourceType,COUNT(*) AS trades,SUM(t.quantity) AS qty,SUM(t.totalPrice) AS adena,COUNT(DISTINCT t.buyerCharacterId) AS buyers,MIN(t.unitPrice) AS minPrice,MAX(t.unitPrice) AS maxPrice FROM market_trades t WHERE t.occurredAt BETWEEN ? AND ?'+item.replace('selfId','t.selfId')+' GROUP BY t.selfId,t.channel,t.sourceType ORDER BY adena DESC,t.selfId LIMIT ?',...params);
    // EXISTS deliberately counts each buy at most once. A later sale of same item type
    // is a candidate, not proof of same physical item, quantity or a round trip.
    const sellbacks=all(db,'SELECT b.selfId,'+name('b')+' AS itemName,COUNT(*) AS buysWithLaterSale,COUNT(DISTINCT b.buyerCharacterId) AS buyers,SUM(b.totalPrice) AS boughtFor FROM market_trades b WHERE b.occurredAt BETWEEN ? AND ? AND b.buyerCharacterId IS NOT NULL'+(o.item===undefined?'':' AND b.selfId=?')+' AND EXISTS (SELECT 1 FROM market_trades s WHERE s.selfId=b.selfId AND s.sellerCharacterId=b.buyerCharacterId AND s.occurredAt>b.occurredAt AND s.occurredAt<=?) GROUP BY b.selfId ORDER BY boughtFor DESC,b.selfId LIMIT ?',o.from,o.to,...(o.item===undefined?[]:[o.item]),o.to,o.limit);
    const evidence=all(db,'SELECT id,eventKey,occurredAt,selfId,channel,sourceType,quantity,unitPrice,totalPrice,buyerCharacterId,sellerCharacterId FROM market_trades WHERE occurredAt BETWEEN ? AND ?'+item+' ORDER BY totalPrice DESC,id LIMIT ?',...params);
    return {query:'market',window:{from:o.from,to:o.to},item:o.item??null,totals,sellbacks,evidence,notes:['History is bounded by explicit inclusive timestamps.','Later sale of same item type by buyer is a candidate, not matching item identity or quantity; not proof of a loop.','Sums count recorded trades, not net adena creation.']};
}
function parse(text){if(text==null)return null;try{return JSON.parse(text);}catch{return null;}}
// The bot's own market trades of the items it deposited, from the history snapshot when one is
// attached (alias h): they date the buy before the deposit and any later board sale.
function tradesOf(db,bot,ids){
    if(!ids.length||!db.prepare("SELECT 1 FROM pragma_database_list WHERE name='h'").get())return null;
    return all(db,'SELECT id,eventKey,occurredAt,channel,selfId,quantity,unitPrice,buyerCharacterId,sellerCharacterId FROM h.market_trades WHERE (buyerCharacterId=? OR sellerCharacterId=?) AND selfId IN ('+ids.map(()=>'?').join(',')+') ORDER BY occurredAt,id LIMIT 20',bot,bot,...ids);
}
function custody(db,o){
    const marks=o.bots.map(()=>'?').join(',');
    const rows=all(db,'SELECT characterId,adena,activity,spotId,statsJson,mindJson FROM bot_life_state WHERE characterId IN ('+marks+') ORDER BY characterId LIMIT ?',...o.bots,o.limit);
    const bots=rows.map(r=>{
        const stats=parse(r.statsJson),mind=parse(r.mindJson);
        const plan=stats?.equipmentPlan,deposit=stats?.lastWarehouseDeposit,liquidation=stats?.lastNpcLiquidation;
        const target=plan?.target?.selfId??null, deposited=Array.isArray(deposit?.items)?deposit.items:[];
        const sold=Array.isArray(liquidation?.sold)?liquidation.sold:[];
        const depositIds=new Set(deposited.map(x=>x?.selfId).filter(positive));
        const overlap=[...new Set(sold.filter(x=>Array.isArray(x)&&depositIds.has(x[0])).map(x=>x[0]))];
        const ordered=Number.isFinite(deposit?.at)&&Number.isFinite(liquidation?.at)&&liquidation.at>deposit.at;
        return {characterId:r.characterId,adena:r.adena,activity:r.activity,spotId:r.spotId,
            money:mind?.money??null,focus:mind?.wishFocus?.[0]??null,earnSpot:mind?.earning?.spotId??null,
            planStrategy:plan?.strategy??null,planTarget:target,lastDeposit:deposit??null,lastLiquidation:liquidation??null,
            custodySignal:{overlapItemIds:overlap,ordered,matchingTarget:target!==null&&deposit?.projectTarget===target,
                candidate:overlap.length>0&&ordered&&target!==null&&deposit?.projectTarget===target},
            trades:tradesOf(db,r.characterId,[...depositIds]),
            jsonQuality:{statsParsed:stats!==null,mindParsed:mind!==null}};
    });
    const found=new Set(rows.map(r=>r.characterId));
    return {query:'custody',bots,requested:o.bots.length,returned:bots.length,missing:o.bots.filter(id=>!found.has(id)),notes:['Snapshot at end of saved run, not event history.','Same item type in last deposit and later liquidation with matching plan target is a candidate only; confirm quantity, identity and plan lifetime from trace.','money array emitted as stored; do not infer units without the source contract.','trades: the bot\'s market trades of deposited items (history snapshot); an NPC liquidation is not a market trade.']};
}
function main(){
    const o=args(process.argv.slice(2)),file=o.query==='market'?'world.history.sqlite':'world.sqlite';
    const db=open(o.run,file);
    const history=path.join(o.run,'world.history.sqlite');
    if(o.query==='custody'&&fs.existsSync(history)){
        if(fs.existsSync(history+'-wal')&&fs.statSync(history+'-wal').size>0)throw Error('History WAL not empty: checkpoint a copy first.');
        db.exec("ATTACH DATABASE '"+('file:'+encodeURI(history).replace(/\?/g,'%3F').replace(/#/g,'%23')+'?immutable=1').replace(/'/g,"''")+"' AS h");
    }
    try{const result=o.query==='market'?market(db,o):custody(db,o);console.log(JSON.stringify({database:file,...result},null,2));}finally{db.close();}
}
if(require.main===module){try{main();}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={args,market,custody};
