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
    fares: { TownA: { TownA: 0 } },
    // The Bounty Hunter's bag holds two stacks: its sword and the expected first drop fill it.
    bags: { 55: { race: 4, slots: 2, maxLoad: 100000 }, 9: { race: 1, slots: 80, maxLoad: 100000 } },
    walkBack: { s1: 0.01 }
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
// The gate chain of Soulshot D: the crafter main was in D at the start, its
// twin learned from the scroll its main left it, crafted, and sold to a main.
const gates = design.gates;
assert.equal(gates.crafter.d, 0);
assert.equal(gates.recipe.d.from, 'its own main\'s drop');
assert.deepEqual(gates.scroll.d, { h: gates.scroll.d.h, from: 'its own main\'s drop', where: { spot: 's1', level: 25, line: '55', classId: 55, npcs: [] } },
    'the scroll reached the twin through the warehouse: where its main hunted (this snapshot names no NPC rewards)');
assert.equal(design.crafters.byTown.TownA, 1, 'its twin sits where its main resupplies (main_town)');
assert.ok(gates.recipe.d.h <= gates.crystal.d.h + 1 && gates.crystal.d.from === 'npcRoute', JSON.stringify(gates));
assert.ok(design.firsts.shot.d <= gates.sold.d && gates.reach10.d >= gates.sold.d, JSON.stringify(gates));
// Money closes to the adena, the twin's wallet included; every item closes.
assert.equal(out.money.closureGap, 0);
assert.equal(out.money.delta, out.flows.net);
assert.equal(design.goods.failing, 0, JSON.stringify(design.goods.worst));
assert.ok(design.goods.totals.crafted > 0 && design.goods.totals.craftIn > 0 && design.goods.totals.learned === 1);
// A run is a function of its seed.
assert.deepEqual(run(5), out);
// The twin's crafts use no more MP than it regenerated (it starts with none): used + lost at max <= regenerated.
assert.ok(design.mp.used > 0 && design.mp.used + design.mp.lost <= design.mp.available + 1e-6, JSON.stringify(design.mp));

// Own use first at the engine: the Bounty Hunter fires Soulshot D too; its
// twin crafts its main's shortfall first, its main draws them through the
// warehouse and fires them; without the rule its twin serves the shelf.
// Money and goods close either way.
{
    const shooting = { ...snapshot, hours: { ...snapshot.hours, 55: hoursOf(55, 50) } };
    const runWith = config => {
        const view = Engine.viewOf(shooting, { npcPrices: 'x1' });
        return Engine.simulate({ view, accounts, bands, rates, hours: 8, seed: 5, nextArrival: arrivals,
            design: Design.plane({ snapshot: shooting, game: Design.gameOf(shooting, view, config), config, start: 'late', grades }) });
    };
    const own = runWith(Design.DESIGN);
    assert.ok(own.design.crafts.own.batches > 0 && own.design.shots.supply.own > 0 && own.design.gates.own.d >= 0, JSON.stringify(own.design.crafts));
    assert.ok(own.design.shotsKind.pair.d.fired > 0, 'the pair\'s main fired its twin\'s shots');
    assert.equal(own.money.closureGap, 0);
    assert.equal(own.design.goods.failing, 0, JSON.stringify(own.design.goods.worst));
    const shelf = runWith({ ...Design.DESIGN, ownUseFirst: false });
    assert.equal(shelf.design.crafts.own.batches, 0);
    assert.equal(shelf.money.closureGap, 0);
}

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

// luxuryCrystallizes: gear Luxury sells for crystals crystallizes back as
// the data say (true) or gives no crystals (false, ours until a second C4
// source confirms the counts).
{
    const world = { ...snapshot, luxuryOptions: { [SWORD]: { town: 'TownA', c: 0, d: 300 } } }, view = Engine.viewOf(world, { npcPrices: 'x1' });
    assert.equal(Design.gameOf(world, view, { ...Design.DESIGN, luxuryCrystallizes: true }).items[SWORD].crystals, 200);
    const off = Design.gameOf(world, view, { ...Design.DESIGN, luxuryCrystallizes: false });
    assert.equal(off.items[SWORD].crystals, 0);
    assert.equal(off.items[BONE], world.items[BONE], 'other items as they are');
}

// The twin's seat follows the mains' WTB ads of its product in the town
// its main arrives in, and only there. The twin starts in its main's
// starter village (the starter_region reading); its main resupplies in
// TownA. The other main, shotless, posts a WTB for Soulshot D in the town of
// its spot: in TownA the twin moves there; in a third town it stays.
{
    const fares = { TownA: { TownA: 0, 'Dwarven Village': 500, TownC: 500 }, 'Dwarven Village': { TownA: 500, 'Dwarven Village': 0, TownC: 500 }, TownC: { TownA: 500, 'Dwarven Village': 500, TownC: 0 } };
    const seated = buyerTown => {
        const s2 = levels.map(level => [`s2@${level}`, { ...yields, town: buyerTown }]);
        const world = { ...snapshot, fares, hours: { ...snapshot.hours, 9: Object.fromEntries(levels.map(level => [level, { classId: 9, shotId: SSD, best: row('s2', 1000, 50), top: [] }])) },
            yields: { ...snapshot.yields, ...Object.fromEntries(s2) }, yieldsDesign: { ...snapshot.yieldsDesign, ...Object.fromEntries(s2) }, walkBack: { s1: 0.01, s2: 0.01 } };
        const view = Engine.viewOf(world, { npcPrices: 'x1' }), config = { ...Design.DESIGN, twinSeat: 'starter_region' };
        return Engine.simulate({ view, accounts, bands, rates, hours: 8, seed: 5, nextArrival: arrivals,
            design: Design.plane({ snapshot: world, game: Design.gameOf(world, view, config), config, start: 'fresh', grades }) }).design;
    };
    const near = seated('TownA'), far = seated('TownC');
    assert.ok(near.liveness.waits.wtb.opened > 0 && far.liveness.waits.wtb.opened > 0, 'the shotless main posted its WTB');
    assert.deepEqual([near.crafters.byTown.TownA, near.counters.reseats], [1, 1], 'a WTB of its product where its main arrived: it moves');
    assert.deepEqual([far.crafters.byTown['Dwarven Village'], far.counters.reseats], [1, 0], 'a WTB in a third town: it stays');
}

// An order no twin takes: the main leaves its two bones and the fee with
// the order, the fee rises at its next two visits, at the third it is
// withdrawn and the bones and the fee come back (no twin holds the armour's
// recipe); money and goods close to the unit.
{
    const ARMOR = 2003, SCROLL2 = 5002;
    const world = { ...snapshot,
        kits: { ...snapshot.kits, 9: Object.fromEntries(levels.map(level => [level, [{ selfId: SWORD, slot: 7 }, { selfId: ARMOR, slot: 10 }]])) },
        items: { ...snapshot.items, [ARMOR]: { kind: 'Armor.Body', grade: 'D', ref: 2000, npcBuy: 1000, crystals: 50 }, [SCROLL2]: { kind: 'Other.Recipe', grade: 'NONE', ref: 100, npcBuy: 50, crystals: 0 } },
        recipes: [...snapshot.recipes, { type: 'dwarven', recipeId: 30, recipeItemId: SCROLL2, level: 2, materials: [{ selfId: BONE, amount: 2 }], productId: ARMOR, productCount: 1, mpCost: 100, successRate: 100, quest: false }],
        sources: { ...snapshot.sources, [SCROLL2]: { drop: [{ npcId: 2, yield: 1 }], spoil: [] } } };
    const view = Engine.viewOf(world, { npcPrices: 'x1' });
    const out = Engine.simulate({ view, accounts, bands, rates, hours: 16, seed: 5, nextArrival: arrivals,
        design: Design.plane({ snapshot: world, game: Design.gameOf(world, view), start: 'late', grades }) });
    const orders = out.design.market.orders, waits = out.design.liveness.waits.order;
    assert.ok(orders.posted >= 1 && orders.claimed === 0, JSON.stringify(orders));
    assert.deepEqual([orders.withdrawn, orders.open], [orders.posted, 0], 'every order no twin took came back');
    assert.ok(waits.failed >= 1 && waits.opened === waits.done + waits.withdrawn + waits.failed + waits.open, JSON.stringify(waits));
    assert.equal(out.money.closureGap, 0);
    assert.equal(out.design.goods.failing, 0, JSON.stringify(out.design.goods.worst));
}

// The design mode's hunting share per band: the fitted shares, a config's
// huntShare row over them, --hunt-share over every band; default follows the
// band it stood for.
{
    const { huntShares } = require('../scripts/economy-model/run');
    const low = { huntShare: 0.6, visitsPerBotHour: 2 }, fitted = { '20-29': low, '30-39': { huntShare: 0.5, visitsPerBotHour: 2 }, default: low };
    assert.deepEqual(huntShares(fitted, null, null).huntShare, { '20-29': 0.6, '30-39': 0.5 }, 'the fitted shares');
    assert.deepEqual(huntShares(fitted, { '30-39': 0.4 }, null).huntShare, { '20-29': 0.6, '30-39': 0.4 });
    const swept = huntShares(fitted, { '30-39': 0.4 }, '0.2');
    assert.deepEqual(swept.huntShare, { '20-29': 0.2, '30-39': 0.2 }, '--hunt-share for every band');
    assert.equal(swept.rates.default.huntShare, 0.2);
    assert.equal(swept.rates['30-39'].visitsPerBotHour, 2, 'the other rates as fitted');
}

// A death is an arrival (deathArrival): at its spot's deaths per hunting
// hour the main dies in the field, drawn by the arrival's seeded roll, and
// visits the respawn town of its spot; without the switch deaths stay
// folded into the hunting share. Money and goods close.
{
    const { deathAt } = require('../scripts/economy-model/rules/trip');
    near(deathAt({ since: 10, huntShare: 0.5, deathsPerHour: 0.5, roll: 1 - Math.exp(-1) }), 14, 'one mean interval: 2 hunting hours, 4 wall hours');
    assert.equal(deathAt({ since: 10, huntShare: 0.5, deathsPerHour: 0, roll: 0.5 }), null, 'a spot where it never dies');
    const dying = { ...snapshot, hours: { 55: hoursOf(55, 0), 9: Object.fromEntries(levels.map(level => [level, { classId: 9, shotId: SSD, best: { ...row('s1', 1000, 50), deaths: 0.5 }, top: [] }])) } };
    const runDying = deathArrival => {
        const view = Engine.viewOf(dying, { npcPrices: 'x1' }), config = { ...Design.DESIGN, deathArrival };
        return Engine.simulate({ view, accounts, bands, rates, hours: 8, seed: 5, nextArrival: arrivals,
            design: Design.plane({ snapshot: dying, game: Design.gameOf(dying, view, config), config, start: 'late', grades }) });
    };
    const died = runDying(true);
    assert.ok(died.design.market.trips.death >= 1, JSON.stringify(died.design.market.trips));
    assert.ok(died.design.market.visits.byBand.low.death >= 1, 'a visit counted by its cause');
    assert.equal(died.money.closureGap, 0);
    assert.equal(died.design.goods.failing, 0);
    assert.equal(runDying(false).design.market.trips.death, undefined, 'without the switch no death sends it to town');
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

// The market of mains: two buyers want the D sword their path names and no
// line offers one, so each posts a WTB at its first visit; a hunter that
// drops swords sells to the standing WTB at or above its floor, the first
// claimer (the dearer, then the earlier account) first, met at once. Neither
// buyer finds shots anywhere: its shot situation parks, so it does not come
// to town again and again. Money and items close.
{
    const OLD = 2002;
    const levels45 = Array.from({ length: 45 }, (_, i) => i + 1);
    // The hunter's loot: half a sword an hour at the NPC's 2000.
    const plain = (spotId, shots, loot = 0) => ({ spotId, kills: 10, exp: 1, adena: 1000, shots, dropLoot: loot, spoilLoot: 0, loot, potions: 0, busyShare: 1, deaths: 0, shotless: null });
    const market = {
        ...snapshot,
        header: { levels: [1, 45], rates: { adena: 1 } },
        exp: levels45.map(level => level * 1e9),
        hours: { 9: Object.fromEntries(levels45.map(level => [level, { classId: 9, shotId: SSD, best: plain('s1', 50), top: [] }])),
            46: Object.fromEntries(levels45.map(level => [level, { classId: 46, shotId: 0, best: plain('s2', 0, 1000), top: [] }])) },
        kits: { 9: Object.fromEntries(levels45.map(level => [level, [{ selfId: SWORD, slot: 7 }]])), 46: Object.fromEntries(levels45.map(level => [level, [{ selfId: OLD, slot: 7 }]])) },
        yields: Object.fromEntries(levels45.flatMap(level => [[`s1@${level}`, { town: 'TownA', drop: { 57: 100 }, spoil: {} }], [`s2@${level}`, { town: 'TownA', drop: { 57: 100, [SWORD]: 0.05 }, spoil: {} }]])),
        items: { ...snapshot.items, [OLD]: { kind: 'Weapon.Sword', grade: 'NONE', ref: 20, npcBuy: 10, crystals: 0 } },
        npcOffers: { preset: {}, x1: { [SWORD]: [{ town: 'TownA', price: 4000 }] } },
        recipes: [], races: { 9: 1, 46: 3 },
        bags: { 9: { race: 1, slots: 80, maxLoad: 1e6 }, 46: { race: 3, slots: 2, maxLoad: 1e6 } },
        pieceWorth: { 9: { d: { level: 20, last: 39, spotId: 's1', deathHours: 0, pieces: { [SWORD]: { slot: 7, gear: 1, with: 2000, without: 1000 } } } } },
        walkBack: { s1: 0.01, s2: 0.01 }
    };
    market.yieldsDesign = market.yields;
    const buyers = [
        { id: 11, station: false, classId: 9, line: '9', level: 22, exp: 22e9, money: 100000, spot: null, shots: {}, held: [], worn: { 7: OLD } },
        { id: 12, station: false, classId: 9, line: '9', level: 24, exp: 24e9, money: 100000, spot: null, shots: {}, held: [], worn: { 7: OLD } },
        { id: 13, station: false, classId: 46, line: '46', level: 35, exp: 35e9, money: 1000, spot: null, shots: {}, held: [OLD], worn: { 7: OLD } }
    ];
    const marketBands = [['first', 1], ['second', 23], ['seller', 30]];
    const runMarket = (seed, config = Design.DESIGN, cohort = buyers, hours = 8) => {
        const view = Engine.viewOf(market, { npcPrices: 'x1' });
        return Engine.simulate({ view, accounts: cohort, bands: marketBands, rates, hours, seed, design: Design.plane({ snapshot: market, game: Design.gameOf(market, view, config), config, start: 'late', grades }) });
    };
    const done = runMarket(3), waits = done.design.liveness.waits;
    assert.equal(waits.wtb.opened, 4, 'each buyer posts a WTB for the sword and one for its shots: no line offers either');
    assert.ok(done.design.market.meetings >= 1, 'the hunter sold to a standing WTB, met at once');
    const bands = done.progress.stageBands, paid = band => bands[band].money.meanStart - bands[band].money.meanEnd;
    assert.equal(paid('first') - paid('second'), 3600, 'the first claimer (the earlier account at the same price) paid its WTB, 0.9 x the NPC\'s 4000; the second is still waiting');
    assert.equal(done.design.market.obtained.d.buy, done.design.market.meetings, 'each sword met a WTB and was worn');
    assert.equal(done.money.closureGap, 0);
    assert.equal(done.design.goods.failing, 0, JSON.stringify(done.design.goods.worst));
    assert.deepEqual(runMarket(3), done, 'a run is a function of its seed');
    // No shots anywhere: after its first visit each buyer's shot situation is parked.
    assert.ok(done.design.market.trips.shotsParked >= 2);
    assert.ok(done.counters.visits <= 12, `three mains in 8 hours come to town ${done.counters.visits} times`);
    // Every wait opened ended (done, withdrawn, failed, at its deadline) or is open at the end.
    for (const result of [done, out]) for (const [kind, w] of Object.entries(result.design.liveness.waits)) {
        assert.equal(w.opened, w.done + w.withdrawn + w.failed + w.deadline + w.open, `${kind}: ${JSON.stringify(w)}`);
    }
    // A claim cannot be filled twice: over a day the hunter drops many swords,
    // but each buyer's WTB (one sword) is met once; the rest go elsewhere.
    const day = runMarket(3, Design.DESIGN, buyers, 24), dayBands = day.design.market;
    assert.ok(day.design.goods.items > 0 && (day.design.goods.totals.drop || 0) > 0);
    assert.ok(dayBands.meetings <= 2 && dayBands.obtained.d.buy <= 2, `two WTBs, two swords at most: ${dayBands.meetings}`);
    const spent = band => day.progress.stageBands[band].money.meanStart - day.progress.stageBands[band].money.meanEnd;
    assert.ok(spent('first') <= 4000 && spent('second') <= 4000, `each buyer paid one sword at most: ${spent('first')}, ${spent('second')}`);
    // A WTB its owner cannot pay fails at the meeting: no deal, the WTB is
    // withdrawn, counted; the seller keeps its sword for the next buyer.
    const poor = runMarket(3, Design.DESIGN, buyers.map(row => (row.id === 11 ? { ...row, money: 1000 } : row)));
    assert.ok(poor.design.market.unfunded.wtb >= 1, JSON.stringify(poor.design.market.unfunded));
    assert.equal(poor.progress.stageBands.first.money.meanStart - poor.progress.stageBands.first.money.meanEnd <= 0, true, 'the poor buyer paid nothing');
    assert.ok(poor.design.liveness.waits.wtb.failed >= 1);
    assert.equal(poor.money.closureGap, 0);
    assert.equal(poor.design.goods.failing, 0, JSON.stringify(poor.design.goods.worst));
}

// An order at a workshop from the customer's own materials: a main that
// wants a sword nobody sells gathers the five bones of its recipe at its
// own spot (its own hour given up: none), leaves them and the fee with the
// order; the Bounty Hunter's twin, which holds the recipe its main dropped
// and has no other work (no craft of its own, no buy store), takes it for
// its MP, the fee before
// the roll. The sword reaches the buyer, who wears it. Money (the fee held
// with the open order included) and items (the bones with the order
// included) close; a 60 % recipe can fail: the bones are gone, the fee kept.
{
    const RECIPE30 = 5030, JUNK = 1869;
    const levels30 = Array.from({ length: 30 }, (_, i) => i + 1);
    // Loot an hour: s1 70 (10 kills x (0.5 bones x 10 + 2 junk x 1)), s2 45 (the recipe's scroll at 0.05 a kill x 50 and the junk).
    const plain = (spotId, shots, loot = 0) => ({ spotId, kills: 10, exp: 1, adena: 1000, shots, dropLoot: loot, spoilLoot: 0, loot, potions: 0, busyShare: 1, deaths: 0, shotless: null });
    const byLevel = make => Object.fromEntries(levels30.map(level => [level, make(level)]));
    const world = {
        ...snapshot,
        hours: { 9: byLevel(() => ({ classId: 9, shotId: 0, best: plain('s1', 0, 70), top: [] })), 55: byLevel(() => ({ classId: 55, shotId: 0, best: plain('s2', 0, 45), top: [] })) },
        kits: { 9: byLevel(() => [{ selfId: SWORD, slot: 7 }]), 55: byLevel(() => [{ selfId: 2002, slot: 7 }]) },
        yields: Object.fromEntries(levels30.flatMap(level => [[`s1@${level}`, { town: 'TownA', drop: { 57: 100, [BONE]: 0.5, [JUNK]: 2 }, spoil: {} }], [`s2@${level}`, { town: 'TownA', drop: { 57: 100, [RECIPE30]: 0.05, [JUNK]: 2 }, spoil: {} }]])),
        items: { ...snapshot.items, 2002: { kind: 'Weapon.Sword', grade: 'NONE', ref: 20, npcBuy: 10, crystals: 0 }, [RECIPE30]: { kind: 'Other.Recipe', grade: 'NONE', ref: 100, npcBuy: 50, crystals: 0 },
            [JUNK]: { kind: 'Other.Material', grade: 'NONE', ref: 2, npcBuy: 1, crystals: 0, weight: 10 } },
        recipes: [{ type: 'dwarven', recipeId: 30, recipeItemId: RECIPE30, level: 1, materials: [{ selfId: BONE, amount: 5 }], productId: SWORD, productCount: 1, mpCost: 50, successRate: 100, quest: false }],
        npcOffers: { preset: {}, x1: {} },
        sources: { [BONE]: { drop: [{ npcId: 1, yield: 1 }], spoil: [] }, [RECIPE30]: { drop: [{ npcId: 1, yield: 1 }], spoil: [] } },
        bags: { 9: { race: 1, slots: 80, maxLoad: 300 }, 55: { race: 4, slots: 80, maxLoad: 300 } },
        pieceWorth: { 9: { d: { level: 20, last: 29, spotId: 's1', deathHours: 0, pieces: { [SWORD]: { slot: 7, gear: 1, with: 2000, without: 1000 } } } } },
        walkBack: { s1: 0.01, s2: 0.01 },
        // A twin without buy-store slots: no line of its own to weigh against the order.
        twins: Object.fromEntries(levels30.map(level => [level, { ...twin(level), storeSlots: { sell: 4, buy: 0 } }]))
    };
    world.yieldsDesign = world.yields;
    const pair = [
        { id: 21, station: false, classId: 55, line: '55', level: 25, exp: 25e9, money: 100, spot: null, shots: {}, held: [2002], worn: { 7: 2002 } },
        { id: 22, station: false, classId: 9, line: '9', level: 25, exp: 25e9, money: 100000, spot: null, shots: {}, held: [], worn: { 7: 2002 } }
    ];
    const runOrder = (seed, rate = 100) => {
        const at = rate === 100 ? world : { ...world, recipes: [{ ...world.recipes[0], successRate: rate }] }, view = Engine.viewOf(at, { npcPrices: 'x1' });
        return Engine.simulate({ view, accounts: pair, bands: [['twin', 1], ['buyer', 25]], rates, hours: 24, seed, design: Design.plane({ snapshot: at, game: Design.gameOf(at, view), start: 'late', grades }) });
    };
    const done = runOrder(4), d = done.design, orders = d.market.orders;
    assert.ok(orders.posted >= 1 && orders.claimed >= 1 && orders.delivered >= 1, JSON.stringify(orders));
    assert.equal(d.market.obtained.d.order, 1, 'the buyer\'s sword came by the order');
    assert.ok(d.goods.totals.craftIn >= 5, 'the bones went into the craft');
    assert.ok(d.money.end.crafters.money - d.money.start.crafters.money >= 650, `the twin kept the fee, 50 MP x 13: ${JSON.stringify(d.money)}`);
    assert.equal(done.money.closureGap, 0);
    assert.equal(d.goods.failing, 0, JSON.stringify(d.goods.worst));
    for (const [kind, w] of Object.entries(d.liveness.waits)) assert.equal(w.opened, w.done + w.withdrawn + w.failed + w.deadline + w.open, `${kind}: ${JSON.stringify(w)}`);
    // A 60 % recipe: some seed fails a craft; the fee stays with the twin, the bones are gone, and both ledgers close.
    const risky = [1, 2, 3, 4, 5, 6, 7, 8].map(seed => runOrder(seed, 60));
    const failed = risky.find(r => r.design.market.orders.failed > 0);
    assert.ok(failed, 'a failed craft among eight seeds');
    assert.ok(failed.design.money.end.crafters.money - failed.design.money.start.crafters.money >= 650, 'the fee is kept');
    for (const r of risky) { assert.equal(r.money.closureGap, 0); assert.equal(r.design.goods.failing, 0, JSON.stringify(r.design.goods.worst)); }
}

// path ranks pieces by their worth per adena of their route: with money for
// one of two pieces the NPC sells (3000 and 2900), the main buys the one
// that lifts its hour 0.9 times before the one that lifts it 0.4 times (both
// worth more than their price). By the cap, the NPC's price, the two would
// tie and the lower item id would win.
{
    const LOW = 2003, HIGH = 2004, JUNK = 1869, levels30 = Array.from({ length: 30 }, (_, i) => i + 1);
    // It earns 20 an hour from junk whose weight brings it to town about hourly (its WTBs' looks).
    const hourRow = { spotId: 's1', kills: 10, exp: 1e7, adena: 0, shots: 0, dropLoot: 20, spoilLoot: 0, loot: 20, potions: 0, busyShare: 1, deaths: 0, shotless: null };
    const world = {
        ...snapshot,
        hours: { 9: Object.fromEntries(levels30.map(level => [level, { classId: 9, shotId: 0, best: hourRow, top: [] }])) },
        kits: { 9: Object.fromEntries(levels30.map(level => [level, [{ selfId: LOW, slot: 6 }, { selfId: HIGH, slot: 10 }]])) },
        items: { ...snapshot.items, [LOW]: { kind: 'Armor.Body', grade: 'D', ref: 3000, npcBuy: 1500, crystals: 0 }, [HIGH]: { kind: 'Armor.Legs', grade: 'D', ref: 3000, npcBuy: 1500, crystals: 0 },
            [JUNK]: { kind: 'Other.Material', grade: 'NONE', ref: 2, npcBuy: 1, crystals: 0, weight: 10 } },
        yields: Object.fromEntries(levels30.map(level => [`s1@${level}`, { town: 'TownA', drop: { [JUNK]: 2 }, spoil: {} }])),
        bags: { 9: { race: 1, slots: 80, maxLoad: 300 } },
        recipes: [], npcOffers: { preset: {}, x1: { [LOW]: [{ town: 'TownA', price: 3000 }], [HIGH]: [{ town: 'TownA', price: 2900 }] } },
        pieceWorth: { 9: { d: { level: 20, last: 39, spotId: 's1', deathHours: 0, pieces: { [LOW]: { slot: 6, gear: 0, with: 1400, without: 1000 }, [HIGH]: { slot: 10, gear: 0, with: 1900, without: 1000 } } } } }
    };
    world.yieldsDesign = world.yields;
    const view = Engine.viewOf(world, { npcPrices: 'x1' });
    const one = Engine.simulate({ view, accounts: [{ id: 31, station: false, classId: 9, line: '9', level: 25, exp: 25e9, money: 4000, spot: null, shots: {}, held: [], worn: {} }],
        bands: [['all', 1]], rates, hours: 12, seed: 2, design: Design.plane({ snapshot: world, game: Design.gameOf(world, view), start: 'late', grades }) });
    assert.deepEqual([one.design.goods.totals.fromNpc, one.design.market.obtained.d.npc], [1, 1], 'one piece bought');
    assert.equal(Math.round(one.flows.perBotHour.npcBuys * 12), -2900, 'the piece worth more per adena');
}

// spot_left: a main holds the spot it chose until its level leaves the spot
// table's range for its line there, even when the spot drops out of its top
// spots: it takes A at grade_changed (20), keeps it through 23-26 where B
// and then C top the list, and moves only at 27, past A's range 20-26.
{
    const levels30 = Array.from({ length: 30 }, (_, i) => i + 1);
    const spot = (spotId, adena) => ({ spotId, kills: 10, exp: 1e9, adena, shots: 0, dropLoot: 0, spoilLoot: 0, loot: 0, potions: 0, busyShare: 1, deaths: 0, shotless: null });
    const ranges = { A: [20, 26], B: [23, 24], C: [25, 30] };
    const inRange = (id, level) => level >= ranges[id][0] && level <= ranges[id][1];
    const topOf = level => (level <= 22 ? ['A'] : level <= 24 ? ['B'] : ['C']).filter(id => inRange(id, level));
    const world = {
        ...snapshot,
        hours: { 9: Object.fromEntries(levels30.map(level => {
            const top = topOf(level).map(id => spot(id, 1000)), others = ['A'].filter(id => level >= 23 && inRange(id, level)).map(id => spot(id, 900));
            return [level, { classId: 9, shotId: 0, best: top[0] || spot('A', 1000), top, ...(others.length ? { others } : {}) }];
        })) },
        spotLevels: { 9: ranges },
        kits: { 9: Object.fromEntries(levels30.map(level => [level, [{ selfId: SWORD, slot: 7 }]])) },
        yields: Object.fromEntries(levels30.flatMap(level => ['A', 'B', 'C'].map(id => [`${id}@${level}`, { town: 'TownA', drop: { 57: 100 }, spoil: {} }]))),
        walkBack: { A: 0.01, B: 0.01, C: 0.01 }
    };
    world.yieldsDesign = world.yields;
    const view = Engine.viewOf(world, { npcPrices: 'x1' });
    const ran = Engine.simulate({ view, accounts: [{ id: 41, station: false, classId: 9, line: '9', level: 19, exp: 19.5e9, money: 1000, spot: null, shots: {}, held: [SWORD], worn: { 7: SWORD } }],
        bands: [['all', 1]], rates, hours: 9, seed: 1, design: Design.plane({ snapshot: world, game: Design.gameOf(world, view), start: 'late', grades }) });
    const moves = ran.design.market.occupation;
    assert.deepEqual([moves.grade_changed, moves.spot_left, moves.rowMissing], [1, 1, 0], JSON.stringify(moves));
}

// A pair's main deals only in the town it stands in: both twins sit in the
// starter village, the Bounty Hunter's twin sells Soulshot D there, and the
// other pair's main, hunting out of TownA, knows that line (its twin's
// town) but never buys from it. Its own twin's shelf would still reach it
// through the account warehouse.
{
    const village = 'Elven Village';
    // The other main's bones bring it to town about every two hours.
    const world = { ...snapshot, races: { 55: 1, 9: 1 }, items: { ...snapshot.items, [BONE]: { ...snapshot.items[BONE], weight: 10 } }, bags: { ...snapshot.bags, 9: { race: 1, slots: 80, maxLoad: 150 } },
        npcOffers: { preset: {}, x1: { [ORE]: [{ town: 'TownA', price: 300 }, { town: village, price: 300 }], [SWORD]: [{ town: 'TownA', price: 4000 }, { town: village, price: 4000 }] } } };
    const config = { ...Design.DESIGN, twinSeat: 'starter_region', crafterShare: 1 };
    const view = Engine.viewOf(world, { npcPrices: 'x1' });
    const apart = Engine.simulate({ view, accounts, bands, rates, hours: 8, seed: 5, nextArrival: arrivals,
        design: Design.plane({ snapshot: world, game: Design.gameOf(world, view, config), config, start: 'fresh', grades }) }).design;
    assert.deepEqual(apart.crafters.byTown, { [village]: 2 }, 'both twins in the village');
    assert.ok(apart.firsts.shot.d > 0, 'the Bounty Hunter\'s twin crafted shots there');
    assert.equal(apart.shots.supply.lines, 0, 'no main bought on a line of a town it did not stand in');
}

// A want the main leaves the grade without fails as outgrown, not as a
// neutral withdrawal: its D sword's WTB is open when it reaches C (40).
{
    const CSWORD = 2005, JUNK = 1869, levels45 = Array.from({ length: 45 }, (_, i) => i + 1);
    const hourRow = { spotId: 's1', kills: 10, exp: 5e8, adena: 0, shots: 0, dropLoot: 20, spoilLoot: 0, loot: 20, potions: 0, busyShare: 1, deaths: 0, shotless: null };
    const world = {
        ...snapshot, header: { levels: [1, 45], rates: { adena: 1 } }, exp: levels45.map(level => level * 1e9),
        hours: { 9: Object.fromEntries(levels45.map(level => [level, { classId: 9, shotId: 0, best: hourRow, top: [] }])) },
        kits: { 9: Object.fromEntries(levels45.map(level => [level, [{ selfId: level < 40 ? SWORD : CSWORD, slot: 7 }]])) },
        items: { ...snapshot.items, [CSWORD]: { kind: 'Weapon.Sword', grade: 'C', ref: 40000, npcBuy: 20000, crystals: 0 }, [JUNK]: { kind: 'Other.Material', grade: 'NONE', ref: 2, npcBuy: 1, crystals: 0, weight: 10 } },
        yields: Object.fromEntries(levels45.map(level => [`s1@${level}`, { town: 'TownA', drop: { [JUNK]: 2 }, spoil: {} }])),
        recipes: [], npcOffers: { preset: {}, x1: { [SWORD]: [{ town: 'TownA', price: 4000 }], [CSWORD]: [{ town: 'TownA', price: 40000 }] } }, bags: { 9: { race: 1, slots: 80, maxLoad: 300 } },
        twins: Object.fromEntries(levels45.map(level => [level, twin(level)]))
    };
    world.yieldsDesign = world.yields;
    const view = Engine.viewOf(world, { npcPrices: 'x1' });
    const grown = Engine.simulate({ view, accounts: [{ id: 51, station: false, classId: 9, line: '9', level: 39, exp: 39e9, money: 1000, spot: null, shots: {}, held: [], worn: {} }],
        bands: [['all', 1]], rates, hours: 8, seed: 1, design: Design.plane({ snapshot: world, game: Design.gameOf(world, view), start: 'late', grades }) }).design;
    // One visit or none before 40: no ladder, the NPC route at once, which its 1000 adena cannot pay.
    const waits = Object.values(grown.liveness.waits), outgrown = waits.reduce((sum, w) => sum + (w.outgrown || 0), 0);
    assert.ok(outgrown >= 1 && waits.every(w => w.failed >= (w.outgrown || 0)), JSON.stringify(grown.liveness.waits));
    assert.equal(waits.filter(w => w.outgrown > 0).reduce((sum, w) => sum + w.withdrawn, 0), 0, 'not a neutral withdrawal');
    assert.equal(grown.market.outgrown.d, outgrown, 'counted under the grade it left');
    for (const w of waits) assert.equal(w.opened, w.done + w.withdrawn + w.failed + w.deadline + w.open);
}

// pathTarget: a level-21 main with 10000 adena and no weapon. Its line's kit
// names a 4000 sword (NPC) at 20-29 and a 40000 one at 30-39. Aiming at its
// own level (ours) it buys the 4000 sword at its first visit; aiming at the
// grade's last level (the model before) it waits for 40000 it never has.
{
    const DEAR = 2006, JUNK = 1869, levels45 = Array.from({ length: 45 }, (_, i) => i + 1);
    const hourRow = { spotId: 's1', kills: 10, exp: 1, adena: 0, shots: 0, dropLoot: 20, spoilLoot: 0, loot: 20, potions: 0, busyShare: 1, deaths: 0, shotless: null };
    const world = {
        ...snapshot, header: { levels: [1, 45], rates: { adena: 1 } }, exp: levels45.map(level => level * 1e9),
        hours: { 9: Object.fromEntries(levels45.map(level => [level, { classId: 9, shotId: 0, best: hourRow, top: [] }])) },
        kits: { 9: Object.fromEntries(levels45.map(level => [level, [{ selfId: level < 30 ? SWORD : DEAR, slot: 7 }]])) },
        items: { ...snapshot.items, [DEAR]: { kind: 'Weapon.Sword', grade: 'D', ref: 40000, npcBuy: 20000, crystals: 0 }, [JUNK]: { kind: 'Other.Material', grade: 'NONE', ref: 2, npcBuy: 1, crystals: 0, weight: 10 } },
        yields: Object.fromEntries(levels45.map(level => [`s1@${level}`, { town: 'TownA', drop: { [JUNK]: 2 }, spoil: {} }])),
        recipes: [], npcOffers: { preset: {}, x1: { [SWORD]: [{ town: 'TownA', price: 4000 }], [DEAR]: [{ town: 'TownA', price: 40000 }] } }, bags: { 9: { race: 1, slots: 80, maxLoad: 300 } },
        twins: Object.fromEntries(levels45.map(level => [level, twin(level)]))
    };
    world.yieldsDesign = world.yields;
    const view = Engine.viewOf(world, { npcPrices: 'x1' });
    const aim = pathTarget => Engine.simulate({ view, accounts: [{ id: 61, station: false, classId: 9, line: '9', level: 21, exp: 21e9, money: 10000, spot: null, shots: {}, held: [], worn: {} }],
        bands: [['all', 1]], rates, hours: 8, seed: 1, nextArrival: arrivals, design: Design.plane({ snapshot: world, game: Design.gameOf(world, view), config: { ...Design.DESIGN, pathTarget }, start: 'late', grades }) }).design;
    const own = aim('own_level_then_up'), last = aim('grade_last_level');
    assert.deepEqual(own.market.obtained.d, { npc: 1 }, 'the sword of its own level, from the NPC');
    assert.equal(own.market.gradeWeapon.d.first !== null, true, 'a weapon of its grade worn');
    assert.equal(last.market.obtained.d, undefined, 'aiming at the last level: nothing it can pay');
}

// A farm route is priced at a spot the main can hunt at its own level: a
// level-25 main whose own spot pays 1000 an hour is not charged nothing for
// farming its sword at a level-30 spot paying 5000 (its farm route would
// cost 0 and its cap fall to 0, refusing every seller): it has no farm
// route and buys the sword from the NPC once its WTB has run its looks.
{
    const JUNK = 1869, levels30 = Array.from({ length: 30 }, (_, i) => i + 1);
    const row = (spotId, adena, loot) => ({ spotId, kills: 10, exp: 1, adena, shots: 0, dropLoot: loot, spoilLoot: 0, loot, potions: 0, busyShare: 1, deaths: 0, shotless: null });
    const world = {
        ...snapshot,
        hours: { 9: Object.fromEntries(levels30.map(level => [level, { classId: 9, shotId: 0, best: level < 30 ? row('s1', 1000, 20) : row('s9', 5000, 220), top: [] }])) },
        kits: { 9: Object.fromEntries(levels30.map(level => [level, [{ selfId: SWORD, slot: 7 }]])) },
        items: { ...snapshot.items, [JUNK]: { kind: 'Other.Material', grade: 'NONE', ref: 2, npcBuy: 1, crystals: 0, weight: 10 } },
        yields: Object.fromEntries(levels30.flatMap(level => [[`s1@${level}`, { town: 'TownA', drop: { [JUNK]: 2 }, spoil: {} }], [`s9@${level}`, { town: 'TownA', drop: { [JUNK]: 2, [SWORD]: 0.01 }, spoil: {} }]])),
        recipes: [], npcOffers: { preset: {}, x1: { [SWORD]: [{ town: 'TownA', price: 4000 }] } }, bags: { 9: { race: 1, slots: 80, maxLoad: 300 } },
        walkBack: { s1: 0.01, s9: 0.01 }
    };
    world.yieldsDesign = world.yields;
    const run2 = hourCost => {
        const config = { ...Design.DESIGN, hourCost }, view = Engine.viewOf(world, { npcPrices: 'x1' });
        return Engine.simulate({ view, accounts: [{ id: 61, station: false, classId: 9, line: '9', level: 25, exp: 25e9, money: 100000, spot: null, shots: {}, held: [], worn: {} }],
            bands: [['all', 1]], rates, hours: 10, seed: 1, design: Design.plane({ snapshot: world, game: Design.gameOf(world, view, config), config, start: 'late', grades }) }).design;
    };
    for (const hourCost of ['opportunity', 'literal']) {
        const out = run2(hourCost);
        assert.deepEqual([out.market.obtained.d?.npc, out.market.routes.zero], [1, 0], `${hourCost}: ${JSON.stringify(out.market.obtained)}, zero ${out.market.routes.zero}`);
    }
}

// Towns A and B, 100 a fare each way. The second main hunts a spot whose
// respawn town is A and drops 500 of a material an hour (5 at the NPC); the
// Bounty Hunter's twin, seated in B, holds a buy line of 1000 of it at 60
// (its workshop's answer stands in for the market here). tripTown
// 'by_gain': a main that knows B's book (its own twin sits in B: twinSeat
// 'hub' seats a twin in a hub though its main resupplies in A) goes there
// and sells on the line; at a bid of 5 (the NPC's price) it never does.
// hubKnown: a main that never saw B's book bets on its own first price for
// the material (25) when that beats the trip; without hubKnown it never
// learns of B. Money and goods close throughout.
{
    const Workshop = require('../scripts/economy-model/rules/workshop');
    const MAT = 1900;
    const runHub = ({ bid, config: patch }) => {
        const rowAt = spotId => (spotId === 's3'
            ? { ...row('s3', 10000, 50), dropLoot: 2500, loot: 2500, shotless: { kills: 5, exp: 0.5, adena: 5000, dropLoot: 1250, spoilLoot: 0, loot: 1250 } } : row(spotId, 1000, 0));
        const s2 = levels.map(level => [`s2@${level}`, { ...yields, town: 'B' }]), s3 = levels.map(level => [`s3@${level}`, { town: 'A', drop: { 57: 100, [MAT]: 50 }, spoil: {} }]);
        const world = { ...snapshot, fares: { A: { A: 0, B: 100 }, B: { A: 100, B: 0 } },
            items: { ...snapshot.items, [MAT]: { kind: 'Other.Material', grade: 'NONE', ref: 10, npcBuy: 5, crystals: 0, weight: 100 } },
            hours: { 55: Object.fromEntries(levels.map(level => [level, { classId: 55, shotId: SSD, best: rowAt('s2'), top: [] }])),
                9: Object.fromEntries(levels.map(level => [level, { classId: 9, shotId: SSD, best: rowAt('s3'), top: [] }])) },
            yields: Object.fromEntries([...s2, ...s3]), yieldsDesign: Object.fromEntries([...s2, ...s3]), walkBack: { s2: 0.01, s3: 0.01 },
            npcOffers: { preset: {}, x1: { [ORE]: [{ town: 'A', price: 300 }], [SWORD]: [{ town: 'A', price: 4000 }] } } };
        // A line that starts at its known price and barely steps (1000 looks to its cap).
        const view = Engine.viewOf(world, { npcPrices: 'x1' });
        const config = { ...Design.DESIGN, tripTown: 'by_gain', hubTowns: ['B'], crafterPersona: { looksToFloor: 1000, buyerStart: 1 }, ...patch };
        const real = Workshop.workshop;
        Workshop.workshop = seen => {
            const out = real(seen);
            if (seen.self !== 0) return out;
            const listed = seen.twin.lines.find(line => line.side === 'buy' && line.item === MAT);
            return { ...out, wanted: [...out.wanted.filter(line => line.item !== MAT), { side: 'buy', item: MAT, qty: 1000, lineId: listed?.id ?? null }],
                prices: { ...out.prices, [`buy:${MAT}`]: { cap: bid > 5 ? bid + 10 : bid, capBy: 'worth', floor: 0, known: bid, first: bid } } };
        };
        try {
            const game = Design.gameOf(world, view, config);
            const out = Engine.simulate({ view, accounts, bands, rates, hours: 8, seed: 5, nextArrival: arrivals, design: Design.plane({ snapshot: world, game, config, start: 'late', grades }) });
            assert.equal(out.money.closureGap, 0);
            assert.equal(out.design.goods.failing, 0, JSON.stringify(out.design.goods.worst));
            return { design: out.design, first: game.firstPrice[MAT] };
        } finally { Workshop.workshop = real; }
    };
    const pair = { twinSeat: 'hub', hubKnown: false, crafterShare: 0.5 };
    const sold = runHub({ bid: 60, config: pair }).design;
    assert.equal(sold.crafters.byTown.B, 2, 'both twins sit in the hub');
    assert.ok(sold.market.trips.hub_trip >= 1 && sold.market.visits.hub.hub_trip >= 1, JSON.stringify(sold.market.trips));
    assert.ok(sold.market.stock.hubLines > 0, JSON.stringify(sold.market.stock));
    const junk = runHub({ bid: 5, config: pair }).design;
    assert.deepEqual([junk.market.trips.hub_trip, junk.market.visits.hub, junk.market.stock.hubLines], [undefined, {}, 0], 'a bid at the NPC price: no hub visit');
    const bet = runHub({ bid: 60, config: { hubKnown: true, crafterShare: 0 } });
    assert.equal(bet.first, 25, 'its own first price of the material');
    assert.ok(bet.design.market.visits.hub.hub_trip >= 1, `a bet on 25 a unit: ${JSON.stringify(bet.design.market.visits)}`);
    assert.deepEqual(runHub({ bid: 60, config: { hubKnown: false, crafterShare: 0 } }).design.market.visits.hub, {}, 'it never learns of B');
}

console.log('PASS economy model design mode');
