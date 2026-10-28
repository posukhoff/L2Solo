'use strict';
// The gear chain from the supply side (docs/market-picture.md, user 10-27),
// through the real worker decisions and the main executor (only the database
// is isolated): the census counts D-level wearers who will need gear G; a
// dwarf who knows G's recipe and holds its inputs, with no bid for G on the
// board and its hour from its own hunt, picks G by the forecast, crafts it and
// lists it. Each hop asserts what a player would see (a bag item, a listing).
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('gear-chain');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
Data.init();
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
const Demand = invoke('GameServer/Bot/Economy/MarketDemand');
const Census = require('./helpers/dLevelCensus');
const Catalog = require('../src/GameServer/Bot/Economy/RecipeProductionIndex');
const Eligibility = require('../src/GameServer/Bot/Economy/CraftEligibility');
const Codec = require('../src/GameServer/Bot/Economy/RecipeBookCodec');
const Shots = require('../src/GameServer/Bot/Economy/ShotCraftPolicy');
const Commit = require('../src/GameServer/Bot/Economy/EconomyCommit');
const Native = require('./helpers/nativeMarketFixture');
const Wealth = invoke('GameServer/Bot/Economy/ColdWealthCraftService');
const Workshops = invoke('GameServer/Bot/Economy/CraftWorkshopService');
const probe = require('./helpers/workerEconomyDecision');

const GIRAN = { locX: 83396, locY: 147904, locZ: -3400 };
const CRAFTER = 920002;
// No bid and no ask on the board: the forecast is the crafter's only signal.
const board = [];
// The census of a world at D, the worker's 'market' table.
Census.start();
const pages = () => [{ tables: [{ name: 'board', from: null, to: 0, full: true, rows: board, removed: [], last: true },
    { name: 'market', from: null, to: 0, full: true, rows: Census.rows(), removed: [], last: true }] }];
const market = (recipes) => ({ recipeEarning: true, refreshEconomy: true, tablePages: pages(), recipes });

const red = [];
function hop(ok, message) { if (ok) return true; red.push(message); console.log(`RED ${message}`); return false; }

async function run() {
    // A level-40 Warsmith in Giran with 3M; its money packet is its own
    // hunt's (the worker's statsPacket), not a fixed hour.
    const crafter = { characterId: CRAFTER, accountName: `bot_chain_${CRAFTER}`, name: 'ChainSmith', phase: 'cold',
        activity: 'shopping', currentRegion: 'Giran', homeRegion: 'Giran', level: 40, adena: 3000000,
        vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 }, inventory: {}, updatedAt: Date.now(), timing: {},
        loc: { ...GIRAN }, stats: { classId: 57 } };
    crafter.persona = BotPersona.generate(crafter);
    crafter.stats = { ...crafter.stats, ...(await probe(crafter, { tablePages: pages() })).statsPacket };
    const hour = Number(crafter.stats.money?.[0]);
    assert(hour > 1000, `the crafter's hour comes from its hunt (${hour})`);
    // G: a sure D-grade piece (recipe level 4 at most) of the census's wished
    // kits the crafter's craft level makes.
    const level = Eligibility.craftLevelFor(crafter);
    const recipe = Catalog.recipeCatalog().rows.find(row => row.level <= Math.min(4, level) && Number(row.successRate) === 100
        && Number(row.productCount) === 1 && Demand.censusOf(row.productId) > 0);
    assert(recipe, `a D piece the census wants and a craft level ${level} makes`);
    const G = Number(recipe.productId);
    console.log(`G ${G} recipe ${recipe.recipeId} (level ${recipe.level}), forecast ${Demand.censusOf(G).toFixed(3)}/h, hour ${hour}`);

    // Hop 1: the crafter knows the recipe and holds its inputs; its market
    // step's craft step crafts G for a listing (exit [-2, town, price, rev]).
    Database.init();
    await Native.character(Database, CRAFTER, crafter.name, crafter.accountName);
    await Database.execute(['UPDATE characters SET level=40,classId=57,race=4 WHERE id=?', [CRAFTER]]);
    await Database.setSkill({ selfId: 172, name: 'Create Item', level }, CRAFTER);
    await Database.setItem(CRAFTER, { selfId: 57, name: 'Adena', amount: crafter.adena });
    for (const row of recipe.materials) await Database.setItem(CRAFTER, { selfId: row.selfId, name: 'Material', amount: row.amount });
    await Database.setCharacterRecipe(CRAFTER, recipe.recipeId, 'dwarven');
    await Life.upsertState({ ...crafter, exp: 0, sp: 0, inventory: Life.inventorySummaryFromItems(await Database.fetchItems(CRAFTER)),
        simulation: { revision: 0 } }, 'gear_chain_fixture');
    const book = { recipeBook: Codec.pack([recipe.recipeId]) };
    const stocked = { ...crafter, inventory: Life.cachedState(CRAFTER).inventory };
    const step = Shots.unpackStep(Shots.packStep((await probe(stocked, market(book))).selected));
    const exit = step?.wealth?.exit;
    hop(step?.wealth?.recipeId === recipe.recipeId && Array.isArray(exit) && Number(exit[0]) === -2,
        `hop 1: the worker crafts G for a listing without a bid (step ${JSON.stringify(step)})`)
        && console.log('hop 1 PASS: craft step', JSON.stringify(step.wealth));

    // Hop 2: main rechecks the step and crafts G; a listing craft keeps G in
    // the bag for the bot's own listing.
    if (!red.length) {
        const smith = Life.cachedState(CRAFTER);
        const opportunity = Wealth.recheck(smith, step.wealth, await Workshops.knownFor(CRAFTER));
        let done = null;
        const random = Math.random;
        // The craft roll is dice, not the chain: it succeeds here.
        Math.random = () => 0;
        try { done = opportunity && await Wealth.execute(smith, opportunity); }
        finally { Math.random = random; }
        const bag = await Database.fetchItems(CRAFTER);
        hop(Native.amount(bag, G) === 1, `hop 2: G is in the crafter's bag (opportunity ${JSON.stringify(opportunity?.exit)}, result ${JSON.stringify(done && { ...done, state: undefined })})`)
            && console.log('hop 2 PASS: G crafted');
    }

    // Hop 3: the crafter's next market step lists G on the board.
    if (!red.length) {
        const holding = { ...Life.cachedState(CRAFTER), inventory: Life.inventorySummaryFromItems(await Database.fetchItems(CRAFTER)) };
        const plan = (await probe(holding, market(book))).economyPlan;
        const listed = JSON.stringify(plan?.sell || null);
        hop(new RegExp(`\\b${G}\\b`).test(listed), `hop 3: the crafter lists G (plan ${JSON.stringify(plan)})`)
            && console.log('hop 3 PASS: listing', listed);
    }
    assert.deepEqual(red, [], 'every hop of the chain passes');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    Census.stop();
    Commit.clear();
    await Database.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
});
