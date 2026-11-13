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
const Worth = require('../scripts/economy-model/rules/worth');
const Books = require('../scripts/economy-model/books');

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
    tradeTowns: { grade: { [SSD]: 'd', [CRYSTAL]: 'd' }, none: { s1: 'TownA' }, d: ['TownA'], higher: 'TownA' },
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
// A line's gear ladder (the snapshot's gearLadder): level bands, each with
// its rungs per slot group (best first); testHours: the hour each piece a
// main there may wear adds in its group (0: the empty slot), the numbers the
// fixture's kit hours read (stubKitHours).
const ladderOf = (line, bands) => ({ slots: {}, lines: { [line]: bands.map(([from, to, groups]) => {
    const each = field => Object.fromEntries(Object.entries(groups).map(([group, row]) => [group, field(row)]));
    return { from, to, level: from, grade: 'd', best: 's1', scale: 1, rungs: each(row => row.rungs), testHours: each(row => row.hour) };
}) } });
// A kit hour source over hourOf(line, level, kit) -> number | null (the
// hour firing none) and shotsOf(line, level, kit, hour) -> [{ id, gross,
// units }] (the hour per kind of shot the kit fires) with the seam of
// kit-hours.js: a piece put on in a slot takes the other hand's weapon off;
// a weapon fires the row's count (shotScale 1).
const kitHoursOf = (hourOf, shotsOf = () => []) => {
    const hour = (line, level, kit) => { const none = hourOf(line, level, kit); return none === null ? null : { none, shots: shotsOf(line, level, kit, none) }; };
    const swaps = (line, level, kit, pieces) => {
        const numbers = value => (value === null ? null : { pAtk: 1, mAtk: 1, pDef: 1, mDef: 1 }), base = hour(line, level, kit);
        return { hour: base, numbers: numbers(base), caster: false, deathHours: 0, swaps: pieces.map(({ slot, selfId }) => {
            const next = [7, 14].includes(Number(slot)) ? { ...kit, 7: 0, 14: 0, [slot]: selfId } : { ...kit, [slot]: selfId }, at = hour(line, level, next);
            return { hour: at, numbers: numbers(at) };
        }) };
    };
    return { hour, swaps, shotScale: () => 1 };
};
// The shots a fixture kit fires: the shot of its line's hour at its
// weapon's grade, the row's shots an hour, gross by what the row with shots
// adds over the row without (adena and loot).
const fixtureShots = world => (line, level, kit, none) => {
    const hour = world.hours?.[line]?.[level], row = hour?.best, weapon = Number(kit[7] || kit[14]) || 0;
    if (!weapon || !hour?.shotId || !(row?.shots > 0)) return [];
    const family = world.shotFamilies.ids.find(ids => ids.includes(hour.shotId)), at = world.shotFamilies.grades.indexOf(world.items[weapon]?.grade);
    const bare = row.shotless || { adena: 0, loot: 0 };
    return [{ id: at >= 0 ? family[at] : hour.shotId, gross: none + row.adena + row.loot - bare.adena - bare.loot, units: row.shots }];
};
// The fixture ladder's kit hours: the sum over the band's groups of the
// number of the piece the kit wears there; a piece without one leaves the
// hour unstated.
const stubKitHours = world => kitHoursOf((line, level, kit) => {
    const band = (world.gearLadder?.lines?.[line] || []).find(row => level >= row.from && level <= row.to);
    if (!band) return null;
    let sum = 0;
    for (const [group, byId] of Object.entries(band.testHours)) {
        const worn = Number(group === 'weapon' ? kit[7] || kit[14] : kit[group]) || 0;
        if (byId[worn] === undefined) return null;
        sum += byId[worn];
    }
    return sum;
}, fixtureShots(world));
// The base fixture's ladder: each line's sword, the kit its shots are fired with.
const swordLadder = line => ladderOf(line, [[1, 30, { weapon: { rungs: [SWORD], hour: { [SWORD]: 1000, 0: 500 } } }]]).lines[line];
snapshot.gearLadder = { slots: {}, lines: { 55: swordLadder('55'), 9: swordLadder('9') } };
// The design plane with the fixture's kit hours unless given.
const plane = options => Design.plane({ kitHours: stubKitHours(options.snapshot), ...options });
const arrivals = (main, { event, now, pending, roll }) => (event === 'level_up' ? pending : now + (event === 'start' ? roll : 1));
const run = (seed, hours = 8, world = snapshot) => {
    const view = Engine.viewOf(world, { npcPrices: 'x1' });
    const game = Design.gameOf(world, view);
    return Engine.simulate({ view, accounts, bands, rates, hours, seed, nextArrival: arrivals, design: plane({ snapshot: world, game, start: 'late', grades }) });
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
// A deal on the line moved the price the buyer knows of its shot, not its
// kit's hour. The run's budget rests on the kit table: a main's table is
// taken once for its kit and band, never again for a price.
assert.equal(design.market.kitTables.taken, 2, 'one kit table per main');
assert.ok(design.botToBot > 0);
// The gate chain of Soulshot D: the crafter main was in D at the start, its
// twin learned from the scroll its main left it, crafted, and sold to a main.
const gates = design.gates;
assert.equal(gates.crafter.d, 0);
assert.equal(gates.recipe.d.from, 'its own main\'s drop');
assert.deepEqual(gates.scroll.d, { h: gates.scroll.d.h, from: 'its own main\'s drop', where: { spot: 's1', level: 25, line: '55', classId: 55, npcs: [] } },
    'the scroll reached the twin through the warehouse: where its main hunted (this snapshot names no NPC rewards)');
assert.equal(design.crafters.byTown.TownA, 1, 'its twin sits where its main resupplies (no trade towns in the fixture)');
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

// A caster's shot kind: its kit fires Spiritshot D (2000 an hour gross, 10
// shots) or Blessed Spiritshot D (2600, 10) or none (1000). At the NPC's 20
// and 50 the blessed nets more (2100 against 1800) and is what it buys and
// fires; at 20 and 90 the plain one (1800 against 1700). The refill and the
// kit's worth read the one answer (firing).
const SPSD = 2510, BSPSD = 3948;
// A caster's world: its spot row (the row's plain hour, row()'s hour without
// shots) with its hour firing Blessed Spiritshots (blessed), Spiritshot D at
// plainPrice and Blessed Spiritshot D at blessedPrice at the NPC; yields
// replaces the spot's per-kill yields.
const casterWorld = ({ plainPrice = 20, blessedPrice, blessed, yields: spotYields = null }) => ({ ...snapshot,
    hours: { 9: Object.fromEntries(levels.map(level => [level, { classId: 9, shotId: SSD, best: { ...row('s1', 1000, 50), blessed }, top: [] }])) }, kits: { 9: snapshot.kits[9] },
    items: { ...snapshot.items, [SPSD]: { kind: 'Other.Shot', grade: 'NONE', ref: 20, npcBuy: 10, crystals: 0 }, [BSPSD]: { kind: 'Other.Shot', grade: 'NONE', ref: 50, npcBuy: 25, crystals: 0 } },
    npcOffers: { preset: {}, x1: { ...snapshot.npcOffers.x1, [SPSD]: [{ town: 'TownA', price: plainPrice }], [BSPSD]: [{ town: 'TownA', price: blessedPrice }] } },
    shotFamilies: { grades: snapshot.shotFamilies.grades, ids: [...snapshot.shotFamilies.ids, [2509, SPSD, 2511, 2512, 2513, 2514], [3947, BSPSD, 3949, 3950, 3951, 3952]] },
    ...(spotYields ? { yields: Object.fromEntries(levels.map(level => [`s1@${level}`, spotYields])), yieldsDesign: Object.fromEntries(levels.map(level => [`s1@${level}`, spotYields])) } : {}) });
// A run of one account over a world with kit hours, held at its end: the
// plane's hooks, the run's context and the view.
const runHeld = (world, kitHours, account, hours) => {
    const view = Engine.viewOf(world, { npcPrices: 'x1' }), real = plane({ snapshot: world, game: Design.gameOf(world, view), start: 'late', grades, kitHours });
    let hooks = null, held = null;
    const design = { ...real, start: context => { held = context; hooks = real.start(context); return hooks; } };
    const out = Engine.simulate({ view, accounts: [account], bands, rates, hours, seed: 1, nextArrival: arrivals, design });
    return { out, hooks, main: held.mains[0], view };
};
{
    const runKind = blessedPrice => {
        const world = casterWorld({ blessedPrice, blessed: { kills: 10, exp: 1, adena: 1000, dropLoot: 150, spoilLoot: 0, loot: 150, shots: 50 } });
        const { out, hooks, main } = runHeld(world, kitHoursOf(() => 1000, () => [{ id: SPSD, gross: 2000, units: 10 }, { id: BSPSD, gross: 2600, units: 10 }]), accounts[1], 8);
        return { firing: hooks.firing(main), shots: Object.keys(main.shots).filter(id => main.shots[id] > 0).map(Number), fired: out.design.shots.byGrade.d?.fired || 0 };
    };
    const blessed = runKind(50), plainKind = runKind(90);
    assert.deepEqual([blessed.firing.id, blessed.firing.worth], [BSPSD, 80], 'at 50 the blessed: worth 80 a shot against the plain\'s 1800');
    assert.deepEqual([plainKind.firing.id, plainKind.firing.worth], [SPSD, 30], 'at 90 the plain: worth 30 a shot against the blessed\'s 1700');
    assert.ok(blessed.fired > 0 && plainKind.fired > 0, 'each fired its shots');
    assert.ok(blessed.shots.length && plainKind.shots.length && blessed.shots.every(id => id === BSPSD) && plainKind.shots.every(id => id === SPSD), `the refill bought the kind chosen: ${blessed.shots} | ${plainKind.shots}`);
}

// A main hunts the hour of the kind it fires. The caster's row: plain 10
// kills, 1 exp, 1000 adena, 50 Spiritshots an hour; without shots 500 adena,
// 0.5 exp; blessed 14 kills, 1.6 exp, 1500 adena, 70 Blessed Spiritshots,
// which its weapon fires at twice the row's count (shotScale 2). The kit
// hours state each kind from that row's hour (adena only: no loot to draw),
// so the decision's net of the kind it fires is what one hunting hour nets.
{
    const blessedHour = { kills: 14, exp: 1.6, adena: 1500, dropLoot: 0, spoilLoot: 0, loot: 0, shots: 70 }, scaleOf = blessed => (blessed ? 2 : 1);
    const hour = { none: 500, shots: [{ id: SPSD, gross: 1000, units: 50 * scaleOf(false) }, { id: BSPSD, gross: 1500, units: 70 * scaleOf(true) }] };
    const kitHours = { ...kitHoursOf(() => hour.none, () => hour.shots), shotScale: (line, level, spotId, weapon, blessed) => scaleOf(blessed) };
    const huntOne = (plainPrice, blessedPrice, blessed = blessedHour) => {
        const world = casterWorld({ plainPrice, blessedPrice, blessed, yields: { town: 'TownA', drop: { 57: 100 }, spoil: {} } });
        const { hooks, main, view } = runHeld(world, kitHours, { ...accounts[1], money: 0 }, 0), firing = hooks.firing(main), price = { [SPSD]: plainPrice, [BSPSD]: blessedPrice };
        const decided = Worth.firing(hour, id => price[id]), hunted = Engine.huntDesign({ ...main, shots: { [SPSD]: 1000, [BSPSD]: 1000 } }, view, 1, () => 0.5, firing).delta;
        return { decided, firing, hunted, net: hunted.flows.huntCold - hunted.shotsUsed * (price[hunted.shotId] || 0) };
    };
    // (1) Blessed at 2 against Spiritshot at 5: 1500 - 140 x 2 = 1220 over 1000 - 50 x 5 = 750.
    // One hunting hour credits the blessed hour (1500 adena, 1.6 exp) and
    // fires 140 Blessed Spiritshots; hunting the plain row it earned 1000
    // adena and 1 exp and fired 50.
    const blessed = huntOne(5, 2);
    assert.equal(blessed.firing.id, BSPSD, 'it fires Blessed Spiritshots');
    assert.deepEqual([blessed.hunted.flows.huntCold, blessed.hunted.exp, blessed.hunted.shotsUsed], [1500, 1.6, 140], 'the blessed hour at its weapon\'s count');
    // (2) The decision's net is the hunting hour's net: blessed 1220, plain
    // at a blessed price of 10 (750 over 100), none at 20 and 10 (500 over 0 and 100).
    for (const [prices, id, net] of [[[5, 2], BSPSD, 1220], [[5, 10], SPSD, 750], [[20, 10], 0, 500]]) {
        const at = huntOne(...prices);
        assert.deepEqual([at.decided.id, at.firing?.id ?? 0, at.decided.net], [id, id, net], `at ${prices}: the kind decided and fired`);
        near(at.net, at.decided.net, `at ${prices}: one hunting hour nets the decision's net`);
    }
    // At a row without a blessed hour (the spot table measured no such fight
    // there) Blessed Spiritshots are no option: at 5 and 2 it fires Spiritshots there.
    const unmeasured = huntOne(5, 2, null);
    assert.deepEqual([unmeasured.firing.id, unmeasured.hunted.flows.huntCold, unmeasured.hunted.shotsUsed], [SPSD, 1000, 50], 'the plain shot at the row');
    // A row the table has no reference count of the plain shot for (shotScale
    // null) states no units: that kind is no option there. At 5 and 10 Blessed
    // Spiritshots net 1500 - 140 x 10 = 100, under firing none's 500: it fires none.
    const noCount = { ...kitHours, shotScale: (line, level, spotId, weapon, blessed) => (blessed ? scaleOf(true) : null) };
    const counted = runHeld(casterWorld({ plainPrice: 5, blessedPrice: 10, blessed: blessedHour, yields: { town: 'TownA', drop: { 57: 100 }, spoil: {} } }), noCount, { ...accounts[1], money: 0 }, 0);
    assert.equal(counted.hooks.firing(counted.main), null, 'the plain shot has no count at the row: no option, it fires none');
}
// (3) A fighter fires its soulshot at its row: one hunting hour credits the
// row (1000 adena, 1 exp) and fires its 50 shots.
{
    const { hooks, main, view } = runHeld(snapshot, stubKitHours(snapshot), accounts[1], 0), firing = hooks.firing(main);
    const hunted = Engine.huntDesign({ ...main, shots: { [SSD]: 1000 } }, view, 1, () => 0.5, firing).delta;
    assert.deepEqual([firing.id, hunted.flows.huntCold, hunted.exp, hunted.shotsUsed], [SSD, 1000, 1, 50], 'the row\'s hour and count');
}

// Own use first at the engine: the Bounty Hunter fires Soulshot D too; its
// twin crafts its main's shortfall first, its main draws them through the
// warehouse and fires them; without the rule its twin serves the shelf.
// Money and goods close either way.
{
    const shooting = { ...snapshot, hours: { ...snapshot.hours, 55: hoursOf(55, 50) } };
    const runWith = config => {
        const view = Engine.viewOf(shooting, { npcPrices: 'x1' });
        return Engine.simulate({ view, accounts, bands, rates, hours: 8, seed: 5, nextArrival: arrivals,
            design: plane({ snapshot: shooting, game: Design.gameOf(shooting, view, config), config, start: 'late', grades }) });
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
    const drops = Engine.designYieldRows(view, '9', 25, row, 'shots').map(([id, perKill]) => [id, perKill * row.kills]);
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

// twinSeat 'starter_then_pays' (the design's text): the twin starts in its
// main's starter village and re-seats at its main's arrival in another town
// only when its best store there beats its best store here by more than the
// fare. Its main resupplies in TownA. The other main, shotless, hunts from
// TownA and posts no WTB for Soulshot D (a main goes for shots only where a
// seller stands): no buy ad of its product stands in any town, its store is
// the same in TownA as in the village, and it stays.
{
    const fares = { TownA: { TownA: 0, 'Dwarven Village': 500, TownC: 500 }, 'Dwarven Village': { TownA: 500, 'Dwarven Village': 0, TownC: 500 }, TownC: { TownA: 500, 'Dwarven Village': 500, TownC: 0 } };
    const seated = (buyerTown, fare = 100) => {
        const s2 = levels.map(level => [`s2@${level}`, { ...yields, town: buyerTown }]);
        const priced = Object.fromEntries(Object.entries(fares).map(([from, to]) => [from, Object.fromEntries(Object.entries(to).map(([town, price]) => [town, price && fare]))]));
        const world = { ...snapshot, fares: priced, hours: { ...snapshot.hours, 9: Object.fromEntries(levels.map(level => [level, { classId: 9, shotId: SSD, best: row('s2', 1000, 50), top: [] }])) },
            yields: { ...snapshot.yields, ...Object.fromEntries(s2) }, yieldsDesign: { ...snapshot.yieldsDesign, ...Object.fromEntries(s2) }, walkBack: { s1: 0.01, s2: 0.01 },
            // Ore and the sword (its D crystals) in the village too: the twin crafts and lists its shots where it sits.
            npcOffers: { preset: {}, x1: { [ORE]: [{ town: 'TownA', price: 300 }, { town: 'Dwarven Village', price: 300 }], [SWORD]: [{ town: 'TownA', price: 4000 }, { town: 'Dwarven Village', price: 4000 }] } } };
        const view = Engine.viewOf(world, { npcPrices: 'x1' }), config = { ...Design.DESIGN, twinSeat: 'starter_then_pays' };
        return Engine.simulate({ view, accounts, bands, rates, hours: 8, seed: 5, nextArrival: arrivals,
            design: plane({ snapshot: world, game: Design.gameOf(world, view, config), config, start: 'fresh', grades }) }).design;
    };
    const near = seated('TownA');
    assert.deepEqual([near.crafters.byTown['Dwarven Village'], near.counters.reseats], [1, 0], 'no WTB of its product where its main arrived: it stays');
}

// twinSeat 'hub' with hubTowns 'by_grade' (the game's trade towns): a twin
// that sells nothing yet sits in the market nearest its main's spot (a
// no-grade lot: TownA); once it holds the Soulshot D recipe its hub is the D
// market: it moves there at its main's next arrival, paying the fare, only when its
// store there beats its store here by more than the fare.
{
    const s2 = levels.map(level => [`s2@${level}`, { ...yields, town: 'TownD' }]);
    const world = fare => ({ ...snapshot, fares: { TownA: { TownA: 0, TownD: fare }, TownD: { TownA: fare, TownD: 0 } },
        hours: { ...snapshot.hours, 9: Object.fromEntries(levels.map(level => [level, { classId: 9, shotId: SSD, best: row('s2', 1000, 50), top: [] }])) },
        yields: { ...snapshot.yields, ...Object.fromEntries(s2) }, yieldsDesign: { ...snapshot.yieldsDesign, ...Object.fromEntries(s2) }, walkBack: { s1: 0.01, s2: 0.01 },
        tradeTowns: { grade: { [SSD]: 'd', [CRYSTAL]: 'd' }, none: { s1: 'TownA' }, d: ['TownD'], higher: 'TownC' } });
    const out = run(5, 8, world(500)).design;
    assert.ok(out.gates.recipe?.d || Object.keys(out.gates.recipe || {}).length, 'the twin learned the shot recipe');
    assert.deepEqual([out.crafters.byTown.TownD, out.counters.reseats], [1, 1], 'seated in the D market by the grade of what it sells');
    const dear = run(5, 8, world(1e9)).design;
    assert.deepEqual([dear.crafters.byTown.TownD, dear.counters.reseats], [undefined, 0], 'a fare above the gain: it stays');
}

// A D shooter respawning in TownA restocks in the D market, where its twin's
// line stands: its shot situations take it to TownD (the shot's trade town,
// 500 a fare), not to the town it stands in; its shots come from the line.
{
    const world = { ...snapshot, fares: { TownA: { TownA: 0, TownD: 500 }, TownD: { TownA: 500, TownD: 0 } },
        npcOffers: { preset: {}, x1: { [ORE]: [{ town: 'TownA', price: 300 }, { town: 'TownD', price: 300 }], [SWORD]: [{ town: 'TownA', price: 4000 }, { town: 'TownD', price: 4000 }] } },
        tradeTowns: { grade: { [SSD]: 'd', [CRYSTAL]: 'd' }, none: { s1: 'TownA' }, d: ['TownD'], higher: 'TownC' } };
    const view = Engine.viewOf(world, { npcPrices: 'x1' }), config = { ...Design.DESIGN, twinSeat: 'hub', hubTowns: ['TownD'] };
    const out = Engine.simulate({ view, accounts: [accounts[0], { ...accounts[1], shots: { [SSD]: 300 } }], bands, rates, hours: 24, seed: 5, nextArrival: arrivals,
        design: plane({ snapshot: world, game: Design.gameOf(world, view, config), config, start: 'late', grades }) });
    const m = out.design.market;
    assert.equal(out.design.crafters.byTown.TownD, 1, 'the twin sits in the D market');
    assert.ok((m.visits.hub.stock_low || 0) + (m.visits.hub['stock_low:shots'] || 0) + (m.visits.hub.shots_out || 0) >= 1, JSON.stringify(m.visits.hub));
    assert.ok(out.design.counters.shotsLine > 0, JSON.stringify([m.trips, m.visits.hub, m.stock, out.design.firsts, out.design.shots.supply, out.design.counters]));
    assert.equal(out.money.closureGap, 0);
    assert.equal(out.design.goods.failing, 0);
}

// The shot situations come from the main's stock and its use alone. The
// world above: the twin's line in TownD is posted at h4.55, while the
// shooter (300 shots at 50 an hour) still holds 75, over its low mark: the
// line raises no offer event for it, and it reads its sellers when it runs
// low (h5.83), finds the line and goes. With 3000 shots it never runs low in
// the run: the line raises no offer event and it makes no shot trip. With a
// low mark of 10 hours of shots (500) it is low from the start with no
// seller: the posted line wakes it, and it goes and buys while still low.
{
    const world = { ...snapshot, fares: { TownA: { TownA: 0, TownD: 500 }, TownD: { TownA: 500, TownD: 0 } },
        npcOffers: { preset: {}, x1: { [ORE]: [{ town: 'TownA', price: 300 }, { town: 'TownD', price: 300 }], [SWORD]: [{ town: 'TownA', price: 4000 }, { town: 'TownD', price: 4000 }] } },
        tradeTowns: { grade: { [SSD]: 'd', [CRYSTAL]: 'd' }, none: { s1: 'TownA' }, d: ['TownD'], higher: 'TownC' } };
    const view = Engine.viewOf(world, { npcPrices: 'x1' }), hub = { ...Design.DESIGN, twinSeat: 'hub', hubTowns: ['TownD'] };
    const runWith = (shots, config = hub) => {
        const out = Engine.simulate({ view, accounts: [accounts[0], { ...accounts[1], shots: { [SSD]: shots } }], bands, rates, hours: 24, seed: 5, nextArrival: arrivals,
            design: plane({ snapshot: world, game: Design.gameOf(world, view, config), config, start: 'late', grades }) });
        assert.equal(out.money.closureGap, 0);
        assert.equal(out.design.goods.failing, 0);
        return { m: out.design.market, bought: out.design.counters.shotsLine };
    };
    const spare = runWith(300);
    assert.deepEqual([spare.m.events.offerPosted, spare.m.visits.hub['stock_low:shots'] >= 1, spare.bought > 0], [0, true, true],
        `no offer event; it goes for its shots at its stock_low: ${JSON.stringify([spare.m.events, spare.m.visits.hub])}`);
    const plenty = runWith(3000);
    assert.deepEqual([plenty.m.events.offerPosted, plenty.m.visits.hub, plenty.bought], [0, {}, 0], 'shots to spare all run: no offer event, no shot trip');
    const low = runWith(300, { ...hub, stockLowMinutes: 600 });
    assert.deepEqual([low.m.events.offerPosted >= 1, low.m.visits.hub['stock_low:shots'] >= 1, low.bought > 0], [true, true, true],
        `low with no seller: the posted line wakes it and it buys before it runs out: ${JSON.stringify([low.m.events, low.m.visits.hub])}`);
}

// A main on its way to a seller of its shot keeps going. The world above
// with a walk of 0.5 h there and back and a low mark of 1.2 hours of shots
// (60): the shooter (300 at 50 an hour) runs low at h4.8, reads the twin's
// line in TownD (posted at h4.55) and sets out (TownD at h5.4: walk and
// hop). A line of its shot raised at h5, while its trip is pending, leaves
// the visit's hour and town as they were. A level-up at h5.1 on the way (45
// shots left, low, not out) does not turn it back: it reads its sellers
// again, still goes, and buys in TownD before its shots run out at h6.
{
    const Mains = require('../scripts/economy-model/mains');
    const world = { ...snapshot, walkBack: { s1: 0.25 }, fares: { TownA: { TownA: 0, TownD: 500 }, TownD: { TownA: 500, TownD: 0 } },
        npcOffers: { preset: {}, x1: { [ORE]: [{ town: 'TownA', price: 300 }, { town: 'TownD', price: 300 }], [SWORD]: [{ town: 'TownA', price: 4000 }, { town: 'TownD', price: 4000 }] } },
        tradeTowns: { grade: { [SSD]: 'd', [CRYSTAL]: 'd' }, none: { s1: 'TownA' }, d: ['TownD'], higher: 'TownC' } };
    const view = Engine.viewOf(world, { npcPrices: 'x1' }), config = { ...Design.DESIGN, twinSeat: 'hub', hubTowns: ['TownD'], stockLowMinutes: 72 };
    // The shooter's (index 1) first visit, its level-ups and its first shot trip's planned arrival; postAt: the hour a line of its shot is raised in TownD.
    const runWith = ({ exp = 25e9, postAt = null }) => {
        const design = plane({ snapshot: world, game: Design.gameOf(world, view, config), config, start: 'late', grades }), start = design.start, mainsSide = Mains.mainsSide;
        const seen = { visit: null, levelUps: [], planned: null };
        let side = null;
        Mains.mainsSide = (...args) => (side = mainsSide(...args));
        design.start = context => {
            const hooks = start(context), next = hooks.nextArrival, visit = hooks.visit, hour = hooks.hour.bind(hooks);
            hooks.nextArrival = (main, ev) => {
                const answer = next(main, ev);
                if (main.index === 1 && ev.event === 'level_up') seen.levelUps.push(ev.now);
                if (main.index === 1 && seen.planned === null && typeof answer === 'number') seen.planned = answer;
                return answer;
            };
            hooks.visit = (main, now, options) => {
                const out = visit(main, now, options);
                if (main.index === 1 && !seen.visit) seen.visit = { at: now, towns: out.delta.towns, held: main.shots[SSD] || 0, bought: (out.main.shots[SSD] || 0) - (main.shots[SSD] || 0) };
                return out;
            };
            hooks.hour = now => { if (now === postAt) side.offerPosted(SSD, 'TownD', 1, 0, now); return hour(now); };
            return hooks;
        };
        try {
            const out = Engine.simulate({ view, accounts: [accounts[0], { ...accounts[1], exp, shots: { [SSD]: 300 } }], bands, rates, hours: 12, seed: 5, design });
            assert.equal(out.money.closureGap, 0);
            assert.equal(out.design.goods.failing, 0);
            return { ...seen, offers: out.design.market.events.offerPosted };
        } finally { Mains.mainsSide = mainsSide; }
    };
    const plain = runWith({});
    near(plain.planned, 5.4, 'it sets out at its low mark for TownD');
    assert.deepEqual([plain.visit.towns, plain.visit.bought > 0], [['TownD'], true], JSON.stringify(plain.visit));
    near(plain.visit.at, 5.4, 'it arrives as planned');
    const posted = runWith({ postAt: 5 });
    assert.equal(posted.offers, 0, 'a main with a shot trip pending is not woken by the line');
    assert.deepEqual([posted.visit.at, posted.visit.towns], [plain.visit.at, plain.visit.towns], 'a line raised on its way: the visit\'s hour and town unchanged');
    // Level 26 starts at 26e9 exp: one exp over it at 1 exp an hour comes at h5.1.
    const leveled = runWith({ exp: 26e9 - 4.1 });
    assert.ok(leveled.levelUps.some(at => at > 4.8 && at < leveled.planned), `a level-up on the way: ${JSON.stringify(leveled)}`);
    assert.deepEqual([leveled.visit.towns, leveled.visit.held > 0, leveled.visit.bought > 0], [['TownD'], true, true],
        `a level-up on the way: it still arrives in TownD before it runs out and buys: ${JSON.stringify(leveled.visit)}`);
}

// A D shooter out of shots with no seller standing anywhere stays out (no
// trip); when a twin's line of its shots is posted in TownE, a D trade town
// that is neither the town of its spot (TownA) nor the D town of the least
// fare (TownD), the posted line wakes it, it goes to TownE and buys there.
{
    const world = { ...snapshot, fares: { TownA: { TownA: 0, TownD: 300, TownE: 500 }, TownD: { TownA: 300, TownD: 0, TownE: 300 }, TownE: { TownA: 500, TownD: 300, TownE: 0 } },
        npcOffers: { preset: {}, x1: { [ORE]: [{ town: 'TownA', price: 300 }, { town: 'TownE', price: 300 }], [SWORD]: [{ town: 'TownA', price: 4000 }, { town: 'TownE', price: 4000 }] } },
        tradeTowns: { grade: { [SSD]: 'd', [CRYSTAL]: 'd' }, none: { s1: 'TownA' }, d: ['TownD', 'TownE'], higher: 'TownC' } };
    const view = Engine.viewOf(world, { npcPrices: 'x1' }), config = { ...Design.DESIGN, twinSeat: 'hub', hubTowns: ['TownE'] };
    const out = Engine.simulate({ view, accounts, bands, rates, hours: 24, seed: 5,
        design: plane({ snapshot: world, game: Design.gameOf(world, view, config), config, start: 'late', grades }) });
    const m = out.design.market;
    assert.equal(out.design.crafters.byTown.TownE, 1, 'the twin sits in TownE');
    // The wake sets no deal: the main reads its situation again, now shots_out with a seller standing.
    assert.ok(m.events.offerPosted >= 1 && m.visits.hub.shots_out >= 1, JSON.stringify([m.events, m.visits.hub]));
    assert.ok(out.design.counters.shotsLine > 0, 'it bought its shots from the line');
    assert.equal(out.money.closureGap, 0);
    assert.equal(out.design.goods.failing, 0);
}

// The town of a shot trip is read again as the main arrives. The fixture
// above: the main out of shots sets out for its twin's line in TownE; as it
// arrives the line is no longer in TownE (the fixture takes the twin's rows
// off the board just before the visit). Rows standing in TownD instead (a D
// trade town, 300 a fare): it visits TownD, pays TownD's fare there and back
// and buys from the line. No row anywhere: it visits the town it stands in
// (TownA) and pays no fare.
{
    const world = { ...snapshot, fares: { TownA: { TownA: 0, TownD: 300, TownE: 500 }, TownD: { TownA: 300, TownD: 0, TownE: 300 }, TownE: { TownA: 500, TownD: 300, TownE: 0 } },
        npcOffers: { preset: {}, x1: { [ORE]: [{ town: 'TownA', price: 300 }, { town: 'TownE', price: 300 }], [SWORD]: [{ town: 'TownA', price: 4000 }, { town: 'TownE', price: 4000 }] } },
        tradeTowns: { grade: { [SSD]: 'd', [CRYSTAL]: 'd' }, none: { s1: 'TownA' }, d: ['TownD', 'TownE'], higher: 'TownC' } };
    const view = Engine.viewOf(world, { npcPrices: 'x1' }), config = { ...Design.DESIGN, twinSeat: 'hub', hubTowns: ['TownE'] };
    // The owner's rows moved to another town's book (the twin's state is untouched: no unit or adena moves).
    const moveRows = (board, owner, to) => {
        for (const row of board.placed.get(owner) || []) {
            const from = board.towns[row.town][row.side][row.key];
            from.splice(from.indexOf(row.entry), 1);
            if (!from.length) delete board.towns[row.town][row.side][row.key];
            ((board.towns[to] ||= { sell: {}, buy: {}, bids: {} })[row.side][row.key] ||= []).push(row.entry);
            row.town = to;
        }
    };
    // The buyer's (index 1) first visit once its twin's line stands in TownE, after change(board).
    const arrival = change => {
        const design = plane({ snapshot: world, game: Design.gameOf(world, view, config), config, start: 'late', grades }), made = [], create = Books.create, start = design.start;
        let seen = null;
        design.start = context => {
            const hooks = start(context), visit = hooks.visit;
            hooks.visit = (main, now, options) => {
                if (seen || main.index !== 1 || !made[0].towns.TownE?.sell[SSD]?.length) return visit(main, now, options);
                change(made[0]);
                const out = visit(main, now, options);
                seen = { towns: out.delta.towns, fares: out.delta.flows.fares, bought: (out.main.shots[SSD] || 0) - (main.shots[SSD] || 0) };
                return out;
            };
            return hooks;
        };
        Books.create = () => { const board = create(); made.push(board); return board; };
        try {
            const out = Engine.simulate({ view, accounts, bands, rates, hours: 24, seed: 5, design });
            assert.equal(out.money.closureGap, 0);
            assert.equal(out.design.goods.failing, 0);
        } finally { Books.create = create; }
        return seen;
    };
    const moved = arrival(board => moveRows(board, 0, 'TownD'));
    assert.deepEqual([moved.towns, moved.fares], [['TownD'], -600], 'the line stands in TownD now: it visits TownD at its fare');
    assert.ok(moved.bought > 0, 'it buys its shots from the line in TownD');
    const gone = arrival(board => Books.remove(board, 0));
    assert.deepEqual([gone.towns, gone.fares, gone.bought], [['TownA'], 0, 0], 'no line anywhere: it visits the town it stands in, no fare');
}

// A line of its shot in the town a main stands in is a seller there, even
// when that town is no trade town of the shot's grade (TownA, a village to
// the D market TownD): its twin's line there wakes the main out of shots,
// and it restocks from the line without travelling (no visit elsewhere, no fare).
{
    const world = { ...snapshot, fares: { TownA: { TownA: 0, TownD: 300 }, TownD: { TownA: 300, TownD: 0 } },
        npcOffers: { preset: {}, x1: { [ORE]: [{ town: 'TownA', price: 300 }, { town: 'TownD', price: 300 }], [SWORD]: [{ town: 'TownA', price: 4000 }, { town: 'TownD', price: 4000 }] } },
        tradeTowns: { grade: { [SSD]: 'd', [CRYSTAL]: 'd' }, none: { s1: 'TownA' }, d: ['TownD'], higher: 'TownC' } };
    const view = Engine.viewOf(world, { npcPrices: 'x1' }), config = { ...Design.DESIGN, twinSeat: 'hub', hubTowns: ['TownA'] };
    const out = Engine.simulate({ view, accounts, bands, rates, hours: 24, seed: 5,
        design: plane({ snapshot: world, game: Design.gameOf(world, view, config), config, start: 'late', grades }) });
    const m = out.design.market;
    assert.equal(out.design.crafters.byTown.TownA, 1, 'the twin sits in TownA');
    assert.ok(m.events.offerPosted >= 1 && (m.trips.shots_out || 0) + (m.trips['stock_low:shots'] || 0) >= 1, JSON.stringify([m.events, m.trips]));
    assert.ok(out.design.counters.shotsLine > 0, 'it bought its shots from the line where it stands');
    assert.deepEqual([m.visits.hub, out.flows.totals.fares], [{}, 0], 'no visit off the town it stands in, no fare');
    assert.equal(out.money.closureGap, 0);
    assert.equal(out.design.goods.failing, 0);
}

// Two hubs of the D market both pay: the twin sits in the one whose gain net
// of its fare is the greater. Two mains hunt from the two hubs, one from
// each; the second hub's fare is the lower, and the twin
// moves there at once, not to the first.
{
    const yieldsAt = town => ({ ...yields, town }), spots = { s2: 'TownD', s3: 'TownE' };
    const yieldRows = Object.fromEntries(levels.flatMap(level => Object.entries(spots).map(([spot, town]) => [`${spot}@${level}`, yieldsAt(town)])));
    const hoursNine = Object.fromEntries(levels.map(level => [level, { classId: 9, shotId: SSD, best: level === 26 ? row('s3', 1000, 50) : row('s2', 1000, 50), top: [] }]));
    const world = { ...snapshot, fares: { TownA: { TownA: 0, TownD: 300, TownE: 100 }, TownD: { TownA: 300, TownD: 0, TownE: 100 }, TownE: { TownA: 100, TownD: 100, TownE: 0 } },
        hours: { ...snapshot.hours, 9: hoursNine }, yields: { ...snapshot.yields, ...yieldRows }, yieldsDesign: { ...snapshot.yieldsDesign, ...yieldRows }, walkBack: { s1: 0.01, s2: 0.01, s3: 0.01 },
        tradeTowns: { grade: { [SSD]: 'd', [CRYSTAL]: 'd' }, none: { s1: 'TownA' }, d: ['TownD', 'TownE'], higher: 'TownC' } };
    const view = Engine.viewOf(world, { npcPrices: 'x1' }), config = { ...Design.DESIGN, twinSeat: 'hub' };
    const pair = [accounts[1], { ...accounts[1], id: 3, level: 26, exp: 26e9 }, accounts[0]];
    const out = Engine.simulate({ view, accounts: pair, bands, rates, hours: 8, seed: 5, nextArrival: arrivals,
        design: plane({ snapshot: world, game: Design.gameOf(world, view, config), config, start: 'late', grades }) }).design;
    assert.deepEqual([out.crafters.byTown.TownE, out.crafters.byTown.TownD, out.counters.reseats], [1, undefined, 1], 'both hubs pay, the second nets more: the twin sits in the second');
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
            design: plane({ snapshot: dying, game: Design.gameOf(dying, view, config), config, start: 'late', grades }) });
    };
    const died = runDying(true);
    assert.ok(died.design.market.trips.death >= 1, JSON.stringify(died.design.market.trips));
    assert.ok(died.design.market.visits.byBand.low.death >= 1, 'a visit counted by its cause');
    assert.equal(died.money.closureGap, 0);
    assert.equal(died.design.goods.failing, 0);
    assert.equal(runDying(false).design.market.trips.death, undefined, 'without the switch no death sends it to town');
}

// A main without shots, or firing none, hunts at the same spot's hour without shots.
const view = Engine.viewOf(snapshot, { npcPrices: 'x1' });
const buyer = Engine.mainOf(accounts[1], 1, view, bands), firing = { id: SSD, perHour: 50 };
const bare = Engine.huntDesign(buyer, view, 2, () => 0.5, firing);
assert.equal(bare.delta.flows.huntCold, 1000, 'two hours at the shotless 500 adena');
assert.equal(bare.delta.huntBare, 2);
assert.equal(Engine.huntDesign({ ...buyer, shots: { [SSD]: 50 } }, view, 2, () => 0.5, null).delta.flows.huntCold, 1000, 'firing none: its shots stay in the bag');
const armed = Engine.huntDesign({ ...buyer, shots: { [SSD]: 50 } }, view, 2, () => 0.5, firing);
assert.equal(armed.delta.flows.huntCold, 1500, 'one hour with its 50 shots at 1000, one without at 500');
assert.equal(armed.delta.shotsUsed, 50);

// The market of mains: two buyers want the D sword their path names and no
// line offers one, so each posts a WTB at its first visit; a hunter that
// drops swords sells to the standing WTB at or above its floor, the first
// claimer (the dearer, then the earlier account) first, met at once. The
// buyers' first visit is their shots_out: the NPC of their town sells their
// no-grade shots at 1 under their worth (75 an hour over 50 shots), so their
// money stays under the NPC's 4000 for the sword. Money and items close.
{
    const OLD = 2002;
    const levels45 = Array.from({ length: 45 }, (_, i) => i + 1);
    // The hunter's loot: half a sword an hour at the NPC's 2000.
    const plain = (spotId, shots, loot = 0) => ({ spotId, kills: 10, exp: 1, adena: 1000, shots, dropLoot: loot, spoilLoot: 0, loot, potions: 0, busyShare: 1, deaths: 0, shotless: null });
    const market = {
        ...snapshot,
        header: { levels: [1, 45], rates: { adena: 1 } },
        exp: levels45.map(level => level * 1e9),
        hours: { 9: Object.fromEntries(levels45.map(level => [level, { classId: 9, shotId: SSD, best: { ...plain('s1', 50), adena: 75 }, top: [] }])),
            46: Object.fromEntries(levels45.map(level => [level, { classId: 46, shotId: 0, best: plain('s2', 0, 1000), top: [] }])) },
        kits: { 9: Object.fromEntries(levels45.map(level => [level, [{ selfId: SWORD, slot: 7 }]])), 46: Object.fromEntries(levels45.map(level => [level, [{ selfId: OLD, slot: 7 }]])) },
        yields: Object.fromEntries(levels45.flatMap(level => [[`s1@${level}`, { town: 'TownA', drop: { 57: 100 }, spoil: {} }], [`s2@${level}`, { town: 'TownA', drop: { 57: 100, [SWORD]: 0.05 }, spoil: {} }]])),
        items: { ...snapshot.items, [OLD]: { kind: 'Weapon.Sword', grade: 'NONE', ref: 20, npcBuy: 10, crystals: 0 }, 1835: { kind: 'Other.Shot', grade: 'NONE', ref: 10, npcBuy: 5, crystals: 0 } },
        npcOffers: { preset: {}, x1: { [SWORD]: [{ town: 'TownA', price: 4000 }], 1835: [{ town: 'TownA', price: 1 }] } },
        recipes: [], races: { 9: 1, 46: 3 },
        bags: { 9: { race: 1, slots: 80, maxLoad: 1e6 }, 46: { race: 3, slots: 2, maxLoad: 1e6 } },
        gearLadder: ladderOf('9', [[1, 45, { weapon: { rungs: [SWORD], hour: { [SWORD]: 2000, [OLD]: 1000, 0: 500 } } }]]),
        walkBack: { s1: 0.01, s2: 0.01 }
    };
    market.yieldsDesign = market.yields;
    const buyers = [
        { id: 11, station: false, classId: 9, line: '9', level: 22, exp: 22e9, money: 3800, spot: null, shots: {}, held: [], worn: { 7: OLD } },
        { id: 12, station: false, classId: 9, line: '9', level: 24, exp: 24e9, money: 3800, spot: null, shots: {}, held: [], worn: { 7: OLD } },
        { id: 13, station: false, classId: 46, line: '46', level: 35, exp: 35e9, money: 1000, spot: null, shots: {}, held: [OLD], worn: { 7: OLD } }
    ];
    const marketBands = [['first', 1], ['second', 23], ['seller', 30]];
    const runMarket = (seed, config = Design.DESIGN, cohort = buyers, hours = 8) => {
        const view = Engine.viewOf(market, { npcPrices: 'x1' });
        return Engine.simulate({ view, accounts: cohort, bands: marketBands, rates, hours, seed, design: plane({ snapshot: market, game: Design.gameOf(market, view, config), config, start: 'late', grades }) });
    };
    const done = runMarket(3), waits = done.design.liveness.waits;
    assert.equal(waits.wtb.opened, 2, 'each buyer posts a WTB for the sword (no line offers one) and none for its shots');
    assert.ok(done.design.market.trips.shots_out >= 2 && done.design.counters.shotsNpc > 0, 'its shots come from the NPC where it stands');
    assert.ok(done.design.market.meetings >= 1, 'the hunter sold to a standing WTB, met at once');
    const bands = done.progress.stageBands, paid = band => bands[band].money.meanStart - bands[band].money.meanEnd;
    // The bands differ by the sword's 3600 and their shots (under 100: the sword's D shots have no seller).
    assert.ok(paid('second') <= 0 && Math.abs(paid('first') - paid('second') - 3600) < 100, `the first claimer (the earlier account at the same price) paid its WTB, 0.9 x the NPC's 4000; the second paid no sword: ${paid('first')}, ${paid('second')}`);
    assert.equal(done.design.market.obtained.d.buy, done.design.market.meetings, 'each sword met a WTB and was worn');
    assert.equal(done.money.closureGap, 0);
    assert.equal(done.design.goods.failing, 0, JSON.stringify(done.design.goods.worst));
    assert.deepEqual(runMarket(3), done, 'a run is a function of its seed');
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

// path ranks pieces by their worth per adena of their route: with money for
// one of two pieces the NPC sells (3000 and 2900), the main buys the one
// that lifts its hour by 18 an hour before the one that lifts it by 8 (both
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
        gearLadder: ladderOf('9', [[1, 30, { 6: { rungs: [LOW], hour: { [LOW]: 28, 0: 20 } }, 10: { rungs: [HIGH], hour: { [HIGH]: 38, 0: 20 } } }]])
    };
    world.yieldsDesign = world.yields;
    const view = Engine.viewOf(world, { npcPrices: 'x1' });
    const one = Engine.simulate({ view, accounts: [{ id: 31, station: false, classId: 9, line: '9', level: 25, exp: 25e9, money: 4000, spot: null, shots: {}, held: [], worn: {} }],
        bands: [['all', 1]], rates, hours: 12, seed: 2, design: plane({ snapshot: world, game: Design.gameOf(world, view), start: 'late', grades }) });
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
        bands: [['all', 1]], rates, hours: 9, seed: 1, design: plane({ snapshot: world, game: Design.gameOf(world, view), start: 'late', grades }) });
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
    const config = { ...Design.DESIGN, twinSeat: 'starter_then_pays', crafterShare: 1 };
    const view = Engine.viewOf(world, { npcPrices: 'x1' });
    const apart = Engine.simulate({ view, accounts, bands, rates, hours: 8, seed: 5, nextArrival: arrivals,
        design: plane({ snapshot: world, game: Design.gameOf(world, view, config), config, start: 'fresh', grades }) }).design;
    assert.deepEqual(apart.crafters.byTown, { [village]: 2 }, 'both twins in the village');
    assert.ok(apart.firsts.shot.d > 0, 'the Bounty Hunter\'s twin crafted shots there');
    assert.equal(apart.shots.supply.lines, 0, 'no main bought on a line of a town it did not stand in');
}

// A want the main leaves the grade without fails as outgrown, not as a
// neutral withdrawal: its D sword's want is open when it reaches C (40).
// No C sword is sold, so the D sword is worn to the last level (15 hunting
// hours) and repays its wait (about 5 h of 620 an hour for 3000 more); the
// C ladder lists the C sword alone.
{
    const CSWORD = 2005, JUNK = 1869, levels45 = Array.from({ length: 45 }, (_, i) => i + 1);
    const hourRow = { spotId: 's1', kills: 10, exp: 4e8, adena: 600, shots: 0, dropLoot: 20, spoilLoot: 0, loot: 20, potions: 0, busyShare: 1, deaths: 0, shotless: null };
    const world = {
        ...snapshot, header: { levels: [1, 45], rates: { adena: 1 } }, exp: levels45.map(level => level * 1e9),
        hours: { 9: Object.fromEntries(levels45.map(level => [level, { classId: 9, shotId: 0, best: hourRow, top: [] }])) },
        kits: { 9: Object.fromEntries(levels45.map(level => [level, [{ selfId: level < 40 ? SWORD : CSWORD, slot: 7 }]])) },
        items: { ...snapshot.items, [CSWORD]: { kind: 'Weapon.Sword', grade: 'C', ref: 40000, npcBuy: 20000, crystals: 0 }, [JUNK]: { kind: 'Other.Material', grade: 'NONE', ref: 2, npcBuy: 1, crystals: 0, weight: 10 } },
        yields: Object.fromEntries(levels45.map(level => [`s1@${level}`, { town: 'TownA', drop: { [JUNK]: 2 }, spoil: {} }])),
        recipes: [], npcOffers: { preset: {}, x1: { [SWORD]: [{ town: 'TownA', price: 4000 }] } }, bags: { 9: { race: 1, slots: 80, maxLoad: 300 } },
        twins: Object.fromEntries(levels45.map(level => [level, twin(level)])),
        gearLadder: ladderOf('9', [[1, 39, { weapon: { rungs: [SWORD], hour: { [SWORD]: 1200, 0: 200 } } }], [40, 45, { weapon: { rungs: [CSWORD], hour: { [CSWORD]: 1400, 0: 200 } } }]])
    };
    world.yieldsDesign = world.yields;
    const view = Engine.viewOf(world, { npcPrices: 'x1' });
    const grown = Engine.simulate({ view, accounts: [{ id: 51, station: false, classId: 9, line: '9', level: 39, exp: 39e9, money: 1000, spot: null, shots: {}, held: [], worn: {} }],
        bands: [['all', 1]], rates, hours: 8, seed: 1, design: plane({ snapshot: world, game: Design.gameOf(world, view), start: 'late', grades }) }).design;
    // One visit or none before 40: no ladder, the NPC route at once, which its 1000 adena cannot pay.
    const waits = Object.values(grown.liveness.waits), outgrown = waits.reduce((sum, w) => sum + (w.outgrown || 0), 0);
    assert.ok(outgrown >= 1 && waits.every(w => w.failed >= (w.outgrown || 0)), JSON.stringify(grown.liveness.waits));
    assert.equal(waits.filter(w => w.outgrown > 0).reduce((sum, w) => sum + w.withdrawn, 0), 0, 'not a neutral withdrawal');
    assert.equal(grown.market.outgrown.d, outgrown, 'counted under the grade it left');
    for (const w of waits) assert.equal(w.opened, w.done + w.withdrawn + w.failed + w.deadline + w.open);
    // Leaving D at 39 bare-handed: its kit's hour is the empty slot's 200
    // over the reference kit's (the D sword) 1200, and it is counted unarmed;
    // a main holding the reference kit reads 1.
    const ratio = 200 / 1200;
    assert.deepEqual(grown.market.kitHour['d end'], { level: 39, sampled: 1, atLeast90: 0, median: ratio, p10: ratio, none: 0, unarmed: 1 });
    const armed = Engine.simulate({ view, accounts: [{ id: 52, station: false, classId: 9, line: '9', level: 39, exp: 39e9, money: 1000, spot: null, shots: {}, held: [SWORD], worn: {} }],
        bands: [['all', 1]], rates, hours: 8, seed: 1, design: plane({ snapshot: world, game: Design.gameOf(world, view), start: 'late', grades }) }).design;
    assert.deepEqual(armed.market.kitHour['d end'], { level: 39, sampled: 1, atLeast90: 1, median: 1, p10: 1, none: 0, unarmed: 0 });
    // A kit hour source given to the plane is the one read: a stub stating 300 for a bare-handed kit and 900 for an armed one.
    const stub = kitHoursOf((line, level, kit) => (line === '9' && level === 39 ? (kit[7] ? 900 : 300) : null));
    const stubbed = Engine.simulate({ view, accounts: [{ id: 53, station: false, classId: 9, line: '9', level: 39, exp: 39e9, money: 1000, spot: null, shots: {}, held: [], worn: {} }],
        bands: [['all', 1]], rates, hours: 8, seed: 1, design: plane({ snapshot: world, game: Design.gameOf(world, view), start: 'late', grades, kitHours: stub }) }).design;
    assert.deepEqual(stubbed.market.kitHour['d end'], { level: 39, sampled: 1, atLeast90: 0, median: 300 / 900, p10: 300 / 900, none: 0, unarmed: 1 });
}

// path's candidates are the class's gear ladder: a level-21 main with 10000
// adena and no weapon whose ladder holds a 40000 sword above a 4000 one
// (both NPC-sold). pathAim 'affordable' (ours) buys the 4000 sword at its
// first visit; 'best_priced' (the model before) waits for 40000 it never has
// in 8 hours.
{
    const DEAR = 2006, JUNK = 1869, levels45 = Array.from({ length: 45 }, (_, i) => i + 1);
    // 1020 an hour, 19 hunting hours to C: its outings add about 18k to its 10000 before then.
    const hourRow = { spotId: 's1', kills: 10, exp: 1e9, adena: 1000, shots: 0, dropLoot: 20, spoilLoot: 0, loot: 20, potions: 0, busyShare: 1, deaths: 0, shotless: null };
    const world = {
        ...snapshot, header: { levels: [1, 45], rates: { adena: 1 } }, exp: levels45.map(level => level * 1e9),
        hours: { 9: Object.fromEntries(levels45.map(level => [level, { classId: 9, shotId: 0, best: hourRow, top: [] }])) },
        kits: { 9: Object.fromEntries(levels45.map(level => [level, [{ selfId: SWORD, slot: 7 }]])) },
        items: { ...snapshot.items, [DEAR]: { kind: 'Weapon.Sword', grade: 'D', ref: 40000, npcBuy: 20000, crystals: 0 }, [JUNK]: { kind: 'Other.Material', grade: 'NONE', ref: 2, npcBuy: 1, crystals: 0, weight: 10 } },
        yields: Object.fromEntries(levels45.map(level => [`s1@${level}`, { town: 'TownA', drop: { [JUNK]: 2 }, spoil: {} }])),
        recipes: [], npcOffers: { preset: {}, x1: { [SWORD]: [{ town: 'TownA', price: 4000 }], [DEAR]: [{ town: 'TownA', price: 40000 }] } }, bags: { 9: { race: 1, slots: 80, maxLoad: 300 } },
        twins: Object.fromEntries(levels45.map(level => [level, twin(level)])),
        gearLadder: ladderOf('9', [[20, 45, { weapon: { rungs: [DEAR, SWORD], hour: { [DEAR]: 1400, [SWORD]: 1300, 0: 1000 } } }]])
    };
    world.yieldsDesign = world.yields;
    const view = Engine.viewOf(world, { npcPrices: 'x1' });
    const aim = pathAim => Engine.simulate({ view, accounts: [{ id: 61, station: false, classId: 9, line: '9', level: 21, exp: 21e9, money: 10000, spot: null, shots: {}, held: [], worn: {} }],
        bands: [['all', 1]], rates, hours: 8, seed: 1, nextArrival: arrivals, design: plane({ snapshot: world, game: Design.gameOf(world, view), config: { ...Design.DESIGN, pathAim }, start: 'late', grades }) }).design;
    const own = aim('affordable'), best = aim('best_priced');
    assert.deepEqual(own.market.obtained.d, { npc: 1 }, 'the rung it can pay, from the NPC');
    assert.equal(best.market.obtained.d, undefined, 'the best priced rung: nothing it can pay');
}

// A piece is worn past its grade's end while the next grade's ladder for its
// slot holds no rung an NPC or Luxury sells it: a level-38 main (20 hunting
// hours to C at 40, 70 to the last level 45) whose D sword gains 50 an hour
// over its bare hands. With the C sword NPC-sold its worth is 50 x 20 h +
// 2000 resale = 3000, under the NPC's 4000: it buys no sword; with the C
// sword unpriced its worth runs to 45 (50 x 70 h + 2000 = 5500) and its cap
// reaches the NPC's price: it buys the sword once its WTB has run its looks.
{
    const CSWORD = 2005, JUNK = 1869, levelsTo = top => Array.from({ length: top }, (_, i) => i + 1);
    const hourRow = { spotId: 's1', kills: 10, exp: 1e8, adena: 1000, shots: 0, dropLoot: 20, spoilLoot: 0, loot: 20, potions: 0, busyShare: 1, deaths: 0, shotless: null };
    const world = (cSold, { top = 45, swordPrice = 4000, luxury = false } = {}) => {
        const levels45 = levelsTo(top);
        const out = {
            ...snapshot, header: { levels: [1, top], rates: { adena: 1 } }, exp: levels45.map(level => level * 1e9),
            hours: { 9: Object.fromEntries(levels45.map(level => [level, { classId: 9, shotId: 0, best: hourRow, top: [] }])) },
            kits: { 9: Object.fromEntries(levels45.map(level => [level, [{ selfId: level < 40 ? SWORD : CSWORD, slot: 7 }]])) },
            items: { ...snapshot.items, [CSWORD]: { kind: 'Weapon.Sword', grade: 'C', ref: 400000, npcBuy: 200000, crystals: 0 }, [JUNK]: { kind: 'Other.Material', grade: 'NONE', ref: 2, npcBuy: 1, crystals: 0, weight: 10 } },
            yields: Object.fromEntries(levels45.map(level => [`s1@${level}`, { town: 'TownA', drop: { 57: 100, [JUNK]: 2 }, spoil: {} }])),
            recipes: [], npcOffers: { preset: {}, x1: { [SWORD]: [{ town: 'TownA', price: swordPrice }], ...(cSold ? { [CSWORD]: [{ town: 'TownA', price: 400000 }] } : {}) } }, bags: { 9: { race: 1, slots: 80, maxLoad: 300 } },
            twins: Object.fromEntries(levels45.map(level => [level, twin(level)])),
            gearLadder: ladderOf('9', [[20, 39, { weapon: { rungs: [SWORD], hour: { [SWORD]: 550, 0: 500 } } }], [40, top, { weapon: { rungs: [CSWORD, SWORD], hour: { [CSWORD]: 600, [SWORD]: 550, 0: 500 } } }]])
        };
        if (luxury) out.luxuryOptions = { [CSWORD]: { town: 'TownA', c: 573, d: 2865 } };
        out.yieldsDesign = out.yields;
        return out;
    };
    const bought = (cSold, opts) => {
        const at = world(cSold, opts), view = Engine.viewOf(at, { npcPrices: 'x1' });
        return Engine.simulate({ view, accounts: [{ id: 71, station: false, classId: 9, line: '9', level: 38, exp: 38e9, money: 100000, spot: null, shots: {}, held: [], worn: {} }],
            bands: [['all', 1]], rates, hours: 12, seed: 1, nextArrival: arrivals, design: plane({ snapshot: at, game: Design.gameOf(at, view), start: 'late', grades }) }).design.market.obtained.d;
    };
    assert.equal(bought(true), undefined, 'the C sword sold: worth 3000 under the NPC\'s 4000');
    assert.deepEqual(bought(false), { npc: 1 }, 'the C sword unpriced: its cap reaches the NPC\'s price');
    // Worn past its grade only to the end of the next grade, whatever is priced
    // beyond: a level-38 main on a 78-level ladder with no C, B or A sword
    // priced wears its D sword to the end of C (140 h: 50 x 140 + 2000 = 9000),
    // not to level 78 (400 h: 22000); the sword at the NPC for 15000 is out of
    // reach of the first and within reach of the second.
    assert.equal(bought(false, { top: 78, swordPrice: 15000 }), undefined, 'worth ends with grade C: 9000 under the NPC\'s 15000');
    // A C sword only the Luxury exchange gives (crystals on lines in reach it
    // cannot count on) is no priced route: the D sword stays worn through C.
    assert.deepEqual(bought(false, { luxury: true }), { npc: 1 }, 'the C sword at Luxury only: not priced, the D sword worn through C');
}

// A piece is worth what it adds to the kit the main wears: a sword that adds
// 500 an hour to a main in its armour and nothing to a bare one (the armour
// alone adds nothing). The armoured main buys the sword from the NPC; the
// bare one aims at nothing. Its kit's hours are read once while its kit and
// band stay: the bare main visits again and again on one table.
{
    const ARMOR = 2003, JUNK = 1869, levels30 = Array.from({ length: 30 }, (_, i) => i + 1);
    const hourRow = { spotId: 's1', kills: 10, exp: 1, adena: 1000, shots: 0, dropLoot: 20, spoilLoot: 0, loot: 20, potions: 0, busyShare: 1, deaths: 0, shotless: null };
    const world = {
        ...snapshot,
        hours: { 9: Object.fromEntries(levels30.map(level => [level, { classId: 9, shotId: 0, best: hourRow, top: [] }])) },
        kits: { 9: Object.fromEntries(levels30.map(level => [level, [{ selfId: SWORD, slot: 7 }, { selfId: ARMOR, slot: 10 }]])) },
        items: { ...snapshot.items, [ARMOR]: { kind: 'Armor.Body', grade: 'D', ref: 2000, npcBuy: 1000, crystals: 0 }, [JUNK]: { kind: 'Other.Material', grade: 'NONE', ref: 2, npcBuy: 1, crystals: 0, weight: 10 } },
        yields: Object.fromEntries(levels30.map(level => [`s1@${level}`, { town: 'TownA', drop: { [JUNK]: 2 }, spoil: {} }])),
        recipes: [], npcOffers: { preset: {}, x1: { [SWORD]: [{ town: 'TownA', price: 4000 }] } }, bags: { 9: { race: 1, slots: 80, maxLoad: 300 } },
        gearLadder: ladderOf('9', [[1, 30, { weapon: { rungs: [SWORD], hour: {} }, 10: { rungs: [ARMOR], hour: {} } }]])
    };
    world.yieldsDesign = world.yields;
    const view = Engine.viewOf(world, { npcPrices: 'x1' });
    const run3 = held => {
        const kitHours = kitHoursOf((line, level, kit) => 1000 + (kit[7] === SWORD && kit[10] === ARMOR ? 500 : 0));
        const out = Engine.simulate({ view, accounts: [{ id: 81, station: false, classId: 9, line: '9', level: 25, exp: 25e9, money: 100000, spot: null, shots: {}, held, worn: {} }],
            bands: [['all', 1]], rates, hours: 10, seed: 1, design: plane({ snapshot: world, game: Design.gameOf(world, view), start: 'late', grades, kitHours }) }).design;
        return { out, kitHours };
    };
    const armoured = run3([ARMOR]), bare = run3([]);
    assert.deepEqual(armoured.out.market.obtained.d, { npc: 1 }, 'in its armour the sword adds 500 an hour: bought');
    assert.equal(bare.out.market.obtained.d, undefined, 'bare, the sword adds nothing: not bought');
    const visits = Object.values(bare.out.market.trips).reduce((sum, n) => sum + n, 0);
    assert.ok(visits >= 3, `the bare main came to town ${visits} times`);
    // The same kit in the same band reads the same: a second run buys the same.
    assert.deepEqual(run3([ARMOR]).out.market.obtained, armoured.out.market.obtained, 'the same kit, the same purchases');
}

// Towns A and B, 100 a fare each way. The second main hunts a spot whose
// respawn town is A and drops 500 of a material an hour (5 at the NPC); the
// Bounty Hunter's twin, seated in B, holds a buy line of 1000 of it at 60
// (its workshop's answer stands in for the market here). A main stands in
// A: a buy line in B at 60 (twinSeat 'hub' seats a twin in a hub though its
// main resupplies in A) does not send it there; it sells its stock to the
// NPC in A, at a bid of 60 as at a bid of 5. Money and goods close throughout.
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
        const config = { ...Design.DESIGN, hubTowns: ['B'], crafterPersona: { looksToFloor: 1000, buyerStart: 1 }, ...patch };
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
            const out = Engine.simulate({ view, accounts, bands, rates, hours: 8, seed: 5, nextArrival: arrivals, design: plane({ snapshot: world, game, config, start: 'late', grades }) });
            assert.equal(out.money.closureGap, 0);
            assert.equal(out.design.goods.failing, 0, JSON.stringify(out.design.goods.worst));
            return { design: out.design, first: game.firstPrice[MAT] };
        } finally { Workshop.workshop = real; }
    };
    const pair = { twinSeat: 'hub', crafterShare: 0.5 };
    for (const bid of [60, 5]) {
        const out = runHub({ bid, config: pair }).design;
        assert.equal(out.crafters.byTown.B, 2, 'both twins sit in the hub');
        assert.deepEqual([out.market.visits.hub, out.market.stock.hubLines], [{}, 0], `a buy line in B at ${bid}: its main never goes there`);
        assert.ok(out.market.stock.npc > 0, `the stock goes to the NPC in A: ${JSON.stringify(out.market.stock)}`);
    }
}

// A party member's exp an hour is the game's share of the party's kills
// (PartyRewardMath), read by every reader of the hours a main needs: the
// workshop's hours to the next grade, the hours to the end of its grade a
// move pays back over, the hours to the end of its spot's levels. Three
// equal members hunting the same spot get 1.39 times a solo main's; a member
// under the squared-level cut gets none, and its hours are not stated (0).
{
    const Workshop = require('../scripts/economy-model/rules/workshop');
    const PartyRewardMath = require('../src/GameServer/Actor/PartyRewardMath');
    const factor = PartyRewardMath.sharesForLevels([25, 25, 25], 3e9)[0].exp / 1e9;
    const three = { levels: [25, 25, 25], self: 0 }, cut = { levels: [25, 80, 80], self: 0 };
    const rowOf = (spotId, adena) => ({ spotId, kills: 10, exp: 5e8, adena, shots: 50, dropLoot: 0, spoilLoot: 0, loot: 0, potions: 0, busyShare: 1, deaths: 0, shotless: null });
    // Each main starts out of shots and TownA's NPC sells them: its shot trip
    // at the start is its first return to town.
    const npcOffers = { ...snapshot.npcOffers, x1: { ...snapshot.npcOffers.x1, [SSD]: [{ town: 'TownA', price: 5 }] } };
    // The hours to the next grade the workshop's rules see for the first
    // account's main, at its twin's first wake (its main's first arrival).
    const gradeHoursOf = party => {
        const world = { ...snapshot, npcOffers, hours: { ...snapshot.hours, 55: Object.fromEntries(levels.map(level => [level, { classId: 55, shotId: SSD, best: { ...rowOf('s1', 1000), exp: 1e8 }, top: [] }])) } };
        const real = Workshop.workshop, seen = [];
        Workshop.workshop = view => { if (view.self === 0) seen.push(view.hoursToGrade); return real(view); };
        try {
            const view = Engine.viewOf(world, { npcPrices: 'x1' });
            Engine.simulate({ view, accounts: accounts.map(account => (account.id === 1 ? { ...account, party } : account)), bands, rates, hours: 2, seed: 5, nextArrival: arrivals,
                design: plane({ snapshot: world, game: Design.gameOf(world, view), start: 'late', grades }) });
        } finally { Workshop.workshop = real; }
        return seen[0];
    };
    const solo = gradeHoursOf(null);
    // The first wake is a little after the start, the party's exp having grown the faster: within 0.5 %.
    const ratio = solo / gradeHoursOf(three);
    assert.ok(Math.abs(ratio / factor - 1) < 0.005, `hours to the grade: a member of three reads ${ratio} times faster, not ${factor}`);
    assert.equal(gradeHoursOf(cut), 0, 'a member under the cut gains no exp: its hours to the grade are not stated');

    // Two spots in one town: the held A and a dearer B (200 an hour), a walk
    // that costs 0.65 (0.33) hours of A's 1000 an hour. At its first return to
    // town the main moves when the gain over the hours it stays beats that.
    // Hunt adena over 3 hours says where it hunted: 3000 all at A, more after a move.
    const config = { ...Design.DESIGN, outingHours: 100 };
    const huntAdena = (party, ranges, level, walk) => {
        const world = { ...snapshot, npcOffers,
            hours: { 9: Object.fromEntries(levels.map(at => [at, { classId: 9, shotId: SSD, best: rowOf('A', 1000), top: [rowOf('B', 1200), rowOf('A', 1000)] }])) },
            spotLevels: { 9: ranges }, kits: { 9: Object.fromEntries(levels.map(at => [at, [{ selfId: SWORD, slot: 7 }]])) },
            yields: Object.fromEntries(levels.flatMap(at => ['A', 'B'].map(id => [`${id}@${at}`, { town: 'TownA', drop: {}, spoil: {} }]))), walkBack: { A: 0, B: walk } };
        world.yieldsDesign = world.yields;
        const view = Engine.viewOf(world, { npcPrices: 'x1' });
        return Engine.simulate({ view, accounts: [{ id: 51, station: false, classId: 9, line: '9', level, exp: level * 1e9, money: 1000, spot: null, shots: {}, held: [SWORD], worn: { 7: SWORD }, party }],
            bands: [['all', 1]], rates, hours: 3, seed: 1, nextArrival: arrivals, design: plane({ snapshot: world, game: Design.gameOf(world, view, config), config, start: 'late', grades }) }).flows.totals.huntCold;
    };
    // The hours to the end of B's levels (26): 4 for a solo main, 2.9 for a member of three; a move over 0.65 hours of walk (650) pays for 4 only.
    const toEnd = { A: [1, 30], B: [1, 26] };
    assert.equal(huntAdena(null, toEnd, 25, 0.65), 3597, 'a solo main moves to B');
    assert.equal(huntAdena(three, toEnd, 25, 0.65), 3000, 'a member of three reaches its spot\'s last level sooner: the move does not pay');
    // The hours to the end of its grade (30): 2 against 1.4; a walk of 330 pays for 2 only.
    assert.equal(huntAdena(null, {}, 29, 0.33), 3597, 'a solo main moves to B');
    assert.equal(huntAdena({ levels: [29, 29, 29], self: 0 }, {}, 29, 0.33), 3000, 'a member of three reaches the end of its grade sooner: the move does not pay');
    assert.equal(huntAdena({ levels: [29, 80, 80], self: 0 }, {}, 29, 0.33), 3000, 'a member under the cut: its hours to the grade are not stated, the move pays for none');
}

console.log('PASS economy model design mode');
