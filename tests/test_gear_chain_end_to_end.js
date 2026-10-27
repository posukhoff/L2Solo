'use strict';
// The gear chain end to end, through the real worker decisions and the main
// executors (only the database is isolated): a buyer needs gear G and bids for
// it; a dwarf crafter who knows no recipe for G bids for G's recipe scroll,
// learns it, holds the inputs, crafts G and sells it; the buyer equips G.
// Each hop asserts what a player would see (a board line, a bag item, a
// recipe in the book, a worn piece).
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('gear-chain');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
Data.init();
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
const Codec = require('../src/GameServer/Bot/Economy/RecipeBookCodec');
const TradeIntent = require('../src/GameServer/Bot/Economy/TradeIntent');
const Shots = require('../src/GameServer/Bot/Economy/ShotCraftPolicy');
const Commit = require('../src/GameServer/Bot/Economy/EconomyCommit');
const { rowOf } = require('../src/GameServer/AfkTrade/BoardIndex');
const Native = require('./helpers/nativeMarketFixture');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Routes = require('../src/GameServer/Bot/Travel/TravelRoutes');
const World = invoke('GameServer/World/World');
const npcIndex = require('../src/GameServer/World/NpcObjectIndex');
const Meetings = invoke('GameServer/AfkTrade/TradeMeetingService');
const Channel = require('../src/GameServer/Bot/Population/ColdTableChannel').shared;
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Wealth = invoke('GameServer/Bot/Economy/ColdWealthCraftService');
const Workshops = invoke('GameServer/Bot/Economy/CraftWorkshopService');
const probe = require('./helpers/workerEconomyDecision');
const gearFixture = require('./fixtures/gear_purchase_state.json');

const BUY = 3, SELL = 1, GIRAN = { locX: 83396, locY: 147904, locZ: -3400 };
const BUYER = 920001, CRAFTER = 920002, SELLER = 920003;
// A buy store row as the worker plan carries it: an encoded intent or [selfId, count, price].
const decode = row => Array.isArray(row) && row.length === 3 && row.every(Number.isFinite)
    ? { itemId: row[0], amount: row[1], price: row[2] } : TradeIntent.decode(row);
let boardId = 921000;
const board = [];
function line(ownerId, storeType, selfId, count, price, id = boardId++) {
    return [id, rowOf({ id, ownerId, storeType, kind: storeType === BUY ? 'buy_ad' : 'shop', status: 'active',
        town: 'Giran', revision: 1, lines: [{ id: id * 10, selfId, count, price, enchant: 0 }] })];
}
const pages = () => [{ tables: [{ name: 'board', from: null, to: 0, full: true, rows: board, removed: [], last: true },
    { name: 'market', from: null, to: 0, full: true, rows: [], removed: [], last: true }] }];
const bot = (characterId, name, classId, level, adena, extra = {}) => ({ characterId, accountName: `bot_chain_${characterId}`,
    name, phase: 'cold', activity: 'shopping', currentRegion: 'Giran', homeRegion: 'Giran', level, adena,
    vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 }, inventory: {}, updatedAt: Date.now(), timing: {},
    loc: { ...GIRAN }, stats: { classId }, ...extra });

// A far bot's market step: the worker's economy refresh (the build and its
// economy plan: buy lines, listings), as a cold bot's turn asks it.
// A red hop is recorded and the chain goes on with what a player would do
// next (the seller's price), so one run names every gap; the file fails at
// the end with all of them.
const red = [];
function hop(ok, message) { if (ok) return true; red.push(message); console.log(`RED ${message}`); return false; }
const market = (tablePages, recipes = null) => ({ recipeEarning: true, refreshEconomy: true, tablePages, recipes });

async function run() {
    // Hop 1: the buyer A (a live level 53 Plains Walker whose kit wants the
    // C grade dagger 233, with money) is at the Giran market; its market
    // step bids for the piece on the board (no NPC sells it).
    const offset = Date.now() - gearFixture.timestamp;
    const shift = value => typeof value === 'number' && value > 1700000000000 && value < 2000000000000
        ? value + offset : Array.isArray(value) ? value.map(shift)
            : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, shift(child)])) : value;
    const buyer = { ...shift(gearFixture.state), characterId: BUYER, activity: 'shopping', currentRegion: 'Giran', loc: { ...GIRAN } };
    // T43 table: its level-39 field 13_37 pays 1.5k adena/h, which prices every bid under the NPC buy-back
    // floor; it hunts the level-53 field 13_42 (153k/h) with the D soulshots that hunt burns in stock.
    buyer.spotId = '13_42';
    buyer.inventory[1463] = { ...buyer.inventory[1463], amount: 3000 };
    // Its live money packet is the old table's (96930 adena/h): main holds the one its worker publishes now.
    buyer.stats = { ...buyer.stats, ...(await probe(buyer, { tablePages: pages() })).statsPacket };
    const buyerNative = await probe(buyer, market(pages()));
    const bids = (buyerNative.economyPlan?.buyAds || []).filter(Boolean).map(decode);
    const gearBid = bids.find(row => Recipes.resolveByProductId(Number(row.itemId))?.type === 'dwarven');
    assert(gearBid, `hop 1: the buyer bids for a piece a dwarf crafts (bids ${JSON.stringify(bids)})`);
    const G = Number(gearBid.itemId), recipe = Recipes.resolveByProductId(G);
    board.push(line(BUYER, BUY, G, 1, gearBid.price));
    console.log(`hop 1 PASS: buyer bids ${gearBid.price} for gear ${G} (recipe ${recipe.recipeId}, scroll ${recipe.recipeItemId})`);

    // Hop 2: the crafter B (a Warsmith who knows no recipe for G) bids for
    // G's recipe scroll; a seller offers the scroll and the inputs.
    board.push(line(SELLER, SELL, recipe.recipeItemId, 1, Math.max(1, Math.floor(gearBid.price / 20))));
    for (const row of recipe.materials) board.push(line(SELLER, SELL, row.selfId, row.amount * 4, 1));
    // T43 table: its hunt pays 63.5k adena/h (207k before), so with 1M its own unfunded weapon root is the
    // money gap above the craft for sale (game decision 10-23); with 3M its weapon is funded first.
    const crafter = bot(CRAFTER, 'ChainSmith', 57, 60, 3000000, {});
    crafter.stats.money = [1000, .001, 0, 0];
    crafter.persona = BotPersona.generate(crafter);
    const scrollPlan = (await probe(crafter, market(pages(),
        { recipeBook: Codec.pack([]) }))).economyPlan;
    const crafterBids = (scrollPlan?.buyAds || []).filter(Boolean).map(decode);
    const scrollBid = crafterBids.find(row => Number(row.itemId) === recipe.recipeItemId);
    const scrollPrice = scrollBid ? scrollBid.price : Math.max(1, Math.floor(gearBid.price / 20));
    if (hop(scrollBid, `hop 2: the crafter bids for G's recipe scroll (bids ${JSON.stringify(crafterBids)})`))
        console.log(`hop 2 PASS: crafter bids ${scrollBid.price} for scroll ${recipe.recipeItemId}`);

    // Hop 3: a seller fills the scroll bid; the crafter learns the recipe at
    // its visit through the native learn transaction.
    Database.init();
    await Native.character(Database, CRAFTER, crafter.name, crafter.accountName);
    await Database.execute(['UPDATE characters SET level=60,classId=57,race=4 WHERE id=?', [CRAFTER]]);
    await Database.setSkill({ selfId: 172, name: 'Create Item', level: 9 }, CRAFTER);
    await Database.setItem(CRAFTER, { selfId: 57, name: 'Adena', amount: crafter.adena - scrollPrice });
    await Database.setItem(CRAFTER, { selfId: recipe.recipeItemId, name: 'Recipe', amount: 1 });
    await Life.upsertState({ ...crafter, adena: crafter.adena - scrollPrice, exp: 0, sp: 0,
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(CRAFTER)), simulation: { revision: 0 } }, 'gear_chain_fixture');
    let smith = Life.acceptLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [CRAFTER]]))[0]);
    smith = await Life.learnCraftableRecipes(smith);
    assert((await Database.fetchCharacterRecipes(CRAFTER)).some(row => Number(row.recipeId) === recipe.recipeId),
        'hop 3: the crafter learned G\'s recipe');
    assert.equal(Native.amount(await Database.fetchItems(CRAFTER), recipe.recipeItemId), 0, 'hop 3: learning used the scroll');
    console.log(`hop 3 PASS: recipe ${recipe.recipeId} learned`);

    // Hop 4: the producer root for G (the buyer's bid is its exit) gets the
    // inputs. Listed inputs are bought, not bid for (R1): the market step's
    // craft step for G buys them at main (ColdWealthCraftService.execute);
    // unlisted ones get bids.
    board.splice(board.findIndex(([, row]) => row[2] === SELL), 1);
    const book = { recipeBook: Codec.pack([recipe.recipeId]) };
    const known = { ...crafter, adena: smith.adena, inventory: smith.inventory };
    const listedPlan = (await probe(known, market(pages(), book))).economyPlan;
    const listedStep = Shots.unpackStep(listedPlan?.shot);
    if (hop(listedStep?.wealth?.recipeId === recipe.recipeId,
        `hop 4a: inputs listed, the crafter's step crafts G buying them (plan ${JSON.stringify(listedPlan)})`))
        console.log('hop 4a PASS: listed inputs, craft step', JSON.stringify(listedStep.wealth));
    // The buyer's own bid for G stands: the crafter bids for the inputs
    // nobody sells at their share of it.
    const inputIds = recipe.materials.map(row => row.selfId);
    const unlisted = () => [{ tables: [{ ...pages()[0].tables[0], rows: board.filter(([, row]) => !(row[2] === SELL && inputIds.includes(Number(row[6][0]?.[1])))) },
        pages()[0].tables[1]] }];
    const inputPlan = (await probe(known, market(unlisted(), book))).economyPlan;
    const inputBids = (inputPlan?.buyAds || []).filter(Boolean).map(decode);
    if (hop(inputBids.some(row => inputIds.includes(Number(row.itemId))),
        `hop 4b: inputs unlisted, the crafter bids for them (bids ${JSON.stringify(inputBids)}, inputs ${inputIds}, plan ${JSON.stringify(inputPlan)})`))
        console.log('hop 4b PASS: input bids', JSON.stringify(inputBids.filter(row => inputIds.includes(Number(row.itemId)))));

    // Hop 5: the buyer's market step publishes its bid on the board from its
    // own adena (BotAfkMarketService.executePlan, the cold writer); the
    // crafter, holding the inputs, then sees that line and its worker selects
    // the craft of G with the line as its exit.
    await Native.character(Database, BUYER, 'ChainBuyer', 'bot_chain_920001');
    await Database.execute(['UPDATE characters SET level=?,exp=?,classId=? WHERE id=?', [buyer.level, buyer.exp, buyer.stats.classId, BUYER]]);
    await Database.setItem(BUYER, { selfId: 57, name: 'Adena', amount: buyer.adena });
    await Life.upsertState({ ...buyer, name: 'ChainBuyer', accountName: 'bot_chain_920001', phase: 'cold', sp: 0,
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(BUYER)), simulation: { revision: 0 } }, 'gear_chain_fixture');
    // The buy part of the buyer's own plan: its store rows (custody 0, the
    // leading buyStore rows) and meeting bids, with their caps and kit.
    const buyPlan = Object.fromEntries(['buyAds', 'buyStore', 'buyCaps', 'buyKit', 'buyTown']
        .filter(key => Object.hasOwn(buyerNative.economyPlan, key)).map(key => [key, buyerNative.economyPlan[key]]));
    await Market.executePlan(Life.cachedState(BUYER), buyPlan);
    const [ad] = (await Database.fetchAfkTradeShops(BUYER)).filter(record => record.lines?.some(row => Number(row.selfId) === G));
    assert(ad, 'hop 5: the buyer\'s bid for G stands on the board');
    board[0] = [ad.id, rowOf(ad)];
    for (const row of recipe.materials) await Database.setItem(CRAFTER, { selfId: row.selfId, name: 'Material', amount: row.amount });
    await Life.upsertState({ ...Life.cachedState(CRAFTER), inventory: Life.inventorySummaryFromItems(await Database.fetchItems(CRAFTER)) }, 'gear_chain_fixture');
    const stocked = { ...known, inventory: Life.cachedState(CRAFTER).inventory };
    const step = Shots.unpackStep(Shots.packStep((await probe(stocked, { recipeEarning: true, refreshEconomy: true,
        recipes: book, tablePages: pages() })).selected));
    if (hop(step?.wealth?.recipeId === recipe.recipeId, `hop 5: the crafter's worker selects the craft of G (step ${JSON.stringify(step)})`))
        console.log('hop 5 PASS: craft step', JSON.stringify(step.wealth));

    // Hop 6: main rechecks the step against the buyer's line, crafts G
    // (Database.craftInventoryItems) and, the crafter shopping in the buyer's
    // town, sells it into the line (AfkTrade.sellToShop). A meeting bid
    // (custody 1) sells through TradeMeetingService: each bot's consent is
    // its worker's meeting preparation, here the real worker (the helper's
    // meetingRequest) behind the coordinator's transport, its proof built as
    // ColdSimulationCoordinator.handleMeetingRequest builds it. The bid stands
    // in the town the buyer's worker priced it for (buyTown, its twin town);
    // the crafter shops there, at the line's place. The buyer walks from
    // Giran: its cold legs (continueColdTravel) are the gatekeeper hops of its
    // route to the point's town. The world holds the route's authored
    // gatekeepers (NpcObjectIndex); the database stays the only other part.
    console.log(`hop 6: the bid stands in ${ad.town}, custody ${ad.custodyPolicy}`);
    const point = { locX: ad.locX, locY: ad.locY, locZ: ad.locZ };
    const smith6 = await Life.upsertState({ ...Life.cachedState(CRAFTER), currentRegion: ad.town, loc: { ...point } }, 'gear_chain_fixture');
    const adenaBefore = Native.amount(await Database.fetchItems(CRAFTER), 57);
    const opportunity = step?.wealth ? Wealth.recheck(smith6, step.wealth, await Workshops.knownFor(CRAFTER)) : null;
    // The worker's tables are main's own board and market (the channel the
    // live coordinator feeds it), so its proof's dependencies are main's.
    const mainPages = () => Channel.pages(['board', 'market'].map(name => Channel.tables.get(name)).filter(Boolean)
        .map(table => Channel.full(table))).map(page => page.payload);
    const refused = [], prepare = Coordinator.requestMeetingPreparation;
    Coordinator.requestMeetingPreparation = async (id, request) => {
        const { request: result } = await probe(Life.cachedState(id), { meetingRequest: structuredClone(request), tablePages: mainPages() })
            .catch(error => { refused.push(`${id}: ${error.message}`); throw error; });
        const side = result.actorA === Number(id) ? 0 : 1, own = result.parties[side];
        return { token: result.token, characterId: Number(id), sequence: own.sequence,
            authority: { phase: own.phase, hotAt: own.hotAt, revision: own.revision },
            route: own.route, certificates: result.lines.map(row => row.payer === side ? row.certificate : null),
            dependencies: result.dependencies || [], sources: result.lines.map(row => [row.adId, row.adRevision]),
            epoch: Coordinator.workerEpoch, worker: Coordinator.worker, approved: true };
    };
    const oldNpc = World.npc;
    const keepers = (Routes.between(GIRAN, point).route?.steps || []).map(row => row.npcId);
    World.npc = { spawns: [...new Set(keepers)].map(selfId => {
        const loc = Data.npcSpawns.flatMap(zone => zone.spawns || []).find(spawn => spawn.selfId === selfId).coords[0];
        return { fetchId: () => selfId, fetchSelfId: () => selfId,
            fetchLocX: () => loc.locX, fetchLocY: () => loc.locY, fetchLocZ: () => loc.locZ };
    }) };
    npcIndex.reset(World); World.npc.spawns.forEach(npc => npcIndex.add(World, npc));
    await Meetings.init();
    // The meeting token seeds each side's consent roll (a random UUID live):
    // one fixed token keeps the run repeatable.
    const meetingTrade = Meetings.trade;
    Meetings.trade = (id, store, selfId, amount, options = {}) => meetingTrade(id, store, selfId, amount,
        { ...options, token: options.token || '00000000-0000-4000-8000-000000000006' });
    const settle = async (until, limitMs = 60000) => {
        for (const deadline = Date.now() + limitMs; Date.now() < deadline;) {
            const value = await until();
            if (value) return value;
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        return null;
    };
    try {
        if (hop(opportunity?.exit?.offer?.recordId === ad.id, `hop 6: main's recheck keeps the step with the buyer's line (exit ${JSON.stringify(opportunity?.exit)})`)) {
            let bagAfterCraft = null;
            const craft = Database.craftInventoryItems, random = Math.random;
            // The craft roll is dice, not the chain: it succeeds here.
            Math.random = () => 0;
            Database.craftInventoryItems = async (...args) => {
                const result = await craft.apply(Database, args);
                bagAfterCraft = await Database.fetchItems(CRAFTER);
                return result;
            };
            let done;
            try { done = await Wealth.execute(smith6, opportunity); }
            finally { Database.craftInventoryItems = craft; Math.random = random; }
            if (hop(bagAfterCraft && Native.amount(bagAfterCraft, G) === 1, `hop 6: G is in the crafter's bag after the craft (result ${JSON.stringify(done && { ...done, state: undefined })})`)) {
                // Both workers consent; the meeting is accepted, then each bot
                // travels its paid legs: the cold step that ends a leg commits
                // the bot at the leg's end (travel over), which wakes the meeting.
                const meeting = done.pending ? await settle(() => refused.length ? 'refused' : Database.fetchTradeMeetingForOwner(CRAFTER)) : null;
                const legs = [];
                const receipt = meeting?.token && await settle(async () => {
                    for (const id of [BUYER, CRAFTER]) {
                        const owned = Life.cachedState(id), travel = owned?.stats?.travel;
                        if (travel?.meetingId !== meeting.id) continue;
                        legs.push(`${id}:${travel.method}:${travel.to.locX}:${travel.to.locY}`);
                        await Life.upsertState({ ...owned, activity: 'shopping', currentRegion: travel.townName, loc: { ...travel.to },
                            stats: { ...owned.stats, travel: null } }, 'gear_chain_arrival');
                        Meetings.wake(id);
                    }
                    return Database.fetchTradeMeetingReceipt(meeting.token, CRAFTER);
                }, 20000);
                console.log(`hop 6: meeting legs ${JSON.stringify(legs)}`);
                const bag = await Database.fetchItems(CRAFTER);
                if (hop((done.sold === true || receipt?.outcome === 'completed') && Native.amount(bag, G) === 0 && Native.amount(bag, 57) > adenaBefore,
                    `hop 6: the crafter sold G into the buyer's line (result ${JSON.stringify({ ...done, state: undefined })}, refused ${JSON.stringify(refused)}, meeting ${JSON.stringify(meeting?.state ? { state: meeting.state, route: [meeting.routeA, meeting.routeB] } : meeting)}, receipt ${JSON.stringify(receipt)}, G ${Native.amount(bag, G)}, adena ${adenaBefore} -> ${Native.amount(bag, 57)})`))
                    console.log(`hop 6 PASS: crafted and sold G for ${Native.amount(bag, 57) - adenaBefore}`);
            }
        }
    } finally {
        Coordinator.requestMeetingPreparation = prepare;
        Meetings.trade = meetingTrade;
        World.npc = oldNpc;
        npcIndex.reset(World); oldNpc?.spawns?.forEach(npc => npcIndex.add(World, npc));
    }

    // Hop 7: the filled bid reaches the buyer's bag and its next resolve
    // (Life.applyResolve -> prepareResolve equipInventoryUpgrades) wears G.
    const buyerBag = await Database.fetchItems(BUYER);
    if (hop(Native.amount(buyerBag, G) === 1, `hop 7: G reached the buyer's bag (items ${JSON.stringify(buyerBag.map(row => [row.selfId, row.amount]))})`)) {
        await Life.applyResolve(Life.cachedState(BUYER), { patch: {} });
        const worn = (await Database.fetchItems(BUYER)).find(row => Number(row.selfId) === G);
        if (hop(Life.cachedState(BUYER)?.inventory?.[G]?.equipped === true && Number(worn?.equipped) === 1,
            `hop 7: the buyer wears G (summary ${JSON.stringify(Life.cachedState(BUYER)?.inventory?.[G])}, item ${JSON.stringify(worn)})`))
            console.log('hop 7 PASS: the buyer wears G');
    }
    assert.deepEqual(red, [], 'every hop of the chain passes');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    Meetings.reset();
    Commit.clear();
    await Database.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
});
