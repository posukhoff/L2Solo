'use strict';

// trip (economy design, character plane): in the field, when does the main
// go to town, and which town. Its situations: bag_full, stock_low:shots,
// shots_out, goal_affordable, hub_trip (each a time computed from the hour
// row the main hunts at) and offer_posted, bid_posted (raised by the engine
// when a matching line enters reach). A field deal sends it now when the
// deal's gain over its next best channel beats the trip's hours x its own
// hour, else the deal is met at its next visit. player_command and
// clan_call have no source in the model. The town: the nearest (the respawn
// town of its spot) or a town it knows a book of (a hub with no remembered
// book at its own first prices: hubKnown), by the gain of the trip there
// (tripTown 'by_gain', ours). Pure: the main's stock, bag, goal, the
// deal and the books it knows arrive as plain data; times are wall hours.
// deathAt is not a decision: the drawn fact that ends an outing in the
// respawn town (a death is an arrival), read beside trip's answer.

// A trip takes at least this long (ours: a spot with no walk back measured).
const MIN_TRIP_HOURS = 1 / 60;
// Hunting hours searched for a full bag (beyond it the bag never fills).
const BAG_HORIZON = 1000;

// Hunting hours until the bag has no free slot or its load reaches
// loadShare of the max load (C4 weight penalty past it; ours: 2/3). Slots:
// the slots used now plus, per item the main does not hold yet, the chance
// it dropped once by then (one stack), and one slot per gear piece (gear does
// not stack). null when neither happens within the horizon.
function bagFullHours(bag, loadShare) {
    if (!bag || !(bag.slots > 0)) return null;
    const perHour = bag.items.reduce((sum, item) => sum + item.rate * (item.weight || 0), 0);
    const byLoad = perHour > 0 ? Math.max(0, (loadShare * bag.maxLoad - bag.weight) / perHour) : null;
    const slotsAt = hours => bag.used + bag.items.reduce((sum, item) => sum + (item.stack ? (item.held ? 0 : 1 - Math.exp(-item.rate * hours)) : item.rate * hours), 0);
    let bySlots = null;
    if (slotsAt(0) >= bag.slots) bySlots = 0;
    else if (slotsAt(BAG_HORIZON) >= bag.slots) {
        let low = 0, high = BAG_HORIZON;
        for (let i = 0; i < 40; i++) { const mid = (low + high) / 2; if (slotsAt(mid) >= bag.slots) high = mid; else low = mid; }
        bySlots = high;
    }
    const found = [byLoad, bySlots].filter(value => value !== null && value <= BAG_HORIZON);
    return found.length ? Math.min(...found) : null;
}

// The goal goal_affordable reads: the next path piece it can buy by a
// route (one it does not want yet, or one whose want is parked: its money
// reaching the route re-opens it), its route cost and the kit's refill
// reserve against its money and its bag at the NPC. pieces: path's pieces in
// path order [{ selfId, slot, route, cost }]; kit: { slot: selfId }; wants:
// { selfId: { state } }; fresh: the path changed since its last visit.
// Returns { need, have, perHour, fresh } or null.
function goalOf({ pieces, kit, wants, reserve, money, bagValue, perHour, fresh }) {
    const next = (pieces || []).find(piece => kit[piece.slot] !== piece.selfId && piece.route !== null && (!wants[piece.selfId] || wants[piece.selfId].state === 'parked'));
    return next ? { need: next.cost + reserve, have: money + bagValue, perHour, fresh } : null;
}

// What a town pays above the nearest one for the stock the main carries
// after h more hunting hours (its bag and what it keeps in the account
// warehouse), plus what its wants cost less there, minus the fare there and
// back and the hop hours both ways at its own hour. A thing whose best price
// in the nearest town (a known buy line, else the NPC) is at or above what
// the town bids adds nothing: junk, sold to the NPC anywhere, never pays for
// a trip. stock: [{ id, held, rate (per hunting hour), npc }]; wants: [{ id,
// qty, cap }]; near: { bids: { id: { price, qty } }, asks: { id: price }
// (its cheapest line or NPC sale) }; town: { town, fare (one way), hours
// (one way), bids, asks: { id: price } (lines only) }; money: its money now.
// Returns the gain's terms: rows [{ held, rate, qty, premium }] (the stock
// the town pays more for) and fixed (the wants' gain less the trip's cost);
// gainAt reads them at h.
function townTerms(view, town) {
    const rows = [];
    for (const row of view.stock || []) {
        const there = town.bids[row.id];
        if (!there) continue;
        const here = Math.max(row.npc || 0, view.near.bids[row.id]?.price || 0);
        if (there.price > here) rows.push({ held: row.held, rate: row.rate || 0, qty: there.qty, premium: there.price - here });
    }
    // A want counts for the units its money left after the fares pays for.
    let fixed = -2 * town.fare - 2 * town.hours * view.ownHour, money = (view.money || 0) - 2 * town.fare;
    for (const want of view.wants || []) {
        const ask = town.asks[want.id];
        if (!(ask <= want.cap) || !(ask > 0)) continue;
        const units = Math.min(want.qty, Math.floor(money / ask));
        if (units <= 0) continue;
        money -= units * ask;
        fixed += units * Math.max(0, Math.min(want.cap, view.near.asks[want.id] ?? Infinity) - ask);
    }
    return { town, rows, fixed };
}
const gainAt = (terms, hunting) => terms.rows.reduce((sum, row) => sum + Math.min(row.held + row.rate * hunting, row.qty) * row.premium, terms.fixed);

// The towns it can pay the fare to and back for, with their gain's terms.
const reachable = view => (view.tripTown === 'by_gain' ? (view.towns || []).filter(town => Number.isFinite(town.fare) && view.money >= 2 * town.fare).map(town => townTerms(view, town)) : []);

// Hunting hours until a town's gain first turns positive (the gain grows
// with the stock it carries), null when not within the bag's horizon.
function hubHours(towns) {
    let best = null;
    for (const terms of towns) {
        if (gainAt(terms, 0) > 0) return 0;
        if (!(gainAt(terms, BAG_HORIZON) > 0)) continue;
        let low = 0, high = BAG_HORIZON;
        for (let i = 0; i < 40; i++) { const mid = (low + high) / 2; if (gainAt(terms, mid) > 0) high = mid; else low = mid; }
        if (best === null || high < best) best = high;
    }
    return best;
}

// The town of a trip after `hunting` hunting hours: the one whose gain is
// highest and positive, else the nearest. Returns { town, hours, refused
// (the towns whose gain is not positive then: refused for want of gain) }.
function townOf(view, towns, hunting) {
    let best = null, gain = 0;
    const refused = [];
    for (const terms of towns) {
        const value = gainAt(terms, hunting);
        if (value > gain) { gain = value; best = terms.town; }
        if (!(value > 0)) refused.push(terms.town.town);
    }
    return best ? { town: best.town, hours: best.hours, refused } : { town: view.town, hours: 0, refused };
}

// main: unused beyond the view (the engine reads it into the view). view:
// { now, since (the time the main's state is taken at), huntShare, tripHours,
// town (the nearest), stockLowHours, loadShare, shots: { held, perHour,
// waiting } (waiting: it holds no restock it can make: no seller known, a
// WTB open, the want parked or not worth it; no shot situation then), bag:
// { slots, used, weight, maxLoad, items: [{ rate (per hunting hour), weight,
// stack, held }] }, goal (goalOf) | null, event, deal: { gain } | null,
// ownHour, tripTown: 'nearest' | 'by_gain', and with by_gain money, stock,
// wants, near and towns (townTerms) }.
// Returns { at, reason, town, refused } (at: the wall hour it arrives in
// town, null without a situation; refused: the towns it knows whose trip
// had no gain then), and parked: the shot situation it holds back (counted).
function trip(main, view) {
    const wall = hunting => view.since + hunting / Math.max(1e-9, view.huntShare);
    const triggers = [];
    const shots = view.shots;
    let parked = false;
    if (shots && shots.perHour > 0) {
        if (shots.waiting) parked = shots.held < shots.perHour * view.stockLowHours;
        else {
            const low = shots.perHour * view.stockLowHours;
            if (shots.held > low) triggers.push({ at: wall((shots.held - low) / shots.perHour), reason: 'stock_low:shots' });
            triggers.push({ at: wall(shots.held / shots.perHour), reason: 'shots_out' });
        }
    }
    const full = bagFullHours(view.bag, view.loadShare);
    if (full !== null) triggers.push({ at: wall(full), reason: 'bag_full' });
    const goal = view.goal;
    if (goal && goal.need > 0) {
        if (goal.have >= goal.need) { if (goal.fresh) triggers.push({ at: view.now, reason: 'goal_affordable' }); } else if (goal.perHour > 0) triggers.push({ at: wall((goal.need - goal.have) / goal.perHour), reason: 'goal_affordable' });
    }
    const towns = reachable(view), hub = hubHours(towns);
    if (hub !== null) triggers.push({ at: wall(hub), reason: 'hub_trip' });
    const walk = view.tripHours > 0 ? view.tripHours : MIN_TRIP_HOURS;
    if ((view.event === 'offer_posted' || view.event === 'bid_posted') && view.deal && view.deal.gain > walk * view.ownHour) triggers.push({ at: view.now, reason: view.event });
    if (!triggers.length) return { at: null, reason: null, town: view.town, parked, refused: [] };
    const first = triggers.reduce((best, row) => (row.at < best.at ? row : best));
    const at = Math.max(view.now, first.at), there = townOf(view, towns, Math.max(0, (at - view.since) * view.huntShare));
    return { at: at + walk + there.hours, reason: first.reason, town: there.town, parked, refused: there.refused };
}

// The wall hour a main dies in the field (a death is an arrival in the
// respawn town of its spot, no walk): its deaths per hunting hour at its
// spot's hour row, the hunting hours to the next death drawn from the
// seeded roll (exponential: a death is as likely in any hunting hour), null
// without deaths. view: { since, huntShare, deathsPerHour, roll in [0, 1) }.
function deathAt({ since, huntShare, deathsPerHour, roll }) {
    if (!(deathsPerHour > 0) || !(huntShare > 0)) return null;
    return since + -Math.log(1 - roll) / deathsPerHour / huntShare;
}

module.exports = { trip, goalOf, deathAt };
