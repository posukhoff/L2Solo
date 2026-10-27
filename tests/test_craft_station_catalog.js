const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');

DataCache.init();

// The Giran stations are the player's shops: what a station crafter can make
// and what each station lists. No station serves bots.
const stationService = { level: 70, stats: { classId: 57 } };
const itemIds = new Set(DataCache.items.map((item) => Number(item.selfId)));
const direct = (craftLevel) => [...new Map(Object.values(C4RecipeItems.loadRecipeItems())
    .filter((recipe) => recipe?.type === 'dwarven' && Number(recipe.level || 0) <= craftLevel
        && itemIds.has(Number(recipe.productId)))
    .map((recipe) => [Number(recipe.recipeId), recipe])).values()]
    .sort((a, b) => Number(a.recipeId) - Number(b.recipeId));

for (const [state, craftLevel] of [[stationService, 9], [{ level: 40, stats: { classId: 56 } }, 4], [{ level: 45, stats: { classId: 57 } }, 5]]) {
    assert.strictEqual(CraftShopService.craftLevelFor(state), craftLevel, 'fixture: craft level');
    assert.deepStrictEqual(CraftShopService.availableRecipes(state).map((recipe) => recipe.recipeId),
        direct(craftLevel).map((recipe) => recipe.recipeId), `craft level ${craftLevel} must see every dwarven recipe up to its level`);
}
assert.deepStrictEqual(CraftShopService.availableRecipes({ level: 70, stats: { classId: 0 } }), [],
    'a non-crafter has no service recipes');

const allowed = direct(9);
const template = id => DataCache.items.find(item => Number(item.selfId) === Number(id));
const shopStation = recipeId => CraftShopService.CraftStations.find(station => CraftShopService.stationRecipes(station, allowed)
    .some(recipe => Number(recipe.recipeId) === Number(recipeId)));
const bWeaponRecipes = allowed.filter(recipe => recipe.successRate === 100
    && template(recipe.productId)?.etc?.rank === 'b'
    && template(recipe.productId)?.template?.kind.startsWith('Weapon.'));
assert.strictEqual(bWeaponRecipes.length, 19, 'native B weapons include physical and caster blunts');
for (const recipe of bWeaponRecipes) {
    const station = shopStation(recipe.recipeId);
    assert(station?.id === 'b_weapons' || station?.id === 'b_weapons_entry',
        `${template(recipe.productId).template.name} must have a B weapon station in the player's market`);
}
assert.strictEqual(CraftShopService.CraftStations[13].id, 'b_weapons', 'existing B crafter account keeps its station');
assert.strictEqual(CraftShopService.CraftStations[31].id, 'b_weapons_entry', 'the entry station is appended after existing accounts');
const entry = CraftShopService.profileFor({ level: 70, accountName: 'bot_craft_32', stats: { classId: 57 } });
assert.strictEqual(entry.stationId, 'b_weapons_entry');
assert(entry.entries.some(row => row.recipeId === 457), 'the new station publishes Great Axe');
assert(entry.entries.some(row => row.recipeId === 441), 'the new station publishes Heavy War Axe');
assert(entry.entries.length <= CraftShopService.MAX_PUBLIC_RECIPES, 'the native public recipe limit is respected');
const entryBProducts = [856, 887, 918,
    357, 383, 503, 554, 612, 633, 2384, 2388, 2397, 2402,
    2376, 2379, 2390, 673, 600, 2406, 2415, 2464];
for (const productId of entryBProducts) {
    const recipe = C4RecipeItems.resolveVariantsByProductId(productId).find(row => row.successRate === 100);
    const station = recipe && shopStation(recipe.recipeId);
    assert(station, `${template(productId).template.name} has its native 100% service`);
    const slot = CraftShopService.CraftStations.indexOf(station);
    const profile = CraftShopService.profileFor({ level: 70, accountName: `bot_craft_${slot + 1}`, stats: { classId: 57 } });
    assert(profile.entries.some(row => row.recipeId === recipe.recipeId), 'station entry recipes reach the physical service portfolio');
    assert(profile.entries.length <= CraftShopService.MAX_PUBLIC_RECIPES);
}
assert.deepStrictEqual(CraftShopService.CraftStations.slice(32).map(row => row.id),
    ['b_armor_zubei', 'b_armor_avadon', 'b_jewelry_entry'], 'new B services append after every persisted crafter account');
const originalItems = DataCache.items;

// Station crafters are seeded at the content cap.
assert.deepStrictEqual(CraftShopService.stationCrafter(), { classId: 57, level: 70 });
const progression = options.default.Progression;
options.default.Progression = { ...(progression || {}), contentCap: 45 };
try {
    assert.deepStrictEqual(CraftShopService.stationCrafter(), { classId: 57, level: 45 });
} finally {
    if (progression === undefined) delete options.default.Progression;
    else options.default.Progression = progression;
}

const nativeSource = C4RecipeItems.nativeSource, loadedSource = C4RecipeItems.loadedSource;
const early = { recipeId: 77, productId: 501, type: 'dwarven', level: 1, materials: [] };
const last = { ...early, recipeId: '77' }, lower = { ...early, recipeId: 22 };
const absentProduct = { ...early, recipeId: 88, productId: 502 };
const common = { ...early, recipeId: 99, type: 'common' };
const fixtureRows = [early, last, lower, absentProduct, common];
const fixtureSource = { rows: fixtureRows, revision: fixtureRows,
    recipeItems: { 100: early, 101: last, 102: lower, 103: absentProduct, 104: common } };
try {
    C4RecipeItems.nativeSource = () => fixtureSource;
    C4RecipeItems.loadedSource = () => fixtureSource;
    DataCache.items = [{ selfId: 501 }];
    assert.deepStrictEqual(CraftShopService.availableRecipes(stationService), [lower, last],
        'station reader keeps scroll order, last numeric recipe-ID variant, exact dwarven type and present products');
    DataCache.items.push({ selfId: 502 });
    assert.deepStrictEqual(CraftShopService.availableRecipes(stationService), [lower, last, absentProduct],
        'an appended product refreshes the same shared recipe relation');
} finally {
    C4RecipeItems.nativeSource = nativeSource; C4RecipeItems.loadedSource = loadedSource;
    DataCache.items = originalItems;
}
console.log('Craft station catalogue checks passed');
