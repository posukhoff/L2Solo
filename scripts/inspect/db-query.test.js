'use strict';
const assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {args,market,custody}=require('./db-query');
const db=new DatabaseSync(':memory:');
try{
 db.exec('CREATE TABLE market_trades(id INTEGER,eventKey TEXT,occurredAt INTEGER,channel TEXT,sourceType TEXT,selfId INTEGER,itemName TEXT,quantity INTEGER,unitPrice INTEGER,totalPrice INTEGER,buyerCharacterId INTEGER,sellerCharacterId INTEGER); CREATE TABLE bot_life_state(characterId INTEGER,adena INTEGER,activity TEXT,spotId TEXT,statsJson TEXT,mindJson TEXT)');
 const insert=db.prepare('INSERT INTO market_trades VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
 const trade=(id,at,item,buyer,seller)=>insert.run(id,'e'+id,at,'npc','npc_buy',item,'item'+item,1,100,100,buyer,seller);
 trade(1,10,90,1,null);trade(2,20,90,2,1);trade(3,25,90,3,1);trade(4,100,90,4,1);trade(5,15,40,1,null);
 let r=market(db,{from:10,to:30,limit:10,item:90});
 assert.equal(r.totals[0].trades,3);assert.equal(r.sellbacks[0].buysWithLaterSale,1);assert.equal(r.sellbacks[0].boughtFor,100);assert.equal(r.evidence.length,3);
 assert.equal(market(db,{from:10,to:15,limit:10,item:90}).sellbacks.length,0);
 const stats={equipmentPlan:{strategy:'luxury_exchange',target:{selfId:852}},lastWarehouseDeposit:{at:10,projectTarget:852,items:[{selfId:90,count:1}]},lastNpcLiquidation:{at:20,sold:[[90,1,700000]]}};
 const ins=db.prepare('INSERT INTO bot_life_state VALUES(?,?,?,?,?,?)');
 ins.run(1,100,'hunt','14_29',JSON.stringify(stats),JSON.stringify({money:[1,2],wishFocus:['power:852:1']}));
 ins.run(2,100,'hunt','14_29',JSON.stringify({...stats,lastNpcLiquidation:{at:5,sold:[[90,1,700000]]}}),'bad');
 const c=custody(db,{bots:[1,2],limit:10});
 assert.equal(c.bots[0].custodySignal.candidate,true);assert.equal(c.bots[1].custodySignal.candidate,false);assert.equal(c.bots[1].jsonQuality.mindParsed,false);
 // Real shape (9d6bf579a): an NPC buy records 'Item <id>', a board sale the real name; one item, one row.
 const named=(id,at,channel,name,buyer,seller)=>db.prepare('INSERT INTO market_trades VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'n'+id,at,channel,channel,1785,name,1,10,10,buyer,seller);
 named(20,10,'npc_buy','Item 1785',7,null);named(21,11,'bot_wts','Soul Ore',8,9);named(22,12,'bot_wts','Soul Ore',9,7);named(23,13,'bot_wts','Soul Ore',10,8);
 const one=market(db,{from:10,to:30,limit:10,item:1785});
 assert.deepEqual(one.sellbacks.map(x=>[x.itemName,x.buysWithLaterSale]),[['Soul Ore',2]],'buys of one item with later sales count in one row');
 assert.equal(one.totals.every(x=>x.itemName==='Soul Ore'),true);
 assert.deepEqual(custody(db,{bots:[1,999],limit:10}).missing,[999]);
 // With the history attached, custody shows the bot's trades around its deposit (at 10) and
 // liquidation (at 20): the last ones up to the deposit, those between, the first after; not the
 // oldest of all history.
 db.exec("ATTACH DATABASE ':memory:' AS h; CREATE TABLE h.market_trades AS SELECT * FROM main.market_trades");
 const old=db.prepare('INSERT INTO h.market_trades VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
 for(let i=0;i<25;i++)old.run(100+i,'old'+i,-1000+i,'npc','npc_buy',90,'item90',1,100,100,1,null);
 const t=custody(db,{bots:[1],limit:10}).bots[0].trades;
 assert.deepEqual(t.before.map(x=>x.id),[123,124,1],'the last trades up to the deposit, the buy at 10 last');
 assert.deepEqual(t.between.map(x=>x.id),[2],'sales between deposit and liquidation');
 assert.deepEqual(t.after.map(x=>x.id),[3,4]);assert.equal(t.betweenTruncated,false);
 const lim=custody(db,{bots:[1,2,999],limit:1});
 assert.deepEqual([lim.returned,lim.truncated,lim.missing],[1,true,[999]],'missing ids and a limit cut are told apart');
 assert.throws(()=>args(['/tmp','market']),/requires/);assert.throws(()=>args(['/tmp','custody','--bot','1,foo']),/requires/);
 console.log('PASS market window, non-multiplying sale candidates, custody chronology and invalid inputs');
}finally{db.close();}
