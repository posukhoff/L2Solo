'use strict';

// trip (economy design, character plane): in the field, when does the main
// go to town, and which town. Its situations: bag_full, stock_low:shots,
// shots_out, goal_affordable (each a time computed from the hour row the
// main hunts at) and offer_posted, bid_posted (raised by the engine when a
// matching line enters reach). A field deal sends it now when the deal's
// gain over its next best channel beats the trip's hours x its own hour,
// else the deal is met at its next visit. player_command and clan_call have
// no source in the model. Pure: the main's stock, bag, goal and the deal
// arrive as plain data; times are wall hours.

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

// main: unused beyond the view (the engine reads it into the view). view:
// { now, since (the time the main's state is taken at), huntShare, tripHours,
// town, stockLowHours, loadShare, shots: { held, perHour, waiting } (waiting:
// it holds no restock it can make: no seller known, a WTB open, the want
// parked or not worth it; no shot situation then), bag: { slots, used,
// weight, maxLoad, items: [{ rate (per hunting hour), weight, stack, held }] },
// goal: { need, have, perHour, fresh } | null (the next path piece's route
// cost + the reserve against money + the bag at the NPC; fresh: the path
// changed since its last visit), event, deal: { gain } | null, ownHour }.
// Returns { at, reason, town } (at: the wall hour it arrives in town) or
// null, and parked: the shot situation it holds back (counted).
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
    const walk = view.tripHours > 0 ? view.tripHours : MIN_TRIP_HOURS;
    if ((view.event === 'offer_posted' || view.event === 'bid_posted') && view.deal && view.deal.gain > walk * view.ownHour) triggers.push({ at: view.now, reason: view.event });
    if (!triggers.length) return { at: null, reason: null, town: view.town, parked };
    const first = triggers.reduce((best, row) => (row.at < best.at ? row : best));
    return { at: Math.max(view.now, first.at) + walk, reason: first.reason, town: view.town, parked };
}

module.exports = { trip };
