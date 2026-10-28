'use strict';
// A recipe as capital (T75), through the real worker decisions and the main
// executor (only the database is isolated): the census counts D-level wearers
// who will need Brigandine Helmet; a dwarf whose Create Item covers its level-3
// recipe, who does not know it, holds the inputs and sees the scroll listed
// at 5300, buys the scroll; holding it, its craft step carries the scroll and
// main learns the recipe and crafts. Many more scroll rows are admitted, and
// the best bound among them has no exit within the horizon: the scroll slot
// goes to the best row its exits price, a listed scroll read apart from the
// ones only a bid brings (WishProviders producer block). A scroll dearer than
// one lot nets is still bought while the recipe's shared worth (the census's
// unmet G crafts x margin, DemandPrice) covers it, and not once the board
// covers the census's G (CraftProfitPolicy.learning: no per-crafter value).
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('recipe-scroll-capital');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
Data.init();
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
const Demand = invoke('GameServer/Bot/Economy/MarketDemand');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Census = require('./helpers/dLevelCensus');
const Codec = require('../src/GameServer/Bot/Economy/RecipeBookCodec');
const Eligibility = require('../src/GameServer/Bot/Economy/CraftEligibility');
const Shots = require('../src/GameServer/Bot/Economy/ShotCraftPolicy');
const Commit = require('../src/GameServer/Bot/Economy/EconomyCommit');
const { rowOf } = require('../src/GameServer/AfkTrade/BoardIndex');
const Native = require('./helpers/nativeMarketFixture');
const Wealth = invoke('GameServer/Bot/Economy/ColdWealthCraftService');
const Workshops = invoke('GameServer/Bot/Economy/CraftWorkshopService');
const probe = require('./helpers/workerEconomyDecision');

const GIRAN = { locX: 83396, locY: 147904, locZ: -3400 };
const CRAFTER = 940002;
// Brigandine Helmet (R6a: scroll 5300 on the board, no crafter knew it).
const recipe = Recipes.resolveByRecipeId(266);
const G = Number(recipe.productId), SCROLL = Number(recipe.recipeItemId);
// The scroll and D crystals on Giran's board (the crafter's own crystals may
// serve its other goals); no bid for G: the forecast is the only signal.
let line = 940100;
const board = [];
function ask(selfId, price, count) {
    const key = line++;
    board.push([key, rowOf({ id: key, ownerId: key + 100, storeType: 1, kind: 'shop', status: 'active',
        town: 'Giran', revision: 1, lines: [{ id: key * 10, selfId, count, price, enchant: 0 }] })]);
}
ask(SCROLL, 5300, 1);
ask(1458, 372, 200);
const setPrice = (at, price) => { board[at][1] = rowOf({ id: board[at][0], ownerId: board[at][0] + 100, storeType: 1, kind: 'shop',
    status: 'active', town: 'Giran', revision: 2, lines: [{ id: board[at][0] * 10, selfId: SCROLL, count: 1, price, enchant: 0 }] }); };
Census.start();
const pages = () => [{ tables: [{ name: 'board', from: null, to: 0, full: true, rows: board, removed: [], last: true },
    { name: 'market', from: null, to: 0, full: true, rows: Census.rows(), removed: [], last: true }] }];
const empty = { recipeBook: Codec.pack([]) };

async function run() {
    assert.equal(recipe.level, 3, 'a level-3 recipe');
    assert(Demand.censusOf(G) > 0, 'the census wants G');
    // A level-34 Artisan in Giran (Create Item 3) holding G's inputs; its
    // hour is its own hunt's (the worker's statsPacket).
    const materials = Object.fromEntries(recipe.materials.map(row => [row.selfId, { selfId: row.selfId, amount: row.amount }]));
    const crafter = { characterId: CRAFTER, accountName: `bot_scroll_${CRAFTER}`, name: 'ScrollSmith', phase: 'cold',
        activity: 'shopping', currentRegion: 'Giran', homeRegion: 'Giran', level: 34, adena: 600000,
        vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 }, inventory: materials, updatedAt: Date.now(), timing: {},
        loc: { ...GIRAN }, stats: { classId: 56 } };
    crafter.persona = BotPersona.generate(crafter);
    crafter.stats = { ...crafter.stats, ...(await probe(crafter, { tablePages: pages() })).statsPacket };
    assert.equal(Eligibility.craftLevelFor(crafter), 3, 'Create Item 3 covers the recipe');

    // Hop 1: the worker's step buys the listed scroll for G's resale root.
    const bought = await probe(crafter, { tablePages: pages(), recipes: empty });
    const root = bought.queue.find(row => row.key === `resale:${G}`);
    assert(root?.funded, `the resale root of G is funded (queue ${JSON.stringify(bought.queue.map(row => [row.key, row.funded]))})`);
    assert.equal(bought.activity?.kind, 'buy', `the step is a buy (${JSON.stringify(bought.activity)})`);
    assert.equal(Number(bought.activity.itemId), SCROLL, 'it buys the scroll');
    assert.equal(bought.activity.price, 5300, 'at its listed price');

    // Hop 1b: the scroll at 200000, far over the lot's net (~38k): the
    // recipe's worth (its unmet crafts) keeps the root, the scroll is bought.
    setPrice(0, 200000);
    const dear = await probe(crafter, { tablePages: pages(), recipes: empty });
    assert.equal(dear.activity?.kind, 'buy', `a dear scroll worth its recipe is bought (${JSON.stringify(dear.activity)})`);
    assert.equal(Number(dear.activity.itemId), SCROLL, 'the dear scroll is the step');
    // Hop 1c: G listed past the census's need at about the crafter's own
    // sale price: nothing unmet, the recipe is worth 0 and one lot cannot pay
    // the scroll.
    ask(G, 87000, Math.ceil(Demand.neededGear().get(G)) + 1);
    const covered = await probe(crafter, { tablePages: pages(), recipes: empty });
    assert(!(covered.activity?.kind === 'buy' && Number(covered.activity.itemId) === SCROLL),
        `no worth, no dear scroll (${JSON.stringify(covered.activity)})`);
    board.pop();
    setPrice(0, 5300);

    // Hop 2: holding the scroll, the craft step carries it; main learns the
    // recipe before it crafts G.
    Database.init();
    await Native.character(Database, CRAFTER, crafter.name, crafter.accountName);
    await Database.execute(['UPDATE characters SET level=34,classId=56,race=4 WHERE id=?', [CRAFTER]]);
    await Database.setSkill({ selfId: 172, name: 'Create Item', level: 3 }, CRAFTER);
    await Database.setItem(CRAFTER, { selfId: 57, name: 'Adena', amount: crafter.adena - 5300 });
    await Database.setItem(CRAFTER, { selfId: SCROLL, name: 'Recipe', amount: 1 });
    for (const row of recipe.materials) await Database.setItem(CRAFTER, { selfId: row.selfId, name: 'Material', amount: row.amount });
    await Life.upsertState({ ...crafter, exp: 0, sp: 0, inventory: Life.inventorySummaryFromItems(await Database.fetchItems(CRAFTER)),
        simulation: { revision: 0 } }, 'recipe_scroll_fixture');
    const holder = { ...crafter, inventory: Life.cachedState(CRAFTER).inventory };
    const step = Shots.unpackStep(Shots.packStep((await probe(holder, { recipeEarning: true, refreshEconomy: true,
        tablePages: pages(), recipes: empty })).selected));
    assert.equal(step?.wealth?.recipeId, recipe.recipeId, `the worker crafts G with the held scroll (step ${JSON.stringify(step)})`);
    assert.deepEqual(step.wealth.scroll, [SCROLL], 'the step carries the scroll to learn');
    const smith = Life.cachedState(CRAFTER);
    const opportunity = Wealth.recheck(smith, step.wealth, await Workshops.knownFor(CRAFTER));
    assert(opportunity, 'main rechecks the craft');
    const random = Math.random;
    // The craft roll is dice, not the chain: it succeeds here.
    Math.random = () => 0;
    try { await Wealth.execute(smith, opportunity); }
    finally { Math.random = random; }
    const known = (await Database.fetchCharacterRecipes(CRAFTER)).map(row => Number(row.recipeId));
    assert(known.includes(recipe.recipeId), `main learns the recipe (${JSON.stringify(known)})`);
    const bag = await Database.fetchItems(CRAFTER);
    assert.equal(Native.amount(bag, SCROLL), 0, 'the scroll is spent');
    assert.equal(Native.amount(bag, G), 1, 'G is crafted');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    Census.stop();
    Commit.clear();
    await Database.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
});
