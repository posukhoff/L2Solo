'use strict';
// T30: a craft plan owns its inputs. The wearer's plan reads its status from
// the bag (one readiness rule with the gear planner), so a full bag is
// ready to craft and a crafter's component with its inputs held is
// component-ready; a recipe material the bot farms is bid for beside the
// farm, at most what farming the missing units costs, in the slots the
// bought rows leave.
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Intent = invoke('GameServer/Bot/Economy/TradeIntent');
const { WishNetwork } = require('../src/GameServer/Bot/Economy/WishNetwork');

// Recipe 287 (2453): 2943 x8, 1894 x8, 1885 x1, 1458 x40, 2131 x3; recipe 41
// makes the component 1894 from 1884 x4, 1882 x4, 1870 x4.
const ROOT = 'power:2453:9';
const recipe287 = { 2943: 8, 1894: 8, 1885: 1, 1458: 40, 2131: 3 };
const bag = amounts => Object.fromEntries(Object.entries(amounts)
    .map(([id, amount]) => [id, { selfId: Number(id), amount, kind: 'Other.Material' }]));
const workshop = { characterId: 7, price: 100, loc: { locX: 1, locY: 2, locZ: 3 }, townName: 'Oren' };
const planOf = (inventory, providers = [287], extra = []) => {
    const component = { kind: 'craft', recipeId: 41, workshop, requirements: [] };
    const wish = { key: ROOT, object: { itemId: 2453, slot: 9 }, plan: { kind: 'craft', recipeId: 287, workshop,
        requirements: [...providers.includes(41) ? [{ key: 'item:1894', amount: 8, plan: component }] : [], ...extra] } };
    const network = { focus: [ROOT], queue: [wish], plans: new Map(), activity: { activity: 'hunting', rootKey: ROOT } };
    const state = { characterId: 990301, level: 45, phase: 'cold', activity: 'hunting', inventory, stats: {} };
    return Providers.personalCraftPlan(state, { network });
};
{
    const full = planOf(bag(recipe287));
    assert.equal(full.status, 'ready_to_craft', 'a bag with every material is ready to craft');
    assert(full.materials.every(row => row.missing === 0));
    const short = planOf(bag({ ...recipe287, 1458: 10 }));
    assert.equal(short.status, 'active', 'a material short keeps the plan active');
    assert.equal(short.materials.find(row => row.selfId === 1458).missing, 30, 'the plan names what it still lacks');
    const leather = { ...recipe287, 1894: 0, 1884: 4, 1882: 4, 1870: 4 };
    assert.equal(planOf(bag(leather), [287, 41]).status, 'component_ready', 'a provider component with its inputs held is ready');
    assert.equal(planOf(bag(leather)).status, 'active', 'a component nobody of the plan crafts is no ready step');
    const crystal = { kind: 'crystallize', improvement: { items: [{ selfId: 2453, amount: 1 }] }, requirements: [] };
    assert.equal(planOf(bag(leather), [287, 41], [{ key: 'item:1458', amount: 40, plan: crystal }]).status, 'active',
        'a plan still breaking gear for crystals stays active while only a component is ready');
}
// A power root crafts 101 by recipe 301 from 202 x10 the bot farms (0.2 h
// a unit; the solve's effort adds held units and the trip, the bid does not),
// a scroll it farms too, and 203 it buys.
const moneyPrice = 1 / 1000;
const farm = (missingAmount, costHours, effort = 50) => ({ kind: 'drop', activity: 'hunting', missingAmount, costHours, effort,
    requirements: [] });
const bought = { kind: 'buy', activity: 'shopping', missingAmount: 5, executable: false, availableUnits: 0, basePrice: 500, requirements: [] };
const rootOf = (key, inputs, valueHours = 100) => ({ key, object: { itemId: 101 }, valueHours, ratio: .01, funded: true,
    plan: { missingAmount: 1, requirements: [{ key: 'item:101', amount: 1, plan: { kind: 'craft', recipeId: 301,
        missingAmount: 1, requirements: inputs } }] } });
const project = (queue, limit = 8) => Intent.project({}, { quantityPrepared: true, moneyPrice, queue }, {}, limit);
const farmed = (missing, costHours) => [{ key: 'item:202', amount: missing, plan: farm(missing, costHours) }];
{
    const [row] = project([rootOf('power:101:7', farmed(10, .2))]);
    assert.equal(row.itemId, 202, 'a farmed recipe material is bid for');
    assert.equal(row.amount, 10);
    assert(Math.abs(row.worth - 200) < 1e-9, 'the bid pays at most the farm hours per unit (0.2 h at 1000 a/h)');
    assert(Math.abs(project([rootOf('power:101:7', farmed(1, .2))])[0].worth - 200) < 1e-9,
        'with most units held the bid still pays the farm cost of one unit, not the held units or the trip');
    assert(Math.abs(project([rootOf('power:101:7', farmed(10, 50))])[0].worth - 100 / 10 / moneyPrice) < 1e-6,
        'a dear farm leaves the root share');
    const both = [...farmed(10, .2), { key: 'item:203', amount: 5, plan: bought }];
    assert.deepEqual(project([rootOf('power:101:7', both)], 1).map(row => row.itemId), [203],
        'a farmed row takes only a slot the bought rows leave');
    assert.deepEqual(project([rootOf('power:101:7', farmed(10, .2)), rootOf('power:102:7',
        [{ key: 'item:202', amount: 4, plan: { ...bought, missingAmount: 4 } }])]).map(row => [row.itemId, row.amount]), [[202, 4]],
        'another root buying the item keeps its own bid for it');
    const scroll = project([rootOf('power:101:7', [{ key: 'item:2298', amount: 1, once: true, plan: farm(1, .2) }, ...farmed(10, .2)])]);
    assert.deepEqual(scroll.map(row => row.itemId), [202], 'a farmed scroll bids nothing (only its chosen path bids)');
    assert.deepEqual(project([rootOf('resale:101', farmed(10, .2))]), [], 'a producer farms its farmed inputs');
    const exchange = Intent.project({}, { quantityPrepared: true, moneyPrice, queue: [{ key: 'power:162:7', object: { itemId: 162 },
        valueHours: 100, ratio: .01, funded: true, plan: { missingAmount: 1, requirements: [{ key: 'item:162', amount: 1,
            plan: { kind: 'exchange', missingAmount: 1, requirements: [{ key: 'item:1458', amount: 50, plan: farm(50, .2) }] } }] } }] }, {}, 8);
    assert.deepEqual(exchange, [], 'a farmed input of no recipe bids nothing');
}
// Through the built network: 20 of 1872 needed, 15 held, the farm 0.2 h a
// unit plus a trip with fees. The bid is for the 5 missing at the farm hours
// of one unit (0.2 h at 1000 a/h), not the solve's effort with the held
// units and the trip in it.
{
    const root = { key: 'power:2453:10', need: 'power', object: { itemId: 2453, slot: 10 }, valueHours: 100, price: 100,
        paths: [{ kind: 'craft', activity: 'crafting', recipeId: 287, quoted: true, price: 100, costHours: .01,
            grossRequirements: [{ key: 'item:1872', amount: 20 }], requirements: [{ key: 'item:1872', amount: 20 }] }] };
    const bone = { key: 'item:1872', object: 1872, price: 60, paths: [{ kind: 'drop', activity: 'hunting', itemId: 1872, amount: 1,
        costHours: .2, readyHours: .2, town: 'Gludio', tripHours: .5, tripFees: 100 }] };
    const built = held => new WishNetwork().build({ actorKey: 'farmbid', inputKey: String(held), remembered: false,
        nodes: [root, bone], roots: [root.key], wallet: 1e6, hourAdena: 1000,
        stockFor: id => ({ owned: id === 1872 ? held : 0, incoming: 0 }), persona: { traits: { commitment: 0 } } });
    for (const [held, missing] of [[15, 5], [0, 20]]) {
        const row = Intent.project({}, built(held), {}, 8).find(r => r.itemId === 1872);
        assert.equal(row?.amount, missing, `with ${held} held the plan bids for the ${missing} missing`);
        assert(Math.abs(row.worth - 200) < 1e-6, `with ${held} held the bid pays the farm cost of a unit (${row.worth})`);
    }
}
console.log('test_plan_inputs ok');
