'use strict';
// The economy design's price rules on inline fixtures: what a kill yields at
// a rate, how a store line's price walks between its bounds at its owner's
// looks, and an unseen item's first price.
const assert = require('node:assert/strict');
const { dropRule, npcKind, DESIGN_RATES } = require('../scripts/economy-model/rules/dropRule');
const { priceStep, PRICE_STEP } = require('../scripts/economy-model/rules/priceStep');
const Bounds = require('../scripts/economy-model/rules/bounds');

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${message}: ${actual} vs ${expected}`);
const x1 = DESIGN_RATES.x1, x50 = DESIGN_RATES.x50;

// A material group with a 0.14 % recipe among common materials (overall 40 %),
// an adena group and a spoil group.
const materials = { overall: 40, items: [
    { selfId: 1867, chance: 59.86, min: 1, max: 1 },
    { selfId: 1872, chance: 40, min: 1, max: 3 },
    { selfId: 2255, chance: 0.14, min: 1, max: 1 }
] };
const adena = { overall: 70, items: [{ selfId: 57, chance: 100, min: 166, max: 299 }] };
const spoil = { overall: 100, items: [{ selfId: 1804, chance: 1.4651, min: 1, max: 1 }, { selfId: 1926, chance: 3.7, min: 1, max: 2 }] };

// Every item's expected yield scales by its kind's rate exactly once: the rare
// recipe as much as the common material (today's capped weights lift a 0.14 %
// recipe to several % of the group at x50).
const one = dropRule({ group: materials, rates: x1 }), fifty = dropRule({ group: materials, rates: x50 });
near(one[2255], 0.4 * 0.0014, 'the recipe at x1: group chance times its weight');
for (const id of [1867, 1872, 2255]) near(fifty[id], x50.drop * one[id], `item ${id} at x50 is 15 x its x1 yield`);
near(fifty[2255] / Object.values(fifty).reduce((sum, count) => sum + count, 0), one[2255] / Object.values(one).reduce((sum, count) => sum + count, 0),
    'the recipe keeps its share of the group');
// A chance over 100 % becomes extra rolls: 40 % x 15 = 6 rolls a kill.
near(fifty[1872], 6 * 0.4 * 2, '6 rolls, each picks the material 40 % of the time, 2 on average');
near(dropRule({ group: adena, rates: x50 })[57], 25 * dropRule({ group: adena, rates: x1 })[57], 'adena at the adena rate 25');
near(dropRule({ group: adena, rates: x1 })[57], 0.7 * 232.5, 'adena at x1: chance times the mean amount');
const spoiled = dropRule({ group: spoil, kind: 'spoil', rates: x50 }), spoiledOne = dropRule({ group: spoil, kind: 'spoil', rates: x1 });
for (const id of [1804, 1926]) near(spoiled[id], 10 * spoiledOne[id], `spoil row ${id} at the spoil rate 10`);
near(spoiledOne[1926], 0.037 * 1.5, 'each spoil row on its own chance');
// The deep-blue penalty divides the rolls; adena under it is divided by the drop rate too, as in Lisvus.
const blue = { active: true, chanceMultiplier: 0.1, minimumChance: 0.0001 };
near(dropRule({ group: materials, rates: x50, penalty: blue })[2255], 0.1 * fifty[2255], 'deep blue drops at a tenth');
near(dropRule({ group: adena, rates: x50, penalty: blue })[57], 0.7 * 25 * 0.1 / 15 * 232.5, 'deep blue adena');
// A group listed above 100 % rolls more than once a kill at x1 too (Tirak's 149 %).
const listed = { overall: 149.3, items: [{ selfId: 955, chance: 60, min: 1, max: 1 }, { selfId: 2026, chance: 40, min: 1, max: 1 }] };
near(dropRule({ group: listed, rates: x1, of: 'raid' })[955], 1.493 * 0.6, '1.49 rolls a kill at x1');
// A raid boss's and an epic boss's item drops roll at their own rates (x10: 3 and 1; x50: 5 and 1); adena at the adena rate.
for (const [preset, raid] of [['x10', 3], ['x50', 5]]) {
    near(dropRule({ group: materials, rates: DESIGN_RATES[preset], of: 'raid' })[2255], raid * one[2255], `a raid boss's recipe at ${preset}`);
    near(dropRule({ group: materials, rates: DESIGN_RATES[preset], of: 'epic' })[2255], one[2255], `an epic boss's recipe at ${preset}`);
    near(dropRule({ group: adena, rates: DESIGN_RATES[preset], of: 'raid' })[57], DESIGN_RATES[preset].adena * dropRule({ group: adena, rates: x1 })[57], `raid adena at ${preset}`);
}
assert.equal(npcKind({ selfId: 12211, template: { kind: 'Boss' } }), 'epic', 'Antharas is an epic boss');
assert.equal(npcKind({ selfId: 10038, template: { kind: 'Boss', raidBoss: true } }), 'raid', 'Tirak is a raid boss');
assert.equal(npcKind({ selfId: 51, template: { kind: 'Monster' } }), 'normal');
assert.throws(() => dropRule({ group: materials, rates: x1, of: 'boss' }), /unknown NPC kind/);

// The seller: 1-5 % under the cheapest rival line it sees, then by an equal
// share of the gap to the floor at each look, at the floor on the persona's look.
const floor = 600;
for (const looksToFloor of [5, 3, 2]) {
    const persona = { looksToFloor, buyerStart: 0.8 };
    let line = priceStep({ side: 'sell' }, { look: 0, floor, rival: 1000, persona, roll: 0.5 });
    near(line.price, 970, 'starts 3 % under the rival at the middle roll');
    let previous = line.price;
    for (let look = 1; look <= looksToFloor; look++) {
        line = priceStep(line, { look, floor, persona });
        assert.ok(line.price < previous && line.price >= floor, `look ${look} of ${looksToFloor} steps down, never under the floor`);
        assert.equal(line.bound, look === looksToFloor ? 'floor' : null, `the floor on look ${looksToFloor} only`);
        previous = line.price;
    }
    near(line.price, floor, `at the floor on look ${looksToFloor}`);
    assert.equal(priceStep(line, { look: looksToFloor + 3, floor, persona }).price, floor, 'and stays there');
}
const patient = { looksToFloor: 5, buyerStart: 0.8 };
near(priceStep({ side: 'sell' }, { look: 0, floor, rival: 1000, persona: patient, roll: 0 }).price, 990, 'the least undercut is 1 %');
near(priceStep({ side: 'sell' }, { look: 0, floor, rival: 1000, persona: patient, roll: 1 }).price, 950, 'the most is 5 %');
assert.equal(priceStep({ side: 'sell' }, { look: 0, floor, rival: 590, persona: patient, roll: 0.2 }).price, floor, 'a rival under the floor: start at the floor');
assert.equal(priceStep({ side: 'sell' }, { look: 0, floor, first: 800, persona: patient }).price, 800, 'no rival, nothing known: the first price');
assert.equal(priceStep({ side: 'sell' }, { look: 0, floor, known: 700, first: 800, persona: patient }).price, 700, 'a known price before the first price');
assert.throws(() => priceStep({ side: 'sell' }, { look: 0, floor, persona: patient }), /first price/, 'no rival, no known and no first price: the caller must supply the first price');
assert.throws(() => priceStep({ side: 'sell' }, { look: 0, floor, first: 800, persona: { looksToFloor: 0.5, buyerStart: 0.8 } }), /under 1/);
// Whole adena: a seller's step rounds up, a buyer's down, neither across its bound.
{
    let sell = priceStep({ side: 'sell' }, { look: 0, floor: 600.4, first: 1000.3, persona: { looksToFloor: 3, buyerStart: 0.8 } });
    assert.equal(sell.price, 1001, 'the first price rounded up');
    sell = priceStep(sell, { look: 1, floor: 600.4, persona: { looksToFloor: 3, buyerStart: 0.8 } });
    assert.equal(sell.price, Math.ceil(1000.3 - (1000.3 - 600.4) / 3), 'a step down rounded up');
    sell = priceStep(sell, { look: 3, floor: 600.4, persona: { looksToFloor: 3, buyerStart: 0.8 } });
    assert.deepEqual([sell.price, sell.bound], [601, 'floor'], 'the floor rounded up, never under it');
    let buy = priceStep({ side: 'buy' }, { look: 0, cap: 999.7, first: 2000, persona: { buyerStart: 0.7 } });
    assert.equal(buy.price, Math.floor(999.7 * 0.7), 'nothing known: the first price held to the cap, times the start factor, rounded down');
    buy = priceStep(buy, { look: 3, cap: 999.7, persona: { buyerStart: 0.7 } });
    assert.deepEqual([buy.price, buy.bound], [999, 'cap'], 'the cap rounded down, never over it');
}
near(priceStep({ side: 'buy' }, { look: 0, cap: 1000, first: 500, persona: { buyerStart: 0.8 } }).price, 400, 'nothing known: the first price under the cap, times the start factor');
assert.throws(() => priceStep({ side: 'buy' }, { look: 0, cap: 1000, persona: { buyerStart: 0.8 } }), /first price/);
// A floor above the cap: no market, no price.
for (const side of ['sell', 'buy']) {
    const none = priceStep({ side }, { look: 0, floor: 700, cap: 650, first: 800, persona: { looksToFloor: 3, buyerStart: 0.8 } });
    assert.deepEqual([none.noMarket, none.price], [true, null], `${side}: floor 700 over cap 650`);
    assert.equal(priceStep({ side }, { look: 0, floor: 650.2, cap: 650.8, first: 800, persona: { looksToFloor: 3, buyerStart: 0.8 } }).noMarket, true, `${side}: no whole price between`);
}
assert.equal(priceStep({ side: 'sell' }, { look: 0, floor: 600, cap: 650, first: 800, persona: patient }).noMarket, false, 'a cap over the floor: a market');

// The buyer: min(known, cap) times its start factor, the cap at the 3rd look,
// two looks at the cap close the line: its own route where a route set the
// cap, parked where its worth did.
for (const buyerStart of [0.7, 0.9]) {
    const persona = { looksToFloor: 3, buyerStart };
    let line = priceStep({ side: 'buy' }, { look: 0, cap: 1000, capBy: 'route', known: 1200, persona });
    near(line.price, 1000 * buyerStart, 'a known price above the cap starts from the cap');
    near(priceStep({ side: 'buy' }, { look: 0, cap: 1000, known: 800, persona }).price, 800 * buyerStart, 'a known price under the cap starts from it');
    for (let look = 1; look <= PRICE_STEP.buyerLooksToCap; look++) {
        line = priceStep(line, { look, cap: 1000, capBy: 'route', persona });
        assert.equal(line.bound, look === 3 ? 'cap' : null, `the cap on the 3rd look only (look ${look})`);
        assert.equal(line.close, null, 'one look at the cap keeps the line');
    }
    near(line.price, 1000, 'at the cap on the 3rd look');
    const closed = priceStep(line, { look: 4, cap: 1000, capBy: 'route', persona });
    assert.equal(closed.close, 'own_route', 'two looks at a route cap: the own route');
    assert.equal(priceStep(line, { look: 4, cap: 1000, capBy: 'npc', persona }).close, 'own_route', 'the NPC is a route too');
    assert.equal(priceStep(line, { look: 4, cap: 1000, capBy: 'worth', persona }).close, 'parked', 'two looks at a worth cap: parked');
}

// The bounds: the floor is the better of the NPC and the crystallizers in
// reach; the cap the lowest of worth, own route and NPC; the first price the
// cheapest route.
assert.equal(Bounds.floor({ npcBuy: 325, crystallizerBids: [] }), 325);
assert.equal(Bounds.floor({ npcBuy: 325, crystallizerBids: [410, 380] }), 410, 'a crystallizer bid above the NPC lifts the floor');
assert.deepEqual(Bounds.cap({ worth: 900, routeCost: 1200, npcSell: null }), { cap: 900, by: 'worth' });
assert.deepEqual(Bounds.cap({ worth: 900, routeCost: 700, npcSell: 800 }), { cap: 700, by: 'route' });
assert.deepEqual(Bounds.cap({ worth: 900, routeCost: null, npcSell: 650 }), { cap: 650, by: 'npc' });
assert.deepEqual(Bounds.firstPrice({ farmHours: 2, bandHour: 30000, craftCost: 45000, npcSell: 70000 }), { price: 45000, route: 'craft' });
assert.deepEqual(Bounds.firstPrice({ farmHours: 0.5, bandHour: 30000, craftCost: 45000 }), { price: 15000, route: 'farm' });
assert.deepEqual(Bounds.firstPrice({ npcSell: 288 }), { price: 288, route: 'npc' });
assert.deepEqual(Bounds.firstPrice({}), { price: null, route: null }, 'no supplying route: no first price');

// The drop rule at x1 is today's expected yield (SpotRewardExpectation) on a
// real normal NPC: Skeleton Bowman (level 20, three drop groups, three spoil
// rows), killed and spoiled by a level-20 killer with Spoil level 3.
{
    const Boot = require('../scripts/economy-model/boot');
    const Data = Boot.boot('x1');
    const Index = require('../src/GameServer/Item/ItemTemplateIndex');
    const Sell = require('../src/GameServer/Items/NpcSellRules');
    const Rewards = invoke('GameServer/Bot/Economy/SpotRewardExpectation');
    const Drops = require('../src/GameServer/Bot/Population/BackgroundDropResolver');
    const Formulas = invoke('GameServer/Formulas');
    const npc = Index.find(Data.npcs, 51), level = 20, spoilSkill = 3;
    assert.equal(npcKind(npc), 'normal');
    const spot = { id: 'rule-check-51', npcEntries: [{ selfId: 51, count: 1 }], rewards: { adenaMin: 0, adenaMax: 0 } };
    const reward = Drops.rewardDataForSpot({ ...spot, npcNames: [npc.template.name] }, () => 0, 51);
    assert.ok(reward.rewards.length >= 3 && reward.spoils.length >= 2, 'the NPC drops and spoils');
    const price = id => { const item = Index.find(Data.items, id); return item.template.kind === 'Other.Quest' ? 0 : Sell.npcBuyPrice(Number(item.template.price || 0)); };
    const rule = { adena: 0, drop: 0, spoil: 0 };
    for (const group of reward.rewards) for (const [id, count] of Object.entries(dropRule({ group, rates: x1 }))) rule[Number(id) === 57 ? 'adena' : 'drop'] += count * (Number(id) === 57 ? 1 : price(id));
    const landed = Formulas.spoilSuccessChance({ skillId: 254, skillLevel: spoilSkill, attackerLevel: level, targetLevel: npc.template.level });
    for (const group of reward.spoils) for (const [id, count] of Object.entries(dropRule({ group, kind: 'spoil', rates: x1 }))) rule.spoil += count * price(id) * landed;
    const today = Rewards.value(spot, level, { spoilSkillLevel: spoilSkill });
    for (const part of ['adena', 'drop', 'spoil']) near(rule[part], today[part], `${part} per kill: the rule at x1 against today`);
    assert.ok(today.drop > 0 && today.spoil > 0 && today.adena > 0);
}

console.log('test_economy_model_rules: ok');
