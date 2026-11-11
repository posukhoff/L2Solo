'use strict';
// usage: node rep.js <run dir>: henna improving decisions followed by main goal_failed impossible,
// classified by whether the symbol is in the bot's final henna rows and whether it was the last drawn
const fs = require('fs');
process.chdir('/Users/iposukhoff/L2Solo');
require('/Users/iposukhoff/L2Solo/src/Global');
const Henna = require('/Users/iposukhoff/L2Solo/src/GameServer/Henna/HennaRules');
const { DatabaseSync } = require('node:sqlite');
const dir = process.argv[2];
const db = new DatabaseSync(dir + '/world.sqlite', { readOnly: true });
const lines = fs.readFileSync(dir + '/logs/decision-trace.jsonl', 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const last = new Map(), out = {}, ex = [];
for (const r of lines) {
  if (!r.bot) continue;
  if (r.kind === 'decided' && r.decision === 'build') { last.set(r.bot, r); continue; }
  if (r.kind === 'raise' && r.name === 'goal_failed' && r.reason === 'impossible' && r.thread === 'main') {
    const d = last.get(r.bot); const m = d && /^henna:(\d+):henna:\d+:improving/.exec(d.answer || '');
    if (!m) continue;
    const sym = Number(m[1]);
    const c = db.prepare("SELECT c.classId, json_extract(b.statsJson, '$.lastImprovement') li FROM characters c JOIN bot_life_state b ON b.characterId=c.id WHERE c.id=?").get(r.bot);
    const rows = db.prepare('SELECT slot, symbolId FROM character_hennas WHERE characterId=?').all(r.bot);
    const li = JSON.parse(c.li || 'null');
    const has = rows.some(x => x.symbolId === sym), full = rows.length >= Henna.slotsForClass(c.classId);
    const lastDrawnJustBefore = li && li.kind === 'henna' && li.at <= r.at && r.at - li.at < 10000;
    const k = (has ? 'drawn' : 'not_drawn') + (full ? '/full_now' : '/free_now') + (lastDrawnJustBefore ? '/last_draw<10s_before' : '');
    out[k] = (out[k] || 0) + 1;
    if (lastDrawnJustBefore) ex.push(`${r.bot} sym ${sym} decided ${d.at} drawn ${li.at} failed ${r.at} rows ${rows.map(x=>x.symbolId)}`);
  }
}
console.log(out); console.log(ex.slice(0, 8).join('\n'));
