'use strict';
// The cold bot's clock: the one owner of its time line. A C4 player's time is
// one line: what it lived is lived once. A cold step resolves at a moment and
// credits the time since the bot's clock; a round may run past its step (its
// last walk, fight or rest ends later), and the next step goes on from there.
// Callers: the kernel's steps (regular, command, party, window rounds) and main's
// cold steps (PopulationService), and every hand-over that writes the clock (hot,
// a PvP encounter, a party conflict). Hot is not a caller: a hot body lives in
// real time. Pure: plain state in, numbers out.

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

module.exports = { own, since, stepAt, elapsedMs, handedAt };
