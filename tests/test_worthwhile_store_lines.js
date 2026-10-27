'use strict';
// A bot's store lines (shop SELL, sell ad) are only for worthwhile items
// (MarketPricing.quotable, user 2026-10-22, 2026-10-23): a recipe scroll, a
// gear piece of grade D and up, its own product, an item another owner bids
// for or one with forecast demand (MarketDemand.forecast). A recipe scroll or a
// gear piece needs no bid and no deal: it lists when its list value beats the
// NPC's price and goes to the NPC when it does not. Any other item is never
// quoted, and a standing line of it is withdrawn.
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Listing = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
const Decision = invoke('GameServer/Bot/Population/ColdEconomyDecision');
const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
const Plan = require('../src/GameServer/Bot/Population/ColdEconomyPlan');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const { SELL, BUY } = require('../src/GameServer/AfkTrade/BoardRules');

const HOUR = 60 * 60 * 1000;
const NOW = 1800000000000;
const BOT = 4242;
// Braided Hemp is the product of recipe 28, which the bot's workshop offers.
const OWN = 1878, BID = 1864, TRADED = 1865, NONE = 1868;
const MATERIALS = [OWN, BID, TRADED, NONE];
// Recipe scrolls and a D-grade gear piece nobody bids for and the board never
// traded. With the datapack's prices the bot's belief of SCROLL (848) and
// GEAR (49114) is above the NPC's (808, 47600), of CHEAP_SCROLL (1389) below
// it (1520).
const SCROLL = 2158, CHEAP_SCROLL = 2183, GEAR = 469;
// Every material has a board price well above the NPC's: only the rule decides.
const deal = (selfId, at, town = null) => Counters.deal(selfId, 5 * Counters.firstPrice(selfId, at), 1, at, 99, town);
const holder = (extra = {}) => ({ characterId: BOT, level: 40, adena: 50000, activity: 'hunting',
    stats: { generatedCold: true, twin: { workshop: [{ recipeId: 28, price: 1000 }] } },
    inventory: { ...Object.fromEntries(MATERIALS.map(selfId => [selfId, { selfId, amount: 100, kind: 'Other.Material' }])),
        ...Object.fromEntries([SCROLL, CHEAP_SCROLL, GEAR].map(selfId => [selfId, { selfId, amount: 1 }])) },
    ...extra });

Counters.reset();
try {
    // Board prices: each material traded once, out of any town (no
    // forecast); TRADED also trades in Giran every hour: a flow, forecast
    // demand without a standing bid.
    for (const selfId of [OWN, BID, NONE]) deal(selfId, NOW - 3 * HOUR);
    deal(TRADED, NOW - HOUR, 'Giran');
    const board = new BoardIndex();
    board.put({ id: 1, ownerId: 77, kind: 'buy_ad', storeType: BUY, town: 'Giran', custodyPolicy: 1,
        lines: [{ lineId: 1, selfId: BID, count: 1, price: 250 }] });

    // A first quote is a roll: across several decision points every
    // worthwhile item is offered at least once, the others never.
    const listed = new Set(), sold = new Set();
    for (let step = 0; step < 24; step++) {
        deal(TRADED, NOW + step * HOUR, 'Giran');
        const sale = Listing.evaluate(holder(), { now: NOW + step * HOUR, board, persona: null,
            npcOffersFor: () => [], findSpot: () => null, stockQuotes: true });
        for (const row of sale.listings) listed.add(Number(row.selfId));
        for (const row of sale.npc) sold.add(Number(row.selfId));
    }
    for (const selfId of [OWN, BID, TRADED, SCROLL, GEAR]) assert(listed.has(selfId), `worthwhile ${selfId} gets a store line`);
    assert(!listed.has(NONE), 'a material with no forecast, no bid and not its own product gets no store line');
    assert(!listed.has(CHEAP_SCROLL) && sold.has(CHEAP_SCROLL),
        'a recipe scroll whose list value is below the NPC price goes to the NPC');

    // A standing line of an item nobody wants is withdrawn; the lines of a
    // material with forecast demand and of a recipe scroll stand.
    const own = new BoardIndex();
    for (const [lineId, selfId] of [[11, NONE], [12, TRADED], [13, SCROLL]]) own.put({ id: lineId, ownerId: BOT,
        kind: 'sell_ad', storeType: SELL, town: 'Giran', custodyPolicy: 1,
        lines: [{ lineId, selfId, count: selfId === SCROLL ? 1 : 100, price: 900 }] });
    const resting = holder({ activity: 'resting' });
    const options = { board: own, now: NOW, findSpot: () => null, npcOffersFor: () => [], onTownDecision: () => {} };
    const economy = { ...Decision.economyFor(resting, options), moneyPrice: .001 };
    const iterator = Plan.prepare(resting, economy, options);
    let prepared;
    do { prepared = iterator.next(); } while (!prepared.done);
    assert.deepEqual(prepared.value.withdraw, [11], 'only the line of the item nobody wants is withdrawn');

    // A store line's review (a hot bot's natural break, a cold bot's review)
    // withdraws a line of an item nobody wants, whatever its custody.
    const review = (selfId, lineId) => ({ recordId: lineId, lineId, selfId, count: 1, price: 900, storeType: SELL,
        custodyPolicy: 0, ownerId: BOT, revision: 1, pricing: { seenCounter: 0 } });
    const ctx = { ...Pricing.traderContext(resting, { ...options, economy, timestamp: NOW }),
        reviewReasons: new Map([[21, 4], [22, 4], [23, 4]]) };
    const looked = Pricing.look(resting, [review(NONE, 21), review(SCROLL, 22), review(TRADED, 23)], ctx);
    assert.deepEqual((looked?.withdrawals || []).map(move => move.lineId), [21],
        'the review withdraws the line of the item nobody wants, the recipe scroll and the forecast material stand');

    // The worker reads the same prices from the published rows as main does.
    let allRows = null;
    Counters.publish({ register: (name, source) => { allRows = source.allRows; }, changed() {} });
    const nativePrices = [...Counters.itemDeals(TRADED).prices];
    const rows = new Map(allRows().map(row => [row[0], row]));
    Counters.useTable(() => rows);
    assert.deepEqual([...Counters.itemDeals(TRADED).prices], nativePrices, 'the mirror reads the native prices');
    console.log('PASS worthwhile store lines: recipe scroll and gear by value, own product, bid and forecast quote; others none; stale line withdrawn');
} finally { Counters.reset(); }
