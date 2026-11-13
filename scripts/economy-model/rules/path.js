'use strict';

// path (economy design, character plane): the grade's kit and each piece's
// route, and the money queue in one fixed order without a solver: the kit's
// refill reserve, then path pieces in path order; an unarmed main's weapon
// (it holds none) is the first piece, before the reserve; a main that holds
// a weapon of a lower grade refills first and buys its weapon after. Taken
// at grade_changed,
// gear_changed and source_stalled (a route that failed twice), never at a
// level-up inside the grade. Pure: the slots, their candidates, the routes
// acquire answered (committed by the engine) and each piece's worth arrive
// as plain data.

// main: { weapon }. view: { kit: [{ slot, worn (the piece it wears there, 0
// for none), held (the worn piece is of its grade: a rung it bought),
// candidates: [{ selfId, slot }] (the gear ladder's rungs of its grade and
// below whose hunt hour beats the worn piece's, best first; slot: where the
// rung is worn) }] (one a slot group, the weapon's first), weapons: {
// selfId: true } (the kit's weapons), routes: { selfId: { route, cost }
// | null }, worth: { selfId: adena | null }, reserve (adena of
// the next outing's shots at known prices), ahead: [{ selfId, slot }] (the
// next grade's kit), aim (pathAim 'affordable'): { money (adena the main
// holds), earn (adena it nets a hunting hour now: its own hour less the shots
// it fires), perHour: { selfId: the adena a hunting hour the piece adds over
// the worn one }, useHours: { selfId: hunting hours it would be worn },
// resale: { selfId: the least it sells for } } | null (pathAim 'best_priced':
// the first priced piece) }.
// Returns { pieces: [{ selfId, slot, route, cost, worth }] in
// path order (a slot whose candidates no route prices names its best one
// with route null, after the priced ones), reserve, order: [{ kind:
// 'piece', selfId, slot } | { kind: 'reserve' }] (the money queue), ahead:
// [{ selfId, slot }] (one piece a slot of the next grade's kit no candidate
// names: kept when found, worn at grade_changed), unpriced: [selfId] (the
// best candidate of each slot no route prices: source_stalled) }.
// What path aims at in a slot. 'best_priced' (the model before): the best
// priced candidate. 'affordable' (ours; the design does not say what path
// does when the kit's piece costs more than the main holds): the priced
// candidate of the greatest net gain, counting the hunting hours it waits
// for its money: its gain an hour over the hours it is worn after the wait,
// plus its resale, less its cost. The money a slot waits on is what the
// main holds less the shot reserve (after an unarmed main's weapon) and the cost of the aims taken for the slots before it in the
// kit's order, the weapon's first (money is spent once). None with a net
// gain: no aim. While it wears a rung of
// its grade, a better one only when the better rung's gain over its use
// beats its cost less the worn rung's resale.
function aimed(aim, view, left) {
    const priced = aim.candidates.filter(piece => view.routes[piece.selfId]);
    const unpriced = !priced.length && aim.candidates.length > 0;
    if (!view.aim) return { chosen: priced[0] ?? null, unpriced };
    const { perHour, useHours, resale, earn } = view.aim, cost = piece => view.routes[piece.selfId].cost;
    const beats = piece => !aim.held || (perHour[piece.selfId] || 0) * (useHours[piece.selfId] || 0) > cost(piece) - (resale[aim.worn] || 0);
    const net = piece => {
        const short = Math.max(0, cost(piece) - left), wait = short > 0 ? short / earn : 0;
        return (perHour[piece.selfId] || 0) * Math.max(0, (useHours[piece.selfId] || 0) - wait) + (resale[piece.selfId] || 0) - cost(piece);
    };
    let chosen = null, best = 0;
    for (const piece of priced) {
        const gain = net(piece);
        if (gain > best && beats(piece)) { chosen = piece; best = gain; }
    }
    return { chosen, unpriced };
}

function path(main, view) {
    const pieces = [], unpriced = [];
    let left = view.aim ? view.aim.money : 0, reserved = view.reserve || 0;
    for (const aim of view.kit) {
        // The shot reserve comes out of the money before the pieces, an
        // unarmed main's weapon excepted (it is bought before the reserve).
        if (reserved > 0 && (main.weapon || !aim.candidates.some(piece => view.weapons[piece.selfId]))) { left = Math.max(0, left - reserved); reserved = 0; }
        const answer = aimed(aim, view, left), chosen = answer.chosen;
        if (answer.unpriced) {
            const best = aim.candidates[0];
            unpriced.push(best.selfId);
            pieces.push({ selfId: best.selfId, slot: best.slot, route: null, cost: null, worth: view.worth[best.selfId] ?? null });
        }
        if (!chosen) continue;
        const route = view.routes[chosen.selfId];
        left -= route.cost;
        pieces.push({ selfId: chosen.selfId, slot: chosen.slot, route: route.route, cost: route.cost, worth: view.worth[chosen.selfId] ?? null });
    }
    // Worth per adena of the route's cost, dearest first; a piece with no worth
    // stated (no row) after those with one; a free route first; a piece no
    // route prices last.
    const rank = piece => (piece.route === null ? -2 : piece.worth === null ? -1 : piece.cost > 0 ? piece.worth / piece.cost : Infinity);
    pieces.sort((a, b) => rank(b) - rank(a) || a.selfId - b.selfId || a.slot - b.slot);
    // The unarmed main's weapon first, before the reserve.
    const first = main.weapon ? null : pieces.find(piece => view.weapons[piece.selfId] && piece.route !== null) || null;
    const rest = pieces.filter(piece => piece !== first), ordered = first ? [first, ...rest] : rest;
    const order = [...(first ? [{ kind: 'piece', selfId: first.selfId, slot: first.slot }] : []), { kind: 'reserve' },
        ...rest.map(piece => ({ kind: 'piece', selfId: piece.selfId, slot: piece.slot }))];
    const named = new Set(view.kit.flatMap(aim => aim.candidates.map(piece => piece.selfId))), slots = new Set(), ahead = [];
    for (const piece of [...(view.ahead || [])].sort((a, b) => a.slot - b.slot || a.selfId - b.selfId)) {
        if (named.has(piece.selfId) || slots.has(piece.slot)) continue;
        slots.add(piece.slot);
        ahead.push({ selfId: piece.selfId, slot: piece.slot });
    }
    return { pieces: ordered, reserve: view.reserve, order, ahead, unpriced };
}

// The hunting hours the kit's refill carries shots for (its next outing).
// refill 'outing' (ours): outingHours, the outing a player sets out on (it
// ends when shots run out: stock_low, shots_out). 'last_outing' (the model
// before): the hunting hours of the outing that just ended, at least
// minHours (lastOuting: those hours).
function refillHours({ refill, outingHours, minHours, lastOuting }) {
    return refill === 'outing' ? outingHours : Math.max(minHours, lastOuting || 0);
}

module.exports = { path, refillHours };
