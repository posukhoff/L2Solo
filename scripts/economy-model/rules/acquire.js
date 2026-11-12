'use strict';

// acquire (economy design, character plane): how a main gets one piece of
// its kit and what that costs. The routes: buy (a player's line or ad in
// reach at or under the buyer's cap; the NPC is a buy apart, 'npc', so the
// outputs tell them apart), order at a workshop from its own materials (the
// materials it holds or still has to get, each by its own cheapest route: a
// line, gathering them, the NPC; a crafter twin gives its recipe and MP for
// the fee, taken before the roll), farm the piece whole, exchange at Luxury;
// the cheapest of adena + hours x own hour wins. Gathering the materials is
// the order route with gathered materials (C4: only a crafter makes the
// piece). Read by path and visit at their situations; no wake of its own.
// Pure: every price, hour and route arrives as plain data in the view.

// How the hours of a route are charged (the design: "hours x own hour").
// 'opportunity' (ours): hours x (own hour - the hour of the spot it would
// farm at, at its own level), what the main gives up by farming there
// instead of hunting its own spot, never under 0. 'literal' (the design's
// text): hours x own hour.
function charge(hours, spotHour, view) {
    if (!(hours > 0)) return 0;
    return hours * (view.hourCost === 'literal' ? view.ownHour : Math.max(0, view.ownHour - (spotHour || 0)));
}

// A material of an order, for one craft: the units it holds at what they
// would sell for (sale), the rest by the cheapest of a line in reach, the
// NPC and gathering them; null when it lacks units nothing supplies.
// Returns { adena (money spent), hours, cost, via, price (per unit of the
// route taken) }.
function material(row, view) {
    const held = Math.min(row.amount, row.held || 0), rest = row.amount - held, heldCost = held * (row.sale || 0);
    if (rest <= 0) return { adena: 0, hours: 0, cost: heldCost, via: 'held', price: 0 };
    const options = [];
    if (row.line !== null && row.line !== undefined) options.push({ via: 'line', price: row.line, adena: rest * row.line, hours: 0, cost: rest * row.line });
    if (row.npc > 0) options.push({ via: 'npc', price: row.npc, adena: rest * row.npc, hours: 0, cost: rest * row.npc });
    if (row.farmHours > 0) { const hours = rest * row.farmHours, cost = charge(hours, row.spotHour, view); options.push({ via: 'gather', price: cost / rest, adena: 0, hours, cost }); }
    if (!options.length) return null;
    const best = options.sort((a, b) => a.cost - b.cost || a.via.localeCompare(b.via))[0];
    return { ...best, cost: best.cost + heldCost };
}

// piece: { selfId }. view: { cap (the buyer's most for a player's line),
// ownHour, hourCost, lines: [{ price, kind: 'line' | 'ad', where }] in
// reach, npc: [{ town, price, fare }] the NPC sellers it reaches, order:
// { recipeId, fee, mp, units (pieces one craft makes, its success rate
// counted), materials: [{ selfId, amount (one craft), held, sale, line,
// npc, farmHours, spotHour }] } | null, farm: { hours, spotHour, where } |
// null (hours to farm one whole), exchange: { town, fare, options: [{ grade,
// amount, price }] } | null (Luxury: the crystals of one option at their
// known price), stalled: [route] (routes that failed twice for this piece) }.
// Returns { route, cost, adena, hours, where, routes (every priced route,
// cheapest first; an order's per piece, its adena the money one craft
// takes), routeCost (the cheapest route that is not a player's line: the
// cap's own route) } or null when nothing supplies the piece.
function acquire(piece, view) {
    const routes = [], stalled = new Set(view.stalled || []);
    const add = (route, adena, hours, cost, where, extra = {}) => { if (!stalled.has(route) && Number.isFinite(cost)) routes.push({ route, adena, hours, cost, where, ...extra }); };
    const line = (view.lines || []).filter(row => row.price <= view.cap).sort((a, b) => a.price - b.price)[0];
    if (line) add('buy', line.price, 0, line.price, line.where);
    for (const row of view.npc || []) add('npc', row.price + (row.fare || 0), 0, row.price + (row.fare || 0), row.town);
    const order = view.order;
    if (order && order.units > 0) {
        const parts = order.materials.map(row => material(row, view));
        if (parts.every(Boolean)) {
            const materials = order.materials.map((row, i) => ({ selfId: row.selfId, amount: row.amount, via: parts[i].via, price: parts[i].price }));
            const materialsCost = parts.reduce((sum, part) => sum + part.cost, 0);
            add('order', order.fee + parts.reduce((sum, part) => sum + part.adena, 0), parts.reduce((sum, part) => sum + part.hours, 0) / order.units,
                (order.fee + materialsCost) / order.units, null, { recipeId: order.recipeId, fee: order.fee, mp: order.mp, materials, materialsCost });
        }
    }
    if (view.farm?.hours > 0) add('farm', 0, view.farm.hours, charge(view.farm.hours, view.farm.spotHour, view), view.farm.where);
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
