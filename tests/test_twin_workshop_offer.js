'use strict';
// A far bot crafter's workshop offer, decided in the worker (TwinCluster):
// each recipe's fee is its MP labour at the bot's hour (mpHours x hourAdena),
// the held offer stands while the new fee stays within the bot's income
// error, no hour value proposes nothing, a station proposes nothing, and the
// offer lists every known recipe the bot can craft (no cut).
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Profit = invoke('GameServer/Bot/Economy/CraftProfitPolicy');
const Shop = invoke('GameServer/Bot/Economy/CraftShopService');
const Twin = invoke('GameServer/Bot/Economy/TwinCluster');

const MP_PER_HOUR = 100;
const recipes = [];
let beyond = null;
for (let id = 1; id < 2000 && (recipes.length < Shop.MAX_PUBLIC_RECIPES + 2 || !beyond); id++) {
    const recipe = Recipes.resolveByRecipeId(id);
    if (recipe && Number(recipe.mpCost) > 0) {
        if (Number(recipe.level) === 1) { if (recipes.length < Shop.MAX_PUBLIC_RECIPES + 2) recipes.push(recipe); }
        else beyond ||= recipe;
    }
}
assert(recipes.length > Shop.MAX_PUBLIC_RECIPES && beyond, 'fixture: more level-1 recipes than a station lists, and a harder one');
const crafter = (twin = undefined, extra = {}) => ({ characterId: 920001, accountName: 'bot_twin_offer', phase: 'cold', level: 20,
    stats: { classId: 56, dwarvenCraftLevel: 1, ...(twin ? { twin } : {}), ...extra } });
const feeOf = (recipe, hourAdena) => Math.max(1, Math.round(Profit.mpHours(recipe, 1, { mpPerHour: MP_PER_HOUR }) * hourAdena));
const offer = (state, book, hourAdena, extra = {}) => Twin.propose(state, { book: book.map(row => row.recipeId), hourAdena,
    mpPerHour: MP_PER_HOUR, error: 0.05, ...extra });

// The fee is the recipe's MP labour at the bot's hour.
const two = recipes.slice(0, 2), hour = 200000;
const first = offer(crafter(), two, hour);
assert.deepEqual(first.workshop, two.map(recipe => ({ recipeId: recipe.recipeId, price: feeOf(recipe, hour) }))
    .sort((a, b) => a.recipeId - b.recipeId), 'each fee is mpHours x hourAdena');

// Held within the income error: the same offer proposes nothing, a small
// hour move keeps the held fees, a move past the error reprices.
assert.equal(offer(crafter(first), two, hour), null, 'an unchanged offer proposes nothing');
assert.equal(offer(crafter(first), two, hour * 1.04), null, 'an hour move within the error keeps the held fees');
const moved = offer(crafter(first), two, hour * 1.5);
assert.deepEqual(moved.workshop.map(row => row.price), first.workshop.map(row =>
    feeOf(recipes.find(recipe => recipe.recipeId === row.recipeId), hour * 1.5)), 'a move past the error reprices');

// No hour value, no proposal; the held offer stands.
assert.equal(offer(crafter(), two, 0), null, 'no hour value proposes no offer');
assert.equal(offer(crafter(first), two, 0), null, 'no hour value leaves the held offer as it is');
// A station is reviewed on main, never offered by the worker.
assert.equal(offer(crafter(undefined, { craftStationId: 'resource_core' }), two, hour), null, 'a station proposes nothing');

// Every known recipe the bot can craft is offered, past the station cap; a
// recipe above its craft level is not.
const all = offer(crafter(), [...recipes, beyond], hour);
assert.deepEqual(all.workshop.map(row => row.recipeId), recipes.map(recipe => recipe.recipeId).sort((a, b) => a - b),
    'the whole craftable book is offered, the uncraftable recipe skipped');
console.log('PASS twin workshop offer: fee = mpHours x hourAdena, held within the income error, none without an hour or at a station');
