'use strict';
// A crafter at the C level (the luxury exchange open: its C kit's D supplier
// is Giran's NPC gear, crystallized) keeps the board's D crystals as a path
// of a craft that needs them (T74, live crafter 2000429): with crystals listed
// cheap and a buyer's line for the product, its craft for sale is rooted and
// buys the listed crystals, never plans to break NPC gear for every one.
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('producer-board-crystals');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
Data.init();
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
const Templates = require('../src/GameServer/Item/ItemTemplateIndex');
const Codec = require('../src/GameServer/Bot/Economy/RecipeBookCodec');
const ProductionIndex = require('../src/GameServer/Bot/Economy/RecipeProductionIndex');
const CraftShop = invoke('GameServer/Bot/Economy/CraftShopService');
const Crystals = require('../src/GameServer/Bot/Economy/BotCrystallization');
const { rowOf } = require('../src/GameServer/AfkTrade/BoardIndex');
const probe = require('./helpers/workerEconomyDecision');

const BUY = 3, SELL = 1, D_CRYSTAL = 1458, CRAFTER = 920004, SELLER = 920003, BUYER = 920001;
let boardId = 921000;
function line(ownerId, storeType, selfId, count, price, id = boardId++) {
    return [id, rowOf({ id, ownerId, storeType, kind: storeType === BUY ? 'buy_ad' : 'shop', status: 'active',
        town: 'Giran', revision: 1, lines: [{ id: id * 10, selfId, count, price, enchant: 0 }] })];
}
const pages = board => [{ tables: [{ name: 'board', from: null, to: 0, full: true, rows: board, removed: [], last: true },
    { name: 'market', from: null, to: 0, full: true, rows: [], removed: [], last: true }] }];

async function run() {
    const crafter = { characterId: CRAFTER, accountName: `bot_chain_${CRAFTER}`, name: 'ChainPrep', phase: 'cold',
        activity: 'shopping', currentRegion: 'Giran', homeRegion: 'Giran', level: 40, adena: 3000000,
        vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 }, inventory: {}, updatedAt: Date.now(), timing: {},
        loc: { locX: 83396, locY: 147904, locZ: -3400 }, stats: { classId: 57 } };
    // Its skills: Create Item at its level's craft level, Crystallize.
    crafter.skills = [{ selfId: 172, level: CraftShop.craftLevelFor(crafter) }, { selfId: 248, level: 1 }];
    assert(Crystals.canSelf(crafter, Crystals.CRYSTAL_RANKS.get(D_CRYSTAL)), 'the crafter breaks D gear itself');
    // A D piece of a recipe it crafts that takes D crystals, the one of the
    // best margin at market prices.
    const recipe = ProductionIndex.recipeCatalog().rows
        .filter(row => Templates.find(Data.items, Number(row.productId))?.etc?.rank === 'd' && !(Number(row.successRate ?? 100) < 100)
            && CraftShop.canCraft(crafter, row) && row.materials.some(input => Number(input.selfId) === D_CRYSTAL))
        .sort((a, b) => ProductionIndex.marketFacts(b).margin - ProductionIndex.marketFacts(a).margin || a.recipeId - b.recipeId)[0];
    assert(recipe, 'a D recipe of a level 40 dwarf takes D crystals');
    const product = Number(recipe.productId), crystals = recipe.materials.find(input => Number(input.selfId) === D_CRYSTAL).amount;
    for (const row of recipe.materials) if (Number(row.selfId) !== D_CRYSTAL) crafter.inventory[row.selfId] = { selfId: row.selfId, amount: row.amount };
    // The crystals sell on the board at a fraction of an NPC piece's yield;
    // a buyer's line pays the product's inputs at market prices three times.
    const board = [line(SELLER, SELL, D_CRYSTAL, crystals * 4, 40),
        line(BUYER, BUY, product, 1, Math.ceil(3 * ProductionIndex.marketFacts(recipe).inputCost))];
    crafter.persona = BotPersona.generate(crafter);
    const recipes = { recipeBook: Codec.pack([recipe.recipeId]) };
    crafter.stats = { ...crafter.stats, ...(await probe(crafter, { tablePages: pages(board), recipes })).statsPacket };
    const result = await probe(crafter, { tablePages: pages(board), recipes });
    const queue = result.queue.map(row => [row.key, Math.round(row.price)]);
    const root = result.queue.find(row => row.key === `resale:${product}`);
    assert(root, `the craft for sale of ${product} (recipe ${recipe.recipeId}) is rooted (queue ${JSON.stringify(queue)})`);
    // Its price is the inputs it buys: the listed crystals, not NPC gear for each.
    assert(root.price < ProductionIndex.marketFacts(recipe).inputCost + crystals * 40 + 1,
        `the root buys the listed crystals (price ${root.price}, crystals ${crystals} x 40, queue ${JSON.stringify(queue)})`);
    console.log(`PASS: resale:${product} rooted at ${Math.round(root.price)} with ${crystals} board crystals`);
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
});
