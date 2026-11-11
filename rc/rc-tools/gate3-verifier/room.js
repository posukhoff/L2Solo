const { DatabaseSync } = require('node:sqlite');
const d = require('/Users/iposukhoff/L2Solo/.claude/worktrees/rel1a/data/Bots/hunt/spots.json');
const room = new Map(d.spots.map(s => [s[0], Math.max(9, Math.min(36, Math.round(Number(s[4] || 1) * 0.75)))]));
for (const [label, file] of process.argv.slice(2).map(a => a.split('='))) {
  const db = new DatabaseSync(file, { readOnly: true });
  for (const standing of [false, true]) {
    const rows = db.prepare(`select spotId, count(*) n from bot_life_state where spotId is not null and activity in ('hunting','resting','grouped','party_wait'${standing ? '' : ",'traveling'"}) group by spotId`).all();
    let spots = 0, viol = 0, maxEx = 0, worst = '', botsOver = 0, bots = 0, unknown = 0, ratioMax = 0, excessSum = 0, over115 = 0;
    for (const r of rows) {
      const cap = room.get(r.spotId); if (!cap) { unknown += r.n; continue; }
      spots++; bots += r.n;
      if (r.n > cap) { viol++; botsOver += r.n; excessSum += r.n - cap; if (r.n > cap * 1.15) over115++; if (r.n - cap > maxEx) { maxEx = r.n - cap; worst = `${r.spotId}:${r.n}/${cap}`; } ratioMax = Math.max(ratioMax, r.n / cap); }
    }
    console.log(`${label} ${standing ? 'standing' : 'with-travel'}: occupied=${spots} over=${viol} over>1.15x=${over115} maxExcess=${maxEx} worst=${worst} maxRatio=${ratioMax.toFixed(2)} botsOnOverSpots=${botsOver}/${bots} excessBots=${excessSum} unknownSpotBots=${unknown}`);
  }
}
