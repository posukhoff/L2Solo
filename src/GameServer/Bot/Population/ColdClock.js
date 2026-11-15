'use strict';
// The cold bot's clock: the one owner of its time line. A C4 player's time is
// one line: what it lived is lived once. A cold step resolves at a moment and
// credits the time since the bot's clock; a round may run past its step (its
// last walk, fight or rest ends later), and the next step goes on from there.
// A round advances action by action from where it starts, the bot regenerating
// by its posture all the while (standing, walking, seated) with its pet.
// Callers: the kernel's steps (regular, command, party, window rounds) and main's
// cold steps (PopulationService), every hand-over that writes the clock (hot,
// a PvP encounter, a party conflict), the solo round and the rest step
// (BackgroundResolver). Hot is not a caller: a hot body lives in real time.
// Pure: plain state in, numbers out.

const Formulas = invoke('GameServer/Formulas');
const { coldRestRegenPerTick, restRegenPerTick } = require('./ColdRest');
const ColdSummonProfile = require('./ColdSummonProfile');

// A bot with no clock yet credits its first step this much.
const FIRST_STEP_MS = 60000;

// The clock the bot's time is credited through: its last round's end, or a
// window's end (stats.huntedThrough), whichever is later.
function own(state) {
    return Math.max(Number(state?.timing?.lastResolvedAt) || 0, Number(state?.stats?.huntedThrough) || 0);
}

// Where a step at timestamp starts crediting. A bot that held for an event
// (stats.eventWait, BotLifeState.prepareResolve) steps at that event or at the
// wait's known end: the time before it was lived waiting, not hunting.
function since(state, timestamp) {
    if (state?.stats?.eventWait) return timestamp;
    return own(state) || timestamp - FIRST_STEP_MS;
}

// The moment a step woken at now resolves at: never before the bot's clock (a
// step woken inside a round's run-past or a window goes on from its end), whole.
function stepAt(state, now) {
    return Math.ceil(Math.max(Number(now) || 0, own(state)));
}

// The step's credited span: the time since its start, none when the step lies
// at or before it. The only producer of a cold round's elapsedMs.
function elapsedMs(state, timestamp) {
    return Math.max(0, timestamp - since(state, timestamp));
}

// The clock a hand-over writes at `at`: the clock never moves back, so time a
// round already credited past `at` is not credited again.
function handedAt(state, at) {
    return Math.max(at, Number(state?.timing?.lastResolvedAt) || 0);
}

// The bot's regeneration rates for a round: on its feet (C4 x1.1, its standing
// passives) and walking (x0.7), keyed by its profile at the round's start.
function rates(state, profile, at) {
    return {
        profile,
        standing: coldRestRegenPerTick(state, { profile, standing: true, timestamp: at }),
        moving: coldRestRegenPerTick(state, { profile, moving: true, timestamp: at })
    };
}

// A saved pet's HP after ms out of a fight (its template's revHp per regen
// tick); the stats unchanged without a wounded pet. profile: its owner's.
function petHealed(stats, ms, profile) {
    const saved = stats?.coldCombat?.summon;
    if (!saved?.active || !(Number(saved.hp) > 0)) return stats;
    const summon = ColdSummonProfile.fullSummon(profile, saved);
    if (!(Number(summon.hp) < Number(summon.maxHp))) return stats;
    const hp = Math.min(Number(summon.maxHp), Number(summon.hp) + Number(summon.revHp || 0) * Math.max(0, ms) / Formulas.REGEN_TICK_MS);
    return { ...stats, coldCombat: { ...stats.coldCombat, summon: { ...summon, hp } } };
}

// Regeneration over a span at a rate (per regen tick), the pet's with it.
// body: { vitals, stats }; returns a new body (stats replaced only when the pet heals).
function regen(body, ms, rate, profile) {
    if (!(ms > 0)) return body;
    const ticks = ms / Formulas.REGEN_TICK_MS, vitals = body.vitals;
    return {
        vitals: { ...vitals, hp: Math.min(vitals.maxHp, vitals.hp + rate.hp * ticks), mp: Math.min(vitals.maxMp, vitals.mp + rate.mp * ticks) },
        stats: petHealed(body.stats, ms, profile)
    };
}

// A rest's regeneration over ms from at: seated, or standing when that refills
// the rest faster (restRegenPerTick, read at the sit); the pet rests with it.
// One rule for the rest step and a rest inside a round. profile: the bot's at at.
// Returns { vitals, stats, regen }.
function seated(state, body, ms, at, profile, options = {}) {
    const vitals = body.vitals;
    const rate = restRegenPerTick({ ...state, vitals, stats: body.stats }, vitals.maxHp - vitals.hp, vitals.maxMp - vitals.mp,
        { profile, timestamp: at, ...options });
    const ticks = Math.max(0, Number(ms) || 0) / Formulas.REGEN_TICK_MS;
    return {
        vitals: { ...vitals, hp: Math.min(vitals.maxHp, vitals.hp + rate.hp * ticks), mp: Math.min(vitals.maxMp, vitals.mp + rate.mp * ticks) },
        stats: petHealed(body.stats, ms, profile),
        regen: rate
    };
}

// A round's clock from where it starts: its moment, the time it acted (fights,
// buffs, heals, walks) and the time it sat. Round-local: only these functions move it.
function open(from) {
    return { at: from, activeMs: 0, seatedMs: 0 };
}

// The round acts for ms in a posture ('standing': a fight, a cast, a heal, standing;
// 'moving': a walk, a flight's run): the clock moves on, the body regenerates at
// the posture's rate. Returns the new body.
function advance(clock, body, ms, posture, roundRates) {
    clock.at += ms;
    clock.activeMs += ms;
    return regen(body, ms, posture === 'moving' ? roundRates.moving : roundRates.standing, roundRates.profile);
}

// The bot sits at the clock's moment for needMs (the rest it needs, read at the
// sit), seated up to the round's bound. A rest that ends by the bound stands it up
// there (up: true, the clock at the rest's end); past it the bot rests on to
// restUntil (the rest step goes on from the round's end), the clock at the sit.
function sit(clock, body, needMs, bound, state, roundRates, options = {}) {
    const end = clock.at + needMs;
    const sat = Math.max(0, Math.min(end, bound) - clock.at);
    const rested = seated(state, body, sat, clock.at, roundRates.profile, options);
    clock.seatedMs += sat;
    const restedBody = { vitals: rested.vitals, stats: rested.stats };
    if (end > bound) return { body: restedBody, up: false, restUntil: Math.ceil(end) };
    clock.at = end;
    return { body: restedBody, up: true };
}

// The round's end: its bound, or its last action's end when that runs past it.
function end(clock, bound) {
    return Math.max(bound, clock.at);
}

module.exports = { own, since, stepAt, elapsedMs, handedAt, rates, regen, seated, open, advance, sit, end };
