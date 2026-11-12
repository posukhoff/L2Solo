'use strict';

// The worth of a gear piece to a bot (ours, no C4 source): the adena an
// hour the piece adds over the hours it is worn, plus what it returns after
// them. Pure over plain numbers; the buyer's cap (bounds.cap) reads it.
//
// - gearWorth: today's gear gain (WishProviders.gearGainReader) carried over:
//   the attack gain (P.Atk, M.Atk for a caster) plus the defence gain (the
//   better of P.Def and M.Def against a threat that may cast, P.Def alone
//   against one that only hits) times the hours a death costs.
// - huntCycleWorth: the hunt cycle's income per hour at the held spot with
//   the piece minus without it (HuntCycle.reader).
// - rungWorth: a ladder rung's worth to a buyer over the piece it wears.

function positive(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
}

function worth(perHour, horizonHours, ownHour) {
    const hours = perHour * positive(horizonHours);
    return { perHour, hours, adena: hours * positive(ownHour) };
}

// The attack and defence shares a piece adds: before and after are the kit's
// numbers { pAtk, mAtk, pDef, mDef } without and with it.
function gearGain({ before, after, caster = false, threatMask = 3 }) {
    const attack = caster ? 'mAtk' : 'pAtk';
    const attackGain = Math.max(0, Number(after[attack]) / Math.max(1, Number(before[attack])) - 1);
    const physical = Math.max(0, 1 - Number(before.pDef) / Math.max(1, Number(after.pDef)));
    const magic = Math.max(0, 1 - Number(before.mDef) / Math.max(1, Number(after.mDef)));
    return { attack: attackGain, defence: threatMask === 1 ? physical : Math.max(physical, magic) };
}

// usable: the class may wear the piece and, for a weapon, its role prefers
// it to the weapon it holds (the caller asks the equipment rules); a piece it
// cannot use is worth nothing.
function gearWorth({ usable = true, before, after, caster, threatMask, deathHours, horizonHours, ownHour }) {
    if (!usable) return worth(0, horizonHours, ownHour);
    const gain = gearGain({ before, after, caster, threatMask });
    return worth(gain.attack + gain.defence * positive(deathHours), horizonHours, ownHour);
}

// incomeWith, incomeWithout: net adena per hour at the held spot; ownHour
// defaults to the income without the piece.
function huntCycleWorth({ incomeWith, incomeWithout, horizonHours, ownHour = incomeWithout }) {
    const hour = positive(ownHour);
    const perHour = hour > 0 ? Math.max(0, Number(incomeWith) - Number(incomeWithout)) / hour : 0;
    return worth(perHour, horizonHours, hour);
}

// The worth of a gear rung to a buyer, in adena, by formula: 'hunt_cycle'
// (ours): the hunt hour with the rung minus the hour with the piece the main
// wears in its slot (rung.hour, worn.hour: adena an hour, each at the best
// spot for its kit, the snapshot's gear ladder), never a share of an hour;
// 'gear_gain' (the design's text): today's gear gain of the rung over the
// worn piece (rung.gear, worn.gear: attack plus defence x death hours, each
// over the same entry kit) times the own hour. The gain an hour is held to
// gainBound times the own hour (ours: a piece at most doubles the hour) and
// bounded says so (a main with no own hour has no gain an hour). useHours: the hunting hours it is worn; resale: what it
// returns after them. rung or worn null (no row) gives null: a worth nobody
// can state. Returns { adena, perHour (adena an hour), bounded }.
function rungWorth({ formula, rung, worn, useHours, ownHour, gainBound, resale = 0 }) {
    if (!rung || !worn) return { adena: null, perHour: 0, bounded: false };
    const own = positive(ownHour), gain = formula === 'gear_gain' ? positive(rung.gear - worn.gear) * own : positive(rung.hour - worn.hour);
    const bounded = gain > gainBound * own, perHour = bounded ? gainBound * own : gain;
    return { adena: perHour * positive(useHours) + positive(resale), perHour, bounded };
}

// The gear ladder group of a slot (the hunt tables' gear table keys): both
// hands one, the earrings (1, 2) one, the rings (4, 5) one, any other slot
// its own.
function ladderGroup(slot) {
    const at = Number(slot);
    return at === 7 || at === 14 ? 'weapon' : at === 2 ? '1' : at === 5 ? '4' : String(at);
}

// The hours a piece's gain counts over and what it returns beyond them.
// 'grade_stage' (the design's text): the hunting hours to the end of the
// grade stage, nothing returned. 'use_plus_resale' (ours): the hunting hours
// the main wears it (useHours: to the end of its grade, and on to the end of
// the next grade when that grade's piece of the slot has no priced route for
// the main: it keeps wearing it, never further), plus the least it sells for then (the floor: the NPC's
// buy price or the best crystallizer bid it knows), so a piece bought late in
// its grade is still worth its resale.
function horizon({ reading, gradeHours, useHours, resale }) {
    if (reading === 'grade_stage') return { hours: positive(gradeHours), resale: 0 };
    return { hours: positive(useHours ?? gradeHours), resale: positive(resale) };
}

module.exports = { gearWorth, huntCycleWorth, rungWorth, horizon, ladderGroup };
