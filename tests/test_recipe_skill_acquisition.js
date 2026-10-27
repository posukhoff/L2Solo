'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Craft = invoke('GameServer/Bot/Economy/CraftShopService');
const Decision = invoke('GameServer/Bot/Economy/WealthCraftDecision');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const recipe = Recipes.resolve(1786);
const state = { characterId: 900003, phase: 'cold', activity: 'hunting', level: 5,
    classId: 53, adena: 100000, inventory: {}, vitals: { mp: 1000 },
    stats: { classId: 53, money: [1000, .001, 0, 0] } };
const context = { hourAdena: 1000, moneyPrice: .001, mpPerHour: 100000, maxBatches: 1 };
// The producer root (WishProviders) chose the buyer line as the exit; the
// wealth step sizes the craft on it from these prepared sources.
const purchase = (count) => ({ town: 'Giran', units: count, whole: true, cost: count, landed: count,
    lines: [{ line: { lineId: 1, selfId: 1, revision: 1 }, count, price: 1 }], tripDetails: { known: true, hours: 0, fees: 0 } });
const options = { ownStock: new Map(), existing: () => 0,
    prepareExits: function* () { yield 'quote'; return [{ type: 'afk', price: 1000, count: 1, town: 'Giran', trip: 0,
        offer: { recordId: 7, lineId: 70, ownerId: 2, revision: 1, price: 1000, count: 1, town: 'Giran' } }]; },
    preparePurchase: function* (owner, id, count) { yield 'quote'; return purchase(count); } };
// recipeReady: the root's scrollSource verdict (WishProviders); r: its
// money-queue ratio, the cash its craft may spend (2c1810b46), here above the
// money price (a funded root).
const row = { key: `resale:${recipe.productId}`, amount: recipe.productCount,
    recipeId: recipe.recipeId, exit: [7, 70, 1000, 1], recipeReady: true, r: 1 };
const step = (who, known, prepared = { context, options }, queue = [row]) => {
    const iterator = Decision.producerStep(who, queue, known, prepared);
    let next; do { next = iterator.next(); } while (!next.done);
    return next.value;
};
assert.equal(Craft.canCraft(state, recipe), true);
assert.equal(Decision.eligible(state), true);
// Whether a recipe can run now is the producer root's verdict (recipeReady,
// WishProviders scrollSource): a ready root of an unknown recipe whose free scroll
// the bot holds is crafted carrying that scroll (main learns it first); a root
// whose scroll is still to buy is not crafted by the wealth step.
const holder = { ...state, inventory: { [recipe.recipeItemId]: { selfId: recipe.recipeItemId, amount: 1 } } };
assert.deepEqual(step(holder, [])?.scroll, [recipe.recipeItemId], 'a held learnable scroll is crafted carrying it');
assert.equal(step(state, [], { context, options }, [{ ...row, recipeReady: false }]), null,
    'a root whose scroll is still to buy is not crafted by the wealth step');
const learned = step(state, [recipe.recipeId]);
assert(learned, 'a known profitable recipe is crafted');
assert.equal(learned.recipe.recipeId, recipe.recipeId);
assert(!learned.basket.purchases.some(row => row.selfId === recipe.recipeItemId), 'a known recipe buys no scroll');
for (const denied of [{ ...state, level: 4 }, { ...state, craftLevel: 0 },
    { ...state, classId: 0, stats: { ...state.stats, classId: 0 } }]) {
    assert.equal(Decision.eligible(denied), false);
    assert.equal(step(denied, [recipe.recipeId]), null);
}
assert.equal(step({ ...state, adena: 0 }, [recipe.recipeId]), null, 'capability does not bypass funding');
assert.equal(step(state, [recipe.recipeId], { context, options: { ...options, preparePurchase: function* () { yield 'quote'; return null; } } }), null,
    'capability does not invent physical material supply');
assert.equal(Decision.eligible({ ...state, stats: { ...state.stats, craftStationId: 'fixed' } }), false);
console.log('PASS beginner native skill -> ready root crafted (held scroll learned first) / scroll to buy not crafted / funding / physical supply / station boundary');
