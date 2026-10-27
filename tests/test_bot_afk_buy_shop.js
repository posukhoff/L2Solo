'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('bot-afk-buy-shop');
require('../src/Global');
fixture.assertConfigured(options.default);
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Places = invoke('GameServer/Bot/Economy/ShopPlaces');
const Native = require('./helpers/nativeMarketFixture');
const Plan = require('../src/GameServer/Bot/Population/ColdEconomyPlan');
const Decision = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
const Ready = require('../src/GameServer/Bot/Economy/ReadyTradeChoice');
const BuyAds = require('../src/GameServer/Bot/Economy/BuyAdPolicy');
const Town = require('../src/GameServer/Bot/Economy/MarketTownPolicy');
const Twin = require('../src/GameServer/Bot/Economy/TwinCluster');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const Recipes = require('../src/GameServer/Items/C4RecipeItems');
const nativeDecision = require('./helpers/workerEconomyDecision');
const POINT = { locX: 83000, locY: 148000, locZ: -3400 };
const REQUESTS = [1464, 1864, 1865, 1866, 1867, 1868, 1869, 1870].map((id, at) => [id, at ? 2 : 1, (at + 1) * 100]);
const cost = rows => rows.reduce((sum, row) => sum + row[1] * row[2], 0);
const wallet = async id => Native.amount(await DB.fetchItems(id), 57);
const records = id => Afk.ownerRecords(id).filter(row => row.kind === 'buy_ad');
const store = id => records(id).filter(row => row.custodyPolicy === 0);
const meetings = id => records(id).filter(row => row.custodyPolicy === 1);
const CRAFTER = { twin: { workshop: [{ recipeId: 1 }] } };

// The worker's side: a producer's recipe inputs lead as its escrow store.
// `inputs` are [itemId, count, price] rows that are crafting inputs, `others`
// plain wishes; the packet is what the worker sends to executePlan, priced
// for the bot's town (ColdEconomyPlan townFor: its twin's, else the grade
// town); townless: a packet without that town.
function workerPlan(id, inputs, others = [], { townless = false } = {}) {
    const lines = [...inputs.map(([selfId, count, price]) => ({ selfId, count, price,
        intent: { itemId: selfId, amount: count, price, key: `power:${selfId}:7`, recipeId: 1, valueHours: 100, valueRate: 1 } })),
    ...others.map(([selfId, count, price]) => ({ selfId, count, price }))];
    const split = BuyAds.storeLines(Life.snapshot(id), lines, Market.buyOrderEscrow(id));
    return Plan.buyBatch(split, townless ? null : Town.buyAdTown(Life.snapshot(id), split));
}
const apply = (id, plan) => Market.executePlan(Life.snapshot(id), plan, { reviewGoal: false });

async function bot(id, stats = {}, loc = POINT) {
    await Native.character(DB, id, `Buyer${id}`, `bot_buy_shop_${id}`, loc);
    await DB.setItem(id, { selfId: 57, name: 'Adena', amount: 1000000, slot: 0 });
    return Life.upsertState({ characterId: id, accountName: `bot_buy_shop_${id}`, name: `Buyer${id}`,
        phase: 'cold', activity: 'shopping', level: 45, adena: 1000000, inventory: Life.inventorySummaryFromItems(await DB.fetchItems(id)),
        currentRegion: 'Giran', loc, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        stats: { generatedCold: true, money: [36000, 0, 0, 0], ...stats }, timing: {} }, 'buy_shop_fixture');
}

async function crafterPlansEscrowStore() {
    await bot(9101, CRAFTER);
    await apply(9101, workerPlan(9101, REQUESTS.slice(0, 5), REQUESTS.slice(5)));
    assert.equal(store(9101).length, 3, 'a crafter opens at most three escrow buy records');
    assert.deepEqual(store(9101).map(row => row.lines[0].selfId), REQUESTS.slice(0, 3).map(row => row[0]));
    assert.equal(meetings(9101).length, 5, 'the remaining wishes stay meeting bids');
    assert.equal(await wallet(9101), 1000000 - cost(REQUESTS.slice(0, 3)), 'the store escrow leaves the wallet');
    assert.equal(Market.buyOrderEscrow(9101), cost(REQUESTS.slice(0, 3)));
    const before = store(9101).map(row => [row.id, row.revision]);
    await apply(9101, workerPlan(9101, REQUESTS.slice(0, 5), REQUESTS.slice(5)));
    assert.equal(await wallet(9101) + Market.buyOrderEscrow(9101), 1000000, 'repeated publication cannot reserve twice');
    assert.deepEqual(store(9101).map(row => [row.id, row.revision]), before, 'an unchanged order rewrites nothing');

    await bot(9102);
    await apply(9102, workerPlan(9102, REQUESTS.slice(0, 3), REQUESTS.slice(3, 5)));
    assert.equal(store(9102).length, 0, 'a bot that is no producer holds no escrow');
    assert.equal(await wallet(9102), 1000000);
    console.log('PASS crafter plan: custody-0 store capped at 3, meetings stay custody 1');
}

async function sellerFillMovesEscrow() {
    await bot(9110, CRAFTER);
    await apply(9110, workerPlan(9110, [[1464, 1, 100], [1864, 5, 100000]]));
    assert.equal(store(9110).length, 2);
    await Life.upsertState({ ...Life.snapshot(9110), activity: 'hunting' }, 'buy_shop_hunt');
    await bot(9111);
    await DB.setItem(9111, { selfId: 1864, name: 'Stem', amount: 12, slot: 0 });
    const refreshed = await Life.refreshInventory(Life.snapshot(9111));
    const seller = await Life.upsertState({ ...refreshed,
        stats: { ...refreshed.stats, money: [36000, 1 / 36000, 0, 0] } }, 'buy_shop_seller_money');
    const economy = { ...Decision.economyFor(seller), network: { activity: null } };
    const plan = Plan.decide(seller, economy, { board: Afk.boardIndex(), now: Date.now(),
        decisionPoint: 'autonomous_buy_store_sale', npcOffersFor: () => [], findSpot: () => null });
    const ad = store(9110).find(row => row.lines[0].selfId === 1864);
    assert.equal(plan.take?.[0], Afk.BUY, 'the native seller decision fills the escrow buy record');
    assert.equal(plan.take[3], ad.id);
    assert.equal(plan.take[2], 5);
    const line = Afk.boardIndex().records.get(ad.id).find(row => row.lineId === plan.take[4]);
    assert.equal(Ready.sale([{ line, count: 5 }], { ...seller, currentRegion: 'Dion' }), null,
        'a physical record cannot be filled remotely from another town');
    assert.equal(Ready.sale([{ line, count: 5 }], { ...seller, loc: { locX: 0, locY: 0, locZ: 0 } }), null,
        'the region label alone does not prove physical arrival');
    const cashBefore = await wallet(9110) + await wallet(9111) + Market.buyOrderEscrow(9110);
    const result = await Market.executePlan(seller, plan, { reviewGoal: false });
    assert.equal(result.pending, undefined);
    assert.equal(Native.amount(await DB.fetchItems(9111), 1864), 7);
    assert.equal(await wallet(9111), 1500000, 'the seller receives exactly five units at the record price');
    assert.equal(Market.buyOrderEscrow(9110), 100, 'only the unfilled request remains reserved');
    assert.equal(await wallet(9110) + await wallet(9111) + Market.buyOrderEscrow(9110), cashBefore,
        'a sale transfers Adena without creating or deleting money');
    await Afk.settleOwners([9110]);
    assert.equal(Native.amount(await DB.fetchItems(9110), 1864), 5, 'the crafter receives the five purchased items');
    await Market.executePlan(Life.snapshot(9111), plan, { reviewGoal: false });
    assert.equal(await wallet(9111), 1500000, 'an old quote cannot pay the seller twice');
    await DB.flushJournals(); await DB.flushHistory();
    const trades = await DB.readHistory([`SELECT quantity,totalPrice,sourceType FROM market_trades
        WHERE buyerCharacterId=? AND sellerCharacterId=?`, [9110, 9111]]);
    assert.deepEqual(trades.map(row => [row.quantity, row.totalPrice, row.sourceType]), [[5, 500000, 'afk_bot_buy_store']]);
    console.log('PASS custody-0 buy record fill: escrow to the seller, goods to the crafter, replay refused');
}

async function legacyBuyShopRefunded() {
    await bot(9120, CRAFTER);
    const place = Places.take('Giran', Places.afkOwner(9120));
    await Afk.publishBot(9120, { storeType: Afk.BUY, town: 'Giran', ...place,
        lines: [{ selfId: 1864, name: 'Stem', count: 2, price: 1000, stackable: true }] });
    assert.equal(await wallet(9120), 998000, 'the old BUY shop holds its escrow');
    await apply(9120, workerPlan(9120, [[1865, 1, 300]]));
    assert.equal(Afk.findOwnerProjection(9120)?.shop?.storeType === Afk.BUY, false, 'the old bot BUY shop is closed');
    assert.equal(store(9120).length, 1);
    assert.equal(await wallet(9120) + Market.buyOrderEscrow(9120), 1000000, 'its escrow is back: only the new store holds money');
    assert.equal(Market.buyOrderEscrow(9120), 300);
    console.log('PASS old bot BUY shop closed and refunded at the next publish');
}

async function twinShopAndStoreShareTown() {
    await bot(9130, CRAFTER);
    await DB.setItem(9130, { selfId: 1864, name: 'Stem', amount: 4, slot: 0 });
    const stem = (await DB.fetchItems(9130)).find(item => Number(item.selfId) === 1864);
    const place = Places.take('Talking Island', Places.afkOwner(9130));
    await Afk.publishBot(9130, { storeType: Afk.SELL, title: 'wts', town: 'Talking Island', ...place, head: 0, appearance: {},
        lines: [{ objectId: Number(stem.id), selfId: 1864, name: 'Stem', count: 4, price: 100, enchant: 0, slot: 0, stackable: true }] });
    // The worker's build proposes the twin's town from the records that stand.
    const state = Life.snapshot(9130);
    const twin = Twin.propose(state, { board: Afk.boardIndex(), watchList: [], findSpot: () => null });
    assert.equal(twin?.town, 'Talking Island', 'the twin trades in the town of its sell shop');
    assert.deepEqual(twin.workshop, CRAFTER.twin.workshop, 'the town joins the held workshop');
    await Life.upsertState({ ...state, stats: { ...state.stats, twin } }, 'buy_shop_twin');

    const townless = workerPlan(9130, [[1865, 1, 300]], [], { townless: true });
    await assert.rejects(apply(9130, townless), /economy_plan_buy_town/, 'main never chooses the town of a buy batch');
    assert.equal(records(9130).length, 0, 'a refused batch publishes nothing');

    await apply(9130, workerPlan(9130, [[1865, 1, 300]], [[1866, 2, 200]]));
    assert.equal(store(9130).length, 1);
    assert.deepEqual(records(9130).map(row => row.town), ['Talking Island', 'Talking Island'],
        'its escrow store and its meeting bids stand in its sell shop\'s town');
    assert.equal(Afk.findOwnerProjection(9130)?.shop?.town, 'Talking Island');
    console.log('PASS twin town: sell shop and custody-0 buy rows share one town; a townless batch is refused');
}

// A no-grade weapon a level-45 bot sells (no starter item).
function noGradeWeapon() {
    const Data = invoke('GameServer/DataCache');
    const starters = new Set((Data.newbieItems || []).flatMap(row => (row.items || []).map(item => Number(item.selfId))));
    const item = Data.items.find(row => /^Weapon\./.test(row.template?.kind) && (row.etc?.rank || 'none') === 'none'
        && Number(row.template?.price) > 1000 && !starters.has(Number(row.selfId)));
    assert(item, 'a no-grade weapon template');
    return item;
}

// Karma closes the towns, not the bot's standing shop: the worker's plan
// refreshes the shop in the town it stands in and main applies it there.
async function karmaShopKeepsItsTown() {
    // A shop line is for a worthwhile item: the bot's own product (its workshop's recipe).
    const productId = Number(Recipes.resolveByRecipeId(25)?.productId);
    const product = invoke('GameServer/DataCache').items.find(row => Number(row.selfId) === productId);
    assert(product, 'the product of recipe 25');
    await bot(9140, { karma: 100, twin: { town: 'Giran', workshop: [{ recipeId: 25 }] } });
    await DB.setItem(9140, { selfId: Number(product.selfId), name: product.template.name, amount: 25, slot: 0 });
    const item = (await DB.fetchItems(9140)).find(row => Number(row.selfId) === Number(product.selfId));
    const place = Places.take('Giran', Places.afkOwner(9140));
    await Afk.publishBot(9140, { storeType: Afk.SELL, title: 'wts', town: 'Giran', ...place, head: 0, appearance: {},
        lines: [{ objectId: Number(item.id), selfId: Number(product.selfId), name: product.template.name, count: 20, price: 1,
            enchant: 0, slot: 0, stackable: true }] });
    // Five more units sit in the bag: the showcase changes, so the plan carries its town.
    const state = await Life.refreshInventory(Life.snapshot(9140));
    const plan = Plan.decide(state, Decision.economyFor(state), { board: Afk.boardIndex(), now: Date.now(),
        showcaseOnly: true, npcOffersFor: () => [], findSpot: () => null });
    assert(plan.sell.length > 0, `the shop's stock is repriced: ${JSON.stringify(plan)}`);
    assert.equal(plan.shop, 'Giran', 'the showcase is refreshed in the town its shop stands in');
    assert.deepEqual([...new Set(plan.sell.map(row => row[3]))], ['Giran']);
    const result = await Market.executePlan(state, plan, { reviewGoal: false });
    assert.notEqual(result.reason, 'shop_visit_changed', 'main applies the karma bot\'s shop refresh');
    assert.equal(Afk.findOwnerProjection(9140)?.shop?.town, 'Giran');
    console.log('PASS karma bot: its standing shop keeps its town in the plan and on main');
}

// A worker build reaches no World: the twin town of a no-grade seller is the
// starter village of its hunting spot, read from the build's spot catalog.
async function workerTwinTownFromSpot() {
    const weapon = noGradeWeapon();
    const village = Town.NO_GRADE_MARKETS.find(row => row.name === 'Talking Island');
    const spot = { id: 'twin-town-spot', avgLevel: 45, minLevel: 40, maxLevel: 50, density: 8,
        center: { locX: village.locX, locY: village.locY, locZ: -3000 }, npcEntries: [] };
    SpotProfiles.cache = [spot];
    await bot(9150);
    await DB.setItem(9150, { selfId: Number(weapon.selfId), name: weapon.template.name, amount: 1, slot: 0 });
    const state = await Life.upsertState({ ...await Life.refreshInventory(Life.snapshot(9150)), spotId: spot.id,
        activity: 'hunting' }, 'buy_shop_twin_spot');
    const sale = Disposition.saleCandidates(state);
    assert(sale.length > 0 && sale.every(row => (invoke('GameServer/DataCache').items
        .find(item => Number(item.selfId) === Number(row.selfId))?.etc?.rank || 'none') === 'none'), 'the bot sells no-grade stock only');
    const probe = await nativeDecision(state, { timestamp: Date.now() });
    assert.equal(probe.statsPacket.twin?.town, 'Talking Island', 'the twin trades in its hunting spot\'s village');
    console.log('PASS worker build: twin town from the spot catalog, no World');
}

async function run() {
    DB.init(); invoke('GameServer/DataCache').init(); await Life.init();
    await crafterPlansEscrowStore();
    await sellerFillMovesEscrow();
    await legacyBuyShopRefunded();
    await twinShopAndStoreShareTown();
    await karmaShopKeepsItsTown();
    await workerTwinTownFromSpot();
}
run().then(async () => { Afk._resetForTests(); await DB.close(); fs.rmSync(fixture.directory, { recursive: true, force: true }); })
    .catch(async error => { console.error(error); await DB.close(); process.exitCode = 1; });
