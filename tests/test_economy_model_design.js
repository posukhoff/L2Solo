'use strict';

// The economy model's design mode on an inline snapshot: a Bounty Hunter's
// main leaves its crafter twin the Soulshot D recipe it spoiled, the account
// pools its money, the twin learns the recipe, buys ore and crystals through
// NPC gear in its town, crafts at its batch's MP deadline and lists the
// shots; another main buys them from the line and fires them. Money closes
// to the adena, every item closes (start + produced - destroyed - sold to
// the NPC = end), a run is a function of its seed, and a main without shots
// hunts at the hour without shots. A twin's crafts use no more MP than it
// regenerates; a recipe under 100 % fails crafts and loses their inputs. A
// dropped item's first price under 'hour_share' spreads the hour over its
// loot; the gear route a town reaches counts the gatekeeper fare.
const assert = require('node:assert/strict');
const Engine = require('../scripts/economy-model/engine');
const Design = require('../scripts/economy-model/design');

const ORE = 1785, CRYSTAL = 1458, SSD = 1463, SCROLL = 5001, SWORD = 2001, BONE = 1872;
// Loot 150 an hour: the per-kill yields below at the NPC's price (10 kills x (0.5 x 10 + 0.2 x 50)).
const row = (spotId, adena, shots) => ({ spotId, kills: 10, exp: 1, adena, shots, dropLoot: 150, spoilLoot: 0, loot: 150, potions: 0, busyShare: 1, deaths: 0,
    shotless: { kills: 5, exp: 0.5, adena: adena / 2, dropLoot: 75, spoilLoot: 0, loot: 75 } });
const levels = Array.from({ length: 30 }, (_, i) => i + 1);
const hoursOf = (classId, shots) => Object.fromEntries(levels.map(level => [level, { classId, shotId: SSD, best: row('s1', 1000, shots), top: [] }]));
const twin = level => ({ classId: level < 40 ? 56 : 57, mp: 3000, createItem: level >= 20 ? 2 : 1, crystallize: level >= 20 ? 'd' : null, maxMp: 188, storeSlots: { sell: 4, buy: 5 } });
const yields = { town: 'TownA', drop: { 57: 100, [BONE]: 0.5, [SCROLL]: 0.2 }, spoil: {} };
const snapshot = {
    header: { levels: [1, 30], rates: { adena: 1 } },
    exp: levels.map(level => level * 1e9),
    hours: { 55: hoursOf(55, 0), 9: hoursOf(9, 50) },
    kits: { 55: Object.fromEntries(levels.map(level => [level, [{ selfId: SWORD, slot: 7 }]])), 9: Object.fromEntries(levels.map(level => [level, [{ selfId: SWORD, slot: 7 }]])) },
    yields: Object.fromEntries(levels.map(level => [`s1@${level}`, yields])),
    yieldsDesign: Object.fromEntries(levels.map(level => [`s1@${level}`, yields])),
    items: {
        [ORE]: { kind: 'Other.Material', grade: 'NONE', ref: 250, npcBuy: 125, crystals: 0 },
        [CRYSTAL]: { kind: 'Other.Crystal', grade: 'D', ref: 650, npcBuy: 325, crystals: 0 },
        [SSD]: { kind: 'Other.Shot', grade: 'NONE', ref: 10, npcBuy: 5, crystals: 0 },
        [SCROLL]: { kind: 'Other.Recipe', grade: 'NONE', ref: 100, npcBuy: 50, crystals: 0 },
        [SWORD]: { kind: 'Weapon.Sword', grade: 'D', ref: 4000, npcBuy: 2000, crystals: 200 },
        [BONE]: { kind: 'Other.Material', grade: 'NONE', ref: 20, npcBuy: 10, crystals: 0 }
    },
    recipes: [{ type: 'dwarven', recipeId: 20, recipeItemId: SCROLL, level: 2, materials: [{ selfId: ORE, amount: 3 }, { selfId: CRYSTAL, amount: 1 }],
        productId: SSD, productCount: 156, mpCost: 40, successRate: 100, quest: false }],
    npcOffers: { preset: {}, x1: { [ORE]: [{ town: 'TownA', price: 300 }], [SWORD]: [{ town: 'TownA', price: 4000 }] } },
    crystalIds: { D: CRYSTAL, C: 1459 },
    races: { 55: 4, 9: 1 },
    twins: Object.fromEntries(levels.map(level => [level, twin(level)])),
    sources: { [BONE]: { drop: [{ npcId: 1, yield: 1 }], spoil: [] }, [SCROLL]: { drop: [{ npcId: 1, yield: 1 }], spoil: [] } },
    shotFamilies: { grades: ['NONE', 'D', 'C', 'B', 'A', 'S'], ids: [[1835, SSD, 1464, 1465, 1466, 1467]] },
    fares: { TownA: { TownA: 0 } }
};
const accounts = [
    { id: 1, station: false, classId: 55, line: '55', level: 25, exp: 25e9, money: 200000, spot: null, shots: {}, held: [SWORD], worn: { 7: SWORD } },
    { id: 2, station: false, classId: 9, line: '9', level: 25, exp: 25e9, money: 100000, spot: null, shots: {}, held: [SWORD], worn: { 7: SWORD } }
];
const bands = [['low', 1], ['high', 40]];
const rates = { default: { huntShare: 1, visitsPerBotHour: 1 } };
const grades = [['d', 20], ['c', 40], ['b', 52], ['a', 61], ['s', 76]];
const arrivals = (main, { event, now, pending, roll }) => (event === 'level_up' ? pending : now + (event === 'start' ? roll : 1));
const run = (seed, hours = 8, world = snapshot) => {
    const view = Engine.viewOf(world, { npcPrices: 'x1' });
    const game = Design.gameOf(world, view);
    return Engine.simulate({ view, accounts, bands, rates, hours, seed, nextArrival: arrivals, design: Design.plane({ snapshot: world, game, start: 'late', grades }) });
};
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6 * Math.max(1, Math.abs(expected)), `${message}: ${actual} against ${expected}`);

const out = run(5);
const design = out.design;
assert.equal(design.crafters.crafterAccounts, 1, 'the Bounty Hunter alone has a crafter twin');
assert.equal(design.recipes.none.kept > 0 && design.recipes.none.learned, 1, 'its main left it the scroll and it learned the recipe');
assert.ok(design.firsts.shot.d > 0, 'the twin crafted Soulshot D');
assert.ok(design.liveness.waits.batch.deadline >= 1, 'a batch ended at its MP deadline');
assert.equal(design.liveness.waits.batch.opened, design.liveness.waits.batch.deadline + design.liveness.waits.batch.open, 'every batch ends at its deadline or is open');
assert.ok(design.crystals.npcRoute > 0, 'crystals through NPC gear in its town');
assert.ok(design.shots.supply.lines > 0, 'the other main bought shots from the twin\'s line');
assert.ok(design.shots.byGrade.d.fired > 0, 'and fired them');
assert.ok(design.botToBot > 0);
// Money closes to the adena, the twin's wallet included; every item closes.
assert.equal(out.money.closureGap, 0);
assert.equal(out.money.delta, out.flows.net);
assert.equal(design.goods.failing, 0, JSON.stringify(design.goods.worst));
assert.ok(design.goods.totals.crafted > 0 && design.goods.totals.craftIn > 0 && design.goods.totals.learned === 1);
// A run is a function of its seed.
assert.deepEqual(run(5), out);
// The twin's crafts use no more MP than it regenerated (it starts with none): used + lost at max <= regenerated.
assert.ok(design.mp.used > 0 && design.mp.used + design.mp.lost <= design.mp.available + 1e-6, JSON.stringify(design.mp));

// A 60 % recipe: a failed craft yields nothing and its inputs are gone (3 ore and a crystal a craft).
{
    const risky = { ...snapshot, recipes: [{ ...snapshot.recipes[0], successRate: 60 }] };
    const r = run(5, 8, risky).design, crafts = r.goods.totals.craftIn / 4;
    assert.ok(r.counters.failedCrafts > 0 && r.counters.failedCrafts < crafts, `${r.counters.failedCrafts} of ${crafts} failed`);
    assert.equal(r.goods.totals.crafted, (crafts - r.counters.failedCrafts) * 156, 'shots only from the crafts that held');
    assert.equal(r.goods.failing, 0, 'the inputs of a failed craft are destroyed, not kept');
}

// hour_share: one hour's drops at their first prices sum to that hour's
// income (adena and loot at the NPC); band_hour lays the whole hour on each.
{
    const view = Engine.viewOf(snapshot, { npcPrices: 'x1' }), row = view.hours[9][25].best;
    const drops = Engine.designYieldRows(view, '9', 25, row, false).map(([id, perKill]) => [id, perKill * row.kills]);
    const income = row.adena * Engine.designAdenaFactor(view, row, 25) + drops.reduce((sum, [id, count]) => sum + count * view.items[id].npcBuy, 0);
    const priced = reading => Design.gameOf(snapshot, view, { ...Design.DESIGN, firstPriceDrop: reading }).firstPrice;
    const share = priced('hour_share');
    near(drops.reduce((sum, [id, count]) => sum + count * share[id], 0), income, 'the hour\'s drops at first prices');
    near(share[SCROLL] / share[BONE], 50 / 10, 'by NPC value');
    const band = priced('band_hour');
    for (const [id, count] of drops) near(band[id] * count, income, `the design's text: item ${id} carries the hour`);
}

// From a town without NPC gear the route a twin reaches is the nearest one
// with the gatekeeper fare: (2000 + 4000) / 200 crystals per crystal.
{
    const world = { ...snapshot, fares: { TownA: { TownA: 0, TownB: 2000 }, TownB: { TownA: 2000, TownB: 0 } } };
    const game = Design.gameOf(world, Engine.viewOf(world, { npcPrices: 'x1' }));
    assert.equal(game.reachByTown.TownB.d.perCrystal, 30);
    assert.equal(game.reachByTown.TownA.d.perCrystal, 20, 'its own town without a fare');
}

// A main without shots hunts at the same spot's hour without shots.
const view = Engine.viewOf(snapshot, { npcPrices: 'x1' });
const buyer = Engine.mainOf(accounts[1], 1, view, bands);
const bare = Engine.huntDesign(buyer, view, 2, () => 0.5);
assert.equal(bare.delta.flows.huntCold, 1000, 'two hours at the shotless 500 adena');
assert.equal(bare.delta.huntBare, 2);
const armed = Engine.huntDesign({ ...buyer, shots: { [SSD]: 50 } }, view, 2, () => 0.5);
assert.equal(armed.delta.flows.huntCold, 1500, 'one hour with its 50 shots at 1000, one without at 500');
assert.equal(armed.delta.shotsUsed, 50);

console.log('PASS economy model design mode');
