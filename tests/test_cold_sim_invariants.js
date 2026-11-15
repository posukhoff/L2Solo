'use strict';
const assert = require('node:assert/strict');
const path = require('path');

// The cold simulation's conservation laws on a fixed sample: nine cells of the
// spot table (a spot's species, a class line, a level, shots) hunted through
// the generator's own hunt for two hours at three seeds. Every hunt tiles its
// clock, credits each regen interval its rate, closes its HP, keeps its stamps
// inside their intervals and its loot inside the bag, and its row fits in its
// hour per kill. The same laws fail on each defect the cold round had
// (time counted twice, regen as one capped lump, a round framed from its
// moment, loot past the bag), re-introduced here by a wrapper around the
// game's own functions. The fixture holds the nine spots' catalogue rows (the
// server's spot catalogue, SpotService + SpotProfiles), so no world spawns.
process.env.TZ = 'UTC';
const Generator = require('../scripts/generate-spot-table');
const Decompose = require('../scripts/economy-model/fight/decompose');
const Invariants = require('../scripts/economy-model/fight/invariants');

const FIXTURE = path.join(__dirname, 'fixtures', 'cold_sim_invariants.json');
const HOURS = 2;
const SEEDS = 3;
Generator.loadSimulation(FIXTURE);
const fixture = require(FIXTURE);
const BR = invoke('GameServer/Bot/Population/BackgroundResolver');
const ColdClock = invoke('GameServer/Bot/Population/ColdClock');
const ColdRest = invoke('GameServer/Bot/Population/ColdRest');
const SurvivalFloor = invoke('GameServer/Bot/Population/SurvivalFloor');
const InventoryLimits = invoke('GameServer/Inventory/InventoryLimits');
const Formulas = invoke('GameServer/Formulas');
const items = invoke('GameServer/DataCache').items;
const profiles = new Map(fixture.profiles.map((profile) => [String(profile.id), profile]));

const vitalsOf = (vitals) => ({ hp: Number(vitals.hp), mp: Number(vitals.mp), maxHp: Number(vitals.maxHp), maxMp: Number(vitals.maxMp) });

// One hunt recorded step by step at the generator's seam (BackgroundResolver.resolveSolo)
// and the clock's (ColdClock: every span a step credits regen over). defect: wrappers
// that re-introduce a defect ({ open, advance, result }).
function recordHunt(cell, seed, defect = {}) {
    const real = { resolveSolo: BR.resolveSolo, open: ColdClock.open, advance: ColdClock.advance, sit: ColdClock.sit, seated: ColdClock.seated };
    const steps = [];
    let step = null;
    ColdClock.open = (from) => {
        const clock = defect.open ? defect.open(real.open, from, step) : real.open(from);
        if (step) step.opens.push(clock.at);
        return clock;
    };
    ColdClock.advance = (clock, body, ms, posture, rates) => {
        const at = clock.at, before = vitalsOf(body.vitals);
        const after = defect.advance ? defect.advance(real.advance, clock, body, ms, posture, rates, step) : real.advance(clock, body, ms, posture, rates);
        if (step) step.intervals.push({ at, ms, rate: posture === 'moving' ? rates.moving : rates.standing, before, after: vitalsOf(after.vitals) });
        return after;
    };
    ColdClock.sit = (clock, body, needMs, bound, state, rates, options = {}) => {
        const at = clock.at, sat0 = clock.seatedMs, before = vitalsOf(body.vitals);
        const rate = ColdRest.restRegenPerTick({ ...state, vitals: body.vitals, stats: body.stats }, before.maxHp - before.hp, before.maxMp - before.mp,
            { profile: rates.profile, timestamp: at, ...options });
        const result = real.sit(clock, body, needMs, bound, state, rates, options);
        if (step) step.intervals.push({ at, ms: clock.seatedMs - sat0, rate, before, after: vitalsOf(result.body.vitals) });
        return result;
    };
    // The rest step passes its moment: it sits the span before it.
    ColdClock.seated = (state, body, ms, at, profile, options) => {
        const result = real.seated(state, body, ms, at, profile, options);
        if (step) step.intervals.push({ at: at - ms, ms, rate: result.regen, before: vitalsOf(body.vitals), after: vitalsOf(result.vitals) });
        return result;
    };
    BR.resolveSolo = (options) => {
        const state = options.state;
        step = { t: options.timestamp, elapsedMs: options.elapsedMs, intervals: [], opens: [], stamps: [],
            before: { activity: state.activity, ...vitalsOf(state.vitals) } };
        let result;
        try {
            result = real.resolveSolo(options);
            if (defect.result) result = defect.result(result, options);
        } finally {
            const done = step;
            step = null;
            if (result) {
                const debug = result.debug || {}, patch = result.patch || {};
                const after = { ...state, ...patch, vitals: { ...state.vitals, ...(patch.vitals || {}) }, inventory: patch.inventory || state.inventory };
                const gained = (result.materialize?.items || []).length;
                Object.assign(done, {
                    round: Number.isFinite(debug.combatMs), combatMs: Number(debug.combatMs) || 0, walkedMs: Number(debug.walkedMs) || 0,
                    seatedMs: Number(debug.seatedMs) || 0, doneAt: Number(result.doneAt) || 0, restUntil: Number(patch.stats?.restUntil) || 0,
                    nextResolveAt: Number(result.nextResolveAt) || 0, died: debug.died === true, taken: Number(debug.damageTaken) || 0,
                    potionsUsed: Number(debug.potionsUsed) || 0, heals: Number(debug.heals) || 0, gapHeals: Number(debug.gapHeals) || 0,
                    after: { activity: after.activity, ...vitalsOf(after.vitals) }, gained,
                    bag: gained ? { slots: SurvivalFloor.stateInventory(after, items).slots, slotLimit: InventoryLimits.forState(after) } : null
                });
                steps.push(done);
            }
        }
        return result;
    };
    const base = Decompose.speciesSpot(profiles.get(cell.spotId), cell.selfId);
    const spot = seed ? { ...base, id: `${base.id}#${seed}` } : base;
    const classId = Generator.classFor(cell.line, cell.level);
    let sum;
    try {
        sum = Generator.hunt(spot, cell.line, cell.level, cell.form, HOURS, undefined, Decompose.creationKit(classId), classId);
    } finally {
        Object.assign(BR, { resolveSolo: real.resolveSolo });
        Object.assign(ColdClock, { open: real.open, advance: real.advance, sit: real.sit, seated: real.seated });
    }
    return { steps, sum };
}

// Every cell at every seed under one defect: the violations by kind and a sample of each.
function sweep(defect) {
    const kinds = {}, sample = {};
    let hunts = 0, kills = 0, deaths = 0;
    for (const cell of fixture.cells) {
        for (let seed = 0; seed < SEEDS; seed++) {
            const hunt = recordHunt(cell, seed, defect);
            const row = Generator.perKill(hunt.sum);
            const { violations } = Invariants.checkHunt(hunt, { row, tickMs: Formulas.REGEN_TICK_MS, rounding: Generator.ROUNDING });
            hunts += 1;
            kills += hunt.sum.mobs;
            deaths += hunt.sum.deaths;
            for (const violation of violations) {
                kinds[violation.kind] = (kinds[violation.kind] || 0) + 1;
                sample[violation.kind] ||= `${cell.spotId}/${cell.selfId} L${cell.level} line ${cell.line} seed ${seed} step ${violation.step}: ${violation.detail}`;
            }
        }
    }
    return { kinds, sample, hunts, kills, deaths };
}

const started = Date.now();
const head = sweep();
console.log(`head: ${head.hunts} hunts, ${head.kills} kills, ${head.deaths} deaths, violations ${JSON.stringify(head.kinds)}`);
for (const line of Object.values(head.sample)) console.log(`  ${line}`);
assert.ok(head.kills > 1000 && head.deaths > 0, `the sample hunts and dies (${head.kills} kills, ${head.deaths} deaths)`);
assert.deepStrictEqual(head.kinds, {}, 'the cold hunt keeps every law');

// Each defect the cold round had, re-introduced, breaks its law.
const lumped = new WeakSet();
const defects = {
    // The generator counted a round's combat again as its rest.
    'time counted twice': [{ result: (result) => ({ ...result, debug: { ...result.debug, seatedMs: (Number(result.debug?.seatedMs) || 0) + (Number(result.debug?.combatMs) || 0) } }) }, 'time.twice'],
    // A round's standing regen applied as one lump at its opening, capped by the bar,
    // and none over the round's own spans.
    'regen as a capped lump': [{ advance: (advance, clock, body, ms, posture, rates, step) => {
        if (step && !lumped.has(step)) {
            lumped.add(step);
            const lump = advance({ ...clock }, body, step.elapsedMs, posture, rates);
            clock.at += ms;
            clock.activeMs += ms;
            return lump;
        }
        clock.at += ms;
        clock.activeMs += ms;
        return body;
    } }, 'vitals.rate'],
    // A round framed from its moment instead of the clock it credits.
    'round stamped from its moment': [{ open: (open, from, step) => open(step ? step.t : from) }, 'time.uncovered'],
    // Loot merged past the bag: a hundred more non-stackable pieces.
    'loot past the cap': [{ result: (result) => {
        if (!(result.materialize?.items || []).length || !result.patch?.inventory) return result;
        const piece = items.find((item) => item?.etc?.stackable === false || item?.template?.stackable === false);
        const inventory = { ...result.patch.inventory, [piece.selfId]: { selfId: Number(piece.selfId), amount: 100, stackable: false } };
        return { ...result, patch: { ...result.patch, inventory } };
    } }, 'loot.slots']
};
for (const [name, [defect, kind]] of Object.entries(defects)) {
    const broken = sweep(defect);
    console.log(`${name}: violations ${JSON.stringify(broken.kinds)}`);
    assert.ok(broken.kinds[kind] > 0, `${name} breaks ${kind}`);
}
const seconds = (Date.now() - started) / 1000;
console.log(`cold simulation invariants passed in ${seconds.toFixed(1)} s`);
assert.ok(seconds < 60, `the check stays under a minute (${seconds.toFixed(1)} s)`);
