const assert = require('assert');
const { useRate } = require('./helpers/progressionRate');
const path = require('path');

require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const FirstPrice = invoke('GameServer/Bot/Economy/FirstPrice');
const Efficiency = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');
const NpcShopPriceScale = invoke('GameServer/World/Generics/NpcShopPriceScale');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const NpcShopBuyLists = invoke('GameServer/World/Generics/NpcShopBuyLists');
const { npcPlanningCatalogRows } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');

const near = (actual, expected, message) => assert(Math.abs(actual - expected) < 1e-6 * Math.max(1, Math.abs(expected)),
    `${message}: ${actual} != ${expected}`);
// The hand-made table of test_spot_value_table: spot S (level 18) is rated at 24 for its dps and spoiler.
Table.useFile(path.join(__dirname, 'fixtures', 'spot_table.json'));
useRate('x1');

// Spot S holds 3 Scavenger Wererats (39) and 1 Sukar Wererat (40), level 18.
const spots = [{ id: 'S', avgLevel: 18, density: 30, npcEntries: [
    { selfId: 39, name: 'Scavenger Wererat', level: 18, count: 3 },
    { selfId: 40, name: 'Sukar Wererat', level: 18, count: 1 }] }];
Table.useSpots(spots);
const reward = DataCache.npcRewards.find((entry) => Number(entry.selfId) === 39);
const dropIds = new Set((reward.rewards || []).flatMap((group) => (group.items || []).map((item) => Number(item.selfId))));
const itemId = 1924;
assert(dropIds.has(itemId), 'the fixture monster drops the test item');
const basePrice = Number(DataCache.items.find((item) => Number(item.selfId) === itemId).template.price);
const yieldPerKill = Planner.itemDropYield(reward, itemId, 'drop', { npcLevel: 18, killerLevel: 24 }).expectedYield;
const kills = 1 / (0.75 * yieldPerKill);
Efficiency.resetLevelBands();
const defaultHour = Efficiency.huntIncome({ level: 24, stats: {} });
const first = FirstPrice.firstPrice(itemId, { spots });
assert.strictEqual(first.spotId, 'S');
assert.strictEqual(first.npcId, 39, 'the monster with the larger share of the spot gives more items per hour: it wins');
assert.strictEqual(first.level, 24, 'the level the table rates the spot at');
near(first.kills, kills, 'kills needed = 1 / (share x yield)');
near(first.hours, kills / (defaultHour.perHour / defaultHour.perKill), 'hours at the kill rate of the bots of that level');
const expected = Math.min(basePrice, Math.max(NpcSellRules.npcBuyPrice(basePrice), kills * defaultHour.perKill));
assert.strictEqual(first.price, Math.round(expected), 'price = hours x their hour = kills needed x their income per kill, inside the NPC walls');
assert(first.price >= NpcSellRules.npcBuyPrice(basePrice) && first.price <= basePrice, 'first price within the NPC walls');

// ARCH-NOTE: first prices use the shared table; private income from another bot is not a cohort price input.
function band(level, perKill) {
    let bot = { characterId: 7000 + perKill, level, stats: { classId: 1 }, inventory: { 1: { selfId: 1, equipped: true } } };
    for (let i = 0; i < 3; i++) {
        bot = { ...bot, stats: { ...bot.stats, huntEfficiency: Efficiency.record(bot, { spotId: 'x', exp: 100, cycleMs: 60000,
            adena: perKill * 10, loot: 0, kills: 10, timestamp: 1000 }) } };
    }
}
Efficiency.resetLevelBands();
band(24, 1e7);
assert.strictEqual(FirstPrice.firstPrice(itemId, { spots, timestamp: 1000 }).price, first.price, 'another rich bot cannot change the first price');
Efficiency.resetLevelBands();
band(24, 0.001);
assert.strictEqual(FirstPrice.firstPrice(itemId, { spots, timestamp: 1000 }).price, first.price, 'another poor bot cannot change the first price');
assert(first.price >= NpcSellRules.npcBuyPrice(basePrice), 'never below the NPC buy-back');
Efficiency.resetLevelBands();

const notDropped = DataCache.items.find((item) => Number(item.template?.price) > 0 && !dropIds.has(Number(item.selfId))
    && !(DataCache.npcRewards.find((entry) => Number(entry.selfId) === 40)?.rewards || [])
        .some((group) => (group.items || []).some((entry) => Number(entry.selfId) === Number(item.selfId))));
assert.strictEqual(FirstPrice.firstPrice(57, { spots }), null, 'adena has no price');

// No hunting source (group E): crafted = materials + labour; a crystal from
// the cheapest gear per crystal; a no-grade shot at the NPC price; anything
// else at the NPC buy-back. Inside the NPC walls.
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const CraftShop = invoke('GameServer/Bot/Economy/CraftShopService');
const BotMarketPricing = invoke('GameServer/Bot/Economy/BotMarketPricing');
const shotD = Recipes.resolveByProductId(1463);
const crafted = FirstPrice.firstPrice(1463, { spots });
assert.strictEqual(crafted.source, 'craft', 'a crafted product nobody drops');
const unitOf = (selfId, where = spots) => {
    const npc = BotMarketPricing.npcPrice({ selfId });
    return Number.isFinite(npc) ? npc : FirstPrice.firstPrice(selfId, { spots: where }).price;
};
const materialsOf = (recipe, where) => recipe.materials.reduce((sum, m) => sum + m.amount * unitOf(m.selfId, where), 0);
near(crafted.materials, materialsOf(shotD) / shotD.productCount, 'materials at the NPC price, else at their own first price');
const crafterLevelOf = (recipe) => [...Array(80).keys()].map((i) => i + 1)
    .find((level) => CraftShop.craftLevelFor({ classId: level >= 40 ? 57 : level >= 20 ? 56 : 53, level }) >= recipe.level);
const crafterLevel = crafterLevelOf(shotD);
assert.strictEqual(crafted.crafterLevel, crafterLevel, 'the lowest dwarf able to craft it');
const labourOf = (recipe) => {
    const level = crafterLevelOf(recipe);
    const restMs = Resolver.estimateRestMs({ level, stats: { classId: level >= 40 ? 57 : level >= 20 ? 56 : 53 } },
        { hp: 1000, maxHp: 1000, mp: 0, maxMp: 10000 }, { requireMana: true });
    return recipe.mpCost / (10000 / (restMs / 1000)) / 3600 * Efficiency.hourValue({ level, stats: {} }).perHour;
};
near(crafted.labour, labourOf(shotD) / shotD.productCount,
    'labour = the craft time (MP over seated regeneration) at the crafter\'s hour');
// A product with two recipes, one that succeeds 60% of the time and one 100%:
// one product costs the materials and labour of 1 / success rate tries, and
// the cheaper recipe prices it.
{
    const recipes = Recipes.resolveVariantsByProductId(357);
    assert.deepStrictEqual(recipes.map((recipe) => recipe.successRate), [60, 100], 'fixture: a 60% and a 100% recipe');
    assert(!Number.isFinite(BotMarketPricing.npcPrice({ selfId: 357 })), 'fixture: no NPC sells it, no ceiling');
    const base = Number(DataCache.items.find((item) => Number(item.selfId) === 357).template.price);
    const costs = recipes.map((recipe) => (materialsOf(recipe) + labourOf(recipe)) / recipe.productCount / (recipe.successRate / 100));
    assert.notStrictEqual(Math.round(costs[0]), Math.round(costs[1]), 'fixture: the two recipes cost differently');
    assert(Math.min(...costs) > NpcSellRules.npcBuyPrice(base), 'fixture: its cost is above the buy-back');
    const made = FirstPrice.firstPrice(357, { spots });
    assert.strictEqual(made.source, 'craft');
    assert.strictEqual(made.price, Math.round(Math.min(...costs)),
        'crafted price = (materials + labour) / count / success rate, of the cheaper recipe');
}
const shotBase = Number(DataCache.items.find((item) => Number(item.selfId) === 1463).template.price);
// No NPC sells a D shot: its price has the NPC buy-back as the floor and no ceiling (E91).
assert.strictEqual(crafted.price, Math.max(NpcSellRules.npcBuyPrice(shotBase),
    Math.round(crafted.materials + crafted.labour)), 'crafted price above the NPC buy-back, no NPC ceiling');
// Saber drops from monster 65 on the table's spot (rated at 24), and a
// recipe (mk_saber, 100%) makes it: its first price is the cheaper of the two.
const sabers = [{ id: 'S', avgLevel: 18, density: 30, npcEntries: [{ selfId: 65, name: 'x', level: 18, count: 1 }] }];
// Prices are asked for the thread's spot catalog, the one the spot table reads.
Table.useSpots(sabers);
const saberBase = Number(DataCache.items.find((item) => Number(item.selfId) === 123).template.price);
const saberYield = Planner.itemDropYield(DataCache.npcRewards.find((entry) => Number(entry.selfId) === 65), 123, 'drop',
    { npcLevel: 18, killerLevel: 24 }).expectedYield;
const saberDrop = Math.round(Math.min(NpcShopPriceScale.price(saberBase, ProgressionRates.profile().multiplier),
    Math.max(NpcSellRules.npcBuyPrice(saberBase), defaultHour.perKill / saberYield)));
const saber = FirstPrice.firstPrice(123, { spots: sabers });
const saberRecipe = Recipes.resolveByProductId(123);
const saberCraft = Math.round(materialsOf(saberRecipe, sabers) + labourOf(saberRecipe));
assert(saberCraft < saberDrop, 'fixture: making the saber is cheaper than hunting it');
assert.strictEqual(saber.source, 'craft', 'a dropped item with a cheaper recipe is priced by the recipe');
assert.strictEqual(saber.price, saberCraft);
// A crystal: Saber breaks into 743 D crystals; a crystal costs the gear's drop price per crystal.
const crystal = FirstPrice.firstPrice(1458, { spots: sabers });
const crystalBase = Number(DataCache.items.find((item) => Number(item.selfId) === 1458).template.price);
assert.strictEqual(crystal.source, 'crystal');
assert.strictEqual(crystal.price, Math.max(NpcSellRules.npcBuyPrice(crystalBase), Math.round(saberDrop / 743)),
    'a crystal costs the gear it comes from per crystal, no NPC ceiling');
Table.useSpots(spots);
// Hunted only, no NPC sells it, no recipe: the hunt estimate is held at the rate-scaled base price.
{
    const bucklerBase = Number(DataCache.items.find((item) => Number(item.selfId) === 945).template.price);
    assert(!Number.isFinite(BotMarketPricing.npcPrice({ selfId: 945 })) && !Recipes.resolveByProductId(945),
        'fixture: no NPC sells the Skeleton Buckler and no recipe makes it');
    const bucklerKills = 1 / (0.75 * Planner.itemDropYield(reward, 945, 'drop', { npcLevel: 18, killerLevel: 24 }).expectedYield);
    const wall = NpcShopPriceScale.price(bucklerBase, ProgressionRates.profile().multiplier);
    assert(bucklerKills * defaultHour.perKill > wall, 'fixture: the hunt estimate is above the wall');
    const buckler = FirstPrice.firstPrice(945, { spots });
    assert.strictEqual(buckler.source, 'drop');
    assert(buckler.price <= wall, 'a hunted item no NPC sells stays at or under the rate-scaled base price');
}
// The worker's NPC prices: the snapshot main sends it.
const workerNpcRows = npcPlanningCatalogRows();
const shotNpcPrice = NpcShopBuyLists.townPriceForItem(1835);
assert(shotNpcPrice > 0, 'fixture: an NPC sells the no-grade soulshot');
BotMarketPricing.useNpcOfferSnapshot(workerNpcRows);
assert.deepStrictEqual(FirstPrice.firstPrice(1835, { spots }), { price: shotNpcPrice, source: 'npc' }, 'a no-grade shot at the NPC price');
BotMarketPricing.useNpcOfferSnapshot(null);
const plain = FirstPrice.firstPrice(notDropped.selfId, { spots });
if (plain.source === 'buyback') assert.strictEqual(plain.price, NpcSellRules.npcBuyPrice(Number(notDropped.template.price)),
    'no source at all: the NPC buy-back');
assert.strictEqual(FirstPrice.firstPrice(1804, { spots: [] }).price, NpcSellRules.npcBuyPrice(
    Number(DataCache.items.find((item) => Number(item.selfId) === 1804).template.price)), 'a recipe with no source: the buy-back');

// A recipe chain deeper than the craft depth is cut where it gets too deep:
// the cut price serves the item asked for, but the deep material's own price,
// asked at the top, prices its whole chain (it is not kept from the cut).
{
    const loose = DataCache.items.filter((item) => Number(item.template?.price) > 0
        && String(item.template?.kind || '').startsWith('Other.Recipe')
        && !Number.isFinite(BotMarketPricing.npcPrice({ selfId: item.selfId })))
        .sort((a, b) => Number(a.template.price) - Number(b.template.price));
    const chain = [...loose.slice(0, 6), loose[loose.length - 1]].map((item) => Number(item.selfId));
    assert.strictEqual(new Set(chain).size, 7, 'fixture: seven distinct items');
    const resolve = Recipes.resolveVariantsByProductId;
    // This artificial price-depth fixture has independent admitted origins.
    const Catalog = invoke('GameServer/Items/ItemAcquisitionCatalog');
    const nativeSource = Catalog.hasSource, nativeRecipe = Catalog.allowsRecipe;
    Catalog.hasSource = id => chain.includes(Number(id)) || nativeSource(id);
    Catalog.allowsRecipe = recipe => chain.includes(Number(recipe?.productId)) || nativeRecipe(recipe);
    Recipes.resolveVariantsByProductId = (id) => {
        const at = chain.indexOf(Number(id));
        return at >= 0 && at < chain.length - 1
            ? [{ productId: chain[at], productCount: 1, successRate: 100, level: 1, mpCost: 0, materials: [{ selfId: chain[at + 1], amount: 1 }] }]
            : resolve(id);
    };
    try {
        FirstPrice.resetCache();
        FirstPrice.cachedFirstPrice(chain[0], { spots: [] });
        const deep = FirstPrice.cachedFirstPrice(chain[5], { spots: [] });
        assert.strictEqual(deep, FirstPrice.firstPrice(chain[5], { spots: [] }).price,
            'a material cut deep in another chain keeps no cut price');
        assert(deep > NpcSellRules.npcBuyPrice(Number(DataCache.items.find((item) => Number(item.selfId) === chain[5]).template.price)),
            'fixture: its full price is above the buy-back the cut gives');
    } finally {
        Recipes.resolveVariantsByProductId = resolve;
        Catalog.hasSource = nativeSource; Catalog.allowsRecipe = nativeRecipe;
        FirstPrice.resetCache();
    }
}

// A kept first price follows its inputs, not a clock: the thread's spot
// catalog and the NPC prices.
{
    const hunted = FirstPrice.firstPrice(945, { spots }).price;
    assert.strictEqual(FirstPrice.cachedFirstPrice(945, { spots }), hunted, 'the kept price is the first price');
    const none = [];
    Table.useSpots(none);
    const unhunted = FirstPrice.firstPrice(945, { spots: none }).price;
    assert.notStrictEqual(unhunted, hunted, 'fixture: without the spot the buckler has another price');
    assert.strictEqual(FirstPrice.cachedFirstPrice(945, { spots: none }), unhunted, 'the kept price follows the spot catalog');
    Table.useSpots(spots);
    assert.strictEqual(FirstPrice.cachedFirstPrice(945, { spots }), hunted, 'and back');
    BotMarketPricing.useNpcOfferSnapshot(workerNpcRows);
    assert.strictEqual(FirstPrice.cachedFirstPrice(1835, { spots }), shotNpcPrice);
    BotMarketPricing.useNpcOfferSnapshot(workerNpcRows.map((row) => (row.selfId === 1835 ? { ...row, price: shotNpcPrice + 2 } : row)));
    assert.strictEqual(FirstPrice.cachedFirstPrice(1835, { spots }), shotNpcPrice + 2, 'the kept price follows the NPC prices');
    BotMarketPricing.useNpcOfferSnapshot(null);
    FirstPrice.resetCache();
}

Table.useFile();
console.log('First price of drops, crafted items, crystals, shots and the rest, inside the NPC walls, passed');
