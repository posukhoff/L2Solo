'use strict';
// R1 for gear: buy, drop or craft is one cost rule for every grade. A B-grade
// wish target follows the path its wish root chose (buy is bought, craft is
// crafted although an offer exists, drop is hunted although craft is cheaper);
// a funded market plan pays with the offer the bot can afford, counting its
// buy-order escrow only where the trip withdraws it (an NPC offer).
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation'); require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Gear = invoke('GameServer/Bot/AI/BotGear');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Sources = invoke('GameServer/Items/ItemAcquisitionCatalog');
const PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');

function kit(level) {
    const inventory = {};
    for (const row of Gear.planFor({ classId: 3, level }).items) {
        const slots = [...inventory[row.selfId]?.equippedSlots || [], row.slot];
        inventory[row.selfId] = { ...row, amount: slots.length, equipped: true,
            equippedCount: slots.length, equippedSlots: slots };
    }
    return inventory;
}
const state = { characterId: 990472, classId: 3, level: 53, phase: 'cold', activity: 'hunting', adena: 100000000,
    currentRegion: 'Giran', loc: { locX: 83396, locY: 147904, locZ: -3400 },
    inventory: { ...kit(40), 57: { selfId: 57, amount: 100000000 } }, stats: { classId: 3 } };
const role = Planner.roleFor(state);
const recipeFor = item => Recipes.resolveVariantsByProductId(item.selfId)
    .find(recipe => recipe.type === 'dwarven' && Sources.allowsRecipe(recipe));
const target = Data.items.find(item => item.etc?.rank === 'b' && [7, 14].includes(Number(item.etc.slot))
    && Planner.suitable(item, state, role, 'b') && recipeFor(item));
assert(target, 'the datapack has a craftable B weapon the bot may wear');
const slot = Number(target.etc.slot);
const recipe = recipeFor(target);
const lineOf = (item, price) => ({ selfId: item.selfId, price, count: 99, sourceType: 'afk', town: 'Giran' });
const options = wishPath => ({ wishTargetId: target.selfId, wishSlot: slot, wishPath, spots: [],
    craftRecipes: [recipe], allowedRecipeIds: new Set([recipe.recipeId]),
    findNpcOffer: () => null, findMarketOffer: item => lineOf(item, 1000) });

const bought = Planner.planFor(state, options('buy'));
assert.equal(Number(bought.target?.selfId), Number(target.selfId));
assert.equal(bought.strategy, 'market', 'a B weapon the wish network buys is bought, not crafted');
assert.equal(bought.market.price, 1000);

// A real monster that drops an item, at a spot the bot hunts.
const dropSpotFor = (itemId, holder) => Data.npcRewards.filter(npc => (npc.rewards || []).some(group => group.items
    .some(item => Number(item.selfId) === Number(itemId))))
    .map(npc => ({ id: `drop-${npc.selfId}`, avgLevel: 53, npcEntries: [{ selfId: npc.selfId, name: npc.template?.name, count: 6 }] }))
    .find(spot => Planner.sourceForItem(itemId, [spot], holder).length);
const holding = materials => {
    const holder = { ...state, inventory: { ...state.inventory } };
    for (const material of materials) {
        holder.inventory[material.selfId] = { selfId: Number(material.selfId), amount: Number(material.amount) };
    }
    return holder;
};

// A B weapon the wish network crafts is crafted although the planner's own
// cost rule buys it: one material is still to hunt (a real source), the
// offer is cheaper in kills.
const huntedMaterial = recipe.materials.find(material => dropSpotFor(material.selfId, state));
assert(huntedMaterial, 'a material of the weapon drops from a monster');
const crafter = holding(recipe.materials.filter(material => material !== huntedMaterial));
const craftOptions = { ...options('craft'), spots: [dropSpotFor(huntedMaterial.selfId, crafter)] };
assert.equal(Planner.planFor(crafter, { ...craftOptions, wishPath: undefined }).strategy, 'market',
    'without a wish path the cost rule buys the cheap offer');
const crafted = Planner.planFor(crafter, craftOptions);
assert.equal(crafted.strategy, 'craft', 'a B weapon the wish network crafts is crafted although an offer exists');

// A B weapon the wish network drops is hunted although the planner's own cost
// rule crafts it: the bot holds every material (craft effort 0, so no drop is
// within 0.8 of it) and a real dropper of the weapon stands at a spot.
const holder = holding(recipe.materials);
const dropSpot = dropSpotFor(target.selfId, holder);
assert(dropSpot, 'the datapack has a monster that drops the weapon');
const dropOptions = { ...options('drop'), spots: [dropSpot], findMarketOffer: () => null };
assert.equal(Planner.planFor(holder, { ...dropOptions, wishPath: undefined }).strategy, 'craft',
    'without a wish path the cost rule crafts from held materials');
const dropped = Planner.planFor(holder, dropOptions);
assert.equal(dropped.strategy, 'direct_drop', 'a B weapon the wish network drops is hunted, not crafted');
assert.equal(Number(dropped.target?.selfId), Number(target.selfId));

// The planner follows the chosen root's own path (the allocated pass, owned
// inputs subtracted), not the item's stockless plan: a bot holding the craft
// inputs crafts although the stockless pass, pricing them again, buys.
const rootKey = `power:${target.selfId}:${slot}`;
const economy = { network: { focus: [rootKey, 0, 0],
    queue: [{ key: rootKey, object: { itemId: target.selfId, slot }, plan: { requirements: [
        { key: `item:${target.selfId}`, amount: 1, plan: { kind: 'craft', recipeId: recipe.recipeId } }] } }],
    activity: { rootKey, activity: 'crafting', kind: 'craft', recipeId: recipe.recipeId },
    plans: new Map([[`item:${target.selfId}`, { kind: 'buy' }]]) } };
const { craftRecipes, allowedRecipeIds, findNpcOffer, findMarketOffer } = options();
const selected = invoke('GameServer/Bot/AI/GearPlanSelection').selectAcquisitionPlan(holder, null, { spots: [],
    planningOptions: { craftRecipes, allowedRecipeIds, findNpcOffer, findMarketOffer }, preparedEconomy: economy }).acquisitionPlan;
assert.equal(Number(selected.target?.selfId), Number(target.selfId));
assert.equal(selected.strategy, 'craft', 'the root that crafts with its held inputs is crafted, not bought');

// Funded market plan: the board line is above the wallet, the NPC copy is
// within wallet + escrow -> the NPC offer, the one the trip gate funds.
const escrow = 50000000;
const poorer = { ...state, adena: 2000000, inventory: { ...state.inventory, 57: { selfId: 57, amount: 2000000 } } };
const wallet = PurchaseFunding.spendable(poorer, 0, { itemId: Number(target.selfId) });
const withEscrow = PurchaseFunding.spendable(poorer, escrow, { itemId: Number(target.selfId) });
assert(withEscrow >= wallet + 2, 'the escrow raises what the bot may spend');
const line = lineOf(target, wallet + 1);
const npc = { ...lineOf(target, wallet + 2), sourceType: 'npc' };
const funded = Planner.fundedMarketPlanForTarget(poorer, target.selfId,
    { buyOrderEscrow: escrow, findMarketOffer: () => line, findNpcOffer: () => npc });
assert(funded, 'the NPC copy within wallet + escrow is a funded plan');
assert.equal(funded.market.sourceType, 'npc');
assert.equal(funded.market.price, wallet + 2);
const onlyLine = Planner.fundedMarketPlanForTarget(poorer, target.selfId,
    { buyOrderEscrow: escrow, findMarketOffer: () => line, findNpcOffer: () => null });
assert.equal(onlyLine, null, 'a board line above the wallet is not funded by the escrow a remote bid may keep');

console.log('PASS gear buy vs craft follows one cost rule (R1)');
