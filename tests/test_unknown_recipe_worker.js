'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Codec = require('../src/GameServer/Bot/Economy/RecipeBookCodec');
const { rowOf } = require('../src/GameServer/AfkTrade/BoardIndex');
const probe = require('./helpers/workerEconomyDecision');
const Market = invoke('GameServer/Bot/Economy/MarketCounters');
const Shots = require('../src/GameServer/Bot/Economy/ShotCraftPolicy');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
const { WishNetwork } = require('../src/GameServer/Bot/Economy/WishNetwork');
const recipe = Recipes.resolveByRecipeId(79);
const state = { characterId: 910001, accountName: 'bot_pop_recipe_test', name: 'RecipeSmith', phase: 'cold',
    activity: 'shopping', currentRegion: 'Giran', homeRegion: 'Giran', level: 60, adena: 1000000,
    vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 }, inventory: {}, updatedAt: Date.now(), timing: {},
    loc: { locX: 83396, locY: 147904, locZ: -3400 }, stats: { classId: 57, money: [1000, .001, 0, 0] } };
let id = 910100;
const records = [];
function record(selfId, side, price, count) {
    const key = id++;
    records.push([key, rowOf({ id: key, ownerId: key + 100, storeType: side, kind: 'shop', status: 'active',
        town: 'Giran', revision: 1, lines: [{ id: key * 10, selfId, count, price, enchant: 0 }] })]);
}
// No buyer line: the product's demand is its trades (MarketDemand), a gear
// bid is no producer signal (T74). The scroll and the inputs are on sale.
record(recipe.recipeItemId, 1, 10, 1);
for (const row of recipe.materials) record(row.selfId, 1, 1, row.amount);
const timestamp = Date.now();
Market.useSpots(() => SpotProfiles.ensure());
Market.reset();
// A plain (+0) deal, as AfkTradeService records it: a deal of an
// enchantable item with no enchant is no demand (MarketCounters.flowEnchant).
Market.deal(recipe.productId, 100000, 20, timestamp - 600000, 12, 'Giran', 13, 0);
Market.deal(recipe.productId, 100000, 20, timestamp - 300000, 14, 'Giran', 15, 0);
let marketRows;
Market.publish({ register: (_name, source) => { marketRows = source.allRows(); }, changed: () => {} });
const pages = rows => [{ tables: [{ name: 'board', from: null, to: 0, full: true, rows, removed: [], last: true },
    { name: 'market', from: null, to: 0, full: true, rows: marketRows.map(row => [row[0], row]), removed: [], last: true }] }];
state.persona = BotPersona.generate(state);
(async () => {
    // A recipe worth learning is the producer root's (WishProviders), not
    // this search's: an empty book with the scroll offered selects no craft.
    const result = await probe(state, { timestamp, recipeEarning: true, refreshEconomy: true, recipes: { recipeBook: Codec.pack([]) }, tablePages: pages(records) });
    assert(!result.selected?.wealth, 'the worker wealth search does not learn an offered recipe');
    const known = await probe(state, { timestamp, recipeEarning: true, refreshEconomy: true, recipes: { recipeBook: Codec.pack([recipe.recipeId]) }, tablePages: pages(records) });
    assert.equal(known.selected?.wealth?.recipeId, recipe.recipeId, 'full book is authoritative even with an empty public portfolio');
    assert(!known.selected.wealth.scroll, 'a known recipe buys no scroll');
    // A held free scroll of the unknown recipe: the craft is selected and
    // carries the scroll main learns before it (WealthCraftDecision.heldScroll).
    const holder = { ...state, inventory: { [recipe.recipeItemId]: { selfId: recipe.recipeItemId, amount: 1 } } };
    const held = Shots.unpackStep(Shots.packStep((await probe(holder, { timestamp, recipeEarning: true, refreshEconomy: true,
        recipes: { recipeBook: Codec.pack([]) }, tablePages: pages(records) })).selected));
    assert.equal(held?.wealth?.recipeId, recipe.recipeId, 'a held scroll lets the worker select its recipe\'s craft');
    assert.deepEqual(held.wealth.scroll, [recipe.recipeItemId], 'the step carries the held scroll to learn');
    // C8: the product's demand forecast (MarketDemand) is the exit: the
    // worker step keeps the listing [-2, town, price, revision] and the
    // value ratio main funds the inputs at.
    const listingPages = pages(records);
    const seller = state;
    const listed = Shots.unpackStep(Shots.packStep(
        (await probe(seller, { timestamp, recipeEarning: true, refreshEconomy: true, recipes: { recipeBook: Codec.pack([recipe.recipeId]) }, tablePages: listingPages })).selected));
    assert.equal(listed?.wealth?.recipeId, recipe.recipeId, 'a forecast with no buyer line selects the craft for sale');
    assert.equal(listed.wealth.exit[0], -2, 'the step keeps its listing exit');
    assert(listed.wealth.r > 0, 'the step carries the value ratio main funds the inputs at');
    // R3: inputs all in the bag cost no cash, so the producer root has no
    // money queue row; the crafter still crafts them for the listing.
    const stocked = { ...seller, inventory: Object.fromEntries(recipe.materials.map(row =>
        [row.selfId, { selfId: row.selfId, amount: row.amount * 50 }])) };
    const owned = (await probe(stocked, { timestamp, recipeEarning: true, refreshEconomy: true, recipes: { recipeBook: Codec.pack([recipe.recipeId]) }, tablePages: listingPages })).selected;
    assert.equal(owned?.wealth?.recipeId, recipe.recipeId, 'a crafter crafts owned inputs for sale');
    // The network's flow: a producer root whose recipe is still to learn has
    // one shopping leaf, its scroll; the input waits though a seller has it
    // (TradeIntent.scrollFirst). Each actor rolls its own choice of leaf.
    const scrollNodes = [
        { key: 'item:1000', object: 1000, price: 10, paths: [{ kind: 'buy', activity: 'shopping', price: 10, available: true, executable: true, availableUnits: 1 }] },
        { key: 'item:2000', object: 2000, price: 1, paths: [{ kind: 'buy', activity: 'shopping', price: 1, available: true, executable: true, availableUnits: 10 }] },
        { key: 'resale:3000', need: 'power', object: { itemId: 3000, kind: 'resale' }, valueHours: 100,
            paths: [{ kind: 'craft', activity: 'crafting', productCount: 1, recipeId: 77, requiresRecipeLearning: true,
                requirements: [{ key: 'item:1000', amount: 1, once: true }, { key: 'item:2000', amount: 2 }],
                grossRequirements: [{ key: 'item:1000', amount: 1, once: true }, { key: 'item:2000', amount: 2 }] }] }];
    for (const stockFor of [undefined, () => ({ owned: 0, incoming: 0 })]) for (let actor = 0; actor < 6; actor++) {
        const network = new WishNetwork().build({ actorKey: `scroll-first:${actor}`, inputKey: String(!!stockFor), nodes: scrollNodes,
            roots: ['resale:3000'], wallet: 100000, hourAdena: 100, persona: BotPersona.generate(state), remembered: false, stockFor });
        assert.equal(network.activity?.nodeKey, 'item:1000', 'an unknown recipe shops for its scroll, not its inputs');
        assert.equal(network.activity.recipeId, 77, 'the scroll leaf carries the recipe main learns');
    }
    console.log('PASS actual worker wealth search: known book or a held scroll, full book authoritative, listing exit from forecast, an unknown recipe shops for its scroll only until it holds it');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
