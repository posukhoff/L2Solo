const fs=require('fs');const dir=process.argv[2];
const txt=fs.readFileSync(process.argv[3],'utf8');
const files=fs.readdirSync(dir).filter(f=>f.endsWith('.js')).map(f=>[f,fs.readFileSync(dir+'/'+f,'utf8')]);
const DEC={earning_spot:/earning_spot|EarningSpot|held_earning/,build:/build|DecisionSections|EconomyDecision/,gear_plan:/gear_plan|GearPlan/,workshop:/workshop|Workshop/,own_lines:/own_lines|OwnLines/,rebuff:/rebuff|Rebuff/,party_stay:/party_stay|PartyStay/};
for (const place of ['far','near']) {
  const m=txt.match(new RegExp(`empty \\(no take\\) ${place}: (.*)`)); if(!m) continue;
  for (const cell of m[1].split(/, (?=[a-z_]+<)/)) {
    const [dec,rest]=cell.split('<'); const sit=rest.replace(/ \(.*$/,'');
    const base=sit.split(':')[0];
    const hits=files.filter(([f,t])=>t.includes(`'${sit}'`)||t.includes(`"${sit}"`)||(sit.includes(':')&&t.includes(sit))).filter(([f,t])=>DEC[dec].test(t));
    const nearHits=hits.filter(([f,t])=>/near|'hot'|phase: 'hot'|nearRaise|HotRaise/.test(t));
    console.log(`${place}|${dec}<${sit}|${(place==='near'?nearHits:hits).map(h=>h[0].replace(/^test_|\.js$/g,'')).slice(0,5).join(',')||'-'}`);
  }
}
