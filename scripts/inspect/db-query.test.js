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
 assert.throws(()=>args(['/tmp','market']),/requires/);assert.throws(()=>args(['/tmp','custody','--bot','1,foo']),/requires/);
 console.log('PASS market window, non-multiplying sale candidates, custody chronology and invalid inputs');
}finally{db.close();}
