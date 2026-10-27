'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
require('./helpers/databaseIsolation');
const fixture = isMainThread ? require('./helpers/isolatedSocialDatabase')('b-grade-craft-progression') : null;
if (isMainThread) require('../src/Global');
else require(workerData.workerPath);
const { publishTwinOffer } = isMainThread ? require('./helpers/twinOffer') : {};
const Geodata = require('../src/GameServer/Geodata/GeodataEngine');
const Data = invoke('GameServer/DataCache');
if (isMainThread) Data.init();
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Shops = invoke('GameServer/Bot/Economy/CraftShopService');
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Progression = invoke('GameServer/Bot/AI/PersonalGearProgression');
const Gear = invoke('GameServer/Bot/AI/BotGear');
const { BoardIndex } = invoke('GameServer/AfkTrade/BoardIndex');
const timestamp = 1791813240000;
const readyFixtures = new Map();

function equipped(inventory, selfId, slot) {
    const previous = inventory[selfId], slots = [...(previous?.equippedSlots || []), slot];
    inventory[selfId] = { selfId, amount: slots.length, equipped: true,
        equippedCount: slots.length, equippedSlots: slots, slot };
}

function verify(recipeId, missing = false, slot = 14, classId = 3, targetId = null) {
    const recipe = Recipes.resolveByRecipeId(recipeId);
    targetId ||= recipe.productId;
    const variants = Recipes.resolveVariantsByProductId(recipe.productId);
    assert(variants.some(row => row.successRate < 100));
    assert(variants.includes(recipe) && recipe.successRate === 100);
    assert.equal(Recipes.resolveByProductId(recipe.productId), variants[0], 'existing callers keep their canonical recipe');
    assert(Object.isFrozen(variants), 'the shared native variant catalogue cannot be changed by a review');
    // No Giran station crafts for a bot: the provider is a dwarf's workshop in
    // Giran, here and in the paid crafts below.
    const workshop = { loc: { ...Shops.CraftStations.find(row => row.id === 'c_weapons_entry').loc } };
    const state = { characterId: 990410, name: 'CraftBuyer', level: 55, classId,
        phase: 'cold', activity: 'hunting', currentRegion: 'Giran', adena: 100000000,
        loc: { locX: 81100, locY: 148000, locZ: -3466 },
        vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 }, inventory: {},
        stats: { classId, exp: Data.experience[54] + 1,
            wishFocus: [`power:${targetId}:${slot}`, 0, 0],
            persona: { primaryDrive: 'progression', understanding: 1,
                traits: { ambition: 0, commitment: 0, caution: 0, empathy: 0, sociability: 0 } } } };
    for (const row of Gear.planFor({ classId, level: 40 }).items) equipped(state.inventory, row.selfId, row.slot);
    assert.equal(Progression.assess(state).milestone.required, false, 'the C milestone is closed');
    // Other slots are already top B; the selected equipment improvement remains a
    // choice of sources, with only this published recipe's complete stock.
    const conflicts = [7, 14].includes(slot) ? [7, 14]
        : [10, 11, 15].includes(slot) ? [slot, 15, ...(slot === 15 ? [10, 11] : [])] : [slot];
    for (const [otherSlot, rows] of Providers.gearCandidates(state)) {
        if (conflicts.includes(otherSlot)) continue;
        for (const row of Object.values(state.inventory)) if (row.equippedSlots?.includes(otherSlot)) {
            row.equippedSlots = row.equippedSlots.filter(side => side !== otherSlot);
            row.equippedCount = row.equippedSlots.length; row.equipped = row.equippedCount > 0;
        }
        equipped(state.inventory, rows[0].selfId, otherSlot);
    }
    for (const material of recipe.materials) state.inventory[material.selfId] = { selfId: material.selfId, amount: material.amount };
    // Supplies above their stock targets, within a bag the survival floor accepts.
    for (const [id, amount] of [[invoke('GameServer/Inventory/ShotStock').planForState(state).selfId, 3000], [1061, 200], [736, 20]])
        state.inventory[id] = { selfId: id, amount };
    const fragment = recipe.materials[1];
    assert(fragment && fragment.selfId !== recipe.recipeItemId, 'native B equipment requires its key material');
    const board = new BoardIndex();
    if (missing) {
        state.inventory[fragment.selfId].amount--;
        board.put({ id: 77, ownerId: 990411, storeType: 1, kind: 'shop', town: 'Giran',
            lines: [{ lineId: 78, selfId: fragment.selfId, count: 1, price: 1, enchant: 0 }] });
    }
    const fee = Shops.productPrice(recipe);
    const service = { characterId: 990412, recipeId, price: fee, entryPrice: fee,
        capacityBatches: 1, townName: 'Giran', loc: workshop.loc };
    const context = Economy.forState(state, { timestamp, board, spots: [], npcOffersFor: () => [],
        workshop: null, knownRecipes: [], withNodes: true, knowledgeEnabled: false,
        routeRows: invoke('GameServer/Bot/Economy/EconomicTrip').towns.map(() => [true, 0, 0]),
        workshops: id => id === recipeId ? [service] : [], rememberContext: false });
    const productNode = context.projection.nodes.find(row => row.key === `item:${recipe.productId}`);
    assert(productNode?.paths.some(row => row.kind === 'craft' && row.recipeId === recipeId),
        'the published 100% variant survives the earlier unavailable lower-success variant');
    if (targetId !== recipe.productId) {
        const final = context.projection.nodes.find(row => row.key === `item:${targetId}`);
        assert(final?.paths.some(row => row.kind === 'mammon_unseal'
            && row.grossRequirements.some(input => input.key === `item:${recipe.productId}`)),
        'the final worn variant is connected to the native base craft');
    }
    const leaf = context.network.activity;
    assert.equal(leaf?.rootKey, `power:${targetId}:${slot}`, 'native network accepts the B equipment goal');
    assert.equal(leaf.activity, missing ? 'shopping' : 'crafting');
    assert.equal(missing ? leaf.itemId : leaf.recipeId, missing ? fragment.selfId : recipeId);
    const plan = Providers.personalCraftPlan(state, context);
    assert.equal(plan?.recipeId, recipeId);
    assert.equal(plan.craftProviders[recipeId].characterId, service.characterId);
    assert.equal(plan.target.selfId, targetId);
    if (targetId !== recipe.productId) {
        assert.deepEqual(plan.unseal, { sourceId: recipe.productId, productId: targetId });
        assert.notEqual(leaf.kind, 'mammon_unseal', 'Mammon must wait for the base craft or missing input');
        const command = invoke('GameServer/Bot/Population/ColdEconomyDecision').capture(context, state);
        assert(command.data.byteLength + 48 + Buffer.byteLength(JSON.stringify(command.echo)) <= 800,
            'the conversion chain fits the bounded cold-worker decision');
    }
    assert.equal(plan.target.slot, slot, 'the selected paperdoll slot reaches the equipment receipt');
    if (!missing) readyFixtures.set(recipeId, { state: { ...state,
        stats: { ...state.stats, ...context.statsPacket } }, plan, workshop });
    return { recipeId, productId: recipe.productId, targetId, missing, activity: leaf.activity };
}

async function verifyNativeCrafts() {
    const Database = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
    const Craft = invoke('GameServer/Bot/Economy/ColdCraftingService');
    const Workshops = invoke('GameServer/Bot/Economy/CraftWorkshopService');
    const TwinCluster = invoke('GameServer/Bot/Economy/TwinCluster');
    fixture.assertConfigured(options.default);
    async function seed(accountName, name, classId, level, inventory, loc, stats) {
        await Database.createAccount(accountName, 'fixture');
        const race = Data.classTemplates.find(row => row.classId === classId).template.race;
        const characterId = Number((await Database.createCharacter(accountName, { name, classId, race,
            maxHp: 1000, maxMp: 1000, sex: 0, face: 0, hair: 0, hairColor: 0, ...loc })).insertId);
        await Database.execute(['UPDATE characters SET level=?, exp=?, hp=1000, mp=1000 WHERE id=?',
            [level, Data.experience[level - 1], characterId]]);
        for (const row of Object.values(inventory)) {
            const name = Data.items.find(item => item.selfId === row.selfId)?.template.name;
            const slots = row.equippedSlots || [];
            for (const slot of slots) await Database.setItem(characterId, { selfId: row.selfId, name,
                amount: 1, equipped: true, slot, enchant: 0 });
            const spare = row.amount - slots.length;
            const stackable = Data.items.find(item => item.selfId === row.selfId)?.etc?.stackable === true;
            for (let left = spare; left > 0; left -= stackable ? spare : 1)
                await Database.setItem(characterId, { selfId: row.selfId, name,
                    amount: stackable ? spare : 1, equipped: false, slot: 0, enchant: 0 });
        }
        return Life.upsertState({ characterId, accountName, name, level, phase: 'cold', activity: 'crafting',
            currentRegion: 'Giran', loc, adena: inventory[57].amount,
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(characterId)),
            vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
            stats: { ...stats, classId }, timing: {} }, 'b_craft_fixture');
    }
    try {
        await Database.init(); await Life.init();
        for (const [recipeId, { state, plan, workshop }] of readyFixtures) {
            const recipe = Recipes.resolveByRecipeId(recipeId);
            // One dwarf per recipe: a workshop craft spends its owner's MP.
            let owner = await seed(`bot_b_dwarf_${recipeId}`, `Forge${recipeId}`, 57, 70,
                { 57: { selfId: 57, amount: 1000 } }, workshop.loc, { role: 'crafter', twin: { town: 'Giran' } });
            await Database.setCharacterRecipe(owner.characterId, recipeId, recipe.type);
            owner = await publishTwinOffer(Life.cachedState(owner.characterId));
            assert(Workshops.publicRecipeRows(owner.characterId).some(row => row[1] === recipeId), `${recipeId}: the dwarf publishes the recipe`);
            // The buyer agrees to the dwarf's published fee (his twin offer).
            const offer = TwinCluster.entriesOf(owner).find(entry => Number(entry.recipeId) === recipeId);
            const provider = { ...plan.craftProviders[recipeId], characterId: owner.characterId, price: offer.price };
            let buyer = await seed(`bot_b_craft_${recipeId}`, `Buyer${recipeId}`, state.classId, 55,
                { ...state.inventory, 57: { selfId: 57, amount: state.adena } }, workshop.loc,
                { ...state.stats, equipmentPlan: { ...plan, craftProviders: { ...plan.craftProviders, [recipeId]: provider } } });
            const before = buyer.adena, ownerBefore = (await Database.fetchItems(owner.characterId)).find(row => row.selfId === 57).amount;
            const committedPlan = buyer.stats.equipmentPlan;
            buyer = await Life.upsertState({ ...buyer, stats: { ...buyer.stats, equipmentPlan: {
                ...committedPlan, recipeId: Recipes.resolveByProductId(recipe.productId).recipeId } } }, 'b_other_recipe');
            await assert.rejects(Workshops.craft(owner.characterId, recipeId, buyer.characterId,
                { funding: { r: plan.valueRate } }), /economy_material_protected/,
            'another recipe variant cannot consume the personal goal reservation');
            const reservedId = recipe.materials[1].selfId;
            buyer = await Life.upsertState({ ...Life.cachedState(buyer.characterId),
                stats: { ...Life.cachedState(buyer.characterId).stats, equipmentPlan: committedPlan },
                inventory: { ...buyer.inventory, [reservedId]: { ...buyer.inventory[reservedId], protectedAmount: 1 } } }, 'b_explicit_protection');
            await assert.rejects(Workshops.craft(owner.characterId, recipeId, buyer.characterId,
                { funding: { r: plan.valueRate } }), /economy_material_protected/,
            'explicitly protected units stay protected even for the selected recipe');
            const unchanged = await Database.fetchItems(buyer.characterId);
            assert.equal(unchanged.find(row => row.selfId === 57).amount, before, 'refusals spend no fee');
            assert(!unchanged.some(row => row.selfId === recipe.productId), 'refusals produce no weapon');
            buyer = await Life.upsertState({ ...Life.cachedState(buyer.characterId), inventory: {
                ...buyer.inventory, [reservedId]: { ...buyer.inventory[reservedId], protectedAmount: 0 } } }, 'b_selected_recipe');
            const returnTo = { loc: { locX: 90000, locY: 148000, locZ: -3400 }, spotId: null, regionName: 'Giran' };
            if (plan.unseal) buyer = await Life.upsertState({ ...buyer, stats: { ...buyer.stats,
                craftReturn: returnTo, marketReturn: returnTo,
                partyMarketReturn: { partyId: 'fixture_party_return', until: Date.now() + 900000 } } }, 'b_unseal_return_ticket');
            const result = await Craft.craft(buyer, () => 0);
            assert.equal(result.crafted, true, `${recipeId}: ${result.reason} ${result.error || ''}`);
            buyer = await Life.upsertState(result.state, 'b_craft_receipt');
            const physical = await Database.fetchItems(buyer.characterId);
            const product = physical.filter(row => row.selfId === recipe.productId);
            assert.equal(product.length, 1, 'one native B equipment receipt');
            if (!plan.unseal) {
                assert.equal(Number(product[0].equipped), 1, 'the B equipment is physically worn');
                assert.equal(Number(product[0].slot), plan.target.slot, 'paired jewelry and full body armor keep their selected paperdoll slot');
                assert.equal(buyer.inventory[recipe.productId].equippedCount, 1);
                assert.equal(buyer.stats.equipmentPlan, undefined, 'the accepted craft plan closes after equipment receipt');
            }
            else assert.equal(buyer.stats.equipmentPlan.target.selfId, plan.unseal.productId,
                'the base receipt must retain the final unsealed goal');
            for (const material of recipe.materials)
                assert.equal(physical.filter(row => row.selfId === material.selfId).reduce((n, row) => n + row.amount, 0), 0);
            assert.equal(buyer.adena, before - provider.price, 'the buyer pays exactly the quoted service fee');
            assert.equal((await Database.fetchItems(owner.characterId)).find(row => row.selfId === 57).amount,
                ownerBefore + provider.price, 'the dwarf receives the paid fee in its physical wallet');
            assert.equal((await Craft.craft({ ...buyer, activity: 'crafting' }, () => 0)).crafted, false,
                'a completed equipment receipt never crafts the equipment again');
            if (plan.unseal) {
                const Mammon = invoke('GameServer/Bot/AI/BotMammonUnseal');
                assert.equal(invoke('GameServer/Bot/Economy/ItemDisposition').reservedEquipmentAmounts(buyer)[recipe.productId], 1,
                    'the base remains protected until its unseal receipt');
                const held = Economy.forState({ ...buyer, activity: 'hunting' }, { timestamp, board: new BoardIndex(), spots: [],
                    npcOffersFor: () => [], workshop: null, workshops: () => [], knownRecipes: [], rememberContext: false,
                    routeRows: invoke('GameServer/Bot/Economy/EconomicTrip').towns.map(() => [true, 0, 0]) });
                assert.equal(held.network.activity?.kind, 'mammon_unseal', 'owned base needs no remaining workshop');
                const resumed = Providers.personalCraftPlan(buyer, held);
                assert.deepEqual(resumed.unseal, plan.unseal, 'the compact network keeps the conversion after base receipt');
                assert.equal(resumed.target.selfId, plan.target.selfId);
                assert.equal(resumed.recipeId, null, 'the held base is not nominated for another craft');
                buyer = await Life.upsertState({ ...buyer, stats: { ...buyer.stats,
                    ...held.statsPacket, equipmentPlan: resumed } }, 'unseal_chain_resumed');
                const trip = buyer.stats.mammonReturn ? buyer : Mammon.beginTravel({ ...buyer, activity: 'hunting' }, timestamp);
                assert(trip, 'the native base receipt starts the Mammon trip');
                assert.equal(trip.stats.travel.reason, 'mammon_unseal', 'the craft continues to Mammon before returning to the field');
                assert.deepEqual(trip.stats.mammonReturn, returnTo, 'the continuation preserves its original return destination');
                assert.equal(trip.stats.partyMarketReturn.partyId, 'fixture_party_return', 'the same party ticket survives the continuation');
                const arrival = invoke('GameServer/Bot/Population/BackgroundResolver').resolveSolo({ state: trip,
                    timestamp: trip.stats.travel.arrivalAt, elapsedMs: trip.stats.travel.arrivalAt - timestamp });
                let arrived = await Life.upsertState({ ...trip, ...arrival.patch }, 'unseal_chain_arrival');
                const returned = await Mammon.finish(arrived, trip.stats.travel.arrivalAt + 1);
                buyer = await Life.upsertState(returned, 'unseal_chain_receipt');
                const after = await Database.fetchItems(buyer.characterId);
                const worn = after.find(row => row.id === product[0].id);
                assert.equal(worn.selfId, plan.unseal.productId, 'the same physical instance becomes the selected variant');
                assert.equal(Number(worn.equipped), 1, 'the final B gloves or boots are physically equipped');
                assert.equal(Number(worn.slot), plan.target.slot);
                assert(!after.some(row => row.selfId === recipe.productId), 'the base is converted, never duplicated');
                assert.equal(buyer.stats.equipmentPlan, undefined, 'only the equipped final variant closes the goal');
                assert(!Mammon.candidate(buyer), 'the accepted variant cannot loop through Mammon');
            }
        }
        console.log('PASS native B craft receipts, eight glove/boot base crafts -> Mammon -> same physical instance equipped -> closed plan');
    } finally { await Database.close(); }
}

const cases = [[461], [457], [329, 2], [331, 5], [333, 3], [342, 10],
    [362, 10, 8], [368, 10, 12], [358, 10], [366, 15, 8], [479, 8, 5]];
const Unseal = invoke('GameServer/Items/C4Unseal');
const unsealCases = Unseal.recipes.filter(row => {
    const item = Data.items.find(item => item.selfId === row.productId);
    return item?.etc?.rank === 'b' && [9, 12].includes(item.etc.slot);
}).map(row => {
    const recipe = Recipes.resolveVariantsByProductId(row.sourceId).find(recipe => recipe.successRate === 100);
    const slot = Data.items.find(item => item.selfId === row.productId).etc.slot;
    return [recipe.recipeId, slot, { heavy: 2, light: 9, robe: 12 }[row.style], row.productId];
});
assert.equal(unsealCases.length, 24, 'four B sets have gloves/boots for all three armour styles');
const results = [...cases, ...unsealCases].flatMap(([recipeId, slot = 14, classId = 3, targetId = null]) =>
    [verify(recipeId, false, slot, classId, targetId), verify(recipeId, true, slot, classId, targetId)]);
// A chosen paperdoll variant is authoritative even when another armour style
// would be the default for an incidental, unplanned Mammon visit.
results.push(verify(430, false, 9, 9, 5710));
// A B craft whose C crystals come from paid C pieces (crystalPreparation):
// the bot breaks them with its own Crystallize (no trip, no workshop), and
// the pieces and the crystals stay reserved for the craft, never sold.
{
    const Sources = invoke('GameServer/Bot/Population/ColdOccupationSources'); Sources.initialise();
    const Crystals = invoke('GameServer/Bot/Economy/BotCrystallization');
    const { state: original, plan } = readyFixtures.get(457);
    const state = structuredClone(original);
    const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
    state.stats.coldCombat = { ...Profile.legacySnapshot(state, []), skills: [...(state.stats.coldCombat?.skills || []),
        ...Profile.skillSnapshotsFromRecords([{ selfId: 248, name: 'Crystallize', level: 2, passive: true }])] };
    delete state.inventory[1459];
    for (const [id, row] of Object.entries(state.inventory)) if (!row.equipped
        && ['d', 'c'].includes(Data.items.find(item => item.selfId === row.selfId)?.etc?.rank)) delete state.inventory[id];
    const crystals = Number(plan.materials.find(row => Number(row.selfId) === 1459)?.amount || 0);
    assert(crystals > 0, 'the B recipe takes C crystals');
    const inputId = Crystals.catalog('c')[0];
    const paid = { ...structuredClone(plan), status: 'active',
        crystalPreparation: { materials: [{ selfId: inputId, amount: 1 }] } };
    const prepared = structuredClone(state);
    prepared.stats.equipmentPlan = paid;
    prepared.inventory[inputId] = { selfId: inputId, amount: 1, equipped: false };
    const review = (from, routeRows) => Economy.forState(from, { timestamp, board: new BoardIndex(), spots: [],
        npcOffersFor: Sources.npcOffersFor, workshop: null, workshops: () => [], knownRecipes: [], rememberContext: false,
        ...(routeRows ? { routeRows } : {}) });
    const rootKey = `crystal_input:${paid.target.selfId}:${paid.target.slot}`;
    const resumed = review(prepared, invoke('GameServer/Bot/Economy/EconomicTrip').towns.map(() => [true, 0, 0]));
    assert.equal(resumed.network.activity.rootKey, rootKey);
    assert.equal(resumed.network.activity.kind, 'crystallize');
    assert.equal(resumed.network.activity.itemId, 1459, 'a paid C piece is crystallized even when the B workshop disappears');
    // The bot breaks its pieces where it stands: no known route is needed.
    assert.equal(review(prepared, null).network.activity.rootKey, rootKey, 'the paid inputs root needs no trip');
    const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
    assert(Disposition.reservedEquipmentAmounts(prepared)[inputId] >= 1, 'the paid C piece is not sold');
    const stocked = structuredClone(prepared);
    delete stocked.inventory[inputId];
    stocked.inventory[1459] = { selfId: 1459, amount: crystals };
    assert(Disposition.reservedEquipmentAmounts(stocked)[1459] >= crystals,
        'the C crystals reserved for the unfinished B craft are not sold');
    results.push({ crystalPreparation: true, resumed: { rootKey: resumed.network.activity.rootKey,
        kind: resumed.network.activity.kind, itemId: resumed.network.activity.itemId } });
}
console.log(`PASS B recipe variants and native craft/material goals (${isMainThread ? 'main' : 'worker'})`);
if (isMainThread) {
    const workerCheck = new Promise((resolve, reject) => {
        const worker = new Worker(__filename, { workerData: {
            workerPath: path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js'),
            sharedGeodata: Geodata.sharedDescriptor(), workerEpoch: 'b-grade-craft-test' } });
        const timer = setTimeout(() => { worker.terminate(); reject(Error('B craft worker timed out')); }, 60000);
        worker.on('message', message => {
            if (message.type !== 'b_grade_craft_result') return;
            clearTimeout(timer);
            try { assert.deepEqual(message.results, results, 'real cold worker and main select the same B steps'); resolve(); }
            catch (error) { reject(error); }
            worker.terminate();
        });
        worker.on('error', error => { clearTimeout(timer); reject(error); });
    });
    Promise.all([workerCheck, verifyNativeCrafts()])
        .catch(error => { console.error(error); process.exitCode = 1; })
        .finally(() => require('node:fs').rmSync(fixture.directory, { recursive: true, force: true }));
} else parentPort.postMessage({ type: 'b_grade_craft_result', results });
