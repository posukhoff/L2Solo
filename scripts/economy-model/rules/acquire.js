'use strict';

// acquire (economy design, character plane): how a main gets one piece of
// its kit and what that costs. The routes: buy (a player's line or ad in
// reach at or under the buyer's cap; the NPC is a buy apart, 'npc', so the
// outputs tell them apart), its own twin crafts it (a pair: the inputs at
// the twin's replacement cost, nothing for MP it holds idle, the recipe's
// scroll when the twin lacks it), exchange at Luxury; the cheapest of adena
// + hours x own hour wins. Our choice: C4's manufacture-to-order stores and
// waiting for a drop are left out. Read by path and visit at their situations; no
// wake of its own. Pure: every price, hour and route arrives as plain data
// in the view.

// How the hours of a route are charged (the design: "hours x own hour").
// 'opportunity' (ours): hours x (own hour - the hour of the spot it would
// hunt at, never under 0) + hours x the piece's use per hour (useHour: the
// adena an hour the piece adds, lost while it waits). 'literal' (the
// design's text): hours x own hour.
function charge(hours, spotHour, view) {
    if (!(hours > 0)) return 0;
    return hours * (view.hourCost === 'literal' ? view.ownHour : Math.max(0, view.ownHour - (spotHour || 0)) + (view.useHour || 0));
}
// piece: { selfId }. view: { cap (the buyer's most for a player's line),
// ownHour, hourCost, useHour (the piece's worth per hunting hour; null when
// no worth is stated), lines:
// [{ price, kind: 'line' | 'ad', where }] in reach, npc: [{ town, price, fare }] the NPC sellers it reaches, twin: { recipeId, cost (adena per piece
// made: inputs at the twin's replacement cost, plus the scroll when it lacks
// the recipe), hours (the craft's MP hours per piece) } | null (its own twin
// cannot craft it), exchange: { town, fare, options: [{ grade,
// amount, price }] } | null (Luxury: the crystals of one option at their
// known price), stalled: [route] (routes that failed twice for this piece) }.
// Returns { route, cost, adena, hours, where, routes (every priced route,
// cheapest first), routeCost (the cheapest route that is not a player's line: the
// cap's own route) } or null when nothing supplies the piece.
function acquire(piece, view) {
    const routes = [], stalled = new Set(view.stalled || []);
    const add = (route, adena, hours, cost, where, extra = {}) => { if (!stalled.has(route) && Number.isFinite(cost)) routes.push({ route, adena, hours, cost, where, ...extra }); };
    const line = (view.lines || []).filter(row => row.price <= view.cap).sort((a, b) => a.price - b.price)[0];
    if (line) add('buy', line.price, 0, line.price, line.where);
    for (const row of view.npc || []) add('npc', row.price + (row.fare || 0), 0, row.price + (row.fare || 0), row.town);
    // The own twin: no money changes hands inside the account; the wait for the craft costs the piece's use.
    if (view.twin) add('twin', 0, view.twin.hours, view.twin.cost + charge(view.twin.hours, view.ownHour, view), null, { recipeId: view.twin.recipeId });
    for (const option of view.exchange?.options || []) {
        if (option.price === null || option.price === undefined) continue;
        const adena = option.amount * option.price + (view.exchange.fare || 0);
        add('exchange', adena, 0, adena, view.exchange.town, { grade: option.grade, amount: option.amount, perCrystal: option.price });
    }
    if (!routes.length) return null;
    routes.sort((a, b) => a.cost - b.cost || a.route.localeCompare(b.route));
    const own = routes.find(row => row.route !== 'buy');
    return { ...routes[0], routes, routeCost: own ? own.cost : null, ownRoute: own ? own.route : null };
}

module.exports = { acquire, charge };
