'use strict';

// What a design bot needs and what it can spare, on its engine state (the
// main: { shots: { id: count }, bag: { id: count } }; the worn kit is never in
// the bag). Pure; called by the design plane when it builds a decision's state.
const LIMITS = require('./limits');
const Engine = require('../engine');
const BeginnerShots = require('../../../src/GameServer/Items/C4BeginnerShots');

// The consumable the bot fires at its row (firing: { id, perHour, beginner },
// null when its line fires nothing there): its purchase target is an outing's
// use, held what it can fire of it (the beginner shots that charge it
// counted: Engine.heldOf), short what it lacks to it (below 0: it holds more
// than an outing).
function consumable(main, firing, limits = LIMITS) {
    if (!firing) return null;
    const target = Math.ceil(firing.perHour * limits.OUTING_HOURS.value), held = Engine.heldOf(main, firing);
    return { id: firing.id, perHour: firing.perHour, target, held, short: target - held };
}

// [[id, count]] the bot can spare: every bag item (its drop and the creation
// items it does not wear), every shot it does not fire, and the shots it
// fires above their target; never a restricted item (the beginner shots: no
// sale, trade or drop, BeginnerShots.isRestricted).
function surplus(main, need) {
    const out = new Map();
    const add = (id, count) => { if (count > 0 && !BeginnerShots.isRestricted(id)) out.set(Number(id), (out.get(Number(id)) || 0) + count); };
    for (const [id, count] of Object.entries(main.bag)) add(id, count);
    for (const [id, count] of Object.entries(main.shots)) add(id, need && Number(id) === need.id ? count - need.target : count);
    return [...out];
}

module.exports = { consumable, surplus };
