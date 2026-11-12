'use strict';

// path (economy design, character plane): the grade's kit and each piece's
// route, and the money queue in one fixed order without a solver: the kit's
// refill reserve, then path pieces in path order; while the main's weapon
// is below its grade (or it holds none) the weapon is the first piece,
// before the reserve. Taken at grade_changed,
// gear_changed and source_stalled (a route that failed twice), never at a
// level-up inside the grade. Pure: the kit, what the main wears, the routes
// acquire answered (committed by the engine) and each piece's worth arrive
// as plain data.

// main: { kit: { slot: selfId } (worn), weapon }. view: { kit: [{ selfId,
// slot, lower: [selfId] }] (the pieces path aims at, one a slot; lower: the
// pieces the grade's kits name for the slot below it, best first, tried in
// turn while no route prices the one before), weapons: { selfId: true }
// (the kit's weapons), weaponBelow (the main's weapon is of a lower grade
// than its own, or it holds none), routes: { selfId: { route, cost } | null },
// worth: { selfId: adena | null }, reserve (adena of the next outing's shots
// at known prices), ahead: [{ selfId, slot }] (the next grade's kit) }.
// Returns { pieces: [{ selfId, slot, route, cost, worth }] in path order
// (pieces it wears left out; a piece no route prices is not dropped: it
// stays named with route null, after the priced ones), reserve, order:
// [{ kind: 'piece', selfId, slot } | { kind: 'reserve' }] (the money queue),
// ahead: [{ selfId, slot }] (one piece a slot of the next grade's kit this
// grade's kit does not name: kept when found, worn at grade_changed),
// unpriced: [selfId] (aimed-at pieces no route prices: source_stalled) }.
function path(main, view) {
    const pieces = [], unpriced = [];
    for (const aim of view.kit) {
        let chosen = null;
        for (const selfId of [aim.selfId, ...(aim.lower || [])]) {
            if (main.kit?.[aim.slot] === selfId) break;
            if (view.routes[selfId]) { chosen = selfId; break; }
            if (selfId === aim.selfId) unpriced.push(selfId);
        }
        if (chosen !== null) pieces.push({ selfId: chosen, slot: aim.slot, route: view.routes[chosen].route, cost: view.routes[chosen].cost, worth: view.worth[chosen] ?? null });
        else if (unpriced.includes(aim.selfId) && main.kit?.[aim.slot] !== aim.selfId && !(aim.lower || []).includes(main.kit?.[aim.slot])) {
            pieces.push({ selfId: aim.selfId, slot: aim.slot, route: null, cost: null, worth: view.worth[aim.selfId] ?? null });
        }
    }
    // Worth per adena of the route's cost, dearest first; a piece with no worth
    // stated (no row) after those with one; a free route first; a piece no
    // route prices last.
    const rank = piece => (piece.route === null ? -2 : piece.worth === null ? -1 : piece.cost > 0 ? piece.worth / piece.cost : Infinity);
    pieces.sort((a, b) => rank(b) - rank(a) || a.selfId - b.selfId || a.slot - b.slot);
    // The weapon first, before the reserve, while the main's weapon is below its grade.
    const first = main.weapon && !view.weaponBelow ? null : pieces.find(piece => view.weapons[piece.selfId] && piece.route !== null) || null;
    const rest = pieces.filter(piece => piece !== first), ordered = first ? [first, ...rest] : rest;
    const order = [...(first ? [{ kind: 'piece', selfId: first.selfId, slot: first.slot }] : []), { kind: 'reserve' },
        ...rest.map(piece => ({ kind: 'piece', selfId: piece.selfId, slot: piece.slot }))];
    const named = new Set(view.kit.flatMap(piece => [piece.selfId, ...(piece.lower || [])])), slots = new Set(), ahead = [];
    for (const piece of [...(view.ahead || [])].sort((a, b) => a.slot - b.slot || a.selfId - b.selfId)) {
        if (named.has(piece.selfId) || slots.has(piece.slot)) continue;
        slots.add(piece.slot);
        ahead.push({ selfId: piece.selfId, slot: piece.slot });
    }
    return { pieces: ordered, reserve: view.reserve, order, ahead, unpriced };
}

module.exports = { path };
