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
// - rungWorth: a ladder rung's worth to a buyer over the kit it wears.
// - firing: the shots a main fires with a kit at the prices it knows, and
//   the kit's net hour then.

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
// (ours): the hunt hour of the kit the main wears with the rung put on minus
// the worn kit's (rung.hour, worn.hour: adena an hour, each at the best spot
// for its kit), never a share of an hour; 'gear_gain' (the design's text):
// today's gear gain of the rung over the worn kit (rung.gear, worn.gear:
// attack plus defence x death hours, swapRows) times the own hour. The gain an hour is held to
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

// Whether wearing a piece in slot takes the piece worn in other off: the
// same slot, either hand's weapon slot (7, 14), a two-handed weapon (14)
// the shield (8), a full armour (15) the chest and legs (10, 11) and either
// of those the full armour.
function slotsConflict(slot, other) {
    const at = Number(slot), was = Number(other);
    return at === was || (ladderGroup(at) === 'weapon' && ladderGroup(was) === 'weapon') || (at === 14 && was === 8)
        || (at === 15 && (was === 10 || was === 11)) || ((at === 10 || at === 11) && was === 15);
}

// The shots a main fires with a kit (ours; C4 leaves it to the player): of
// the kit's hour (kit-hours: the hour firing none, and per kind of shot the
// worn weapon fires its hour gross of shots and the shots it fires an hour),
// the option that nets most an hour at the prices the main knows
// (priceOf(id): adena a shot; null for a shot it knows no price of: a main
// cannot plan to fire what it cannot price, so that kind is no option; a price
// of 0 is a shot that is free). Ties keep firing none, then the first kind. Returns { id (0: none),
// units (shots an hour), net (the hour less the shots' and the arrows' cost: a
// bow's options state the arrows they spend, { id, units }, null where its
// attacks are not stated, which makes the option none), arrows (the chosen
// option's, null for none or a kit without a bow), worth (the
// most a shot of the chosen kind may cost and stay chosen, the other options
// at their prices; 0 firing none) }, null for a kit with no hour.
function firing(hour, priceOf) {
    if (!hour) return null;
    // The adena an hour of an option's arrows at the price the main knows
    // (undefined: a kit that fires none, 0; null: a bow's attacks not stated;
    // NaN: an arrow it cannot price: the option is no option).
    const arrowCost = arrows => {
        if (arrows === undefined) return 0;
        if (arrows === null) return NaN;
        const known = priceOf(arrows.id), price = known === null || known === undefined ? NaN : Number(known);
        return arrows.units * price;
    };
    const options = [], noneCost = arrowCost(hour.noneArrows);
    if (hour.none !== null && hour.none !== undefined && Number.isFinite(noneCost)) options.push({ id: 0, units: 0, gross: hour.none - noneCost, net: hour.none - noneCost, arrows: hour.noneArrows ?? null });
    for (const shot of hour.shots) {
        const known = priceOf(shot.id), price = known === null || known === undefined ? NaN : Number(known), cost = arrowCost(shot.arrows);
        if (!Number.isFinite(price) || !Number.isFinite(cost)) continue;
        options.push({ id: shot.id, units: shot.units, gross: shot.gross - cost, net: shot.gross - cost - shot.units * price, arrows: shot.arrows ?? null });
    }
    if (!options.length) return null;
    let best = options[0];
    for (const option of options) if (option.net > best.net) best = option;
    let rival = 0;
    if (best.id) {
        rival = -Infinity;
        for (const option of options) if (option !== best) rival = Math.max(rival, option.net);
        if (rival === -Infinity) rival = 0;
    }
    return { id: best.id, units: best.units, net: best.net, arrows: best.arrows, worth: best.id && best.units > 0 ? Math.max(0, (best.gross - rival) / best.units) : 0 };
}

// The pieces a body wears of a kit ({ paperdoll slot: selfId }): [[slot,
// selfId]] in paperdoll order, each piece taking off what it cannot be worn
// with (slotsConflict): one weapon (a two-handed one over a one-handed), a
// two-handed weapon no shield, a full armour no chest or legs. An empty slot
// is absent.
function wornKit(kit) {
    const worn = [];
    for (const [slot, selfId] of Object.entries(kit || {}).map(([slot, selfId]) => [Number(slot), Number(selfId)]).sort((a, b) => a[0] - b[0])) {
        if (!(selfId > 0)) continue;
        for (let at = worn.length - 1; at >= 0; at--) if (slotsConflict(slot, worn[at][0])) worn.splice(at, 1);
        worn.push([slot, selfId]);
    }
    return worn;
}
// The key of a kit as a body wears it (wornKit): two kits worn alike share it.
function kitKey(kit) {
    return wornKit(kit).map(([slot, selfId]) => `${slot}:${selfId}`).join(',');
}

// A kit row's net row for rungWorth at the prices a main knows (firing):
// { hour: the net hour, gear }, null where the hour is not stated.
function netRow(row, priceOf) {
    const fired = row ? firing(row.hour, priceOf) : null;
    return fired ? { hour: fired.net, gear: row.gear } : null;
}

// The rows of a kit's swaps (a kit hour source's swaps: the worn kit's hour
// and numbers, the body's caster mark and death hours, and per piece the
// hour and numbers of the kit with it): worn { hour, gear: 0 } and per piece
// { hour, gear }, hour the kit's hour (kit-hours, priced by netRow), gear its
// gear gain over the worn kit (gearWorth over one hour of a unit hour,
// against a threat that may cast). null where an hour is not stated: a worth
// nobody can state.
function swapRows(read) {
    const worn = read && read.hour !== null ? { hour: read.hour, gear: 0 } : null;
    const rows = (read?.swaps || []).map(swap => (swap.hour === null || !worn ? null : { hour: swap.hour,
        gear: gearWorth({ before: read.numbers, after: swap.numbers, caster: read.caster, threatMask: 3, deathHours: read.deathHours, horizonHours: 1, ownHour: 1 }).perHour }));
    return { worn, rows };
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

module.exports = { gearWorth, huntCycleWorth, rungWorth, horizon, ladderGroup, slotsConflict, wornKit, kitKey, swapRows, firing, netRow };
