const assert = require('assert');

require('../src/Global');
invoke('GameServer/DataCache').init();

const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const GearPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const ColdCraftingService = invoke('GameServer/Bot/Economy/ColdCraftingService');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const Sections = invoke('GameServer/Bot/Economy/DecisionSections');

const originals = {
    ensure: SpotProfiles.ensure,
    planFor: GearPlanner.planFor,
    craft: ColdCraftingService.craft,
    upsertState: LifeState.upsertState,
    cachedState: LifeState.cachedState
};

async function run() {
    const state = {
        characterId: 73,
        name: 'CraftWaitProbe',
        phase: 'cold',
        level: 30,
        activity: 'crafting',
        timing: { nextResolveAt: Date.now() - 1 },
        stats: { equipmentPlan: { status: 'ready_to_craft', strategy: 'craft', recipeId: 189 } },
        inventory: {}
    };
    let saved = null;

    SpotProfiles.ensure = () => [];
    GearPlanner.planFor = () => state.stats.equipmentPlan;
    ColdCraftingService.craft = () => Promise.resolve({ state, crafted: false, reason: 'materials_changed' });
    LifeState.upsertState = (next, reason) => {
        saved = { state: next, reason };
        return Promise.resolve(next);
    };

    const result = await PopulationService.resolveColdState(state);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(saved.reason, 'cold_craft_wait');
    assert.strictEqual(saved.state.activity, 'hunting', 'a station wait without a ready recipe must resume material farming');
    assert(saved.state.timing.nextResolveAt > Date.now(), 'recovered craft wait must receive a new scheduling deadline');

    // A held craft whose provider left the market for good (a retired
    // station's workshop, a dwarf that withdrew the recipe): the bot, still
    // hunting, never sets out for it; its plan is refused as for a bot that
    // reached the provider, and rebuilds.
    ColdCraftingService.craft = originals.craft;
    const staff = C4RecipeItems.resolveByRecipeId(198);
    const bag = (rows) => Object.fromEntries(rows.map(row => [row.selfId, { selfId: row.selfId, amount: row.amount }]));
    const gone = { workshop: true, characterId: 999999, price: 1000, known: true };
    let owner = { characterId: 999999, phase: 'cold', stats: { workshop: { entries: [] } } };
    LifeState.cachedState = id => Number(id) === 999999 ? owner : originals.cachedState(id);
    const held = (inventory, plan) => ({ ...state, activity: 'hunting', inventory,
        stats: { decisionSeq: 4, activityLeaf: 7, equipmentPlan: { status: 'ready_to_craft', strategy: 'craft',
            recipeId: 198, target: { selfId: staff.productId }, ...plan } } });
    const cases = {
        'the plan\'s own craft': held(bag(staff.materials), { craftProviders: { 198: gone } }),
        // Coarse Bone Powder (recipe 31) is the component the plan crafts; its inputs are in the bag.
        'a planned component': held(bag([...staff.materials.filter(row => row.selfId !== 1881), { selfId: 1872, amount: 400 }]),
            { componentRecipes: { 1881: 31 }, craftProviders: { 31: gone } })
    };
    for (const [name, holder] of Object.entries(cases)) {
        saved = null;
        GearPlanner.planFor = () => holder.stats.equipmentPlan;
        const refused = await PopulationService.resolveColdState(holder);
        assert.strictEqual(refused.ok, true, name);
        assert.strictEqual(saved?.reason, 'cold_craft_missing_station', `${name}: a gone provider ends the step, not a hunt`);
        assert.strictEqual(saved.state.activity, 'hunting', name);
        assert.strictEqual(saved.state.stats.travel, null, `${name}: no trip to a gone provider`);
        assert.strictEqual(saved.state.stats.wishDirty, Sections.sectionBit('sources'), `${name}: the refusal is a sources event`);
        assert.strictEqual(saved.state.stats.activityLeaf, 0, `${name}: the held plan is retired, the next decision rebuilds it`);
    }
    // The same workshop owner gone hot runs nothing now: a ready plan is
    // refused (no_crafter) and rebuilds instead of coming back every step.
    owner = { characterId: 999999, phase: 'hot', stats: {} };
    saved = null;
    GearPlanner.planFor = () => cases['the plan\'s own craft'].stats.equipmentPlan;
    const waiting = await PopulationService.resolveColdState(cases['the plan\'s own craft']);
    assert.strictEqual(waiting.ok, true);
    assert.strictEqual(saved?.reason, 'cold_craft_no_crafter', 'a hot workshop owner is no runnable crafter');
    assert.strictEqual(saved.state.stats.travel, null, 'no trip to a busy provider');
    assert.strictEqual(saved.state.stats.wishDirty & Sections.sectionBit('sources'), Sections.sectionBit('sources'));
    assert.strictEqual(saved.state.stats.activityLeaf, 0, 'the held plan is retired, the next decision rebuilds it');
    // A near body's executor (ShoppingState) refuses through the same owner,
    // but only the plan its held decision carries; a plan left on the cold
    // row is the cold step's to refuse.
    owner = { characterId: 999999, phase: 'cold', stats: { workshop: { entries: [] } } };
    const Shopping = invoke('GameServer/Bot/AI/States/ShoppingState');
    const nearPlan = () => ({ status: 'ready_to_craft', strategy: 'craft', recipeId: 198,
        target: { selfId: staff.productId }, craftProviders: { 198: gone } });
    const near = (carried) => {
        const plan = nearPlan();
        const actor = { fetchId: () => 74, backpack: { fetchItems: () => staff.materials.map(row => ({ ...row })) } };
        return { actor, coldLifeState: { characterId: 74, phase: 'hot', stats: { decisionSeq: 4, activityLeaf: 7, equipmentPlan: plan } },
            heldEconomy: { personalCraft: carried ? plan : null, statsPacket: { decisionSeq: 4, activityLeaf: 7 } } };
    };
    const carried = near(true);
    assert.strictEqual(Shopping.workshopTarget(carried, carried.actor), null, 'no workshop target for a gone provider');
    assert.strictEqual(carried.coldLifeState.stats.activityLeaf, 0, 'the held decision carrying the plan is refused');
    assert.strictEqual(carried.coldLifeState.stats.wishDirty & Sections.sectionBit('sources'), Sections.sectionBit('sources'));
    const stale = near(false);
    assert.strictEqual(Shopping.workshopTarget(stale, stale.actor), null);
    assert.strictEqual(stale.coldLifeState.stats.activityLeaf, 7, 'a cold-row plan the decision does not carry refuses nothing');
    assert.strictEqual(Number(stale.coldLifeState.stats.wishDirty || 0), 0);
    console.log('Bot craft wait recovery checks passed');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
}).finally(() => {
    SpotProfiles.ensure = originals.ensure;
    GearPlanner.planFor = originals.planFor;
    ColdCraftingService.craft = originals.craft;
    LifeState.upsertState = originals.upsertState;
    LifeState.cachedState = originals.cachedState;
});
