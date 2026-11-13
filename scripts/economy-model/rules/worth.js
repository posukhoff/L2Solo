'use strict';

// The worth of a gear piece to a bot (ours, no C4 source): the adena an
// hour the piece adds over the hours it is worn, plus what it returns after
// them. Pure over plain numbers; the buyer's cap (bounds.cap) reads it.
//
// - rungWorth: a ladder rung's worth to a buyer over the kit it wears.
// - firing: the shots a main fires with a kit at the prices it knows, and
//   the kit's net hour then.

function positive(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
}

// The worth of a gear rung to a buyer, in adena (ours): the hunt cycle's
// hour of the kit the main wears with the rung put on minus the worn kit's
// (rung.hour, worn.hour: adena an hour, each at the best spot for its kit),
// never a share of an hour. The gain an hour is held to
// gainBound times the own hour (ours: a piece at most doubles the hour) and
// bounded says so (a main with no own hour has no gain an hour). useHours: the hunting hours it is worn; resale: what it
// returns after them. rung or worn null (no row) gives null: a worth nobody
// can state. Returns { adena, perHour (adena an hour), bounded }.
function rungWorth({ rung, worn, useHours, ownHour, gainBound, resale = 0 }) {
    if (!rung || !worn) return { adena: null, perHour: 0, bounded: false };
    const own = positive(ownHour), gain = positive(rung.hour - worn.hour);
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
// attacks are not stated, which makes the option no option), worth (the
// most a shot of the chosen kind may cost and stay chosen, the other options
// at their prices; 0 firing none) }, null for a kit with no hour.
function firing(hour, priceOf) {
    if (!hour) return null;
    // The adena an hour of an option's arrows at the price the main knows
    // (undefined: a kit without a bow, 0; null: a bow's attacks not stated;
    // NaN: an arrow it cannot price: the option is no option).
    const arrowCost = arrows => {
        if (arrows === undefined) return 0;
        if (arrows === null) return NaN;
        const known = priceOf(arrows.id), price = known === null || known === undefined ? NaN : Number(known);
        return arrows.units * price;
    };
    const options = [], noneCost = arrowCost(hour.noneArrows);
    if (hour.none !== null && hour.none !== undefined && Number.isFinite(noneCost)) options.push({ id: 0, units: 0, gross: hour.none - noneCost, net: hour.none - noneCost });
    for (const shot of hour.shots) {
        const known = priceOf(shot.id), price = known === null || known === undefined ? NaN : Number(known), cost = arrowCost(shot.arrows);
        if (!Number.isFinite(price) || !Number.isFinite(cost)) continue;
        options.push({ id: shot.id, units: shot.units, gross: shot.gross - cost, net: shot.gross - cost - shot.units * price });
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
    return { id: best.id, units: best.units, net: best.net, worth: best.id && best.units > 0 ? Math.max(0, (best.gross - rival) / best.units) : 0 };
}

// The worn kit's hunt over the reference kit's at a level (two kit hours:
// kit-hours, each option with its kill share and shot share, the kit's kills
// an hour and its kills times fight share over the cell row's), per form a
// main hunts its spot row in (Engine.formOf): bare (firing none), shots (its
// plain shot: a soulshot or a Spiritshot) and blessed (Blessed Spiritshots),
// matched by kind, since a lower-grade weapon fires another id. Each form
// { kills, shots }: the worn share over the reference's; null where either
// hour does not state the form's shares or the reference's share is not above
// 0. The spot row is the reference kit's hour, so a main's hunt is the row
// times kills (adena, exp, drops) and its shots the row's times shots.
function huntFactors(worn, reference) {
    const ratio = (w, r) => (w && r && Number.isFinite(w.killShare) && Number.isFinite(w.shotShare) && r.killShare > 0 && r.shotShare > 0
        ? { kills: w.killShare / r.killShare, shots: w.shotShare / r.shotShare } : null);
    const kind = (hour, blessed) => (hour?.shots || []).find(shot => (shot.kind === 'blessedSpiritshot') === blessed) || null;
    return { bare: ratio(worn?.noneShare, reference?.noneShare), shots: ratio(kind(worn, false), kind(reference, false)), blessed: ratio(kind(worn, true), kind(reference, true)) };
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
// { hour: the net hour }, null where the hour is not stated.
function netRow(row, priceOf) {
    const fired = row ? firing(row.hour, priceOf) : null;
    return fired ? { hour: fired.net } : null;
}

// The rows of a kit's swaps (a kit hour source's swaps: the worn kit's hour,
// and per piece the hour of the kit with it): worn { hour } and per piece
// { hour }, the kit's hour (kit-hours, priced by netRow). null where an hour
// is not stated: a worth nobody can state.
function swapRows(read) {
    const worn = read && read.hour !== null ? { hour: read.hour } : null;
    const rows = (read?.swaps || []).map(swap => (swap.hour === null || !worn ? null : { hour: swap.hour }));
    return { worn, rows };
}

// The hours a piece's gain counts over and what it returns beyond them.
// The hunting hours (ours) the main wears it (useHours: to the end of its grade, and on to the end of
// the next grade when that grade's piece of the slot has no priced route for
// the main: it keeps wearing it, never further), plus the least it sells for then (the floor: the NPC's
// buy price or the best crystallizer bid it knows), so a piece bought late in
// its grade is still worth its resale.
function horizon({ gradeHours, useHours, resale }) {
    return { hours: positive(useHours ?? gradeHours), resale: positive(resale) };
}

module.exports = { rungWorth, horizon, ladderGroup, slotsConflict, wornKit, kitKey, swapRows, firing, netRow, huntFactors };
