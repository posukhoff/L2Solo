'use strict';
// Where a measured hunt's time and deaths go, per cell of the hunt table: the
// same hunt the builder runs (generate-spot-table hunt, the lift on), watched
// through the module objects the cold resolver calls (BackgroundResolver.resolveSolo
// per step, BotEncounterReadiness at each fight's start, ColdClassPolicy.select
// per bot action, RestPolicy.needsRest), so the fight is the game's code,
// unchanged. Per hunt: the wall clock split into fight, walk, rest sat after
// the fight, rest extensions, death recovery, idle and the overlap of a round's
// combat with the next step (the resolver starts a rest at the round's start,
// not at its fight's end); the rest reasons; HP and MP at each fight's start;
// the bot's actions and skills per kill; potions in fight and at rest; the
// start HP of each fatal fight. A second hunt with the rest moved to the
// fight's end (this script's loop only) shows how much the overlap moves rest
// and kills. Next to it the mean-path fight (expected values through the
// game's class policy, hit and mob action rules) from the rested line and from
// the measured start vitals names the term that carries the error. Offline only.
//   node scripts/economy-model/fight/decompose.js --rows <est rows json> --catalogue <catalogue json>
//        [--adm 40] [--close 20] [--hours 2] [--out <json>]
require('../../../src/Global');
const fs = require('fs');
const Generator = require('../../generate-spot-table');
const HuntTable = require('../hunt-table');
const Lift = require('../hunt-lift');

const BR = invoke('GameServer/Bot/Population/BackgroundResolver');
const ER = invoke('GameServer/Bot/AI/BotEncounterReadiness');
const RP = invoke('GameServer/Bot/AI/RestPolicy');
const CCPol = invoke('GameServer/Bot/Population/ColdClassPolicy');
const CCP = invoke('GameServer/Bot/Population/ColdCombatProfile');
const CMA = invoke('GameServer/Bot/Population/ColdMobAction');
const TM = invoke('GameServer/Bot/AI/BotTargetMatchup');
const Rules = invoke('GameServer/Skills/C4SkillRules');
const Diagnostics = require('../../../src/GameServer/Bot/Economy/EconomyDiagnostics');
const PopulationConfig = require('../../../src/GameServer/Bot/Population/PopulationConfig');

const START = 1_750_000_000_000;
// A mean-path fight stops here (no kill: the bot cannot hurt the mob).
const MEAN_PATH_ACTIONS = 400;
// A potion or gap-heal term is named when the hunt uses this many per kill.
const COUNT_TERM = 0.1;

// The builder's species spot and creation kit (hunt-table.js, whose functions
// are not exported: that file is a stamped input of the table).
function speciesSpot(spot, selfId) {
    const entries = spot.npcEntries.filter(entry => Number(entry.selfId) === selfId);
    const total = spot.npcEntries.reduce((sum, entry) => sum + Math.max(1, Number(entry.count) || 1), 0);
    const count = entries.reduce((sum, entry) => sum + Math.max(1, Number(entry.count) || 1), 0);
    const levelCounts = {};
    for (const entry of entries) levelCounts[entry.level] = (levelCounts[entry.level] || 0) + Math.max(1, Number(entry.count) || 1);
    return { ...spot, npcEntries: entries, npcSelfIds: [selfId], npcNames: [entries[0].name],
        density: (Number(spot.density) || 1) * count / total, levelCounts,
        dominantLevels: Object.entries(levelCounts).map(([level, held]) => ({ level: Number(level), count: held })).sort((a, b) => b.count - a.count) };
}
function creationKit(classId) {
    const Data = invoke('GameServer/DataCache'), Starter = invoke('GameServer/Knowledge/StarterItemCatalog');
    const rows = Starter.starterRows(Data.newbieItems, classId, Data.items);
    return bot => {
        const inventory = {};
        for (const row of rows) inventory[String(row.selfId)] = row.equipped
            ? { selfId: Number(row.selfId), amount: 1, equipped: true, equippedCount: 1, equippedSlots: [row.slot], slot: row.slot }
            : { selfId: Number(row.selfId), amount: Number(row.amount) || 1 };
        bot.inventory = inventory;
    };
}

const hpOrMp = need => need.hp < RP.THRESHOLDS.solo.hp ? 'hp' : 'mp';

// One hunt (Generator.hunt's arguments) watched step by step. moveRest: the
// rest of a round starts at its combat's end and regenerates only while sat.
function watchHunt({ spot, line, level, form, hours, classId, kit, moveRest = false }) {
    const end = START + hours * 3600000;
    const real = { resolveSolo: BR.resolveSolo, atVitals: ER.atVitals, evaluate: ER.evaluate, needsRest: RP.needsRest, select: CCPol.select,
        diagnostics: PopulationConfig.developerDiagnostics };
    let rec = null, prev = null, mark = null, stepNeed = null, shift = 0;
    const fresh = () => ({ parts: { fight: 0, walk: 0, rest: 0, restExt: 0, death: 0, idle: 0, overlap: 0 }, restInCombat: 0, beyondEnd: 0, restUnsat: 0, restUnsatRounds: 0,
        reportedRest: 0, restReasons: {}, marks: [], seen: { profiles: null, view: null, fp: null } });
    const close = next => {
        const d = Math.min(next, end) - prev.t, parts = rec.parts;
        if (prev.kind === 'hunt') {
            const inCombat = Math.min(prev.c, d), rem = d - inCombat;
            parts.walk += prev.walk;
            parts.fight += prev.c - prev.walk;
            parts.overlap += prev.c - inCombat;
            if (prev.resting) {
                parts.rest += rem;
                rec.restInCombat += inCombat;
                rec.reportedRest += Math.max(0, prev.restUntil - prev.t);
                rec.beyondEnd += Math.max(0, prev.restUntil - Math.max(prev.t + prev.c, end));
                const why = rec.restReasons[prev.reason] ||= { n: 0, ms: 0, asked: 0 };
                why.n += 1; why.ms += rem; why.asked += Math.max(0, prev.restUntil - prev.t - (moveRest ? prev.c : 0));
            } else {
                parts.idle += rem;
                // A rest the round set without sitting down (the builder's sums count it as rest).
                rec.reportedRest += Math.max(0, prev.restUntil - prev.t);
                rec.restUnsat += Math.max(0, prev.restUntil - prev.t);
                if (prev.restUntil > prev.t) rec.restUnsatRounds += 1;
            }
        } else if (prev.kind === 'rest') parts.restExt += d;
        else if (prev.kind === 'dead') parts.death += d;
        else if (prev.resting) {
            parts.rest += d;
            const why = rec.restReasons[prev.reason] ||= { n: 0, ms: 0, asked: 0 };
            why.n += 1; why.ms += d; why.asked += d;
        } else parts.idle += d;
    };
    BR.resolveSolo = options => {
        if (options.timestamp === START) { rec = fresh(); prev = null; mark = null; shift = 0; Diagnostics.reset(); }
        else if (prev) close(options.timestamp);
        const state = options.state, dead = state.activity === 'dead' || Number(state.vitals?.hp) <= 0;
        const kind0 = dead ? 'dead' : state.activity === 'resting' ? 'rest' : null;
        if (kind0 === 'rest' && shift > 0) options = { ...options, elapsedMs: Math.max(0, options.elapsedMs - shift) };
        shift = 0;
        stepNeed = null;
        const marksBefore = rec.marks.length, fleesBefore = fleeCount();
        let result = real.resolveSolo(options);
        const debug = result.debug || {}, patch = result.patch || {};
        const kind = kind0 || (Number.isFinite(debug.combatMs) ? 'hunt' : 'other');
        const resting = patch.activity === 'resting';
        let restUntil = Number(patch.stats?.restUntil) || 0;
        const c = kind === 'hunt' ? Number(debug.combatMs) : 0;
        if (moveRest && kind === 'hunt' && resting && c > 0) {
            restUntil += c;
            shift = c;
            result = { ...result, patch: { ...patch, stats: { ...patch.stats, restUntil } }, nextResolveAt: restUntil };
        }
        if (debug.died && rec.marks.length) rec.marks[rec.marks.length - 1].died = true;
        let reason = debug.reason || 'other';
        if (kind === 'hunt' && resting) {
            const last = rec.marks.length > marksBefore ? rec.marks[rec.marks.length - 1] : null;
            if (fleeCount() > fleesBefore) reason = 'fled';
            else if (last && last.actions === 0 && last.ready === false) reason = 'before_not_ready';
            else if (last && last.actions === 0 && last.need) reason = `before_${hpOrMp(last)}`;
            else if (stepNeed) reason = `after_${hpOrMp(stepNeed)}`;
            else reason = patch.stats?.lastReason || 'other';
        }
        prev = { t: options.timestamp, kind, c, walk: Number(debug.walkedMs) || 0, resting, restUntil, reason };
        return result;
    };
    ER.atVitals = (profiles, hp, mp, pet) => {
        const owner = profiles.find(profile => profile.servitor !== true);
        rec.seen.profiles ||= profiles;
        mark = { hp, mp, maxHp: owner.maxHp, maxMp: owner.maxMp, actions: 0, casts: 0, skills: {}, ready: null, need: null, died: false };
        rec.marks.push(mark);
        return real.atVitals(profiles, hp, mp, pet);
    };
    ER.evaluate = (remaining, target, attacksOf) => {
        const verdict = real.evaluate(remaining, target, attacksOf);
        rec.seen.view ||= target;
        if (mark && mark.ready === null) mark.ready = verdict.ready;
        return verdict;
    };
    RP.needsRest = (subject, hpRatio, mpRatio, options) => {
        const out = real.needsRest(subject, hpRatio, mpRatio, options);
        if (mark && mark.actions === 0 && mark.need === null) mark.need = out;
        else if (mark && mark.actions > 0) stepNeed = out ? { hp: hpRatio, mp: mpRatio } : null;
        return out;
    };
    CCPol.select = (profile, context) => {
        const selected = real.select(profile, context);
        if (!context?.prepare && mark) {
            rec.seen.fp ||= profile;
            const skill = selected?.skill || null, key = skill ? String(skill.selfId) : 'weapon';
            mark.actions += 1;
            if (skill) mark.casts += 1;
            mark.skills[key] = (mark.skills[key] || 0) + 1;
        }
        return selected;
    };
    PopulationConfig.developerDiagnostics = true;
    try {
        const sum = Generator.hunt(spot, line, level, form, hours, undefined, kit, classId);
        if (prev) close(end);
        const counts = Diagnostics.metrics().counts || {};
        rec.restPotions = Number(counts['cold_fight:potion:rest'] || 0);
        return { sum, rec };
    } finally {
        Object.assign(BR, { resolveSolo: real.resolveSolo });
        Object.assign(ER, { atVitals: real.atVitals, evaluate: real.evaluate });
        RP.needsRest = real.needsRest;
        CCPol.select = real.select;
        PopulationConfig.developerDiagnostics = real.diagnostics;
        Diagnostics.reset();
    }
}

function fleeCount() {
    const counts = Diagnostics.metrics().counts || {};
    return Object.entries(counts).filter(([key]) => key.startsWith('cold_fight:flee:')).reduce((sum, [, n]) => sum + n, 0);
}

const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const pct = (values, p) => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

// A watched hunt per kill: the cell the builder writes, the wall parts (s per
// kill; fight + walk + rest + restExt + death + idle - overlap = the hunt's
// time), rest reasons, start vitals, rotation, potions and fatal fights.
function summarize({ sum, rec }, hours) {
    const mobs = sum.mobs, perKill = ms => mobs > 0 ? ms / 1000 / mobs : null;
    const fights = rec.marks.filter(m => m.actions > 0);
    const skills = {};
    for (const m of fights) for (const [key, n] of Object.entries(m.skills)) skills[key] = (skills[key] || 0) + n;
    const actions = fights.reduce((a, m) => a + m.actions, 0), casts = fights.reduce((a, m) => a + m.casts, 0);
    return {
        cell: HuntTable.cellOf(sum, hours), mobs, deaths: sum.deaths, kills: sum.mobs / hours,
        wall: Object.fromEntries(Object.entries(rec.parts).map(([k, ms]) => [k, perKill(ms)])),
        wallMs: { ...rec.parts }, restInCombat: perKill(rec.restInCombat), reportedRestMs: rec.reportedRest, beyondEndMs: rec.beyondEnd, restUnsatMs: rec.restUnsat, restUnsatRounds: rec.restUnsatRounds,
        restReasons: Object.fromEntries(Object.entries(rec.restReasons).map(([k, r]) => [k, { n: r.n, sat: perKill(r.ms), asked: perKill(r.asked) }])),
        startHp: mean(fights.map(m => m.hp / m.maxHp)), startMp: mean(fights.map(m => m.mp / Math.max(1, m.maxMp))),
        startMpP10: pct(fights.map(m => m.mp / Math.max(1, m.maxMp)), 0.1),
        fights: fights.length, actionsPerKill: mobs > 0 ? actions / mobs : null, castsPerKill: mobs > 0 ? casts / mobs : null,
        skills: Object.fromEntries(Object.entries(skills).sort((a, b) => b[1] - a[1]).slice(0, 4)),
        potions: mobs > 0 ? sum.potions / mobs : null, restPotions: mobs > 0 ? rec.restPotions / mobs : null,
        fightPotions: mobs > 0 ? (sum.potions - rec.restPotions) / mobs : null, gapHeals: mobs > 0 ? sum.gapHeals / mobs : null,
        buffCasts: mobs > 0 ? sum.buffCasts / mobs : null,
        fatal: rec.marks.filter(m => m.died).map(m => ({ hp: m.hp / m.maxHp, mp: m.mp / Math.max(1, m.maxMp) })),
        seen: rec.seen
    };
}

// The fight on expected values from (hp, mp): bot actions by the game's class
// policy with cooldowns and MP, expected hit, action delay; mob actions at their
// mean per action and pace (ColdMobAction.actionMix).
function meanPathFight(p, view, fp, hp, mp) {
    const shot = p.shot || null, mix = CMA.actionMix(view, { profile: p }, 0);
    let t = 0, botAt = 0, mobAt = CCP.openingMs(p, view), mobHp = view.maxHp, actions = 0, casts = 0;
    const cooldowns = {};
    while (mobHp > 0 && actions < MEAN_PATH_ACTIONS) {
        if (botAt <= mobAt) {
            actions += 1;
            t = botAt;
            const skill = CCPol.select(fp, { hp, mp, cooldowns, time: START + t, charges: 0, mob: view, mobHp })?.skill || null;
            let dmg = TM.expectedHit(p, view, skill, shot);
            if (skill && Number(view.pull) > 1 && Rules.hitsArea(Rules.resolveCached(skill))) dmg *= Number(view.pull);
            if (skill) { mp = Math.max(0, mp - Number(skill.mp || 0)); cooldowns[skill.selfId] = START + t + Number(skill.reuse || 0); casts += 1; }
            botAt += CCP.actionDelayMs(fp, skill, CCP.actionShot(shot, skill)?.spiritshot === true);
            mobHp -= Math.max(0.01, dmg);
        } else { t = mobAt; hp -= mix.perAction; mobAt += mix.actionMs; }
    }
    const pull = Math.max(1, Number(view.pull) || 1);
    return { fight: mobHp > 0 ? null : Math.max(t, botAt) / 1000 / pull, castsPerKill: casts / pull, actionsPerKill: actions / pull };
}

// The terms per cell (s per kill unless named a count): what the mean path
// misses from the rested line and from the measured start vitals, what the
// rest overlap moves; the largest seconds term is named, counts are flagged.
function terms(asIs, moved) {
    const seen = asIs.seen, p = seen.profiles?.find(q => q.servitor !== true);
    const out = { simFight: asIs.cell[2], restAsRead: asIs.cell[3], restSat: asIs.wall.rest + asIs.wall.restExt,
        restMoved: moved.wall.rest + moved.wall.restExt, killsAsIs: asIs.kills, killsMoved: moved.kills,
        deathsAsIs: asIs.mobs > 0 ? asIs.deaths / asIs.mobs : null, deathsMoved: moved.mobs > 0 ? moved.deaths / moved.mobs : null };
    if (p && seen.view && seen.fp && asIs.mobs > 0) {
        const line = RP.restedLine(null);
        out.meanRested = meanPathFight(p, seen.view, seen.fp, p.maxHp * line.hp, p.maxMp * line.mp);
        out.meanAtStart = meanPathFight(p, seen.view, seen.fp, p.maxHp * asIs.startHp, p.maxMp * asIs.startMp);
    }
    const seconds = {};
    if (out.meanRested?.fight != null && out.meanAtStart?.fight != null) {
        seconds.mpAtStart = Math.abs(out.meanAtStart.fight - out.meanRested.fight);
        seconds.rotation = Math.abs(out.simFight - out.meanAtStart.fight);
    }
    if (out.restAsRead != null) seconds.restOverlap = Math.abs(out.restMoved - out.restAsRead);
    out.seconds = seconds;
    const named = Object.entries(seconds).sort((a, b) => b[1] - a[1])[0];
    out.named = [named ? named[0] : 'none'];
    if (asIs.fightPotions > COUNT_TERM) out.named.push('potions');
    if (asIs.gapHeals > COUNT_TERM) out.named.push('gapHeals');
    return out;
}

// One cell: the as-is hunt, the hunt with the rest moved, their terms.
function decompose({ spot, selfId, line, level, form, hours = 2, classId = Generator.classFor(line, level) }) {
    const hunted = selfId ? speciesSpot(spot, Number(selfId)) : spot, kit = creationKit(classId);
    const asIs = summarize(watchHunt({ spot: hunted, line, level, form, hours, classId, kit }), hours);
    const moved = summarize(watchHunt({ spot: hunted, line, level, form, hours, classId, kit, moveRest: true }), hours);
    const out = { asIs, moved, terms: terms(asIs, moved) };
    delete asIs.seen; delete moved.seen;
    return out;
}

function sample(rows, n) {
    const out = [], step = rows.length / Math.max(1, n);
    for (let i = 0; i < n && rows.length; i++) out.push(rows[Math.floor(i * step + step / 2)]);
    return out;
}

function main(argv) {
    const arg = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
    const hours = Number(arg('hours') || 2), nAdm = Number(arg('adm') || 40), nClose = Number(arg('close') || 20);
    const catalogue = arg('catalogue'), rowsFile = arg('rows');
    if (!catalogue || !rowsFile) throw new Error('decompose: --rows <est rows json> and --catalogue <catalogue json> are required');
    process.env.TZ = 'UTC';
    Generator.loadSimulation(catalogue);
    const profiles = new Map(JSON.parse(fs.readFileSync(catalogue, 'utf8')).profiles.map(spot => [String(spot.id), spot]));
    const rows = JSON.parse(fs.readFileSync(rowsFile, 'utf8')).rows.filter(r => r.cell[0] > 0);
    const adm = rows.filter(r => r.cell[0] >= 10 && r.cell[1] <= 0.05), close = rows.filter(r => r.cell[1] > 0.005 && r.cell[1] < 1);
    const cells = [...sample(adm, nAdm).map(r => ({ r, kind: 'admitted' })), ...sample(close, nClose).map(r => ({ r, kind: 'close' }))];
    Lift.lift(true);
    const out = [];
    try {
        for (const { r, kind } of cells) {
            const [, level, spotId, selfId, form] = r.k.split('|');
            const one = decompose({ spot: profiles.get(spotId), selfId, line: String(r.line), level: Number(level), form: Number(form), hours });
            out.push({ k: r.k, line: r.line, kind, build: r.cell, estimate: r.est?.fight ?? null, ...one });
        }
    } finally { Lift.lift(false); }
    if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify(out));
    report(out);
    return out;
}

function report(out) {
    const f = v => v == null ? '-' : Number(v).toFixed(3);
    const rel = (a, b) => b > 0 ? Math.abs(a - b) / b : null;
    for (const kind of ['admitted', 'close']) {
        const g = out.filter(o => o.kind === kind && o.asIs.mobs > 0);
        if (!g.length) continue;
        const named = {};
        for (const o of g) named[o.terms.named[0]] = (named[o.terms.named[0]] || 0) + 1;
        const flag = name => g.filter(o => o.terms.named.includes(name)).length;
        const q = (values, p) => f(pct(values.filter(v => v != null), p));
        const same = g.filter(o => o.build && o.asIs.cell.every((v, i) => v === o.build[i])).length;
        console.log(`${kind} cells ${g.length} (as-is cell equal to the build's: ${same}); largest term: ${JSON.stringify(named)}; potions ${flag('potions')}, gap heals ${flag('gapHeals')}`);
        for (const name of ['mpAtStart', 'rotation', 'restOverlap']) {
            const v = g.map(o => o.terms.seconds[name]);
            console.log(`  ${name} s/kill p50 ${q(v, 0.5)} p90 ${q(v, 0.9)}`);
        }
        console.log(`  fight |err| mean path rested p50 ${q(g.map(o => rel(o.terms.meanRested?.fight, o.terms.simFight)), 0.5)} at start ${q(g.map(o => rel(o.terms.meanAtStart?.fight, o.terms.simFight)), 0.5)} estimate ${q(g.map(o => rel(o.estimate, o.terms.simFight)), 0.5)}`);
        console.log(`  start MP p50 ${q(g.map(o => o.asIs.startMp), 0.5)}, casts/kill sim p50 ${q(g.map(o => o.asIs.castsPerKill), 0.5)} mean path ${q(g.map(o => o.terms.meanAtStart?.castsPerKill), 0.5)}`);
        console.log(`  rest s/kill as read p50 ${q(g.map(o => o.terms.restAsRead), 0.5)}, sat as-is ${q(g.map(o => o.terms.restSat), 0.5)}, moved ${q(g.map(o => o.terms.restMoved), 0.5)}; kills/h moved/as-is p50 ${q(g.map(o => o.terms.killsMoved / o.terms.killsAsIs), 0.5)} p10 ${q(g.map(o => o.terms.killsMoved / o.terms.killsAsIs), 0.1)}`);
        console.log(`  deaths/kill as-is p90 ${q(g.map(o => o.terms.deathsAsIs), 0.9)} moved ${q(g.map(o => o.terms.deathsMoved), 0.9)}; fatal fight start HP mean ${f(mean(g.flatMap(o => o.asIs.fatal.map(d => d.hp))))}`);
        const reasons = {};
        for (const o of g) for (const [k, r] of Object.entries(o.asIs.restReasons)) reasons[k] = (reasons[k] || 0) + r.n;
        console.log(`  rest reasons (rounds): ${JSON.stringify(reasons)}`);
    }
}

module.exports = { decompose, watchHunt, summarize, meanPathFight, terms, main, speciesSpot, creationKit };
if (require.main === module) main(process.argv.slice(2));
