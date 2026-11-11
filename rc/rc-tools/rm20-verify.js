const fs=require('fs'),os=require('os'),np=require('path');
const SG=require(np.resolve('scripts/saved-games'));
const d=fs.mkdtempSync(np.join(os.tmpdir(),'rm20v-'));
require(np.resolve('src/Global'));
options.default.Database.path=np.join(d,'world.sqlite');
(async()=>{
 await SG.run({operation:'load',databasePath:np.join(d,'world.sqlite'),savesDir:process.argv[2],id:process.argv[3]});
 const DB=invoke('Database');DB.init();await new Promise(r=>setTimeout(r,1500));
 console.log('wars',JSON.stringify(await DB.fetchClanWars(0)));
 const T=Date.now();const halls=await DB.initClanHalls(T);
 const h=halls.find(x=>x.ownerId===6000000);console.log('hall',JSON.stringify(h));
 const VN=invoke('GameServer/ClanHall/VisitNeed');
 console.log('available',VN.available({...h,functions:JSON.parse(h.functionsJson)},T), 'support list',(require(np.resolve('data/ClanHalls/support.json'))||{})[8]?.length);
 const m=(await DB.fetchClanCharacters()).filter(c=>c.clanId===6000000);console.log('members',m.length,m.some(c=>c.name==='PerfPlayer1'));
 const c=await DB.fetchCharacters('perf_player1');console.log('login finds',c.length,c[0].name,c[0].clanId);
 process.exit(0)})().catch(e=>{console.error(e);process.exit(1)});
