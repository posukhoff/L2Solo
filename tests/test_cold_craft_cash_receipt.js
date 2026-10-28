'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('cold-craft-cash-receipt');
require('../src/Global');
const { publishTwinOffer } = require('./helpers/twinOffer');
isolated.assertConfigured(options.default);
const DataCache = invoke('GameServer/DataCache');
const ColdCraftingService = invoke('GameServer/Bot/Economy/ColdCraftingService');
DataCache.init();

async function verifyAuthoredPhysicalCraft() {
    const Database = invoke('Database');
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(198);
    assert(recipe, 'the authored Crystal Staff recipe198 exists');
    const inputs = new Map();
    for (const material of recipe.materials) {
        inputs.set(Number(material.selfId), Number(inputs.get(Number(material.selfId)) || 0)
            + Number(material.amount));
    }
    const nativeItem = selfId => DataCache.items.find(row => Number(row.selfId) === Number(selfId));
    console.log('Authored recipe inputs:', JSON.stringify({
        recipeId: recipe.recipeId,
        productId: recipe.productId,
        materials: [...inputs].map(([id, amount]) => ({ id, amount, name: nativeItem(id)?.template?.name }))
    }));
    // No Giran station crafts for a bot: a personal craft is a dwarf's
    // workshop exchange. The receipt runs on Steel (two raw inputs, no
    // component) at one workshop, then on the Crystal Staff at another.
    assert.strictEqual(ColdCraftingService.stationForRecipe(recipe.recipeId), null, 'no native station crafts recipe 198 for a bot');
    const stationRecipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(30);
    const stationInputs = new Map(stationRecipe.materials.map(row => [Number(row.selfId), Number(row.amount)]));
    const [firstInputId, secondInputId] = stationInputs.keys();
    assert(firstInputId && secondInputId, 'the station recipe has two physical inputs');
    assert.strictEqual(ColdCraftingService.stationForRecipe(stationRecipe.recipeId), null, 'no native station crafts Steel for a bot');
    // Everyone stands at Giran's centre: a bot workshop stands at its twin
    // town's centre (no shop), and a customer reaches it within WORKSHOP_RANGE.
    const giran = invoke('GameServer/Bot/Economy/ColdMarketListingService').townCenter('Giran');
    const held = (items, selfId) => items.filter(row => Number(row.selfId) === selfId)
        .reduce((sum, row) => sum + Number(row.amount), 0);
    const item = (selfId, amount) => ({ selfId, amount, name: nativeItem(selfId)?.template?.name || `Item ${selfId}`,
        equipped: false, slot: 0, enchant: 0 });
    async function seed(accountName, name, classId, level, rows, stats = {}) {
        await Database.createAccount(accountName, 'fixture');
        const race = Number(DataCache.classTemplates.find(row => Number(row.classId) === classId)?.template?.race || 0);
        const id = Number((await Database.createCharacter(accountName, { name, race, classId, sex: 0,
            face: 0, hair: 0, hairColor: 0, maxHp: 1000, maxMp: 1000, ...giran })).insertId);
        const exp = Number(DataCache.experience[level - 1]);
        await Database.execute(['UPDATE characters SET level=?, exp=?, hp=1000, mp=1000 WHERE id=?', [level, exp, id]]);
        for (const row of rows) await Database.setItem(id, row);
        return Life.upsertState({ characterId: id, accountName, name, phase: 'cold', activity: 'crafting',
            level, exp, loc: { ...giran }, currentRegion: 'Giran',
            adena: held(rows, 57), inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
            vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
            stats: { classId, generatedCold: true, money: [36000, 0, 0, 0], ...stats }, timing: {} }, 'native_gear_craft_fixture');
    }
    async function image(ids) {
        return Promise.all(ids.map(async id => ({
            items: await Database.fetchItems(id),
            character: (await Database.execute(['SELECT * FROM characters WHERE id=?', [id]]))[0],
            life: (await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0],
            cache: structuredClone(Life.cachedState(id))
        })));
    }
    isolated.assertConfigured(options.default);
    try {
        await Database.init();
        assert(Database.isReady());
        await Life.init();
        let crafter = await seed('bot_native_gear_steel', 'NativeGearSteel', 57, 70, [item(57, 1000000)], { role: 'crafter', twin: { town: 'Giran' } });
        await Database.setCharacterRecipe(crafter.characterId, stationRecipe.recipeId, stationRecipe.type);
        crafter = await publishTwinOffer(crafter);
        const steelProvider = { [stationRecipe.recipeId]: { workshop: true, characterId: crafter.characterId } };
        let customer = await seed('bot_native_gear_customer', 'NativeGearCustomer', 10, 40,
            [item(57, 1000000), ...[...stationInputs].filter(([id]) => id !== firstInputId && id !== secondInputId)
                .map(([id, amount]) => item(id, amount))], {
                equipmentPlan: { status: 'ready_to_craft', strategy: 'craft', recipeId: stationRecipe.recipeId,
                    target: { selfId: stationRecipe.productId }, craftProviders: steelProvider }
            });
        const created = await Database.createAutonomousClan({ name: 'PersonalCraftClan', leaderId: customer.characterId,
            memberIds: [customer.characterId], founderQuorum: 1, maxBotClans: 40, maxBotMemberShare: 1 });
        assert(created.ok, created.code);
        await Database.execute(['UPDATE clans SET level=1 WHERE id=?', [created.clanId]]);
        await invoke('GameServer/Clan/ClanGoalService').clanProjectionById(created.clanId);
        customer = Life.cachedState(customer.characterId);
        assert.equal(customer.stats.equipmentPlan.strategy, 'craft', 'joining preserves a personal craft recipe');
        assert.equal(customer.stats.equipmentPlan.clanGoal, undefined);
        const ids = [customer.characterId, crafter.characterId];
        const noGrantBefore = await image(ids);
        const physical = noGrantBefore[0].items;
        const supplemented = await ColdCraftingService.supplementMaterials(customer.characterId, physical, stationRecipe);
        assert.strictEqual(supplemented.items, physical, 'preparation returns the same physical rows');
        assert.deepStrictEqual(supplemented.supplemented, [], 'preparation grants no input');
        assert.deepStrictEqual(await image(ids), noGrantBefore, 'preparation cannot create inputs or mutate SQL/cache');
        async function refuse(label) {
            customer = await Life.upsertState({ ...customer, activity: 'crafting',
                inventory: Life.inventorySummaryFromItems(await Database.fetchItems(customer.characterId)) },
            'native_gear_input_acquired');
            const before = await image(ids);
            const result = await ColdCraftingService.craft(customer, () => 0);
            assert.strictEqual(result.crafted, false, label);
            assert.strictEqual(result.reason, 'not_ready', label);
            assert.deepStrictEqual(await image(ids), before, `${label}: all SQL rows, wallets and caches stay unchanged`);
        }
        await refuse('neither physical input');
        await Database.setItem(customer.characterId, item(firstInputId, stationInputs.get(firstInputId) - 1));
        await refuse('the first input one short, no second');
        const first = (await Database.fetchItems(customer.characterId)).find(row => Number(row.selfId) === firstInputId);
        await Database.updateItemAmount(customer.characterId, first.id, stationInputs.get(firstInputId));
        await refuse('the whole first input still requires the second');
        await Database.setItem(customer.characterId, item(secondInputId, stationInputs.get(secondInputId) - 1));
        await refuse('the second input one short');
        const second = (await Database.fetchItems(customer.characterId)).find(row => Number(row.selfId) === secondInputId);
        await Database.updateItemAmount(customer.characterId, second.id, stationInputs.get(secondInputId));
        customer = await Life.upsertState({ ...customer, activity: 'crafting',
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(customer.characterId)) },
        'native_gear_all_inputs_acquired');
        // A workshop owner gone hot still serves through its body (T93); a hot
        // row with no body in the world has no MP to craft: the plan waits,
        // nothing is exchanged.
        const coldCrafter = Life.cachedState(crafter.characterId);
        await Life.upsertState({ ...coldCrafter, phase: 'hot' }, 'native_gear_station_hot');
        const unavailableBefore = await image(ids);
        const unavailableInput = structuredClone(customer);
        const unavailable = await ColdCraftingService.craft(customer, () => 0);
        assert.strictEqual(unavailable.reason, 'not_ready', 'a hot owner with no body is away for now, not gone');
        assert.strictEqual(unavailable.crafted, false);
        assert.deepStrictEqual(customer, unavailableInput, 'an away crafter cannot mutate caller state');
        assert.deepStrictEqual(await image(ids), unavailableBefore, 'an away crafter changes no SQL/cache rows');
        await Life.upsertState({ ...Life.cachedState(crafter.characterId), phase: 'cold' },
            'native_gear_station_restored', { releaseHot: true });
        assert.strictEqual((await Life.findByCharacterId(crafter.characterId)).phase, 'cold',
            'the explicit hot ownership handback restores the workshop owner before receipt controls');

        // A real SQLite abort occurs after transaction-local ingredient deletes
        // and before product insertion. Rollback preserves all physical facts;
        // the existing refresh may update reconciliation metadata separately.
        await Database.execute([`CREATE TRIGGER refuse_native_gear_product BEFORE INSERT ON items
            WHEN NEW.characterId = ${customer.characterId} AND NEW.selfId = ${stationRecipe.productId}
            BEGIN SELECT RAISE(ABORT, 'native_gear_product_refused'); END;`, []]);
        const rollbackBefore = await image(ids);
        const rollbackInput = structuredClone(customer);
        const rejected = await ColdCraftingService.craft(customer, () => 0);
        assert.strictEqual(rejected.crafted, false);
        assert.strictEqual(rejected.reason, 'craft_rejected');
        assert.strictEqual(rejected.error, 'native_gear_product_refused', 'existing transaction error identity is retained');
        assert.deepStrictEqual(customer, rollbackInput, 'failed transaction cannot mutate its caller state');
        const rollbackAfter = await image(ids);
        assert.deepStrictEqual(rollbackAfter.map(row => ({ items: row.items, character: row.character })),
            rollbackBefore.map(row => ({ items: row.items, character: row.character })),
            'real transaction failure rolls back ingredients/product/wallet/physical characters');
        await Database.execute(['DROP TRIGGER refuse_native_gear_product', []]);
        const before = await image(ids);
        const entry = ColdCraftingService.stationForRecipe(stationRecipe.recipeId, customer);
        assert(entry?.workshop && Number.isSafeInteger(entry.price) && entry.price > 0, 'the workshop fee is positive');
        const result = await ColdCraftingService.craft(customer, () => 0);
        assert.strictEqual(result.crafted, true, 'all authored physical inputs enable one native manufacture');
        assert.strictEqual(result.recipeId, stationRecipe.recipeId);
        assert.strictEqual(result.reason, 'crafted');
        assert.strictEqual(result.batchCount, 1);
        assert.deepStrictEqual(result.supplementedMaterials, []);
        const afterItems = await Database.fetchItems(customer.characterId);
        const stationItems = await Database.fetchItems(crafter.characterId);
        for (const [id, amount] of stationInputs) {
            assert.strictEqual(held(before[0].items, id) - held(afterItems, id), amount,
                `authored recipe consumes exactly ${amount} physical input ${id}`);
            assert.strictEqual(Number(result.state.inventory[id]?.amount || 0), held(afterItems, id),
                `the returned inventory cannot retain consumed input ${id}`);
        }
        assert.strictEqual(held(afterItems, stationRecipe.productId), stationRecipe.productCount, 'exactly one recipe output');
        assert.strictEqual(held(afterItems, 57), held(before[0].items, 57) - entry.price);
        assert.strictEqual(held(stationItems, 57), held(before[1].items, 57) + entry.price);
        const [stationRow] = await Database.execute(['SELECT adena FROM bot_life_state WHERE characterId=?', [crafter.characterId]]);
        assert.strictEqual(stationRow.adena, held(stationItems, 57), 'the crafter\'s saved wallet holds the fee it earned');
        assert.strictEqual(Life.cachedState(crafter.characterId).adena, held(stationItems, 57),
            'the crafter\'s held wallet holds the fee it earned');
        assert.strictEqual(held(afterItems, 57) + held(stationItems, 57),
            held(before[0].items, 57) + held(before[1].items, 57), 'fee transfers conserve both physical wallets');
        assert.strictEqual(result.state.adena, held(afterItems, 57), 'returned wallet follows the committed physical debit');
        const settled = await Life.upsertState(result.state, 'native_gear_craft_settled');
        assert.strictEqual(Life.cachedState(customer.characterId).adena, held(afterItems, 57));
        assert.strictEqual(settled.inventory[stationRecipe.productId].amount, stationRecipe.productCount);
        for (const id of stationInputs.keys()) assert.strictEqual(Number(settled.inventory[id]?.amount || 0), 0);
        const persisted = (await Database.execute(['SELECT inventorySummary, adena FROM bot_life_state WHERE characterId=?',
            [customer.characterId]]))[0];
        assert.strictEqual(persisted.adena, held(afterItems, 57));
        const persistedInventory = JSON.parse(persisted.inventorySummary);
        assert.strictEqual(persistedInventory[stationRecipe.productId].amount, stationRecipe.productCount);
        for (const id of stationInputs.keys()) assert.strictEqual(Number(persistedInventory[id]?.amount || 0), 0);
        const duplicateBefore = await image(ids);
        const duplicate = await ColdCraftingService.craft({ ...settled, activity: 'crafting' }, () => 0);
        assert.strictEqual(duplicate.crafted, false, 'consumed inputs cannot manufacture a second output');
        assert.strictEqual(duplicate.reason, 'not_ready');
        assert.deepStrictEqual(await image(ids), duplicateBefore, 'duplicate attempt changes no SQL rows, wallet or cache');
        // Native zero-balance control: the existing receipt amount 0 is valid.
        const exactFeeCustomer = await seed('bot_native_gear_exact_fee', 'NativeGearExactFee', 10, 40,
            [item(57, entry.price), ...[...stationInputs].map(([id, amount]) => item(id, amount))], {
                equipmentPlan: { status: 'ready_to_craft', strategy: 'craft', recipeId: stationRecipe.recipeId,
                    target: { selfId: stationRecipe.productId }, craftProviders: steelProvider }
            });
        const exactFeeInput = structuredClone(exactFeeCustomer);
        const exactFeeCraft = await ColdCraftingService.craft(exactFeeCustomer, () => 0);
        assert.strictEqual(exactFeeCraft.crafted, true);
        assert.strictEqual(exactFeeCraft.state.adena, 0, 'a native zero cash receipt is valid and authoritative');
        assert.strictEqual(held(await Database.fetchItems(exactFeeCustomer.characterId), 57), 0);
        assert.deepStrictEqual(exactFeeCustomer, exactFeeInput, 'successful receipt reconciliation clones caller state');

        // Repeat the paid exchange through a real bot workshop. This path
        // accepts transaction lifecycle rows before the final inventory refresh.
        const Workshop = invoke('GameServer/Bot/Economy/CraftWorkshopService');
        const populationConfig = invoke('GameServer/Bot/Population/PopulationConfig');
        const oldBuyersDisabled = populationConfig.staticBuyersDisabled;
        const workshopOwner = await seed('bot_native_gear_workshop', 'NativeGearWorkshop',
            57, 70, [item(57, 1000000)], { role: 'crafter', twin: { town: 'Giran' } });
        await Database.setCharacterRecipe(workshopOwner.characterId, recipe.recipeId, recipe.type);
        const publishedWorkshop = await publishTwinOffer(workshopOwner);
        assert([...Workshop.publicForRecipe(recipe.recipeId, {})].some(row => row.characterId === workshopOwner.characterId),
            'the physical learned recipe produces a native public workshop offer');
        const workshopCustomer = await seed('bot_native_gear_workshop_customer', 'NativeGearWorkshopBuyer',
            10, 40, [item(57, 1000000), ...[...inputs].map(([id, amount]) => item(id, amount))], {
                equipmentPlan: { status: 'ready_to_craft', strategy: 'craft', recipeId: recipe.recipeId,
                    target: { selfId: recipe.productId } }
            });
        try {
            populationConfig.staticBuyersDisabled = true;
            workshopCustomer.stats.equipmentPlan.craftProviders = { [recipe.recipeId]: { workshop: true,
                characterId: workshopOwner.characterId, revision: publishedWorkshop.simulation.revision } };
            const selectedWorkshop = ColdCraftingService.stationForRecipe(recipe.recipeId, workshopCustomer);
            assert.strictEqual(selectedWorkshop.characterId, workshopOwner.characterId);
            assert.strictEqual(selectedWorkshop.workshop, true);
            assert(Number.isSafeInteger(selectedWorkshop.price) && selectedWorkshop.price > 0);
            const workshopIds = [workshopCustomer.characterId, workshopOwner.characterId];
            const workshopBefore = await image(workshopIds);
            const workshopInput = structuredClone(workshopCustomer);
            const workshopResult = await ColdCraftingService.craft(workshopCustomer, () => 0);
            assert.strictEqual(workshopResult.crafted, true);
            assert.strictEqual(workshopResult.reason, 'crafted');
            assert.strictEqual(workshopResult.batchCount, 1);
            assert(workshopResult.result.customerState, 'the exchange returns the actual native customer lifecycle row');
            const workshopAfter = await image(workshopIds);
            for (const [id, amount] of inputs) {
                assert.strictEqual(held(workshopBefore[0].items, id) - held(workshopAfter[0].items, id), amount);
                assert.strictEqual(Number(workshopResult.state.inventory[id]?.amount || 0), 0);
            }
            assert.strictEqual(held(workshopAfter[0].items, recipe.productId), recipe.productCount);
            assert.strictEqual(held(workshopAfter[0].items, 57), 1000000 - selectedWorkshop.price);
            assert.strictEqual(held(workshopAfter[1].items, 57), 1000000 + selectedWorkshop.price);
            assert.strictEqual(workshopAfter[1].life.adena, held(workshopAfter[1].items, 57),
                'the workshop owner\'s saved wallet holds the fee it earned');
            assert.strictEqual(workshopAfter[1].cache.adena, held(workshopAfter[1].items, 57),
                'the workshop owner\'s held wallet holds the fee it earned');
            assert.strictEqual(held(workshopAfter[0].items, 57) + held(workshopAfter[1].items, 57), 2000000);
            assert.strictEqual(workshopResult.state.adena, held(workshopAfter[0].items, 57),
                'paid workshop row publication cannot restore pre-exchange cash');
            assert.deepStrictEqual(workshopCustomer, workshopInput, 'workshop adoption clones caller state');
            const workshopSettled = await Life.upsertState(workshopResult.state, 'native_workshop_craft_settled');
            assert.strictEqual(workshopSettled.adena, held(workshopAfter[0].items, 57));
            assert.strictEqual(Life.cachedState(workshopCustomer.characterId).adena, workshopSettled.adena);
            const [workshopRow] = await Database.execute(['SELECT adena, inventorySummary FROM bot_life_state WHERE characterId=?',
                [workshopCustomer.characterId]]);
            assert.strictEqual(workshopRow.adena, workshopSettled.adena);
            assert.strictEqual(JSON.parse(workshopRow.inventorySummary)[recipe.productId].amount, recipe.productCount);
            const workshopDuplicateBefore = await image(workshopIds);
            const workshopDuplicate = await ColdCraftingService.craft({ ...workshopSettled, activity: 'crafting' }, () => 0);
            assert.strictEqual(workshopDuplicate.crafted, false);
            assert.strictEqual(workshopDuplicate.reason, 'not_ready');
            assert.deepStrictEqual(await image(workshopIds), workshopDuplicateBefore);
            assert.equal(ColdCraftingService.stationForRecipe(recipe.recipeId, workshopSettled), null,
                'a finished plan keeps no workshop agreement');
            const offered = customer => ({ workshop: true, characterId: workshopOwner.characterId,
                price: Workshop.lookup(workshopOwner.characterId, recipe.recipeId, customer).price });
            const currentStation = offered(workshopSettled);
            const batchCustomer = await seed('bot_workshop_batch_customer', 'WorkshopBatchBuyer', 0, 40,
                [item(57, 1000000), ...[...inputs].map(([id, amount]) => item(id, amount * 2))], {
                    equipmentPlan: { status: 'ready_to_craft', strategy: 'craft', recipeId: recipe.recipeId,
                        outputAmount: recipe.productCount * 2, target: { selfId: recipe.productId },
                        craftProviders: { [recipe.recipeId]: { ...currentStation, known: false } } }
                });
            await Database.execute(['UPDATE characters SET locX=0,locY=0 WHERE id=?', [batchCustomer.characterId]]);
            const batchResult = await ColdCraftingService.craft(batchCustomer, () => 0);
            assert.equal(batchResult.crafted, true, 'fighter uses the agreed dwarf without learning his recipe');
            assert.equal(batchResult.batchCount, 2, 'final own-use execution respects requested output');
            assert.equal(held(await Database.fetchItems(batchCustomer.characterId), recipe.productId), recipe.productCount * 2);
            assert((await Database.fetchItems(batchCustomer.characterId)).filter(row => Number(row.selfId) === Number(recipe.productId))
                .every(row => Number(row.amount) === 1), 'nonstackable output keeps one physical object per crafted item');
            assert.equal((await Database.fetchCharacterRecipes(batchCustomer.characterId)).length, 0);
            assert.equal(batchResult.state.adena, 1000000 - currentStation.price * 2);
            assert.equal(ColdCraftingService.stationForRecipe(recipe.recipeId, batchCustomer)?.characterId,
                workshopOwner.characterId, 'the agreed dwarf is kept; a different dwarf is never selected');
            const recoveryStation = offered(batchResult.state);
            assert(recoveryStation);
            const recovering = await seed('bot_workshop_lost_reply', 'WorkshopLostReply', 0, 40,
                [item(57, 1000000), ...[...inputs].map(([id, amount]) => item(id, amount * 2))], {
                    equipmentPlan: { status: 'ready_to_craft', strategy: 'craft', recipeId: recipe.recipeId,
                        outputAmount: 1, target: { selfId: recipe.productId },
                        craftProviders: { [recipe.recipeId]: { ...recoveryStation, known: false } } }
                });
            const exchange = Database.craftForCustomer;
            let exchanges = 0;
            Database.craftForCustomer = async (...args) => {
                const result = await exchange(...args);
                if (++exchanges === 1) throw Error('lost_native_reply');
                return result;
            };
            let recovered;
            try { recovered = await ColdCraftingService.craft(recovering, () => 0); }
            finally { Database.craftForCustomer = exchange; }
            assert.equal(recovered.crafted, true);
            assert.equal(exchanges, 2, 'one attempt plus recovery of its saved result');
            assert.equal(recovered.result.replayed, true);
            assert.equal(recovered.state.adena, 1000000 - recoveryStation.price);
            for (const [id, amount] of inputs) assert.equal(held(await Database.fetchItems(recovering.characterId), id), amount);
            const recoveredImage = await image([recovering.characterId, workshopOwner.characterId]);
            const completedRetry = await ColdCraftingService.craft({ ...recovered.state, activity: 'crafting' }, () => 0);
            assert.equal(completedRetry.reason, 'not_ready');
            assert.deepStrictEqual(await image([recovering.characterId, workshopOwner.characterId]), recoveredImage);
            console.log('Native paid workshop conservation:', JSON.stringify({
                recipeId: recipe.recipeId,
                fee: selectedWorkshop.price,
                exchangeLifecycleAdena: workshopResult.result.customerState.adena,
                customer: workshopRow.adena,
                crafter: held(workshopAfter[1].items, 57),
                duplicateRefused: true
            }));
        } finally {
            populationConfig.staticBuyersDisabled = oldBuyersDisabled;
            Workshop.remove(workshopOwner.characterId);
        }
        // Private receipt validation controls use the existing unit facade
        // boundary on the direct exchange, a clan crafter's (the Steel dwarf
        // joins the customer's clan; the customer is a member too, else
        // ClanMembershipPolicy drops a goal of another clan). They do not
        // claim a native committed exchange or funding.
        const nativeExchange = Database.craftForCustomer;
        await Database.execute(['UPDATE characters SET clanId=? WHERE id=?', [created.clanId, crafter.characterId]]);
        const receiptCustomer = await seed('bot_native_receipt_validation', 'NativeReceiptValidation', 10, 40,
            [item(57, 1000000), ...[...stationInputs].map(([id, amount]) => item(id, amount))], {
                equipmentPlan: { status: 'ready_to_craft', strategy: 'craft', recipeId: stationRecipe.recipeId,
                    target: { selfId: stationRecipe.productId }, clanGoal: { clanId: created.clanId },
                    craftProviders: { [stationRecipe.recipeId]: { characterId: crafter.characterId, known: true, loc: { ...giran } } } },
                clanId: created.clanId
            });
        await Database.execute(['UPDATE characters SET clanId=? WHERE id=?', [created.clanId, receiptCustomer.characterId]]);
        assert(ColdCraftingService.stationForRecipe(stationRecipe.recipeId, receiptCustomer)?.clan, 'the clan crafter crafts Steel');
        const receiptInput = structuredClone(receiptCustomer);
        const receiptIds = [receiptCustomer.characterId, crafter.characterId];
        try {
            for (const amount of [undefined, null, '929920', NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
                Database.craftForCustomer = async () => ({ customerAdena: { amount } });
                const invalidBefore = await image(receiptIds);
                await assert.rejects(ColdCraftingService.craft(receiptCustomer, () => 0),
                    { name: 'TypeError', message: 'Invalid customer craft cash receipt' });
                assert.deepStrictEqual(receiptCustomer, receiptInput, 'invalid private receipt cannot mutate caller input');
                assert.deepStrictEqual(await image(receiptIds), invalidBefore, 'invalid facade receipt reaches no later SQL/cache writer');
            }
        } finally {
            Database.craftForCustomer = nativeExchange;
        }

        console.log('Native authored craft conservation:', JSON.stringify({ recipeId: stationRecipe.recipeId,
            productId: stationRecipe.productId, inputs: [...stationInputs], fee: entry.price, output: stationRecipe.productCount,
            firstInputId, secondInputId, duplicateRefused: true }));
    } finally {
        await Database.close();
        require('node:fs').rmSync(isolated.directory, { recursive: true, force: true });
    }
}

verifyAuthoredPhysicalCraft().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
