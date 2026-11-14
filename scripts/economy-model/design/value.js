'use strict';

// What an hour of a design bot is worth, in hours of value: its exp over the
// line's best exp an hour at its level, its NPC income (adena, drop and spoil
// at the NPC's price) over the line's best income an hour there, weighted by
// its persona, less the price of its deaths. The best hours are its line's top
// rows with shots (static spot-table data). The weights come from the persona
// alone (the game's powerWeight, without the wallet: a value held between
// decisions would go stale with every purchase if it moved with money).
// Read only by the formula variant of supply; pure on the view and plain data.
const Engine = require('../engine');
const EconomicValuation = require('../../../src/GameServer/Bot/Economy/EconomicValuation');
const LIMITS = require('./limits');

// The weight of money in an hour's value; exp takes the rest.
const moneyWeight = persona => 1 / (1 + EconomicValuation.powerWeight(persona));

// { exp, npc }: the line's best exp and best NPC income an hour at a level
// with shots. Held per view, line and level (its inputs).
const bests = new WeakMap();
function bestOf(view, main) {
    if (!bests.has(view)) bests.set(view, new Map());
    const held = bests.get(view), key = `${main.line}@${main.level}`;
    if (held.has(key)) return held.get(key);
    const top = view.hours[main.line]?.[main.level]?.top || [];
    const out = { exp: 0, npc: 0 };
    for (const row of top) {
        out.exp = Math.max(out.exp, row.exp);
        out.npc = Math.max(out.npc, Engine.rowItems(view, main, row, 'shots').npc);
    }
    if (!(out.exp > 0) || !(out.npc > 0)) throw new Error(`no best hour with shots for line ${main.line} at level ${main.level}`);
    held.set(key, out);
    return out;
}

// The hour's value at the main's spot row in a form ('bare', 'shots',
// 'blessed'; factors: the worn kit's { kills, deaths } per form against the
// line's reference kit). withoutDrop: the same hour with a full bag, its items
// left on the ground (adena and exp stay).
function hourValue(view, main, form, factors, persona, withoutDrop = false) {
    const row = Engine.spotRowOf(view, main), hour = Engine.rowIn(row, form), factor = factors[form];
    const best = bestOf(view, main), wMoney = moneyWeight(persona);
    const items = Engine.rowItems(view, main, row, form);
    const exp = Engine.huntExp(main, hour, 1) * factor.kills;
    const income = (withoutDrop ? items.adena : items.npc) * factor.kills;
    const risk = (hour.deaths || 0) * factor.deaths * (LIMITS.DEATH_HOURS.value + view.deathExp[main.level - 1] / best.exp) * LIMITS.RISK_WEIGHT.value;
    return exp / best.exp * (1 - wMoney) + income / best.npc * wMoney - risk;
}

module.exports = { moneyWeight, hourValue, bestOf };
