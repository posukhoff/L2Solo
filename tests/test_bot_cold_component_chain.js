const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ColdCraftingService = invoke('GameServer/Bot/Economy/ColdCraftingService');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Workshops = invoke('GameServer/Bot/Economy/CraftWorkshopService');

DataCache.init();

const originals = {
    fetchItems: Database.fetchItems,
    craftForCustomer: Database.craftForCustomer,
    execute: Database.execute,
    fetchCharacterRecipes: Database.fetchCharacterRecipes,
    findByCharacterId: LifeState.findByCharacterId,
    acceptClanCraftState: LifeState.acceptClanCraftState,
    lookup: Workshops.lookup,
    quote: Workshops.quote,
    upsertState: LifeState.upsertState,
    refreshInventory: LifeState.refreshInventory
};

async function run() {
    const finalRecipe = Recipes.resolveByRecipeId(189);
    const componentRecipe = Recipes.resolveByRecipeId(29);
    // The component's crafter is a crafter of the bot's clan: no Giran station
    // crafts for a bot.
    const crafterLoc = { locX: 83400, locY: 147900, locZ: -3400 };
    const clanCraft = plan => ({ ...plan, clanGoal: { clanId: 1 },
        craftProviders: { [componentRecipe.recipeId]: { characterId: 900, known: true, loc: crafterLoc } } });
    const repeated = { ...finalRecipe, materials: [{ selfId: componentRecipe.productId, amount: 3 }, { selfId: componentRecipe.productId, amount: 5 }] };
    const repeatedState = { inventory: { [componentRecipe.productId]: { amount: 5 },
        ...Object.fromEntries(componentRecipe.materials.map(input => [input.selfId, { amount: input.amount * 3 }])) },
    stats: { equipmentPlan: clanCraft({}) } };
    assert.equal(ColdCraftingService.hasMaterials(repeatedState, repeated), false, 'duplicate inputs require their sum');
    assert.equal(ColdCraftingService.readyRecipeFor(repeatedState, repeated)?.recipeId, componentRecipe.recipeId,
        'missing aggregate material selects its component');
    assert.equal(ColdCraftingService.requiredCraftCount(repeated, componentRecipe, repeatedState), 3,
        'the component demand uses the same aggregate input');
    const completed = { ...repeatedState, stats: { equipmentPlan: { recipeId: repeated.recipeId, outputAmount: 2 } },
        inventory: { ...repeatedState.inventory, [repeated.productId]: { amount: 2 } } };
    assert.equal(ColdCraftingService.requiredCraftCount(repeated, repeated, completed), 0);
    assert.equal(ColdCraftingService.readyRecipeFor(completed, repeated), null,
        'extra ingredients cannot trigger another paid attempt after the root is filled');
    assert.equal(ColdCraftingService.requiredCraftCount(repeated, repeated, {
        ...completed, inventory: { ...completed.inventory, [repeated.productId]: { amount: 1 } }
    }), 1, 'partial output only leaves the remaining native batch');
    const items = componentRecipe.materials.map((material, index) => ({
        id: index + 1,
        selfId: material.selfId,
        amount: material.amount * 3
    }));
    items.push({ id: 99, selfId: 57, amount: 100000 });
    const inventory = Object.fromEntries(items.map((item) => [item.selfId, { ...item }]));
    finalRecipe.materials
        .filter((material) => Number(material.selfId) !== Number(componentRecipe.productId))
        .forEach((material) => {
            inventory[material.selfId] = { selfId: material.selfId, amount: material.amount };
        });

    Database.fetchItems = async () => items;
    let exchange = null;
    let customer = null;
    Database.craftForCustomer = async (_crafterId, _customerId, value) => {
        exchange = value;
        return { ok: true, customerState: customer };
    };
    Database.execute = async () => [{ clanId: 1 }];
    Database.fetchCharacterRecipes = async () => [{ recipeId: componentRecipe.recipeId }];
    LifeState.acceptClanCraftState = row => row;
    const crafterState = {
        characterId: 900,
        level: 70,
        phase: 'cold',
        activity: 'crafting',
        loc: crafterLoc,
        vitals: { hp: 1000, mp: 1000, maxMp: 1000 },
        stats: { classId: 57 }
    };
    LifeState.findByCharacterId = async () => crafterState;
    LifeState.upsertState = async (state) => state;
    LifeState.refreshInventory = async (state) => {
        assert.deepStrictEqual(state.inventory, {}, 'craft reconciliation must rebuild inventory from physical item rows after consuming a component');
        return {
        ...state,
        inventory: {
            ...state.inventory,
            1870: { selfId: 1870, amount: 0 },
            1871: { selfId: 1871, amount: 0 },
            1879: { selfId: 1879, amount: 3 }
        }
        };
    };

    customer = {
        characterId: 42,
        name: 'ComponentProbe',
        phase: 'cold',
        level: 30,
        activity: 'crafting',
        loc: { locX: 83396, locY: 147904, locZ: -3400 },
        inventory,
        stats: {
            equipmentPlan: clanCraft({ status: 'ready_to_craft', strategy: 'craft', recipeId: finalRecipe.recipeId }),
            craftReturn: { loc: { locX: -8200, locY: 11300, locZ: -3100 }, spotId: '2_-24', regionName: 'Wandering' }
        }
    };
    const result = await ColdCraftingService.craft(customer, () => 0);

    assert.strictEqual(result.reason, 'component_crafted', 'the ready nested resource must be crafted before the final equipment');
    assert.strictEqual(exchange.crafterMp, 1000 - componentRecipe.mpCost * 3, 'the crafter spends the MP of every batch');
    assert.strictEqual(exchange.product.amount, 3, 'a ready component batch must produce every prepared unit in one exchange');
    assert(exchange.materials.every((material) => material.amount % 3 === 0), 'a component batch must consume materials for its full prepared quantity');
    assert.strictEqual(result.state.activity, 'traveling', 'a component craft without enough raw inputs for the next batch must leave the crafter');
    assert.strictEqual(result.state.stats.travel.reason, 'component_craft_return', 'component crafting must return through the gatekeeper before resuming material farming');

    Database.fetchItems = async () => [];
    LifeState.refreshInventory = async (state) => {
        assert.deepStrictEqual(state.inventory, {}, 'a stale craft attempt must discard its virtual material snapshot');
        return { ...state, inventory: {} };
    };
    const stale = await ColdCraftingService.craft({
        characterId: 42,
        name: 'StaleComponentProbe',
        phase: 'cold',
        level: 30,
        activity: 'crafting',
        inventory,
        stats: { equipmentPlan: clanCraft({ status: 'ready_to_craft', strategy: 'craft', recipeId: finalRecipe.recipeId }) }
    });
    assert.strictEqual(stale.reason, 'materials_changed', 'a virtual-only material must not be sent to a crafter');
    assert.deepStrictEqual(stale.state.inventory, {}, 'the following acquisition plan must see the physical inventory only');

    const adenaItems = componentRecipe.materials.map((material, index) => ({
        id: index + 1,
        selfId: material.selfId,
        amount: material.amount
    }));
    adenaItems.push({ id: 99, selfId: 57, amount: 0 });
    Database.fetchItems = async () => adenaItems;
    LifeState.refreshInventory = async (state) => ({ ...state, inventory: {} });
    // A dwarf's workshop stands at its twin place (the customer is there) and
    // asks a fee the bag cannot pay.
    Workshops.lookup = (_ownerId, recipeId) => ({ state: crafterState, place: { town: 'Giran', loc: crafterLoc },
        recipe: Recipes.resolveByRecipeId(recipeId), price: 100, entryPrice: 100 });
    Workshops.quote = () => ({ price: 100 });
    const unaffordable = await ColdCraftingService.craft({
        characterId: 42,
        name: 'UnfundedComponentProbe',
        phase: 'cold',
        level: 30,
        activity: 'crafting',
        loc: crafterLoc,
        inventory: Object.fromEntries(adenaItems.map((item) => [item.selfId, { ...item }])),
        stats: { equipmentPlan: { status: 'ready_to_craft', strategy: 'craft', recipeId: finalRecipe.recipeId,
            craftProviders: { [componentRecipe.recipeId]: { workshop: true, characterId: 900 } } } }
    });
    assert.strictEqual(unaffordable.reason, 'insufficient_adena', 'an unaffordable batch must remain a local bot outcome rather than reject the scheduler');
    console.log('Bot cold component chain checks passed');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
}).finally(() => {
    Object.assign(Database, {
        fetchItems: originals.fetchItems,
        craftForCustomer: originals.craftForCustomer,
        execute: originals.execute,
        fetchCharacterRecipes: originals.fetchCharacterRecipes
    });
    Object.assign(Workshops, { lookup: originals.lookup, quote: originals.quote });
    Object.assign(LifeState, {
        findByCharacterId: originals.findByCharacterId,
        acceptClanCraftState: originals.acceptClanCraftState,
        upsertState: originals.upsertState,
        refreshInventory: originals.refreshInventory
    });
});
