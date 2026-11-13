'use strict';

// trip (economy design, character plane): in the field, when does the main
// go to town, and which town. Its situations: bag_full, stock_low:shots,
// shots_out, goal_affordable (each a time computed from the hour row the
// main hunts at) and offer_posted, bid_posted (raised by the engine
// when a matching line enters reach). A field deal sends it now when the
// deal's gain over its next best channel beats the trip's hours x its own
// hour, else the deal is met at its next visit. The shot situations come
// from its stock and its use alone (the hour it crosses its low mark, the
// hour it runs out), whatever the board holds: trip names the next one as a
// situation read at its hour. Whenever trip is asked while the main is low
// or out (at such a situation or any other event) the sellers are read
// (shotTown): a seller sends it, none leaves it hunting, low or out, until
// it is asked next (a line of its shot posted while it is low or out raises
// offer_posted).
// player_command and clan_call have no source in the model. The town: the
// town the main stands in, except a shot trip, which goes to the town of
// the seller (shotTown).
// Pure: the main's stock, bag, goal and the deal arrive as plain data;
// times are wall hours.
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

// The town a main restocks shots in, from the sellers that stand now (the
// board stands for trade chat: a public fact read when the situation is
// read, no memory of past prices): the town it stands in when its own twin
// holds the shot (ownHeld: the account warehouse) or its NPC sells the shot
// at or under its worth (npcAsk: the NPC's price) and the main can pay the
// shots that lift it over its low mark (need, shotsShort) there; else, of
// the town it stands in and the trade towns of the shot's grade and above
// (MarketTownPolicy), those where a line of the shot stands at or under its
// worth there and the main can pay the gatekeeper fare there and back and
// those shots at the line's price, the one it stands in, else the one with
// the least fare. A seller it cannot pay so is none: the visit would leave
// it low, and it would go again at once without hunting. The same read at
// its arrival on a shot trip names the town of the visit (the line it set
// out for may have sold meanwhile). towns: [{ town, fare (one way), ask (the
// cheapest line's price there, null without one), cap (the most it pays a
// unit there) }]. Returns the town's name, null when no seller stands.
function shotTown({ here, ownHeld = false, npcAsk = null, money, need = 0, towns }) {
    if (ownHeld || (npcAsk !== null && money >= need * npcAsk)) return here;
    const sold = towns.filter(row => row.ask !== null && row.ask <= row.cap && money >= 2 * row.fare + need * row.ask);
    if (!sold.length) return null;
    if (sold.some(row => row.town === here)) return here;
    return sold.reduce((best, row) => (row.fare < best.fare ? row : best)).town;
}

// The shots the main has to buy to stand over its low mark (its shots for
// stockLowHours of hunting) at wall hour now: what it held at since, less
// what it fired hunting since; 0 when it stands over it. shots: { held,
// perHour }; at: { since, now, huntShare, stockLowHours }.
function shotsShort({ held, perHour }, { since, now, huntShare, stockLowHours }) {
    const left = held - perHour * huntShare * (now - since), low = perHour * stockLowHours;
    return left > low ? 0 : Math.floor(low - Math.max(0, left)) + 1;
}

// Is the main low or out of its shot at wall hour now (at or under its low mark).
function shotsLow(shots, at) {
    return shotsShort(shots, at) > 0;
}

// main: unused beyond the view (the engine reads it into the view). view:
// { now, since (the time the main's state is taken at), huntShare, tripHours,
// town (the nearest), stockLowHours, loadShare, shots: { held, perHour },
// bag: { slots, used, weight, maxLoad, items: [{ rate (per hunting hour),
// weight, stack, held }] }, goal (goalOf) | null, event, deal: { gain } |
// null, ownHour, shotTowns: { ownHeld, npcAsk, money, towns, hopHours }
// (shotTown's sellers, read only while it is low or out) }.
// Returns { at, away, reason, town, read } (at: the wall hour it arrives in
// town, null without a situation; away: the hours it is away from its spot,
// lumped before the visit: the walk to town and back, and for another town
// a gatekeeper hop there and one back, 0 without a trip, so a death drawn
// before at beats a situation to read; read: at is instead the hour of its
// next shot situation, read then without going).
function trip(main, view) {
    const wall = hunting => view.since + hunting / Math.max(1e-9, view.huntShare);
    const triggers = [];
    const shots = view.shots;
    let shotAt = null;
    if (shots && shots.perHour > 0) {
        const low = shots.perHour * view.stockLowHours, situations = [];
        if (shots.held > low) situations.push({ at: wall((shots.held - low) / shots.perHour), reason: 'stock_low:shots' });
        situations.push({ at: wall(shots.held / shots.perHour), reason: 'shots_out' });
        // A situation come by now, or asked at any event while it is low or out.
        const due = situations.filter(row => row.at <= view.now);
        if ((due.length || shotsLow(shots, view)) && view.shotTowns) {
            shotAt = shotTown({ here: view.town, ...view.shotTowns, need: shotsShort(shots, view) });
            if (shotAt) triggers.push({ at: view.now, reason: due.length ? due[due.length - 1].reason : 'stock_low:shots' });
        }
        const next = situations.find(row => row.at > view.now);
        if (next) triggers.push({ ...next, read: true });
    }
    const full = bagFullHours(view.bag, view.loadShare);
    if (full !== null) triggers.push({ at: wall(full), reason: 'bag_full' });
    const goal = view.goal;
    if (goal && goal.need > 0) {
        if (goal.have >= goal.need) { if (goal.fresh) triggers.push({ at: view.now, reason: 'goal_affordable' }); } else if (goal.perHour > 0) triggers.push({ at: wall((goal.need - goal.have) / goal.perHour), reason: 'goal_affordable' });
    }
    const walk = view.tripHours > 0 ? view.tripHours : MIN_TRIP_HOURS;
    if ((view.event === 'offer_posted' || view.event === 'bid_posted') && view.deal && view.deal.gain > walk * view.ownHour) triggers.push({ at: view.now, reason: view.event });
    if (!triggers.length) return { at: null, away: 0, reason: null, town: view.town };
    const first = triggers.reduce((best, row) => (row.at < best.at ? row : best));
    if (first.read) return { at: first.at, away: 0, reason: first.reason, town: view.town, read: true };
    const at = Math.max(view.now, first.at);
    const shotTrip = first.reason === 'stock_low:shots' || first.reason === 'shots_out';
    const there = shotTrip && shotAt !== view.town ? { town: shotAt, hours: 2 * view.shotTowns.hopHours } : { town: view.town, hours: 0 };
    const away = walk + there.hours;
    return { at: at + away, away, reason: first.reason, town: there.town };
}

// The wall hour a main dies in the field (a death is an arrival in the
// respawn town of its spot with no walk there; the walk back to its spot is
// the hours it is away): its deaths per hunting hour at its
// spot's hour row, the hunting hours to the next death drawn from the
// seeded roll (exponential: a death is as likely in any hunting hour), null
// without deaths. view: { since, huntShare, deathsPerHour, roll in [0, 1) }.
function deathAt({ since, huntShare, deathsPerHour, roll }) {
    if (!(deathsPerHour > 0) || !(huntShare > 0)) return null;
    return since + -Math.log(1 - roll) / deathsPerHour / huntShare;
}

module.exports = { trip, goalOf, deathAt, shotTown, shotsLow, shotsShort };
