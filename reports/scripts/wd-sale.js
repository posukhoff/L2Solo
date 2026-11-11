// Same item withdrawn from the warehouse and sold to an NPC within --ms (default 100) after, per bot:
// last withdrawal vs last NPC liquidation in bot_life_state.statsJson (snapshot: a lower bound).
const { DatabaseSync } = require('node:sqlite');
const [run, msArg] = process.argv.slice(2); const ms = Number(msArg || 100);
// Only events of this run: the save carries the last withdrawal/liquidation of earlier play.
const from = Date.parse(JSON.parse(require('fs').readFileSync(run + '/run.json', 'utf8')).startedAt);
const db = new DatabaseSync('file:' + encodeURI(run + '/world.sqlite') + '?immutable=1', { readOnly: true });
let bots = 0, withBoth = 0; const hits = [];
for (const r of db.prepare('SELECT characterId, statsJson FROM bot_life_state').all()) {
  bots++; let s; try { s = JSON.parse(r.statsJson); } catch { continue; }
  const wd = s.lastWarehouseWithdrawal, liq = s.lastNpcLiquidation;
  if (!Array.isArray(wd?.items) || !Array.isArray(liq?.sold) || !(wd.at >= from)) continue; withBoth++;
  const dt = liq.at - wd.at; if (!(dt >= 0 && dt <= ms)) continue;
  const ids = new Set(wd.items.map(i => Number(i[0]))); const same = liq.sold.filter(x => ids.has(Number(x[0])));
  // Inputs the bot's gear plan still lists at the end of the run (its paused and nested plans too).
  const mats = new Set(); for (let q = s.equipmentPlan, d = 0; q && d < 5; q = q.inputPreparation, d++) for (const m of [...(q.materials || []), ...(q.exchange?.materials || [])]) mats.add(Number(m.selfId));
  if (same.length) hits.push({ bot: r.characterId, dtMs: dt, items: same.map(x => x[0]), planInput: same.some(x => mats.has(Number(x[0]))), adena: same.reduce((a, x) => a + x[1] * x[2], 0) });
}
console.log(JSON.stringify({ run: run.split('/').pop(), ms, bots, withBoth, hits: hits.length, planInputHits: hits.filter(h => h.planInput).length, adena: hits.reduce((a, h) => a + h.adena, 0), detail: hits.slice(0, 12) }));
