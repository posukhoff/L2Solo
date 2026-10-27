'use strict';
// C12: no Giran station serves bots. A station (resource or grade) is the
// player's shop only: a workshop list it saved for bots before stays off the
// board, a plan held on it is refused, and a component no provider of the
// plan crafts is no craft (the bot must hold it, bought or farmed).
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('station-workshop');
require('../src/Global');
isolated.assertConfigured(options.default);
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Shops = invoke('GameServer/Bot/Economy/CraftShopService');
const Crafting = invoke('GameServer/Bot/Economy/ColdCraftingService');
const Workshop = invoke('GameServer/Bot/Economy/CraftWorkshopService');

(async () => {
    const Recipes = invoke('GameServer/Items/C4RecipeItems');
    const recipe = Recipes.resolveByRecipeId(28);
    const station = Shops.CraftStations.find(row => row.id === 'resource_core');
    assert(recipe && station.recipeIds.includes(28), 'the core resource station lists Braided Hemp');
    const staff = Recipes.resolveByRecipeId(198);
    const retired = Shops.CraftStations.find(row => row.id === 'c_weapons_entry');
    assert(staff && retired.recipeIds.includes(198), 'the C entry station lists the Crystal Staff');
    const agent = Recipes.resolveByRecipeId(497);
    assert(agent && station.recipeIds.includes(497) && staff.materials.some(row => row.selfId === agent.productId),
        'fixture: the Crystal Staff needs Reinforcing Agent, which the core resource station lists');
    const accountOf = row => `bot_craft_${String(Shops.CraftStations.indexOf(row) + 1).padStart(2, '0')}`;
    const item = (selfId, amount) => ({ selfId, amount, name: DataCache.items.find(row => row.selfId === selfId)?.template?.name || `Item ${selfId}`,
        equipped: false, slot: 0, enchant: 0 });
    const slotOf = row => 10000 + Shops.CraftStations.indexOf(row);
    async function seed(accountName, name, classId, level, rows, stats = {}, loc = station.loc) {
        await Database.createAccount(accountName, 'fixture');
        const race = Number(DataCache.classTemplates.find(row => Number(row.classId) === classId)?.template?.race || 0);
        const id = Number((await Database.createCharacter(accountName, { name, race, classId, sex: 0,
            face: 0, hair: 0, hairColor: 0, maxHp: 1000, maxMp: 1000, ...loc })).insertId);
        await Database.execute(['UPDATE characters SET level=?, exp=?, hp=1000, mp=1000 WHERE id=?',
            [level, Number(DataCache.experience[level - 1]), id]]);
        for (const row of rows) await Database.setItem(id, row);
        return Life.upsertState({ characterId: id, accountName, name, phase: 'cold', activity: 'crafting',
            level, loc: { ...loc }, currentRegion: 'Giran',
            adena: rows.find(row => row.selfId === 57)?.amount || 0,
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
            vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
            stats: { classId, generatedCold: true, money: [36000, 0, 0, 0], ...stats }, timing: {} }, 'station_workshop_fixture');
    }
    try {
        await Database.init();
        await Life.init();
        // An ordinary generated bot's index is its creation time: never a station.
        assert.equal(Shops.isStationService({ stats: { generatedIndex: 1791543604756 } }), false, 'an ordinary dwarf is no station');
        assert.equal(Shops.isStationService({ stats: { generatedIndex: 10005 } }), true, 'a reserved slot is a station');
        assert.equal(Shops.isStationService({ accountName: 'bot_craft_03', stats: {} }), true, 'a station account is a station');

        const inputs = new Map();
        for (const row of recipe.materials) inputs.set(Number(row.selfId), (inputs.get(Number(row.selfId)) || 0) + Number(row.amount));
        const customer = await seed('bot_station_customer', 'StationCustomer', 10, 45,
            [item(57, 1000000), ...[...inputs].map(([id, amount]) => item(id, amount))]);

        // Each station saved with the workshop it published to bots before:
        // the player still finds its list, bots no longer do.
        for (const [row, held] of [[station, recipe], [retired, staff]]) {
            const fee = Shops.productPrice(held);
            const owner = await seed(accountOf(row), `Station${row.id.replace(/_/g, '')}`.slice(0, 16), 57, 70, [item(57, 1000)],
                { craftStationId: row.id, generatedIndex: slotOf(row) }, row.loc);
            const shop = Shops.profileFor(owner);
            assert(shop.entries.some(entry => entry.recipeId === held.recipeId), `the player finds recipe ${held.recipeId} at ${row.id}`);
            await Shops.ensureRecipes(owner.characterId, shop);
            const cached = Life.cachedState(owner.characterId);
            Workshop.register({ ...cached, stats: { ...cached.stats, workshop: { entries: [{ recipeId: held.recipeId, price: fee }] } } });
            assert.equal(Workshop.publicForRecipe(held.recipeId, customer).some(entry => entry.characterId === owner.characterId), false,
                `${row.id} offers bots no workshop`);
            // The recipe's inputs in the bag: the craft itself is ready.
            const ready = Object.fromEntries(held.materials.map(entry => [entry.selfId, { selfId: entry.selfId, amount: entry.amount }]));
            const holder = { ...customer, activity: 'crafting', inventory: { ...customer.inventory, ...ready },
                stats: { ...customer.stats, equipmentPlan: { status: 'ready_to_craft', strategy: 'craft',
                    recipeId: held.recipeId, target: { selfId: held.productId },
                    craftProviders: { [held.recipeId]: { workshop: true, characterId: owner.characterId, price: fee, known: true } } } } };
            assert.equal(Crafting.stationForRecipe(held.recipeId, holder), null, `a plan held on ${row.id} finds no crafter there`);
            const refused = await Crafting.craft(holder, () => 0);
            assert.equal(refused.crafted, false);
            assert.equal(refused.reason, 'missing_station', 'a bot arriving with that plan gets a rejection, not a wait');
        }

        // A Crystal Staff plan from a workshop that names no crafter for
        // Reinforcing Agent: with the agent's inputs in the bag the bot does
        // not go to Giran to craft it; the plan waits for the agent itself.
        const agentInputs = Object.fromEntries(agent.materials.map(row => [row.selfId, { selfId: row.selfId, amount: row.amount }]));
        const staffPlan = { ...customer, inventory: { ...customer.inventory, ...agentInputs },
            stats: { ...customer.stats, equipmentPlan: { status: 'active', strategy: 'craft', recipeId: 198,
                target: { selfId: staff.productId }, componentRecipes: {},
                craftProviders: { 198: { workshop: true, characterId: 1, price: 1, known: true } } } } };
        const next = Crafting.nextCraft(staffPlan);
        assert.equal(next.recipe, null, 'no component craft without a provider');
        assert.equal(next.refusal, null, 'the plan waits for the material');
        assert.equal(Crafting.craftTrip(staffPlan).trip, null, 'no trip to a Giran station');
        console.log('PASS station workshop: Giran stations off the bots\' board, held station plans refused, no unprovided component craft');
    } finally {
        await Database.close();
        require('node:fs').rmSync(isolated.directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
