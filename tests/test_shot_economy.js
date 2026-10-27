const assert = require('assert');
const { useRate } = require('./helpers/progressionRate');

require('../src/Global');

const previousRate = process.env.L2NODE_PROGRESSION_RATE;
useRate('x10');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const PriceScale = require('../src/GameServer/World/Generics/NpcShopPriceScale');
const NpcShopBuyLists = invoke('GameServer/World/Generics/NpcShopBuyLists');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const MarketListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const MarketTownPolicy = invoke('GameServer/Bot/Economy/MarketTownPolicy');

assert.strictEqual(PriceScale.price(250, 1), 250);
assert.strictEqual(PriceScale.price(250, 10), 500);
assert(PriceScale.price(250, 50) < 250 * 5, 'even x50 must avoid a linear NPC price jump');
assert.strictEqual(NpcShopBuyLists.fetchForNpc(7315).find((row) => row.selfId === 1785)?.price,
    600, 'the taxed Gludio Soul Ore price should double at x10');

const dwarf = { characterId: 100, classId: 57, level: 60, adena: 1000000,
    phase: 'cold', activity: 'shopping', currentRegion: 'Giran',
    loc: { locX: 83396, locY: 147904, locZ: -3400 },
    stats: { classId: 57 }, inventory: {}, vitals: { mp: 1000 },
    skills: [{ selfId: 248, level: 2 }] };
const dRecipeItem = { selfId: 1804, name: 'Recipe: Soulshot: D-Grade', amount: 1 };
assert.strictEqual(ItemDisposition.canLearnRecipe(dwarf, dRecipeItem), true,
    'a high-level crafter should still learn a D-grade shot recipe');
assert.strictEqual(ItemDisposition.isNpcOnlyItem(dRecipeItem), false,
    'shot recipes must be offered to other crafters before NPC liquidation');
const dRecipeSeller = { characterId: 101, level: 40, classId: 28,
    stats: { classId: 28 }, inventory: { 1804: { ...dRecipeItem, kind: 'Other.Recipe' } } };
const dRecipeListing = ItemDisposition.saleCandidates(dRecipeSeller, { unlimited: true })
    .find((item) => item.selfId === 1804);
assert.strictEqual(dRecipeListing?.rank, 'd', 'D-grade shot recipes must follow the D market');
assert.strictEqual(MarketTownPolicy.targetTownForItems(dRecipeSeller, [dRecipeListing]),
    MarketTownPolicy.dGradeMarketFor(dRecipeSeller));
assert.strictEqual(MarketTownPolicy.targetTownForItems(dRecipeSeller, [{ selfId: 1804 }]),
    MarketTownPolicy.dGradeMarketFor(dRecipeSeller),
    'a restored AFK recipe line must retain the grade of its product');
assert.strictEqual(MarketTownPolicy.targetTownForItems(dRecipeSeller, [{ selfId: 1805 }]), 'Giran');


// A shot lot and a shot recipe are the market's like any item (group E):
// no floor to match, no demand count to fill; the expected value decides.
const shotLot = { selfId: 1463, name: 'Soulshot: D-grade', kind: 'Other.Shot',
    count: 10000, price: 90, basePrice: 10 };
assert.strictEqual(MarketListingPolicy.classify(dwarf, shotLot).action, 'market');
assert.strictEqual(MarketListingPolicy.listingPrice, undefined, 'no listing floor');
const recipeSeller = { characterId: 201, name: 'LootSeller', level: 50, classId: 28,
    adena: 100000, stats: {}, inventory: { '1805': {
        selfId: 1805, name: 'Recipe: Soulshot: C-Grade', amount: 1, kind: 'Other.Recipe'
    } } };
const recipeItem = ItemDisposition.saleCandidates(recipeSeller, { unlimited: true })
    .find((item) => item.selfId === 1805);
assert(recipeItem, 'a non-crafter holding a shot recipe should be able to sell it');
assert.strictEqual(recipeItem.rank, 'c', 'C-grade shot recipes belong in Giran');
assert.strictEqual(MarketListingPolicy.classify(recipeSeller, recipeItem).action, 'market');

const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const originalHotOffers = MarketOpportunity.hotOffers;
try {
    MarketOpportunity.hotOffers = () => [{ sourceType: 'afk_bot_store', sourceId: 500,
        projection: { actor: { fetchId: () => 900500, fetchLocX: () => 1,
            fetchLocY: () => 2, fetchLocZ: () => 3 } } }];
    const actor = { fetchId: () => 1 };
    const target = ShotStock.restockTarget(actor, 'Giran');
    assert.strictEqual(target.actorId, 900500);
    assert.strictEqual(target.sourceId, 500);
    assert.strictEqual(ShotStock.restockTarget(actor, 'Giran', [target.sourceId]), null,
        'an unreachable AFK projection must be excluded by its shop owner identity');
} finally { MarketOpportunity.hotOffers = originalHotOffers; }
const ownSupply = { ...dwarf, inventory: { '129': {
    selfId: 129, amount: 1, equipped: true, slot: 7
}, '1463': { selfId: 1463, amount: ShotStock.PURCHASE_TARGET_AMOUNT + 156, kind: 'Other.Shot' } } };
const ownShotTarget = invoke('GameServer/Bot/Economy/EconomyContext').basics(ownSupply).stock('shots').target;
ownSupply.inventory['1463'].amount = ownShotTarget + 156;
assert.strictEqual(ItemDisposition.saleCandidates(ownSupply, { unlimited: true })
    .find((item) => item.selfId === 1463)?.count, 156,
    'a shot seller must keep enough stock for their own weapon: what its restock fills it to');

useRate(previousRate);

console.log('Shot economy pricing, recipe and demand checks passed');
