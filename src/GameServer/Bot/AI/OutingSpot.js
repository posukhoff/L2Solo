'use strict';

// Which spot a group hunts this outing (a solo bot is a group of one). Taken
// only at an outing's start (the caller names the situations) and held until
// the next one: a group keeps its spot while it fits and re-picks among the
// spots that fit only when it stops fitting; a min-maxer re-picks the best
// fitting spot at every outing's start. It neither searches the spots nor
// values them: the caller hands it the candidates it values, and a candidate's
// value carries no road (where the group stands does not rank the spots).
// Pure on plain data. Callers: the economy model's plane (the game's earning
// choice is to call it too).
//
// A spot fits a group when, for every member:
// - level gap: the member is at most 5 levels above the spot's mobs, where C4
//   gives the full exp (MobExperience.gapFactor; L2JLisvus L2Attackable.java:
//   1743-1749). Our reading for a spot of several species: the spot's mean mob
//   level (avgLevel), not each species. Mobs too strong are the safety's side.
// - safety: the member's expected deaths over the outing (deaths an hour at the
//   spot in the form it hunts, times the outing's hours) are at most the bound
//   (inclusive). The bound is ours and the caller's limit row.
const MobExperience = require('../../Progression/MobExperience');

// members: [{ level }]; candidate: { spotId, value, avgLevel, members: [{ deathsPerHour, outingHours }] } (members' order).
const outingDeaths = ({ deathsPerHour, outingHours }) => (deathsPerHour > 0 ? deathsPerHour * outingHours : 0);

function checkedBound(bound) {
    if (!Number.isFinite(bound) || bound < 0) throw new Error(`no safe outing deaths bound (got ${bound})`);
    return bound;
}

// Why the candidate does not fit the group: 'no_row' (none), 'level_gap', 'unsafe'; null when it fits.
function unfit(candidate, members, bound) {
    checkedBound(bound);
    if (!candidate) return 'no_row';
    if (members.some(member => MobExperience.gapFactor(member.level - candidate.avgLevel) < 1)) return 'level_gap';
    if (candidate.members.some(member => outingDeaths(member) > bound)) return 'unsafe';
    return null;
}

// A min-maxer persona: progression its drive and high ambition (the persona text cards' high trait, BotPersona.js: >= 0.62).
const MIN_MAX_AMBITION = 0.62;
const minMaxer = persona => !!persona && persona.primaryDrive === 'progression' && Number(persona.traits?.ambition) >= MIN_MAX_AMBITION;

// { held: spotId | null, candidates, members, minMax, bound } -> { spotId, reason, refusedUnsafe }.
// reason: 'kept' | 'first' | 'unfit:<why>' | 'minmax' | 'none'; refusedUnsafe: the candidates refused as unsafe.
// No candidate fits: none (never the least deadly of the unsafe ones).
function choose({ held = null, candidates, members, minMax = false, bound }) {
    const own = held === null ? null : candidates.find(candidate => String(candidate.spotId) === String(held)) || null;
    const heldWhy = held === null ? null : unfit(own, members, bound);
    if (held !== null && heldWhy === null && !minMax) return { spotId: String(held), reason: 'kept', refusedUnsafe: 0 };
    let best = null, refusedUnsafe = 0;
    for (const candidate of candidates) {
        const why = unfit(candidate, members, bound);
        if (why === 'unsafe') refusedUnsafe++;
        if (why === null && (!best || candidate.value > best.value)) best = candidate;
    }
    if (!best) return { spotId: null, reason: 'none', refusedUnsafe };
    const reason = held === null ? 'first' : heldWhy !== null ? `unfit:${heldWhy}` : 'minmax';
    return { spotId: String(best.spotId), reason, refusedUnsafe };
}

module.exports = { unfit, choose, minMaxer, MIN_MAX_AMBITION };
