'use strict';

const { slotsConflict } = require('./worth');

// acquire (economy design, character plane): how a main gets one piece of
// its kit and what that costs. The routes: buy (a player's line or ad in
// reach at or under the buyer's cap; the NPC is a buy apart, 'npc', so the
// outputs tell them apart), its own twin crafts it (a pair: the inputs at
// the twin's replacement cost, nothing for MP it holds idle, the recipe's
// scroll when the twin lacks it), exchange at Luxury; the cheapest of adena
// + hours x own hour wins. Our choice: C4's manufacture-to-order stores and
// waiting for a drop are left out. Read by path and visit at their situations; no
// wake of its own. Pure: every price, hour and route arrives as plain data
// in the view. Also whether a Luxury route's crystals stand (its own
// exchange route, visit and the KIT HOUR measure) and the kit a main could
// pay now (the measure).

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
// amount, price (the most it pays a crystal: the dearest unit of the
// cheapest it needs when the route is weighed; null: it takes none from a
// line), own (its own twin's crystals of the grade), lines (the lines
// and ads of the crystal it deals on, cheapest first) }] } | null (Luxury: a
// route only while its crystals stand now: crystalsStanding), stalled:
// [route] (routes that failed twice for this piece, or a Luxury route path
// chose whose crystals left) }.
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
        const stand = crystalsStanding({ amount: option.amount, perCrystal: option.price }, option.own, option.lines || []);
        if (stand.have < option.amount) continue;
        const adena = stand.adena + (view.exchange.fare || 0);
        add('exchange', adena, 0, adena, view.exchange.town, { grade: option.grade, amount: option.amount, perCrystal: option.price });
    }
    if (!routes.length) return null;
    routes.sort((a, b) => a.cost - b.cost || a.route.localeCompare(b.route));
    const own = routes.find(row => row.route !== 'buy');
    return { ...routes[0], routes, routeCost: own ? own.cost : null, ownRoute: own ? own.route : null };
}

// A Luxury route's crystals that stand: its own twin's (up to the amount)
// and the lines (cheapest first) at or under the most it pays a crystal
// (none when no price is stated); left: the units a line still holds.
// { own, have, adena, top }: the route stands when have >= its amount;
// adena: what its crystals past its own twin's cost, the cheapest units
// taken up to the amount (the fare apart); top: the price of the dearest
// unit taken (null: none taken).
function crystalsStanding(route, ownCrystals, lines, left = entry => entry.qty) {
    const own = Math.min(route.amount, ownCrystals || 0);
    let have = own, adena = 0, top = null;
    for (const entry of lines) {
        if (!(entry.price <= route.perCrystal)) continue;
        const units = left(entry), taken = Math.min(units, Math.max(0, route.amount - have));
        if (taken > 0) { adena += taken * entry.price; top = entry.price; }
        have += units;
    }
    return { own, have, adena, top };
}

// The kit a main could wear by paying now: of its candidates ({ slot,
// selfId, gain, routes }, hop: a route in another town) the highest gain
// first, each taken by its cheapest route within the money left, never a
// piece whose slot conflicts with one taken (Worth.slotsConflict), at most
// one route in another town (a visit hops once); the money a piece taken
// off would bring is not counted. A route is { cost, hop }, or a Luxury
// route { exchange: acquire's exchange route, crystal, fare, hop } that
// stands while its crystals do (crystalsStanding) over crystals (crystal ->
// { own: its own twin's units, lines: the lines in reach, cheapest first }),
// each taken piece's crystals taken off them: its own twin's first, then the
// cheapest lines at or under its price. Returns the kit (slot -> selfId).
function payableKit(worn, candidates, money, crystals = {}) {
    let kit = worn, left = money, hopped = false;
    const taken = new Set(), ownTaken = {}, lineTaken = new Map();
    const unitsLeft = entry => entry.qty - (lineTaken.get(entry.id) || 0);
    const stand = row => crystalsStanding(row.exchange, (crystals[row.crystal]?.own || 0) - (ownTaken[row.crystal] || 0), crystals[row.crystal]?.lines || [], unitsLeft);
    const costOf = row => {
        if (!row.exchange) return row.cost;
        const { have, adena } = stand(row);
        return have >= row.exchange.amount ? adena + row.fare : Infinity;
    };
    for (const { slot, selfId, routes } of [...candidates].sort((a, b) => b.gain - a.gain)) {
        if ([...taken].some(other => slotsConflict(slot, other))) continue;
        const route = routes.map(row => ({ row, cost: costOf(row) })).filter(({ row, cost }) => cost <= left && !(row.hop && hopped)).sort((a, b) => a.cost - b.cost)[0];
        if (!route) continue;
        left -= route.cost; hopped ||= route.row.hop; taken.add(slot);
        if (route.row.exchange) {
            const { exchange, crystal } = route.row, { own } = stand(route.row);
            ownTaken[crystal] = (ownTaken[crystal] || 0) + own;
            let need = exchange.amount - own;
            for (const entry of crystals[crystal]?.lines || []) {
                if (need <= 0 || entry.price > exchange.perCrystal) break;
                const units = Math.min(need, unitsLeft(entry));
                if (units > 0) { lineTaken.set(entry.id, (lineTaken.get(entry.id) || 0) + units); need -= units; }
            }
        }
        kit = Object.fromEntries([...Object.entries(kit).filter(([other]) => !slotsConflict(slot, other)), [slot, selfId]]);
    }
    return kit;
}

module.exports = { acquire, charge, crystalsStanding, payableKit };
