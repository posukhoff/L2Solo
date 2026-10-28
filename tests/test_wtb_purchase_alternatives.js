'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Alternative = require('../src/GameServer/Bot/Economy/BidPurchaseAlternative');
const Decision = invoke('GameServer/Bot/Economy/PriceDecision');
const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
const { BoardIndex, SELL, BUY } = require('../src/GameServer/AfkTrade/BoardIndex');
const Party = require('../src/GameServer/Bot/Population/PartyAdmission');
const ITEM = 413, now = 1800000000000;
const buyer = { characterId: 1, activity: 'hunting', stats: {} };
const board = new BoardIndex();
let npc = [], routes = { Dion: { known: true, hours: 0, fees: 0 }, Oren: { known: true, hours: 0, fees: 0 } };
const ctx = { state: buyer, characterId: 1, hour: 600000, adena: 1000000, board,
    travelDetails: town => routes[town] || { known: false, hours: NaN, fees: NaN },
    npcOffersFor: () => npc, timestamp: now, understanding: .5, knowledgeEnabled: false,
    marketTrades: {}, trader: { wait: 0, assertiveness: .5, caution: .5 }, economy: { worth: () => 34454032 } };
const cap = (units = 1, money = 1000000, extra = {}) => Alternative.cap(ITEM, ctx, { units, money, town: 'Dion', ...extra });
const shop = (id, price, count = 1, extra = {}) => board.put({ id, ownerId: id + 10, revision: 1,
    storeType: SELL, town: 'Dion', ...extra, lines: [{ lineId: id, selfId: ITEM, enchant: extra.enchant || 0, count, price }] });
Party.configureTradeAdmission(() => null);

// The shop of another town than the bid's meeting (Dion), over an equal trip.
const away = (id, price, count = 1, extra = {}) => shop(id, price, count, { town: 'Oren', ...extra });

// The reported gear case: high subjective value cannot beat a real shop.
away(1, 74136);
assert.equal(cap(), 74136);
routes.Dion = routes.Oren = { known: true, hours: 50 / 3600, fees: 7800 };
assert.equal(cap(), 74136, 'identical nonzero trips cancel to the exact shop price');
routes.Dion = routes.Oren = { known: true, hours: 0, fees: 0 };
const belief = { mu: Math.log(105000), K: 5.8 };
const market = { units: 1, lot: 1, buyersPerHour: NaN, purchaseCap: cap() };
for (let seed = 0; seed < 30; seed++) {
    const bid = Decision.chooseBid(belief, market, ctx.trader, { worth: 34454032, cap: 1000000 }, ['wtb', seed], 188565);
    assert(bid && bid.price <= 74136, 'new and standing bids obey the outside purchase');
}
assert.equal(Decision.chooseBid(belief, { ...market, purchaseCap: 50000 }, ctx.trader,
    { worth: 34454032, cap: 1000000 }, ['below-grid']).price, 50000, 'cheap supply below the grid is still a priced option');

// Full quantity, one shared trip, affordable cash fees and travel time.
assert.equal(cap(10), Infinity, 'one cheap unit cannot fill a ten-unit order');
npc = [{ sourceType: 'npc', selfId: ITEM, price: 126636, town: 'Oren', available: true }];
assert.equal(cap(2), Math.floor((74136 + 126636) / 2));
board.clear();
assert.equal(cap(), 126636);
assert.equal(cap(10), Infinity, 'an unaffordable NPC basket is not executable');
routes.Giran = { known: true, hours: .01, fees: 1000 };
npc = [{ sourceType: 'npc', selfId: ITEM, price: 116083, town: 'Giran', available: true }];
assert.equal(cap(), 123083, 'NPC price plus fare and foregone hunting');
routes.Dion = { known: true, hours: .005, fees: 500 };
assert.equal(cap(), 119583, 'subtract the WTB meeting trip before setting its unit ceiling');
assert.equal(cap(1, 116500), Infinity, 'price fits the wallet but the fare does not');
assert.equal(cap(1, 499), 0, 'the buyer cannot fund the WTB meeting fare either');
routes.Giran = { known: false, hours: NaN, fees: NaN };
assert.equal(cap(), Infinity, 'unknown routes are never free alternatives');
routes.Dion = { known: true, hours: 0, fees: 0 };
npc = [{ sourceType: 'npc', selfId: ITEM, price: 100, town: 'Dion', available: false }];
assert.equal(cap(), Infinity);
npc = [{ sourceType: 'npc', selfId: ITEM, price: 100, count: 1, town: 'Dion', available: true }];
assert.equal(cap(2), Infinity);
assert.equal(cap(1, 1000000, { enchant: 1 }), Infinity, 'ordinary NPC stock cannot replace enchanted gear');
npc = [];
shop(1, 100, 1, { ownerId: 1 });
shop(2, 100, 1, { enchant: 1 });
assert.equal(cap(), Infinity, 'own stock and different enchants do not provide the item');

// Public conditional quantities are not reservations. The buyer's accepted
// executable quote and party admission are required before using one.
board.clear();
away(3, 100, 1, { custodyPolicy: 1, kind: 'sell_ad' });
assert.equal(cap(), Infinity);
ctx.economy.network = { activity: { activity: 'shopping', kind: 'buy', sourceType: 'afk', quoted: true,
    executable: true, itemId: ITEM, town: 'Oren', unitPrice: 100, amount: 1 } };
assert.equal(cap(), 100);
Party.configureTradeAdmission(() => ({ partyId: 'busy' }));
assert.equal(cap(), Infinity, 'a party-bound seller cannot attend the meeting');
Party.configureTradeAdmission(() => null);
delete ctx.economy.network;

// A small source change still retires an overpriced accepted bid, even when
// personal noise would normally keep the previous quote untouched.
board.clear();
away(1, 74000);
Counters.reset();
const line = { ownerId: 1, recordId: 2, lineId: 2, revision: 1, storeType: BUY, selfId: ITEM,
    town: 'Dion', custodyPolicy: 1, count: 1, price: 188565, enchant: 0, fills: 0,
    pricing: { price: 188565, seenCounter: 0, seenItem: 0, seenFills: 0, rival: 188564,
        worth: 34454032, sigma: 1, seenAt: now, seenCount: 1 } };
board.put({ id: 3, ownerId: 99, storeType: BUY, town: 'Dion', lines: [{ lineId: 3, selfId: ITEM, count: 1, price: 188565 }] });
const review = Pricing.look(buyer, [line], { ...ctx, preparedWorth: () => 34454032, reviewReasons: new Map([[2, 1]]) });
assert(review?.reprices?.[0]?.price <= 74000, 'outside option overrides the small-movement hold');
const pendingWorth = Pricing.look(buyer, [line], { ...ctx, preparedWorth: () => NaN, reviewReasons: new Map([[2, 4]]) });
assert.equal(pendingWorth.reprices[0].price, 74000,
    'unknown new usefulness cannot preserve an old bid above a confirmed cheaper purchase');
assert.equal(pendingWorth.reprices[0].pricing.worth, line.pricing.worth,
    'a downward correction retains the original authored worth');
const fresh = Pricing.bid(ITEM, ctx, { units: 1, worth: 34454032, cap: 1000000,
    town: 'Dion', money: 1000000, rollKey: ['new-ad'] });
assert(fresh?.price <= 74000, 'publication and review use the same executable outside option');
const RetryLook = invoke('GameServer/Bot/Economy/BoardLook'), retrySeen = new RetryLook.SeenLines();
const lookCtx = { ...ctx, preparedWorth: () => 34454032 };
assert(RetryLook.review(buyer, [line], lookCtx, retrySeen)?.reprices?.[0]?.price <= 74000);
assert(RetryLook.review(buyer, [line], lookCtx, retrySeen)?.reprices?.[0]?.price <= 74000,
    'an undelivered correction retries at the next own look without another source change');

// A useful, funded item still needs fresh consent at the actual agreed price.
const agreed = (price, count = 1) => ({ payer: 0, selfId: ITEM, enchant: 0, count, price });
assert.throws(() => Alternative.assertMeetingPurchase([agreed(188565)], 0, 'Dion', ctx),
    /trade_meeting_purchase_price_changed/);
assert.doesNotThrow(() => Alternative.assertMeetingPurchase([agreed(74000)], 0, 'Dion', ctx));
assert.doesNotThrow(() => Alternative.assertMeetingPurchase([agreed(188565), agreed(188565)], 0, 'Dion', ctx),
    'one reserved cheap unit cannot supply two physical stacks in the same purchase');
npc = [{ sourceType: 'npc', town: 'Dion', price: 80000 }];
assert.throws(() => Alternative.assertMeetingPurchase([agreed(188565), agreed(188565)], 0, 'Dion', ctx),
    /trade_meeting_purchase_price_changed/, 'split physical stacks share one full-quantity price check');
board.clear();
assert.throws(() => Alternative.assertMeetingPurchase([agreed(80001)], 0, 'Dion', ctx),
    /trade_meeting_purchase_price_changed/, 'NPC stock also bounds fresh bilateral consent');
assert.doesNotThrow(() => Alternative.assertMeetingPurchase([agreed(80000)], 0, 'Dion', ctx));
assert.doesNotThrow(() => Alternative.assertMeetingPurchase([agreed(188565)], 1, 'Dion', ctx),
    'a seller does not prepare the counterparty purchase');
const absentTrip = { ...ctx, travelDetails: () => ({ known: false, hours: NaN, fees: NaN }) };
assert.throws(() => Alternative.assertMeetingPurchase([agreed(80000)], 0, 'Dion', absentTrip), /trade_meeting_route/);
npc = []; away(1, 74000);
const BuyAds = invoke('GameServer/Bot/Economy/BuyAdPolicy');
const completeTrip = town => {
    const route = ctx.travelDetails(town); return route.known ? route.fees + route.hours * ctx.hour : Infinity;
};
completeTrip.details = ctx.travelDetails;
const partialTrip = () => Infinity;
partialTrip.details = () => ({ known: false, hours: NaN, fees: NaN });
const preparedBid = BuyAds.bidFor({ ...buyer, phase: 'cold', adena: 1000000,
    stats: { money: [600000, 1 / 600000, 0, 0, .01, 100000, ITEM] } },
{ type: 'buy_craft_material', target: { itemId: ITEM, amount: 1 } }, {
    town: 'Dion', board, persona: { traits: {} }, findSpot: () => null, tripCost: partialTrip,
    economy: { ...ctx.economy, trip: completeTrip, hourAdena: ctx.hour, moneyPrice: 1 / ctx.hour }, npcOffersFor: () => []
});
assert(preparedBid?.price <= 74000, 'a partial recipe route cannot hide the complete prepared WTB alternatives');
assert.deepEqual(require('../src/GameServer/Bot/Population/ColdEconomyPlan').buyBatch([preparedBid], 'Dion').buyCaps, [74000],
    'native publication receives the prepared limit without rebuilding routes or pricing');
assert.equal(Pricing.bid(ITEM, { ...ctx, travelDetails: partialTrip.details }, { units: 1,
    worth: 34454032, cap: 1000000, town: 'Dion', money: 1000000, rollKey: ['unknown-meeting'] }), null,
    'a new bid waits until its own meeting route is executable');
// A buy intent's item bids at the intent's own worth (its share of the root),
// even when the economy's own worth of the item is higher (another root's use).
const intentWorth = 50000;
const inputBid = BuyAds.bidFor({ ...buyer, phase: 'cold', adena: 1000000,
    stats: { money: [600000, 1 / 600000, 0, 0, .01, 100000, ITEM] } },
{ type: 'buy_craft_material', target: { itemId: ITEM, amount: 1 },
    intent: { key: 'craft:1', itemId: ITEM, amount: 1, worth: intentWorth, valueHours: intentWorth / ctx.hour, valueRate: 1 } }, {
    town: 'Dion', board, persona: { traits: {} }, findSpot: () => null, tripCost: completeTrip,
    economy: { ...ctx.economy, worth: () => 200000, network: { demands: new Map([[`item:${ITEM}`, 200000 / ctx.hour]]) },
        projection: { values: new Map() }, trip: completeTrip, hourAdena: ctx.hour, moneyPrice: 1 / ctx.hour }, npcOffersFor: () => []
});
assert(inputBid?.price > 0 && inputBid.price <= intentWorth,
    'a buy intent never bids above its intent worth, even when its own worth is higher');
// A near bot's look (the accepted card's trader context) prices an intent's
// BUY line at the intent's worth, as the worker's look does.
const cardState = { ...buyer, characterId: 77, phase: 'hot', updatedAt: 5, stats: { money: [600000, 1 / 600000, 0, 0] } };
invoke('GameServer/Bot/Population/ColdSimulationCoordinator').economyDecisions.accept(77,
    require('../src/GameServer/Bot/Population/ColdEconomyDecision').capture(
        { watchList: [{ itemId: ITEM, amount: 1, worth: intentWorth, kind: 'material' }] }, cardState));
assert.equal(require('../src/GameServer/Bot/Economy/BoardLook').buyWorth(
    invoke('GameServer/Bot/Economy/MarketListingPolicy').cardTraderContext(cardState, { board }), ITEM), intentWorth,
    'a near bot\'s look reads the card\'s intent worth');
const tradeBoard = new BoardIndex();
tradeBoard.put({ id: 10, ownerId: buyer.characterId, revision: 1, storeType: BUY, town: 'Dion',
    custodyPolicy: 1, kind: 'buy_ad', lines: [{ lineId: 10, selfId: ITEM, enchant: 0,
        count: 1, price: 188565, pricing: { price: 188565, worth: 34454032 } }] });
for (const [id, price, custodyPolicy] of [[11, 80000, 1], [12, 74000, 0]])
    tradeBoard.put({ id, ownerId: id + 10, revision: 1, storeType: SELL, town: 'Dion', custodyPolicy,
        lines: [{ lineId: id, selfId: ITEM, enchant: 0, count: 1, price }] });
const planEconomy = { ...ctx.economy, trip: completeTrip, hourAdena: ctx.hour, moneyPrice: 1 / ctx.hour,
    network: { activity: { activity: 'shopping', kind: 'buy', sourceType: 'afk', quoted: true,
        executable: true, itemId: ITEM, amount: 1, unitPrice: 80000, town: 'Dion' } } };
const iterator = require('../src/GameServer/Bot/Population/ColdEconomyPlan').prepare({ ...buyer,
    level: 30, phase: 'cold', adena: 1000000, inventory: {}, vitals: { hp: 1000, mp: 1000 }, stats: { classId: 0 } },
planEconomy, { now, board: tradeBoard, persona: { traits: {} }, tripCost: partialTrip, npcOffersFor: () => [] });
let plan;
do { plan = iterator.next(); } while (!plan.done);
assert.deepEqual(plan.value.take, [SELL, ITEM, 1, 11, 11, 1, 80000]);
assert.deepEqual(require('../src/GameServer/Bot/Population/ColdEconomyPlan').bidLimits({ ...buyer, level: 30, phase: 'cold',
    adena: 1000000, inventory: {}, vitals: { hp: 1000, mp: 1000 }, stats: { classId: 0 } }, planEconomy,
{ now, board: tradeBoard, persona: { traits: {} }, tripCost: partialTrip, npcOffersFor: () => [] }), [[10, 10, 1, 1, 188565, 0]],
'a lifecycle command withdraws the owner\'s old bid as crossed: its own town sells the whole lot');
const smallWallet = Pricing.bid(ITEM, { ...ctx, adena: 100000 }, { units: 2, worth: 34454032, cap: 100000,
    town: 'Dion', money: 100000, rollKey: ['short-wallet'] });
assert.equal(smallWallet.count, 1);
assert(smallWallet.price <= 74000, 'the smaller funded order sees the one cheap available unit');
routes.Dion = { known: true, hours: 0, fees: 500 };
assert.equal(Alternative.cashCap(line, { ...ctx, adena: 60000 }), 59500,
    'a conditional bid has no escrow to add to its actual wallet');
assert.equal(Alternative.cashCap({ ...line, custodyPolicy: 0 }, { ...ctx, adena: 60000 }), 248065,
    'a backed bid recovers its real escrow and still pays the meeting fare');
const underfunded = Pricing.look(buyer, [line], { ...ctx, adena: 60000, preparedWorth: () => 34454032,
    reviewReasons: new Map([[2, 4]]) });
assert(underfunded?.reprices?.[0]?.price <= 59500, 'standing bids can fund the entire meeting');
routes.Dion = { known: true, hours: 0, fees: 0 };

// A standing bid never stays at its own town's whole ask (no matcher would
// cross them): it withdraws; a new bid opens under that ask.
// Another town's ask, a partial lot or an NPC-backed one keeps the ceiling.
board.clear();
npc = [];
shop(1, 74000);
const standing = { ...line, custodyPolicy: 0, count: 1, price: 74000 };
assert.equal(Alternative.lineLimit(standing, ctx), 0, 'a bid at its own town\'s whole ask withdraws');
assert.equal(Alternative.lineLimit({ ...standing, price: 90000 }, ctx), 0, 'a bid over it withdraws too');
const opened = Pricing.bid(ITEM, ctx, { units: 1, worth: 34454032, cap: 1000000, town: 'Dion',
    money: 1000000, rollKey: ['own-town'] });
assert(opened?.price > 0 && opened.price <= 73999, 'a new bid opens under the own town\'s whole ask, not withdrawn');
assert.equal(Alternative.lineLimit({ ...standing, price: 60000 }, ctx), null, 'and a standing bid under that ask stays: both sides agree');
// An enchanted bid with no economy price has no price belief: the look still
// withdraws it at its own town's whole ask (the cap needs no belief).
board.clear();
shop(1, 74000, 1, { enchant: 1 });
assert.deepEqual(Pricing.look(buyer, [{ ...standing, enchant: 1 }], { ...ctx, reviewReasons: new Map([[2, 4]]) })
    ?.withdrawals.map(move => move.lineId), [2],
'a crossed bid with no price belief is withdrawn by the look');
board.clear();
shop(1, 74000);
assert.doesNotThrow(() => Alternative.assertMeetingPurchase([agreed(74000)], 0, 'Dion', ctx),
    'an agreed meeting buy at the shop price stays consented');
board.clear();
away(1, 74000, 2);
assert.equal(Alternative.lineLimit({ ...standing, price: 90000 }, ctx), 74000, 'another town\'s ask lowers the bid');
assert.equal(Alternative.lineLimit(standing, ctx), null, 'and a bid at it stands');
shop(2, 70000);
assert.equal(Alternative.lineLimit({ ...standing, count: 2, price: 90000 }, ctx), 74000,
    'a partial own-town lot is no whole purchase: the other town\'s whole lot caps');
board.clear();
shop(1, 74000);
away(2, 60000);
assert.equal(Alternative.lineLimit({ ...standing, price: 70000 }, ctx), 60000,
    'a cheaper whole lot elsewhere caps a bid under the own-town ask');
board.clear();
npc = [{ sourceType: 'npc', selfId: ITEM, price: 80000, town: 'Dion', available: true }];
shop(1, 74000);
assert.equal(Alternative.lineLimit({ ...standing, count: 2, price: 90000 }, ctx), 77000,
    'one shop unit and one NPC unit cap the bid, not withdraw it');
npc = [];

// A bid does not yield to a meeting (T76, supply-driven market): a cheaper
// meeting-only ad of its own town neither withdraws nor caps it; a shop's
// ask at the same price does.
board.clear();
shop(1, 74000, 1, { custodyPolicy: 1, kind: 'sell_ad' });
assert.equal(Alternative.lineLimit(standing, ctx), null, 'a bid at its own town\'s meeting-only ask stands');
assert.equal(Alternative.lineLimit({ ...standing, price: 90000 }, ctx), null, 'a bid over it stands too');
board.clear();
shop(1, 74000);
assert.equal(Alternative.lineLimit(standing, ctx), 0, 'a shop\'s ask at the bid still crosses it');
// Cheaper lines of other towns do not hide the own town's ask.
board.clear();
for (let id = 100; id <= 120; id++) away(id, 70000);
shop(1, 74000);
assert.equal(Alternative.lineLimit(standing, ctx), 0, 'the own town\'s ask behind 21 cheaper lines still crosses');

// Only a crossing bid leaves: one under its own town's whole ask stands, a
// new one opens under it, and a reprice stays under it.
board.clear();
shop(1, 74000);
assert.equal(Alternative.lineLimit({ ...standing, price: 70000 }, ctx), null, 'a bid under its own town\'s ask stands');
const under = Pricing.bid(ITEM, ctx, { units: 1, worth: 60000, cap: 60000, town: 'Dion', money: 1000000,
    rollKey: ['under-own'] });
assert(under?.price > 0 && under.price <= 60000, 'a bid whose limit is under the ask opens');
const repriced = Pricing.look(buyer, [{ ...standing, price: 60000, pricing: { ...standing.pricing, price: 60000 } }],
    { ...ctx, preparedWorth: () => 34454032, reviewReasons: new Map([[2, 4]]) });
assert(!repriced?.withdrawals?.length && (repriced?.reprices || []).every(move => move.price < 74000),
    'a reprice of a standing bid never lands on its own town\'s ask');
// The money a new bid may fund (its queue's share, here half the wallet)
// cannot buy the lot; once it stands on the whole wallet it is not withdrawn.
const funded = Pricing.bid(ITEM, { ...ctx, adena: 100000 }, { units: 1, worth: 34454032, cap: 50000,
    town: 'Dion', money: 50000, rollKey: ['x'] });
assert(funded?.price > 0 && funded.price <= 50000, 'a bid the queue funds under the ask opens');
assert.equal(Alternative.lineLimit({ ...standing, price: funded.price }, { ...ctx, adena: 100000 - funded.price }), null,
    'the plan rebuild keeps that standing bid');

// A changed route invalidates the scalar attention cache without new deals
// or a moved public quote. The native pricing cursor is applied between looks.
board.clear();
npc = [{ sourceType: 'npc', selfId: ITEM, price: 80000, town: 'Giran', available: true }];
routes.Giran = { known: true, hours: .1, fees: 0 };
const Look = require('../src/GameServer/Bot/Economy/BoardLook');
const seen = new Look.SeenLines();
const naturalCtx = { ...ctx, preparedWorth: () => 34454032 };
const firstReview = Pricing.lookOwn(buyer, [line], naturalCtx, seen);
if (firstReview?.reprices?.length) Object.assign(line, firstReview.reprices[0]);
assert(line.price > 80000);
routes.Giran = { known: true, hours: 0, fees: 0 };
const cheaperRoute = Pricing.lookOwn(buyer, [line], naturalCtx, seen);
assert(cheaperRoute?.reprices?.[0]?.price <= 80000, 'a cheaper route triggers a natural reprice without a new trade');

const Town = invoke('GameServer/Bot/Economy/MarketTownPolicy');
// The twin keeps the town of its oldest escrow buy record; the worker's
// bids are priced there and published there (buyAdTown reads the twin).
const twin = require('../src/GameServer/Bot/Economy/TwinCluster').propose(buyer, { board: { ownerLines: () => [
    { kind: 'buy_ad', storeType: BUY, custodyPolicy: 0, selfId: ITEM, count: 1, recordId: 8, town: 'Gludio' },
    { kind: 'buy_ad', storeType: BUY, custodyPolicy: 0, selfId: ITEM, count: 1, recordId: 7, town: 'Dion' }
] }, watchList: [], findSpot: () => null });
assert.equal(Town.buyAdTown(buyer, [{ selfId: ITEM }], { twin }), 'Dion',
    'worker preparation and native publication retain the oldest escrow buy record\'s town');
console.log('WTB alternatives: publication, review, quantities, routes, funding and conditional execution passed');
