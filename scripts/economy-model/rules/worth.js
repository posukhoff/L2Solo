'use strict';

// The worth of a gear piece to a bot (ours, no C4 source): the hours of its
// own hour the piece adds over the hours to the end of its grade stage, and
// in adena those hours times the own hour (the bot's income per hour at its
// earning spot). Two formulas, both pure over plain numbers, so the economy
// model can rank them against the simulated fight; the buyer's cap
// (bounds.cap) reads the adena.
//
// - gearWorth: today's gear gain (WishProviders.gearGainReader) carried over:
//   the attack gain (P.Atk, M.Atk for a caster) plus the defence gain (the
//   better of P.Def and M.Def against a threat that may cast, P.Def alone
//   against one that only hits) times the hours a death costs.
// - huntCycleWorth: the hunt cycle's income per hour at the held spot with
//   the piece minus without it (HuntCycle.reader).

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

// The worth of a path piece to a buyer, in adena, by formula: 'gear_gain'
// (the design's text: today's gear gain, row.gear its hours per hour) or
// 'hunt_cycle' (ours: the hunt cycle's hour with the piece over without,
// row.with / row.without). The hunt cycle's share explodes where the hour
// without the piece is near zero or below (a kit that dies more than it
// earns): its gain is held to gainBound times the own hour (ours) and
// bounded says so. row: the snapshot's pieceWorth row; null (no row: a piece
// no line's path names) gives null, a worth nobody can state.
function pieceWorth({ formula, row, horizonHours, ownHour, gainBound }) {
    if (!row) return { adena: null, perHour: 0, bounded: false };
    if (formula === 'gear_gain') return { ...worth(positive(row.gear), horizonHours, ownHour), bounded: false };
    if (row.with === null || row.without === null) return { ...worth(0, horizonHours, ownHour), bounded: false };
    const gain = Number(row.with) - Number(row.without);
    const share = gain <= 0 ? 0 : Number(row.without) > 0 ? gain / Number(row.without) : Infinity;
    const bounded = share > gainBound;
    return { ...worth(bounded ? gainBound : share, horizonHours, ownHour), bounded };
}

module.exports = { gearWorth, huntCycleWorth, pieceWorth };
