'use strict';
// Read-only invariants of one run's end world vs the start save. Usage: node inv.js <world.sqlite> <save.sqlite> <run.json> <trace.jsonl>
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const [worldPath, savePath, runPath, tracePath] = process.argv.slice(2);
const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
const t0 = Date.parse(run.startedAt), wS = Date.parse(run.windowStart), wE = Date.parse(run.windowEnd);
const hours = (wE - t0) / 3600000;
const db = new DatabaseSync(worldPath, { readOnly: true });
const sv = new DatabaseSync(savePath, { readOnly: true });

const WDIR = '/Users/iposukhoff/L2Solo/.claude/worktrees/rel1a/data/Items/Weapons';
const rank = new Map();
for (const f of fs.readdirSync(WDIR).filter(f => f.endsWith('.json'))) {
    let arr; try { arr = JSON.parse(fs.readFileSync(path.join(WDIR, f), 'utf8')); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    for (const w of arr) if (w && w.selfId && w.etc) rank.set(w.selfId, String(w.etc.rank || 'none').toLowerCase());
}
const SHOTS = { none: [1835, 2509, 3947, 5789, 5790], d: [1463, 2510, 3948], c: [1464, 2511, 3949], b: [1465, 2512, 3950], a: [1466, 2513, 3951], s: [1467, 2514, 3952] };
const ALL_SHOTS = new Set(Object.values(SHOTS).flat());
const MINLV = { none: 1, d: 20, c: 40, b: 52, a: 61, s: 76 };

const bots = db.prepare(`select l.characterId id, l.accountName acc, l.phase, l.activity, l.activityStartedAt, l.updatedAt, l.lastResolvedAt,
  l.nextResolveAt, l.spotId, l.currentRegion, l.deathCount, c.level, c.exp, c.locX, c.locY, l.statsJson
  from bot_life_state l join characters c on c.id=l.characterId`).all();
const start = new Map(sv.prepare(`select l.characterId id, c.exp, c.level, l.deathCount, c.locX, c.locY, l.activity from bot_life_state l join characters c on c.id=l.characterId`).all().map(r => [r.id, r]));
const adena = (d, tbl) => new Map(d.prepare(`select characterId id, sum(amount) a from ${tbl} where selfId=57 group by characterId`).all().map(r => [r.id, r.a]));
const aEnd = adena(db, 'items'), aStart = adena(sv, 'items'), wEnd = adena(db, 'warehouse_items'), wStart = adena(sv, 'warehouse_items');
const items = new Map();
for (const r of db.prepare(`select characterId id, selfId, amount, equipped, slot from items`).all()) {
    if (!items.has(r.id)) items.set(r.id, []);
    items.get(r.id).push(r);
}
const hunters = bots.filter(b => b.activity !== 'merchant' && !String(b.acc).startsWith('bot_craft_'));
const out = { run: run.sha, hours: +hours.toFixed(3), bots: bots.length, hunters: hunters.length };

// Progress
let dExp = 0, dAd = 0, dAdW = 0, dDeath = 0, lvUp = 0, noProgress = [];
for (const b of hunters) {
    const s = start.get(b.id); if (!s) continue;
    dExp += b.exp - s.exp; lvUp += b.level - s.level;
    dAd += (aEnd.get(b.id) || 0) - (aStart.get(b.id) || 0);
    dAdW += (wEnd.get(b.id) || 0) - (wStart.get(b.id) || 0);
    dDeath += b.deathCount - s.deathCount;
    if (b.exp === s.exp && b.locX === s.locX && b.locY === s.locY && (aEnd.get(b.id) || 0) === (aStart.get(b.id) || 0)) noProgress.push(b.id);
}
const bh = hunters.length * hours;
out.progress = { botHours: +bh.toFixed(1), expPerBotH: Math.round(dExp / bh), adenaInvPerBotH: Math.round(dAd / bh), adenaWhPerBotH: Math.round(dAdW / bh),
    adenaTotalPerBotH: Math.round((dAd + dAdW) / bh), levelUps: lvUp, deathCountDelta: dDeath, deathsPerBotH: +(dDeath / bh).toFixed(4),
    noProgressAllRun: noProgress.length, noProgressIds: noProgress.slice(0, 20) };

// Shots and weapon
const shot = { noWeapon: [], gradeAboveLevel: [], noShotOfGrade: [], shotsOtherGradeOnly: [], ok: 0, noShotByActivity: {} };
for (const b of hunters) {
    const inv = items.get(b.id) || [];
    const weapons = inv.filter(i => i.equipped && rank.has(i.selfId));
    if (!weapons.length) { shot.noWeapon.push(b.id); continue; }
    const r = rank.get(weapons[0].selfId);
    if (b.level < MINLV[r]) shot.gradeAboveLevel.push(`${b.id}:${r}@${b.level}`);
    const have = inv.filter(i => SHOTS[r].includes(i.selfId) && i.amount > 0);
    if (!have.length) {
        const other = inv.some(i => ALL_SHOTS.has(i.selfId) && i.amount > 0);
        (other ? shot.shotsOtherGradeOnly : shot.noShotOfGrade).push(`${b.id}:${r}`);
        const k = `${b.phase}/${b.activity}`; shot.noShotByActivity[k] = (shot.noShotByActivity[k] || 0) + 1;
    } else shot.ok++;
}
out.shots = { ok: shot.ok, noWeapon: shot.noWeapon.length, noWeaponIds: shot.noWeapon.slice(0, 15), gradeAboveLevel: shot.gradeAboveLevel.length, gradeAboveLevelIds: shot.gradeAboveLevel.slice(0, 15),
    noShotOfGrade: shot.noShotOfGrade.length, noShotOfGradeIds: shot.noShotOfGrade.slice(0, 15), otherGradeOnly: shot.shotsOtherGradeOnly.length, otherGradeOnlyIds: shot.shotsOtherGradeOnly.slice(0, 15), noShotByActivity: shot.noShotByActivity };

// Frozen / long in town / lost ground (end state)
const TOWN_ACT = new Set(['shopping', 'crafting']);
const long = [], stale = [], lost = [], deadState = [];
for (const b of hunters) {
    if (b.phase === 'cold' && (b.updatedAt || 0) < wS) stale.push(`${b.id}:${b.activity}:${Math.round((wE - (b.updatedAt || 0)) / 60000)}m`);
    if (b.activity === 'dead') deadState.push(b.id);
    const age = b.activityStartedAt ? (wE - b.activityStartedAt) / 60000 : null;
    if (TOWN_ACT.has(b.activity) && age !== null && age > 15) long.push(`${b.id}:${b.phase}/${b.activity}:${Math.round(age)}m`);
    if (b.activity === 'hunting' && !b.spotId) lost.push(`${b.id}:${b.phase}:hunting-no-spot`);
    if (!b.locX && !b.locY) lost.push(`${b.id}:loc0`);
}
const ages = {};
for (const b of hunters) {
    const age = b.activityStartedAt ? (wE - b.activityStartedAt) / 60000 : -1;
    const k = b.activity; ages[k] ||= { n: 0, over15: 0, over30: 0, max: 0 };
    ages[k].n++; if (age > 15) ages[k].over15++; if (age > 30) ages[k].over30++; ages[k].max = Math.max(ages[k].max, Math.round(age));
}
out.state = { staleColdNoWriteInWindow: stale.length, staleIds: stale.slice(0, 15), townActivityOver15m: long.length, townIds: long.slice(0, 20), lostGround: lost.length, lostIds: lost.slice(0, 15), deadState, activityAges: ages };

// Trace: failures, deaths, per-bot repeats
const fails = {}, failByBot = new Map(), decidedByBot = new Map(), deaths = [], rawFail = [];
let first = Infinity, last = 0;
for (const l of fs.readFileSync(tracePath, 'utf8').split('\n')) {
    if (!l) continue; let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.type) continue;
    first = Math.min(first, r.at); last = Math.max(last, r.at);
    if (r.kind === 'raise' && /^(goal_failed|out_of_money|source_stalled)/.test(r.name)) {
        fails[r.name] = (fails[r.name] || 0) + 1;
        failByBot.set(r.bot, (failByBot.get(r.bot) || 0) + 1);
    }
    if (r.kind === 'failure') rawFail.push(r.site);
    if (r.kind === 'decided') decidedByBot.set(r.bot, (decidedByBot.get(r.bot) || 0) + 1);
    if (r.kind === 'death') deaths.push(`${r.bot}:${r.killer}@${r.spot}`);
    if (r.kind === 'errand' && r.outcome === 'failed') fails['errand_failed'] = (fails['errand_failed'] || 0) + 1;
}
const th = (last - first) / 3600000;
const failTot = Object.values(fails).reduce((a, b) => a + b, 0);
const topFail = [...failByBot.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
const topDec = [...decidedByBot.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
out.trace = { hours: +th.toFixed(3), failRaises: fails, failTotal: failTot, failPerBotH: +(failTot / (hunters.length * th)).toFixed(3),
    topFailBots: topFail.map(([b, n]) => `${b}:${n} (${(n / th).toFixed(1)}/h)`), botsOver10FailPerH: [...failByBot.values()].filter(n => n / th > 10).length,
    topDecidedBots: topDec.map(([b, n]) => `${b}:${n} (${(n / th).toFixed(1)}/h)`), failureSites: rawFail.length, deaths: deaths.length, deathsPerBotH: +(deaths.length / (hunters.length * th)).toFixed(4), deathList: deaths };
console.log(JSON.stringify(out, null, 1));
