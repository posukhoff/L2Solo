'use strict';
// One finite sale into one bid (MVP-5): a bid, backed or conditional, buys
// its own count at its own price whatever the seller believes the item is
// worth (G2, user 2026-10-23), cheaper foreign asks serve the buyer first,
// own unsold goods count once, an uninspected cheaper tail is a limit, and
// an unreadable buyer is never revenue.
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const Price = invoke('GameServer/Bot/Economy/PriceDecision');
const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');

const ITEM = 1869, TOWN = 'Dwarven Village', timestamp = 1800000000000;
const seller = { characterId: 42, marketTrades: {} };
const persona = { traits: { assertiveness: 0.5, caution: 0 }, understanding: 0.3 };
let nextId = 100;
function put(board, { ownerId, storeType, count, price, custodyPolicy = 0, enchant = 0 }) {
    const id = nextId++;
    board.put({ id, ownerId, storeType, custodyPolicy, revision: 1, town: TOWN,
        lines: [{ lineId: id + 1000, selfId: ITEM, count, price, enchant }] });
    return board.list(ITEM, storeType).find(line => line.recordId === id);
}
const sale = (board, offer, options) => Price.bidSale(seller, offer,
    { board, timestamp, residualUnitValue: 10, ...options });

// A backed bid buys its count and no more; the rest is residual.
let board = new BoardIndex();
const backed = put(board, { ownerId: 7, storeType: 3, count: 3, price: 500 });
let result = sale(board, backed, { units: 10 });
assert.equal(result.status, 'ready');
assert.equal(result.after.sold, 3, 'a backed buyer takes only its count');
assert.equal(result.after.residual, 7);
assert.equal(result.gross, 3 * 500 + 7 * 10);

// A conditional bid of price P and count N takes min(N, my units) at P,
// whatever the seller believes: a public ask at a tenth of the bid (not a
// competitor here) leaves the bid's value unchanged.
board = new BoardIndex();
const conditional = put(board, { ownerId: 7, storeType: 3, count: 20, price: 500, custodyPolicy: 1 });
result = sale(board, conditional, { units: 50 });
assert.equal(result.status, 'ready');
assert.equal(result.after.sold, 20, 'a conditional bid takes its whole count');
assert.equal(result.after.receipts, 20 * 500, 'at its own price');
assert.equal(sale(board, conditional, { units: 5 }).after.receipts, 5 * 500, 'no more than the seller has');
const cheapBoard = new BoardIndex();
const cheapBelief = put(cheapBoard, { ownerId: 7, storeType: 3, count: 20, price: 500, custodyPolicy: 1 });
put(cheapBoard, { ownerId: 8, storeType: 1, count: 1, price: 50 });
const doubted = sale(cheapBoard, cheapBelief, { units: 50 });
assert.equal(doubted.status, 'ready');
assert.equal(doubted.after.receipts, 20 * 500, 'a seller who values the item low still values the bid at its price');

// Own unsold goods (free stock, accepted incoming, own lines) are sold
// first: the same new units add less.
const fresh = sale(board, conditional, { units: 5 });
const crowded = sale(board, conditional, { units: 5, oldUnits: 18 });
assert.equal(fresh.gross, 5 * 500);
assert.equal(crowded.gross, 2 * 500 + 3 * 10, 'own unsold goods lower the gain of new units');

// Cheaper foreign asks of the same enchant serve the buyer first; own and
// enchanted asks and dearer asks do not.
board = new BoardIndex();
const bid = put(board, { ownerId: 7, storeType: 3, count: 10, price: 500 });
put(board, { ownerId: 8, storeType: 1, count: 4, price: 400 });
put(board, { ownerId: 42, storeType: 1, count: 3, price: 300 });
put(board, { ownerId: 9, storeType: 1, count: 5, price: 350, enchant: 2 });
put(board, { ownerId: 11, storeType: 1, count: 6, price: 600 });
result = sale(board, bid, { units: 10, asks: board.list(ITEM, 1) });
assert.equal(result.cheaperUnits, 4);
assert.equal(result.after.sold, 6, 'a cheaper competitor takes its share of the bid first');

// A sixth cheaper ask behind five inspected ones that do not cover the bid:
// the competition is unknown, the bid gives no revenue.
board = new BoardIndex();
const deep = put(board, { ownerId: 7, storeType: 3, count: 20, price: 500 });
for (let at = 0; at < 6; at++) put(board, { ownerId: 20 + at, storeType: 1, count: 1, price: 300 + at });
result = sale(board, deep, { units: 5, asks: board.list(ITEM, 1) });
assert.equal(result.status, 'limit', 'an uninspected cheaper tail is a limit, not revenue');
assert.deepEqual(Price.cheaperAsks(board.list(ITEM, 1), { ownerId: 42, price: 500 }), { cheaperUnits: 5, tail: true });

// No buyer left after cheaper sellers: only the NPC residual.
board = new BoardIndex();
const covered = put(board, { ownerId: 7, storeType: 3, count: 2, price: 500 });
put(board, { ownerId: 8, storeType: 1, count: 5, price: 400 });
result = sale(board, covered, { units: 4, asks: board.list(ITEM, 1) });
assert.equal(result.after.sold, 0);
assert.equal(result.gross, 4 * 10, 'with no buyer left only the residual value remains');

// A conditional bid the seller cannot read (an edited record) is unknown.
board = new BoardIndex();
const stale = { ...put(board, { ownerId: 7, storeType: 3, count: 5, price: 500, custodyPolicy: 1 }), revision: 0 };
assert.equal(sale(board, stale, { units: 1 }).status, 'unknown', 'an unreadable buyer is not revenue');

// Answering a bid now: a conditional bid is valued at its price and count;
// one buyer with two lines is answered once, at its best line.
board = new BoardIndex();
const answerBid = put(board, { ownerId: 7, storeType: 3, count: 4, price: 500, custodyPolicy: 1 });
put(board, { ownerId: 7, storeType: 3, count: 1, price: 450, custodyPolicy: 1 });
const trip = () => 0; trip.details = () => ({ known: true, hours: 0, fees: 0 });
const ctx = Pricing.traderContext({ characterId: 42, adena: 0, inventory: {}, stats: {} }, { board, timestamp, persona,
    economy: { hourAdena: 10000, moneyPrice: 0.001, worth: () => 0, trip, board } });
const answer = Pricing.bestAnswer(ITEM, ctx, { units: 6, residualUnitValue: 10 });
const expected = sale(board, answerBid, { units: 6 });
assert.equal(answer.line.lineId, answerBid.lineId);
assert.equal(answer.count, 4, 'the physical answer offers the bid count; the trade checks the money');
assert.equal(answer.outcome.sold, expected.after.sold);
assert.equal(answer.outcome.receipts, 4 * 500, 'a conditional bid is valued at its whole count');

// A backed bid is answered with its count and valued in full.
board = new BoardIndex();
const backedAnswer = put(board, { ownerId: 7, storeType: 3, count: 4, price: 500 });
const backedCtx = Pricing.traderContext({ characterId: 42, adena: 0, inventory: {}, stats: {} }, { board, timestamp, persona,
    economy: { hourAdena: 10000, moneyPrice: 0.001, worth: () => 0, trip, board } });
const paid = Pricing.bestAnswer(ITEM, backedCtx, { units: 6, residualUnitValue: 10 });
assert.equal(paid.line.lineId, backedAnswer.lineId);
assert.equal(paid.count, 4);
assert.equal(paid.outcome.sold, 4);
assert.equal(paid.outcome.receipts, 4 * 500, 'a backed bid pays its whole count');

// A bid at or under the NPC buy-back is no buyer (user 10-27): the seller's
// NPC exit beats it, so it sells nothing, sizes no lot and is no answer.
board = new BoardIndex();
const floorBid = put(board, { ownerId: 7, storeType: 3, count: 5, price: Price.buyback(ITEM) });
assert.notEqual(sale(board, floorBid, { units: 5 }).status, 'ready', 'a bid at the buy-back is no exit');
assert.equal(Price.bidLots(seller, floorBid, { board, timestamp }), 0, 'a bid at the buy-back takes no lot');
assert.equal(Pricing.bestAnswer(ITEM, Pricing.traderContext({ characterId: 42, adena: 0, inventory: {}, stats: {} },
    { board, timestamp, persona, economy: { hourAdena: 10000, moneyPrice: 0.001, worth: () => 0, trip, board } }),
{ units: 5, residualUnitValue: 10 }), null, 'a bid at the buy-back is not answered');
const overBid = put(board, { ownerId: 8, storeType: 3, count: 5, price: Price.buyback(ITEM) + 1 });
assert.equal(sale(board, overBid, { units: 5 }).after.sold, 5, 'one adena over the buy-back is a buyer');
console.log('PASS bid sale: a bid at its price and count, competitors, own stock, tail and answers');
