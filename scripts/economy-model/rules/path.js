'use strict';

// path (economy design, character plane): the grade's kit and each piece's
// route, and the money queue in one fixed order without a solver: the kit's
// refill reserve, then path pieces in path order; an unarmed main's weapon
// is the first piece, before the reserve. Taken at grade_changed,
// gear_changed and source_stalled (a route that failed twice), never at a
// level-up inside the grade. Pure: the kit, what the main wears, the routes
// acquire answered (committed by the engine) and each piece's worth arrive
// as plain data.

// main: { kit: { slot: selfId } (worn), weapon }. view: { kit: [{ selfId,
// slot }] (the kit at the grade's last level: ours), weapons: { selfId:
// true } (the kit's weapons), routes: { selfId: { route, cost } | null },
// worth: { selfId: adena | null }, reserve (adena of the next outing's
// shots at known prices) }.
// Returns { pieces: [{ selfId, slot, route, cost, worth }] in path order
// (pieces it wears and pieces nothing supplies left out), reserve, order:
// [{ kind: 'piece', selfId, slot } | { kind: 'reserve' }] (the money queue) }.
function path(main, view) {
    const open = view.kit.filter(piece => main.kit?.[piece.slot] !== piece.selfId && view.routes[piece.selfId]);
    const pieces = open.map(piece => ({ selfId: piece.selfId, slot: piece.slot, route: view.routes[piece.selfId].route, cost: view.routes[piece.selfId].cost,
        worth: view.worth[piece.selfId] ?? null }));
    // Worth per adena of the route's cost, dearest first; a piece with no worth
    // stated (no row) after those with one; a free route first.
    const rank = piece => (piece.worth === null ? -1 : piece.cost > 0 ? piece.worth / piece.cost : Infinity);
    pieces.sort((a, b) => rank(b) - rank(a) || a.selfId - b.selfId || a.slot - b.slot);
    const unarmed = !main.weapon, weapon = unarmed ? pieces.find(piece => view.weapons[piece.selfId]) : null;
    const rest = pieces.filter(piece => piece !== weapon), ordered = weapon ? [weapon, ...rest] : rest;
    const order = [...(weapon ? [{ kind: 'piece', selfId: weapon.selfId, slot: weapon.slot }] : []), { kind: 'reserve' },
        ...rest.map(piece => ({ kind: 'piece', selfId: piece.selfId, slot: piece.slot }))];
    return { pieces: ordered, reserve: view.reserve, order };
}

module.exports = { path };
