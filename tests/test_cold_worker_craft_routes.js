const assert = require('assert');
const path = require('path');
const { Worker } = require('worker_threads');

require('../src/Global');
const Geodata = require('../src/GameServer/Geodata/GeodataEngine');

const DataCache = invoke('GameServer/DataCache');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');

DataCache.init();

// The cold worker runs the same acquisition planner as the main thread. Its
// module boundary may hide live services, but not the recipe catalogue a craft
// route reads: without it a cold bot can never choose a craft route, and a
// stored craft plan collapses to `complete` as soon as a material arrives.
// Grade recipes reach bots through a crafter's workshop (grade stations serve
// none), so both threads plan over a Warsmith's catalogue.
const stationDwarf = { level: 70, stats: { classId: 57 } };
const workshopRecipes = { craftRecipes: CraftShopService.CraftStations.flatMap(station =>
    CraftShopService.stationRecipes(station, CraftShopService.availableRecipes(stationDwarf))) };
const mage = { characterId: 9100001, level: 40, stats: { classId: 10, role: 'mage' }, inventory: {} };
const target = GearAcquisitionPlanner.preferredTarget(mage, workshopRecipes);
assert(target?.recipe, 'fixture: a C-grade mage must receive a craftable target on the main thread');
const readyInventory = target.recipe.materials.reduce((inventory, material) => ({
    ...inventory,
    [material.selfId]: { selfId: material.selfId, amount: material.amount }
}), {});
const atubaMace = C4RecipeItems.resolveByRecipeId(189);
const crystalSupplement = invoke('GameServer/Bot/Economy/CraftSupplementMaterials');
const componentInventory = atubaMace.materials.reduce((inventory, material) => {
    if (Number(material.selfId) === 1879 || crystalSupplement.isSupplementalMaterial(material.selfId)) return inventory;
    inventory[material.selfId] = { selfId: material.selfId, amount: material.amount };
    return inventory;
}, { 1870: { selfId: 1870, amount: 3 }, 1871: { selfId: 1871, amount: 3 } });

const probes = {
    // The caller names the crafter of the target recipe (a clan crafter).
    ready: [{ ...mage, inventory: readyInventory }, { spots: [], ...workshopRecipes, allowedRecipeIds: new Set([target.recipe.recipeId]) }],
    component: [{ characterId: 9100002, level: 20, stats: { classId: 10, role: 'mage' }, inventory: componentInventory },
        { spots: [], recipeId: atubaMace.recipeId, ...workshopRecipes,
            // No Giran station crafts for a bot: the caller names the crafted
            // recipes (a clan crafter makes Cokes, the Atuba Mace component).
            allowedRecipeIds: new Set([atubaMace.recipeId, C4RecipeItems.resolveByProductId(1879).recipeId]) }]
};
const summary = (plan) => ({ status: plan?.status, strategy: plan?.strategy, recipeId: plan?.recipeId ?? null });
const mainThread = Object.fromEntries(Object.entries(probes).map(([key, [state, options]]) => (
    [key, summary(GearAcquisitionPlanner.planFor(state, options))]
)));
assert.strictEqual(mainThread.ready.status, 'ready_to_craft', 'fixture: main thread must see a ready craft route');
assert.strictEqual(mainThread.component.status, 'component_ready', 'fixture: main thread must see a ready component');
// Ready means a crafter runs the recipe: a full bag nobody crafts from is not.
assert.notStrictEqual(GearAcquisitionPlanner.planFor({ ...mage, inventory: readyInventory }, { spots: [], ...workshopRecipes }).status,
    'ready_to_craft', 'a full bag with no crafter is not ready');

// Load the real worker module graph (its invoke boundary and stubs), then run
// the planner inside that thread.
const workerPath = path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js');
const probeSource = `
const { parentPort, workerData } = require('worker_threads');
require(workerData.workerPath);
const planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const result = {};
for (const [key, [state, options]] of Object.entries(workerData.probes)) {
    const plan = planner.planFor(state, options);
    result[key] = { status: plan?.status, strategy: plan?.strategy, recipeId: plan?.recipeId ?? null };
}
parentPort.postMessage({ type: 'probe_result', result });
`;
const worker = new Worker(probeSource, {
    eval: true,
    workerData: { sharedGeodata: Geodata.sharedDescriptor(), workerPath, probes, workerEpoch: 'craft-route-test' },
    resourceLimits: { maxOldGenerationSizeMb: 512 }
});
const timeout = setTimeout(() => {
    console.error('worker_probe_timeout');
    process.exitCode = 1;
    worker.terminate();
}, 60000);
worker.on('message', (message) => {
    if (message?.type !== 'probe_result') return;
    clearTimeout(timeout);
    worker.terminate();
    try {
        assert.deepStrictEqual(message.result.ready, mainThread.ready,
            'a cold bot with every material must get the same craft route as on the main thread');
        assert.deepStrictEqual(message.result.component, mainThread.component,
            'refreshing a stored craft plan in the worker must not close it as complete when a component is ready');
        console.log('Cold worker craft route checks passed');
    } catch (error) {
        console.error(error.message);
        console.error('main', JSON.stringify(mainThread), 'worker', JSON.stringify(message.result));
        process.exitCode = 1;
    }
});
worker.on('error', (error) => {
    clearTimeout(timeout);
    console.error(error);
    process.exitCode = 1;
});
