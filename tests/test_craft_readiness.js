'use strict';
// T34: one readiness rule for a craft plan and its executor, and components
// crafted by the bot's own recipe. The plan (WishProviders.personalCraftPlan)
// and the executor (ColdCraftingService.craftTrip) read the same rule: the
// deepest recipe with its inputs in the bag whose crafter runs it. A bot that
// knows a component's recipe crafts it where it stands; a plan that says
// ready with nobody running it is refused (the plan rebuilds). A producer
// whose input nobody sells whole crafts it from its own basket.
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const ColdCrafting = invoke('GameServer/Bot/Economy/ColdCraftingService');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Policy = require('../src/GameServer/Bot/Economy/WealthCraftPolicy');
const WealthDecision = require('../src/GameServer/Bot/Economy/WealthCraftDecision');

// Recipe 287 (2453): 2943 x8, 1894 x8, 1885 x1, 1458 x40, 2131 x3, MP 138;
// recipe 41 makes the component 1894 from 1884 x4, 1882 x4, 1870 x4, MP 40.
const ROOT = 'power:2453:9';
const recipe287 = { 2943: 8, 1894: 8, 1885: 1, 1458: 40, 2131: 3 };
const leather = { ...recipe287, 1894: 7, 1884: 4, 1882: 4, 1870: 4 };
const bag = amounts => Object.fromEntries(Object.entries(amounts)
    .map(([id, amount]) => [id, { selfId: Number(id), amount, kind: 'Other.Material' }]));
const workshop = { characterId: 990399, price: 100, loc: { locX: 1, locY: 2, locZ: 3 }, townName: 'Oren' };
const stateOf = (inventory, mp = 500) => ({ characterId: 990341, level: 45, phase: 'cold', activity: 'hunting',
    loc: { locX: 10, locY: 20, locZ: 30 }, vitals: { hp: 100, mp }, inventory, stats: { dwarvenCraftLevel: 5 } });
// The focus root crafts 287 at a workshop; its component 1894 by the bot's
// own recipe 41 (a craft path without a workshop) or at the workshop.
const planOf = (state, componentBy = 'self') => {
    const component = { kind: 'craft', recipeId: 41, requiresRecipeLearning: false, requirements: [],
        ...(componentBy === 'workshop' ? { workshop } : {}) };
    const wish = { key: ROOT, object: { itemId: 2453, slot: 9 }, plan: { kind: 'craft', recipeId: 287, workshop,
        requirements: [{ key: 'item:1894', amount: 8, plan: component }] } };
    const network = { focus: [ROOT], queue: [wish], plans: new Map(), activity: { activity: 'hunting', rootKey: ROOT } };
    return Providers.personalCraftPlan(state, { network });
};
const withPlan = (state, plan) => ({ ...state, stats: { ...state.stats, equipmentPlan: plan } });

// The rule itself: the recipe first, then a component; nobody running a
// ready recipe is no readiness.
{
    const r287 = Recipes.resolveByRecipeId(287), r41 = Recipes.resolveByRecipeId(41);
    const all = recipe => recipe;
    assert.equal(Planner.craftReadiness(r287, stateOf(bag(recipe287)), all).status, 'ready_to_craft');
    assert.equal(Planner.craftReadiness(r287, stateOf(bag(recipe287)), () => null).status, null,
        'a full bag nobody crafts from is not ready');
    const component = Planner.craftReadiness(r287, stateOf(bag(leather)), all);
    assert.equal(component.status, 'component_ready');
    assert.equal(component.recipe.recipeId, r41.recipeId, 'the ready step is the component');
    assert.equal(Planner.craftReadiness(r287, stateOf(bag(leather)), recipe => recipe.recipeId === 287 ? recipe : null).status,
        null, 'a component nobody crafts is no ready step');
}

// The wearer's own recipe: the plan names the bot itself, the executor
// crafts where the bot stands, both by the same rule.
{
    const ready = stateOf(bag(leather));
    const plan = planOf(ready);
    assert.equal(plan.craftProviders[41].self, true, 'the bot crafts the component itself');
    assert.equal(plan.status, 'component_ready', 'its own component with the inputs held is ready');
    const trip = ColdCrafting.craftTrip(withPlan(ready, plan));
    assert.equal(trip.here, true, 'the executor crafts it where the bot stands');
    assert.equal(trip.refusal, null);
    assert.equal(ColdCrafting.nextCraft(withPlan(ready, plan)).recipe.recipeId, 41);

    // Out of MP the plan stays ready (no MP event would wake it): the bot
    // hunts on and regains MP, no refusal, no trip.
    const tired = stateOf(bag(leather), 10);
    assert.equal(planOf(tired).status, 'component_ready', 'MP is no readiness');
    const trip2 = ColdCrafting.craftTrip(withPlan(tired, plan));
    assert.equal(trip2.here, undefined);
    assert.equal(trip2.trip, null);
    assert.equal(trip2.refusal, null, 'out of MP the bot waits for it, not a rebuild');
    // A skill below the recipe is no own crafter: the plan is not ready.
    assert.equal(planOf({ ...ready, stats: { dwarvenCraftLevel: 0 } }).status, 'active');
}

// A ready plan whose workshop offers nothing now is refused at the executor
// instead of coming back to it every step; a short plan just waits.
{
    const ready = stateOf(bag(leather));
    const plan = planOf(ready, 'workshop');
    assert.equal(plan.status, 'component_ready', 'the plan trusts its chosen workshop');
    assert.equal(ColdCrafting.craftTrip(withPlan(ready, plan)).refusal, 'no_crafter',
        'the workshop not offering it now refuses the held plan');
    const short = stateOf(bag({ ...recipe287, 1894: 0 }));
    const shortPlan = planOf(short, 'workshop');
    assert.equal(shortPlan.status, 'active');
    assert.equal(ColdCrafting.craftTrip(withPlan(short, shortPlan)).refusal, null, 'a short plan waits, no refusal');
}

// A producer: nobody sells 1894 whole, the crafter knows recipe 41 and buys
// its inputs; the basket crafts the component first.
{
    const r287 = Recipes.resolveByRecipeId(287);
    const producer = stateOf({});
    const quote = (id, amount) => id === 1894 ? null
        : { whole: true, units: amount, cost: 10 * amount, landed: 10 * amount, town: 'Giran' };
    const owned = () => null;
    const context = { hourAdena: 1000, mpPerHour: 600, component: WealthDecision.ownComponent(producer, new Set([41, 287])) };
    const basket = Policy.basketFor(r287, quote, owned, 1, context);
    assert(basket, 'the basket closes with the component crafted');
    const row = basket.purchases.find(purchase => purchase.selfId === 1894);
    assert.equal(row.source.source, 'craft');
    assert.equal(row.source.recipe, 41);
    assert.equal(row.source.batches, 8, 'eight batches of one unit for the eight missing');
    assert.deepEqual(row.source.purchases.map(purchase => [purchase.selfId, purchase.count]).sort((a, b) => a[0] - b[0]),
        [[1870, 32], [1882, 32], [1884, 32]], 'the component buys its own inputs');
    assert.equal(basket.extraMp, 8 * 40, 'its MP is the parent\'s processing');
    assert.equal(row.cost, 3 * 32 * 10, 'its cash is its inputs\' cash');
    assert.equal(Policy.basketFor(r287, quote, owned, 1, { ...context, component: null }), null,
        'without the recipe nobody sells 1894 and the basket fails');
    assert.equal(Policy.basketFor(r287, quote, owned, 1,
        { ...context, component: WealthDecision.ownComponent(producer, new Set([287])) }), null,
        'a component recipe the crafter does not know is no input');
}
// The executor's own craft (craftHere): the bag's inputs and the bot's MP
// pay the batches, no fee, no trip; the component reaches the parent and the
// bot goes on to it. A busy economy write waits; another refusal rebuilds.
(async () => {
    const Database = invoke('Database');
    const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
    const Commit = require('../src/GameServer/Bot/Economy/EconomyCommit');
    const saved = { fetchItems: Database.fetchItems, craft: Database.craftInventoryItems, refresh: LifeState.refreshInventory,
        admit: Commit.admit, finish: Commit.finish, acceptRow: Commit.acceptRow };
    const ready = stateOf(bag(leather));
    const held = withPlan(ready, planOf(ready));
    let rows = Object.entries(leather).map(([selfId, amount], index) => ({ id: index + 1, selfId: Number(selfId), amount }));
    let call = null, failure = null, savedRow = false;
    // The committed row holds the saved stats: an older plan, the new commit leaf.
    Commit.acceptRow = row => ({ ...row.coldState, stats: { ...row.coldState.stats,
        equipmentPlan: { status: 'active', recipeId: 1 }, economyCommit: ['c1', 1] } });
    Database.fetchItems = async () => rows.map(row => ({ ...row }));
    Commit.admit = async state => { if (failure) throw Error(failure); return { state, command: 'c1' }; };
    Commit.finish = () => {};
    Database.craftInventoryItems = async (id, value) => {
        call = { id, ...value };
        rows = rows.map(row => [1884, 1882, 1870].includes(row.selfId) ? { ...row, amount: row.amount - 4 * value.batches }
            : row.selfId === 1894 ? { ...row, amount: row.amount + value.batches } : row);
        return { success: true, units: value.batches, mp: value.coldState.vitals.mp - 40 * value.batches,
            ...(savedRow ? { coldLifeRow: { coldState: value.coldState } } : {}) };
    };
    LifeState.refreshInventory = async state => ({ ...state, inventory: Object.fromEntries(rows.map(row => [row.selfId, { ...row }])) });
    try {
        const crafted = await ColdCrafting.craft({ ...held, activity: 'crafting' });
        assert.equal(crafted.reason, 'component_crafted');
        assert.equal(call.recipeId, 41);
        assert.equal(call.batches, 1, 'one batch: the parent lacks one unit');
        assert.equal(crafted.state.vitals.mp, 460, 'the craft spends the bot\'s own MP');
        assert.equal(crafted.state.inventory[1894].amount, 8);
        assert.equal(Planner.craftReadiness(Recipes.resolveByRecipeId(287), crafted.state, recipe => recipe).status,
            'ready_to_craft', 'the component completes the parent\'s inputs');
        assert.equal(crafted.state.activity, 'hunting', 'its workshop offers nothing here: no craft to go on with');

        // MP for 2 of the 8 batches: the bot crafts 2 and hunts on (the
        // worker waits for its MP, plan.selfCraftMp), no craft it cannot pay.
        const short = { ...recipe287, 1894: 0, 1884: 32, 1882: 32, 1870: 32 };
        rows = Object.entries(short).map(([selfId, amount], index) => ({ id: index + 1, selfId: Number(selfId), amount }));
        const tired = stateOf(bag(short), 100);
        const tiredPlan = planOf(tired);
        assert.equal(tiredPlan.selfCraftMp, 40, 'the ready step the bot crafts itself names its MP');
        savedRow = true;
        const capped = await ColdCrafting.craft({ ...withPlan(tired, tiredPlan), activity: 'crafting' });
        savedRow = false;
        assert.equal(capped.batchCount, 2, 'the MP pays two batches');
        assert.notEqual(capped.state.activity, 'crafting', 'out of MP the bot does not stay at a craft it cannot run');
        const kept = capped.state.stats.equipmentPlan;
        assert.deepEqual([kept.status, kept.recipeId, kept.selfCraftMp], [tiredPlan.status, tiredPlan.recipeId, 40],
            'this step\'s plan stays over the saved one, naming its next own step\'s MP');
        assert.deepEqual(capped.state.stats.economyCommit, ['c1', 1], 'the commit leaf is the row\'s');

        rows = Object.entries(leather).map(([selfId, amount], index) => ({ id: index + 1, selfId: Number(selfId), amount }));
        failure = 'economy_operation_in_flight';
        assert.equal((await ColdCrafting.craft({ ...held, activity: 'crafting' })).reason, 'own_craft_busy');
        failure = 'economy_material_protected';
        assert.equal((await ColdCrafting.craft({ ...held, activity: 'crafting' })).reason, 'own_craft_rejected');
    } finally {
        Database.fetchItems = saved.fetchItems; Database.craftInventoryItems = saved.craft;
        LifeState.refreshInventory = saved.refresh; Commit.admit = saved.admit; Commit.finish = saved.finish;
        Commit.acceptRow = saved.acceptRow;
    }

    // A component that takes an input its parent or a sibling component
    // already prices is no component: both would price the same asks.
    const made = (recipeId, productId, input) => ({ recipeId, productId, productCount: 1, mpCost: 10, type: 'dwarven',
        successRate: 100, level: 1, materials: [{ selfId: input, amount: 4 }] });
    const parentOf = materials => ({ recipeId: 990001, productId: 990011, productCount: 1, mpCost: 10, type: 'dwarven',
        successRate: 100, level: 1, materials: materials.map(selfId => ({ selfId, amount: 1 })) });
    const quote = (id, amount) => [1894, 1895].includes(id) ? null : { whole: true, units: amount, cost: 10 * amount, landed: 10 * amount, town: 'Giran' };
    const basketOf = (parent, components) => Policy.basketFor(parent, quote, () => null, 1,
        { hourAdena: 1000, mpPerHour: 600, component: id => components[id] || null });
    assert(basketOf(parentOf([1884, 1894]), { 1894: made(990002, 1894, 1882) }), 'a component on its own input closes');
    assert.equal(basketOf(parentOf([1884, 1894]), { 1894: made(990002, 1894, 1884) }), null, 'it takes the parent\'s input');
    assert(basketOf(parentOf([1894, 1895]), { 1894: made(990002, 1894, 1882), 1895: made(990003, 1895, 1870) }),
        'siblings on their own inputs close');
    assert.equal(basketOf(parentOf([1894, 1895]), { 1894: made(990002, 1894, 1882), 1895: made(990003, 1895, 1882) }), null,
        'siblings take one input');
    console.log('test_craft_readiness ok');
})().catch(error => { console.error(error); process.exit(1); });
