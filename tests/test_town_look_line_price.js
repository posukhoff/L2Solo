const assert = require('assert');
const { useRate } = require('./helpers/progressionRate');

require('../src/Global');
useRate('x10');
invoke('GameServer/DataCache').init();
const PriceBelief = invoke('GameServer/Bot/Economy/PriceBelief');
const PriceDecision = invoke('GameServer/Bot/Economy/PriceDecision');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
const Look = invoke('GameServer/Bot/Economy/BoardLook');
const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
const { BoardIndex, BUY, SELL } = require('../src/GameServer/AfkTrade/BoardIndex');

// An unsold line, buy or sell, is passed once at each new town look of its
// owner: a sell line nobody bought is re-quoted lower, never under the NPC
// buyback; a bid nobody filled learns the market is above it.
const ITEM = 2;
const OWNER = 41;
const at = Date.now();
const buyback = PriceDecision.marketFor(ITEM).buyback;
assert(buyback > 0, 'fixture item has an NPC buyback');

function boardWith(rivalAsk) {
    const board = new BoardIndex({ groupOf: Counters.counterOf });
    if (rivalAsk) board.put({ id: 900, ownerId: 99, storeType: SELL, town: 'Giran',
        lines: [{ lineId: 900, selfId: ITEM, count: 1, price: rivalAsk }] });
    return board;
}
// ITEM is the owner's own product: its store line is worthwhile
// (MarketPricing.quotable), only the town look moves its price.
const context = board => ({ characterId: OWNER, timestamp: at, board, knowledgeEnabled: false, understanding: 0.5,
    ownProducts: () => new Set([ITEM]),
    hour: 1000, adena: 1e9, npcOffersFor: () => [], travel: () => 0, tripCost: null,
    trader: { wait: 0.03, assertiveness: 0.5, caution: 0.5, understanding: 0.5 } });
function sellLine(price, { custodyPolicy = 0, fills = 0 } = {}) {
    return { ownerId: OWNER, recordId: 1, lineId: 1, revision: 1, storeType: SELL, selfId: ITEM, enchant: 0,
        count: 1, price, town: 'Giran', custodyPolicy, fills,
        pricing: { price, seenCounter: 0, seenAt: at, seenItem: 0, rival: 0, worth: 0, seenFills: 0,
            seenCount: 1, sigma: 0.3 } };
}
const owner = n => ({ characterId: OWNER, inventory: {}, stats: { townLook: { n } } });
const applied = (line, move) => ({ ...line, price: move.price, revision: line.revision + 1, pricing: move.pricing });

// A rival asks twice the buyback: the owner's centre stands above the buyback.
const rivalBoard = boardWith(2 * buyback);
const centre = Math.round(Math.exp(PriceBelief.prior(ITEM, context(rivalBoard)).mu));
assert(centre > buyback, 'fixture centre is above the buyback');

for (const custodyPolicy of [0, 1]) {
    const seen = new Look.SeenLines();
    let line = sellLine(centre, { custodyPolicy });
    assert.strictEqual(Pricing.lookOwn(owner(0), [line], context(rivalBoard), seen), null,
        `custody ${custodyPolicy}: no town look, no deal: the line stands`);
    const first = Pricing.lookOwn(owner(1), [line], context(rivalBoard), seen);
    assert.strictEqual(first.reprices.length, 1, `custody ${custodyPolicy}: a town look re-quotes the unsold line`);
    assert(first.reprices[0].price < centre && first.reprices[0].price > buyback,
        `custody ${custodyPolicy}: lower, still above the buyback (${first.reprices[0].price})`);
    assert.strictEqual(first.withdrawals.length, 0);
    assert.strictEqual(Pricing.lookOwn(owner(1), [line], context(rivalBoard), seen), null,
        `custody ${custodyPolicy}: the same visit counts once`);
    line = applied(line, first.reprices[0]);
    const nextHour = { ...context(rivalBoard), hour: 1001 };
    assert.strictEqual(Pricing.lookOwn(owner(1), [line], nextHour, seen), null,
        `custody ${custodyPolicy}: a review without line evidence does not raise the lowered ask back`);
    const second = Pricing.lookOwn(owner(2), [line], context(rivalBoard), seen);
    assert(second.reprices[0].price < line.price && second.reprices[0].price > buyback,
        `custody ${custodyPolicy}: the next visit lowers it again`);
    assert.strictEqual(Pricing.lookOwn(owner(2), [line], context(rivalBoard), new Look.SeenLines()), null,
        `custody ${custodyPolicy}: a worker restart does not invent a visit`);
}

// A line that sold since its last look is not lowered by the visit.
{
    const seen = new Look.SeenLines();
    const line = sellLine(centre, { fills: 1 });
    Pricing.lookOwn(owner(0), [line], context(rivalBoard), seen);
    const looked = Pricing.lookOwn(owner(1), [line], context(rivalBoard), seen);
    assert(!looked?.reprices.some(move => move.price < centre), 'a filled line is not lowered');
    assert(!looked?.withdrawals.length);
}

// The centre falls to the buyback: the line holds its ask, no withdrawal.
{
    const quiet = boardWith(0);
    assert(Math.round(Math.exp(PriceBelief.prior(ITEM, context(quiet)).mu)) <= buyback,
        'fixture centre without a rival sits at the buyback');
    const seen = new Look.SeenLines();
    const line = sellLine(Math.round(buyback * 1.05));
    Pricing.lookOwn(owner(0), [line], context(quiet), seen);
    assert.strictEqual(Pricing.lookOwn(owner(1), [line], context(quiet), seen), null,
        'a quote at or under the buyback keeps the standing ask');
}

// A bid nobody filled is passed once by a visit; a filled bid gets no pass.
const bid = (fills = 0) => ({ storeType: BUY, fills, selfId: 1463, price: 20,
    pricing: { price: 20, seenCounter: 0, seenItem: 0, rival: 0, worth: 100, seenFills: 0 } });
const belief = { mu: Math.log(20), K: 3 };
const visit = PriceBelief.lineObservations(bid(), belief, { timestamp: at, visit: true });
assert.strictEqual(visit.length, 1);
assert(visit[0][0] > Math.log(20), 'an unanswered bid learns the market is above it');
assert(PriceBelief.lineObservations(bid(1), belief, { timestamp: at, visit: true }).every(row => row[0] <= Math.log(20)),
    'a filled bid gets no pass from the visit');
assert.strictEqual(PriceBelief.lineObservations(bid(), belief, { timestamp: at }).length, 0,
    'no visit, no deal: no evidence');
// A gear bid (ITEM, wished kit gear) is never passed (T76): the buyer waits
// at its price, the bid does not climb; its fills still learn.
const gearBid = (fills = 0) => ({ ...bid(fills), selfId: ITEM });
assert.strictEqual(PriceBelief.lineObservations(gearBid(), belief, { timestamp: at, visit: true }).length, 0,
    'an unanswered gear bid learns nothing on a visit');
const gearFilled = PriceBelief.lineObservations(gearBid(1), belief, { timestamp: at, visit: true });
assert(gearFilled.length === 1 && gearFilled[0][0] < Math.log(20), 'a filled gear bid still learns it paid enough');

// A finished market visit stamps the state: the count of the town looks.
const state = { characterId: 1, activity: 'shopping', stats: {}, timing: {}, loc: { x: 0, y: 0, z: 0 } };
const done = GoalExecutor.finishMarketVisit(state, at, { recoverMissingReturn: true });
if (done) {
    assert.strictEqual(done.stats.townLook.n, 1);
    assert.strictEqual(done.stats.townLook.at, at);
    const again = GoalExecutor.finishMarketVisit({ ...done, activity: 'shopping' }, at + 1, { recoverMissingReturn: true });
    if (again) assert.strictEqual(again.stats.townLook.n, 2);
}
assert.strictEqual(GoalExecutor.finishMarketVisit({ ...state, activity: 'hunting' }, at), null);

console.log('town look line price passed');
process.exit(0);
