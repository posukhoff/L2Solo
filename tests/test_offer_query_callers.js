// Pins what each caller of the offer query sees before the copies become one
// query (step 3.3 group B, U20): the town each caller looks in, which owners
// and source kinds it skips, and the line it takes. Board records live in
// memory only (AfkTrade.refreshRecord); no database.
const assert = require('assert');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('fx-market-case');
const fs = require('node:fs');
require('../src/Global');
fixture.assertConfigured(options.default);
process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));
const NativeChoice = require('./helpers/nativeMarketChoice');

(async () => {

const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const World = invoke('GameServer/World/World');
World.user = { sessions: [], revision: 0 };

const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const BotAfkMarket = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const ClanOrderService = invoke('GameServer/Clan/ClanOrderService');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');

const STEM = 1864;
const SOULSHOT = 1835;
const SWORD = 2;
let nextId = 991000;

function record(ownerId, { kind = 'sell_ad', custodyPolicy = 0, storeType = 1, town = 'Giran', account = `bot_${ownerId}`, lines }) {
    const id = ++nextId;
    return AfkTrade.refreshRecord({
        id, ownerId, ownerName: `Owner${ownerId}`, ownerAccount: account, kind, storeType, status: 'active', town,
        title: '', custodyPolicy, revision: 1, expiresAt: 0, locX: 83000, locY: 148000, locZ: -3400, appearance: {},
        lines: lines.map((line, index) => ({ id: id * 10 + index, name: `Item ${line.selfId}`, enchant: 0, ...line }))
    });
}

function picked(offer) {
    return offer ? `${offer.sourceType}:${offer.sourceId}:${offer.town}:${offer.price}` : null;
}

// C2 (ClanEquipmentService recheck) and C6/C9: the buyer's own records and
// other towns are skipped; in town an NPC competes.
{
    record(991101, { town: 'Dion', lines: [{ selfId: STEM, count: 3, price: 10 }] });
    record(991102, { town: 'Giran', lines: [{ selfId: STEM, count: 3, price: 12 }] });
    record(991103, { town: 'Giran', lines: [{ selfId: STEM, count: 3, price: 11 }] });
    assert.strictEqual(picked(MarketOpportunity.bestOffer(STEM, { town: 'Giran', buyerCharacterId: 991103 })),
        'afk_bot_store:991102:Giran:12', 'C2: own record skipped, other town ignored');
    assert.strictEqual(picked(MarketOpportunity.bestOffer(STEM, { town: 'Giran', budget: 11 })),
        'afk_bot_store:991103:Giran:11', 'C6: the budget caps the price');
    assert.strictEqual(MarketOpportunity.bestOffer(STEM, { town: 'Giran', budget: 10 }), null);
    assert.strictEqual(picked(MarketOpportunity.bestOffer(STEM, {})), 'afk_bot_store:991101:Dion:10',
        'C8: no town and no buyer, the cheapest anywhere');
    assert.strictEqual(picked(MarketOpportunity.bestOffer(STEM, { buyerCharacterId: 991101 })),
        'afk_bot_store:991103:Giran:11', 'no town, own record skipped');
    AfkTrade._resetForTests();
}

// A clan buy is an errand (ClanOrderService.memberOffer, the clan equipment
// market pick): it skips a cheaper meeting-only line (a bot's sell ad, custody
// 1) and takes the line that settles at once; a wish buy still sees the ad.
{
    record(991151, { kind: 'sell_ad', custodyPolicy: 1, lines: [{ selfId: STEM, count: 3, price: 10 }] });
    record(991152, { kind: 'shop', lines: [{ selfId: STEM, count: 3, price: 12 }] });
    const member = { characterId: 991153, accountName: 'bot_991153', phase: 'cold', level: 20, adena: 100000,
        currentRegion: 'Giran', activity: 'hunting', inventory: {}, stats: { generatedCold: true } };
    assert.strictEqual(picked(MarketOpportunity.bestOffer(STEM, { town: 'Giran', buyerCharacterId: 991153 })),
        'afk_bot_store:991151:Giran:10', 'a wish buy sees the cheaper meeting line');
    assert.strictEqual(picked(ClanOrderService.memberOffer(member, STEM)),
        'afk_bot_store:991152:Giran:12', 'clan member offer: the settled line, not the meeting one');
    const equipment = GearAcquisitionPlanner.marketOfferForTarget({ selfId: STEM }, member, { maxMarketPrice: 12, purpose: 'clan' });
    assert.strictEqual(picked(equipment), 'afk_bot_store:991152:Giran:12', 'clan equipment market pick: the settled line');
    AfkTrade._resetForTests();
}

// Remote trade or travel (BuyAdPolicy.remoteBuy): the worker's batch decides,
// main reads the buy ads it published and builds no bid of its own. The
// sword trades at its template price, a bid main used to build could fill.
{
    const orc = invoke('GameServer/Bot/Economy/MarketTownPolicy').NO_GRADE_MARKETS
        .find(market => market.name === 'Orc Village');
    const state = { characterId: 991201, accountName: 'bot_991201', phase: 'cold', level: 20, adena: 1000000,
        loc: { locX: orc.locX, locY: orc.locY, locZ: orc.locZ }, currentRegion: orc.name, activity: 'hunting',
        inventory: {}, stats: { generatedCold: true } };
    const goal = (plan = {}) => ({ type: 'upgrade_gear', status: 'active', target: { itemId: SWORD, adena: 900000 },
        plan: { expectedBenefit: 'market_search_for_gear', marketTown: null, estimatedCost: 900000, ...plan } });
    for (let deal = 0; deal < 10; deal++) MarketCounters.deal(SWORD, 136000, 1, Date.now() - (10 - deal) * 60000, 7);
    assert.strictEqual(BotAfkMarket.canTradeRemotely(state, goal()), false,
        'no bid for the goal item in the bot\'s batch: the goal travels');
    record(991201, { kind: 'buy_ad', storeType: AfkTrade.BUY, custodyPolicy: 1,
        lines: [{ selfId: SWORD, count: 1, price: 100000 }] });
    assert.strictEqual(BotAfkMarket.canTradeRemotely(state, goal()), true,
        'the batch bid for the goal item: the bot trades remotely');
    assert.strictEqual(BotAfkMarket.canTradeRemotely(state, goal({ sourceType: 'afk', priceSource: 'offer' })), false,
        'a ready player ask is bought where it stands');
    assert.strictEqual(BotAfkMarket.canTradeRemotely(state, goal({ sourceType: 'npc' })), false,
        'an NPC purchase is made in its town');
    record(991202, { town: 'Dion', lines: [{ selfId: SWORD, count: 1, price: 1 }] });
    assert.strictEqual(picked(MarketOpportunity.bestOffer(SWORD, { town: null, budget: 1000000, buyerCharacterId: 991201 })),
        'afk_bot_store:991202:Dion:1', 'C7: a board line in any town');
    AfkTrade._resetForTests();
    MarketCounters.reset();
}

// C11 (ShotStock.restockTarget): a hot shot trip goes to the best seller in
// the town, an ad by record at its place (D6, group C); the bot's own shop
// and the excluded sellers are skipped.
{
    const actor = { fetchId: () => 991301, classId: 0 };
    record(991302, { kind: 'sell_ad', lines: [{ selfId: SOULSHOT, count: 500, price: 5 }] });
    record(991301, { kind: 'shop', lines: [{ selfId: SOULSHOT, count: 500, price: 4 }] });
    record(991303, { kind: 'shop', lines: [{ selfId: SOULSHOT, count: 500, price: 6 }] });
    record(991304, { kind: 'shop', lines: [{ selfId: SOULSHOT, count: 500, price: 6 }] });
    const ad = ShotStock.restockTarget(actor, 'Giran');
    assert.deepStrictEqual([ad?.sourceId, ad?.actorId, ad?.recordId > 0], [991302, null, true], 'C11: the cheapest, an ad by record');
    assert.strictEqual(ShotStock.restockTarget(actor, 'Giran', [991302])?.sourceId, 991303, 'C11: then the cheapest stall');
    assert.strictEqual(ShotStock.restockTarget(actor, 'Giran', [991302, 991303])?.sourceId, 991304, 'C11: excluded skipped');
    assert.strictEqual(ShotStock.restockTarget(actor, 'Dion'), null, 'C11: only the town');
    // A cheaper personal advertisement cannot send a current player
    // companion on a trip that native acceptance will necessarily reject.
    record(991305, { kind: 'sell_ad', custodyPolicy: 1, lines: [{ selfId: SOULSHOT, count: 500, price: 3 }] });
    assert.equal(ShotStock.restockTarget(actor, 'Giran')?.sourceId, 991305, 'solo hot buyer selects the cheaper personal ad');
    const previousUsers = World.user;
    World.user = { sessions: [], revision: 0 };
    const companion = { actor, botSession: true, partyCompanion: true, accountId: 'bot_guard_buyer',
        fetchAccountId: () => 'bot_guard_buyer' };
    World.insertUser(companion);
    try {
        assert(!MarketOpportunity.hotOffers(SOULSHOT, { town: 'Giran', buyerCharacterId: actor.fetchId() })
            .some(offer => offer.sourceId === 991305), 'hot buyer admission removes the forbidden candidate before the trip');
        assert.equal(ShotStock.restockTarget(actor, 'Giran')?.sourceId, 991302,
            'actual companion shot-restock caller selects the still-legal backed stock instead');
        const amounts = new Map([[57, 10000], [SOULSHOT, 0]]);
        const items = new Map([...amounts].map(([selfId]) => [selfId, { fetchId: () => selfId,
            fetchAmount: () => amounts.get(selfId), setAmount: amount => amounts.set(selfId, amount) }]));
        actor.session = companion;
        actor.fetchLevel = () => 1;
        companion.coldLifeState = { characterId: actor.fetchId(), phase: 'hot',
            stats: { money: [77000, 1.3e-5, 0, 0, 4e-5, 7000, SOULSHOT] } };
        actor.backpack = { fetchItemFromSelfId: selfId => items.get(Number(selfId)) };
        const originalBuy = AfkTrade.buyFromShop, purchases = [];
        AfkTrade.buyFromShop = async (_buyer, store, selfId, amount, options) => {
            purchases.push([store.ownerId, amount, options.expectedPrice]);
            amounts.set(57, amounts.get(57) - amount * options.expectedPrice);
            amounts.set(selfId, amounts.get(selfId) + amount);
            return {};
        };
        try {
            const result = await ShotStock.purchaseActorRestock(actor, { town: 'Giran', skipNpc: true,
                targetAmount: 100, unitPrice: 7, potionUnitPrice: 0,
                plan: ShotStock.planForKind('soulshot', 'none') });
            assert.deepEqual(purchases, [[991302, 100, 5]],
                'actual purchase/fill caller skips cheaper personal stock and fills from legal backed stock');
            assert.equal(result.delta, 100, 'skipNpc companion still completes the legal purchase');
        } finally { AfkTrade.buyFromShop = originalBuy; }

    } finally { World.user = previousUsers; }
    AfkTrade._resetForTests();
}

// C14 (NeedsEvaluator market material): a crafter buys a missing material on
// the board when it saves farming, from the offer that saves most.
{
    record(991402, { town: 'Dion', lines: [{ selfId: STEM, count: 2, price: 40 }] });
    record(991403, { town: 'Giran', lines: [{ selfId: STEM, count: 5, price: 50 }] });
    record(991401, { town: 'Giran', lines: [{ selfId: STEM, count: 9, price: 1 }] });
    const state = { characterId: 991401, accountName: 'bot_991401', name: 'Crafter', phase: 'cold', level: 30,
        classId: 0, adena: 200000, activity: 'hunting', currentRegion: 'Giran', inventory: {},
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        stats: { equipmentPlan: { status: 'active', strategy: 'craft', recipeId: 1,
            materials: [{ selfId: STEM, amount: 5, missing: 5, farmEffort: 50 }] } } };
    // ARCH-NOTE: FX-C1/C2a do not turn an old craft plan into a shopping
    // leaf. The real worker sees all three original lots and chooses a hunt.
    const native = await NativeChoice.capture(state, {}, 'C14_original_3lots');
    assert.strictEqual(native.read.activity.activity, 'hunting');
    assert.strictEqual(native.goals.length, 1);
    assert.strictEqual(native.goals[0].priority, 50);
    assert.strictEqual(native.goals.find(candidate => candidate.type === 'buy_craft_material'
        && candidate.target.itemId === STEM), undefined);
    assert.strictEqual(invoke('GameServer/Bot/Economy/PurchaseFunding').spendable(native.state, 0, { itemId: STEM }), 0);
    // The same native BoardIndex still fills the requested5Stems in one
    // town, excluding the original owner's cheap lot. This is the stack
    // purchase query, not an invented funded wish or a completed SQL trade.
    const query = invoke('GameServer/Bot/Economy/OfferQuery').cheapestTown(AfkTrade.boardIndex(), STEM,
        { amount: 5, money: 200000, excludeOwner: 991401 });
    assert.strictEqual(query.town, 'Giran', 'only the original Giran public lot fills all five');
    assert.strictEqual(query.units, 5);
    assert.strictEqual(query.cost, 5 * 50, 'all five original units are priced by that lot');
    assert.strictEqual(query.landed, query.cost);
    assert.deepStrictEqual(query.lines.map(row => [row.line.ownerId, row.count, row.price]), [[991403, 5, 50]]);
    AfkTrade._resetForTests();
}

console.log('Offer query callers: pinned');

})().catch(error => { console.error(error); process.exitCode = 1; });
