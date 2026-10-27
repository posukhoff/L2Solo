const assert = require('assert');
require('../src/Global');
invoke('GameServer/DataCache').init();
// Public-price/decision pins use knowledge OFF, independently of learning pace.
const originalInvoke = global.invoke;
global.invoke = (name) => name === 'GameServer/Bot/Economy/PriceLearning'
    ? { knowledgeEnabled: () => true, errorOf: () => { throw new Error('public pins must not request personal error'); } }
    : originalInvoke(name);
const PriceBelief = invoke('GameServer/Bot/Economy/PriceBelief');
const MarketPricing = invoke('GameServer/Bot/Economy/MarketPricing');
global.invoke = originalInvoke;
const PriceDecision = invoke('GameServer/Bot/Economy/PriceDecision');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const { BoardIndex, SELL, BUY } = require('../src/GameServer/AfkTrade/BoardIndex');
const Alternative = require('../src/GameServer/Bot/Economy/BidPurchaseAlternative');

// N79 keeps all public sources and the expected-value decision; personal
// item memory, fading and attention chance are deliberately removed.
const now = 1800000000000;
const STEM = 1864;
MarketCounters.reset();
for (let deal = 0; deal < 40; deal++) MarketCounters.deal(STEM, 1000, 10, now - (40 - deal) * 90000, 7);
const board = new BoardIndex({ groupOf: MarketCounters.counterOf });
const ctx = (extra = {}) => ({ characterId: 1, understanding: 0.5, timestamp: now, board,
    knowledgeEnabled: false, marketTrades: {}, ...extra });
const prior = PriceBelief.prior(STEM, ctx());
assert(Math.abs(Math.exp(prior.mu) / 1000 - 1) < 0.35, 'recent item deals still dominate public price');
assert.strictEqual(prior.bias, 0, 'knowledge OFF has no personal error');
board.put({ id: 1, ownerId: 9, storeType: SELL, town: 'Giran', lines: [{ lineId: 1, selfId: STEM, count: 5, price: 950 }] });
board.put({ id: 2, ownerId: 8, storeType: BUY, town: 'Giran', lines: [{ lineId: 2, selfId: STEM, count: 5, price: 900 }] });
const withOffers = PriceBelief.prior(STEM, ctx());
assert.strictEqual(withOffers.K, prior.K + 2, 'best ask and best buy each retain weight one');
assert(Math.abs(withOffers.mu - (prior.mu * prior.K + Math.log(950) + Math.log(900)) / (prior.K + 2)) < 1e-12,
    'prior weights/sources unchanged');
const belief = { mu: Math.log(1000), K: 10 };
PriceBelief.learn(belief, [[Math.log(1000) - 0.5 * PriceBelief.sigma(belief), 3]]);
assert(Math.exp(belief.mu) < 1000 && belief.K === 13, 'passed buyers still add downward evidence weight');
assert(!PriceBelief.learn(belief, []), 'no evidence adds no weight');
assert.strictEqual(PriceBelief.readBook, undefined);
assert.strictEqual(PriceBelief.writeBook, undefined);
assert.strictEqual(PriceBelief.lookup, undefined);
assert.strictEqual(MarketPricing.lookChance, undefined);
assert.strictEqual(MarketPricing.learnDeal, undefined);

// The ask. Value of money: a base rate plus the bot's need.
assert.strictEqual(PriceDecision.waitRate({ hourAdena: 76797, moneyPrice: 0, gapHorizonHours: 0 }), 0);
assert(Math.abs(PriceDecision.waitRate({ hourAdena: 76797, moneyPrice: 3.235e-5, gapHorizonHours: 59.1 }) - .042) < .002);
const market = (rival = null, buyersPerHour = 4) => ({ buyback: 50, buyersPerHour, lot: 1, units: 1,
    known: true, applicableUnits: buyersPerHour > 0 ? 4 : 0, delayHours: buyersPerHour > 0 ? 1 / buyersPerHour : 0,
    rivals: rival ? [{ landed: rival, units: 1 }] : [], npcLanded: Infinity, ownTrip: 0 });
const believed = { mu: Math.log(1000), K: 10 };
const needy = { wait: PriceDecision.waitRate({ hourAdena: 123854, moneyPrice: 7.304e-5, gapHorizonHours: 21.9 }), assertiveness: 0.5, caution: 0.5 };
const richBold = { wait: 0, assertiveness: 0.95, caution: 0.5 };
const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
// Where buyers are few (one an hour) the wait costs: a needy seller undercuts.
const asks = (trader, rival) => Array.from({ length: 21 }, (_, at) => PriceDecision.chooseAsk(believed, market(rival, 1), trader, ['t', at]).price);
assert(median(asks(needy, 950)) <= median(asks(needy)), 'cheaper finite rivals reduce the ask');
assert(median(asks(richBold, 950)) >= median(asks(needy, 950)), 'assertiveness remains the same willingness assessment');
assert(median(asks(richBold)) > median(asks(needy)), 'assertiveness and money: a higher ask');
// Loss aversion: a sale under the bot's own value weighs 1 + caution.
assert.strictEqual(PriceDecision.saleUtility(1200, 1000, 0.5), 1200);
assert.strictEqual(PriceDecision.saleUtility(800, 1000, 0.5), 700);
const timid = { ...needy, caution: 0 };
const careful = { ...needy, caution: 1 };
const lowBelief = { mu: Math.log(1000), K: 2 };
const slow = market(null, 0.05);
const timidAsk = median(Array.from({ length: 20 }, (_, at) => PriceDecision.chooseAsk(lowBelief, slow, timid, ['c', at]).price));
const carefulAsk = median(Array.from({ length: 20 }, (_, at) => PriceDecision.chooseAsk(lowBelief, slow, careful, ['c', at]).price));
assert(carefulAsk >= timidAsk, `a cautious seller does not sell under its value to sell sooner (${carefulAsk} vs ${timidAsk})`);
// The NPC buy-back is the outside option, the NPC shop one more offer.
assert.strictEqual(PriceDecision.chooseAsk(believed, market(null, 0), needy, ['n']).npc, true, 'no buyers: the NPC');
const npcShop = { ...market(null), npcLanded: 600 };
assert(PriceDecision.chooseAsk(believed, npcShop, needy, ['s']).price < PriceDecision.chooseAsk(believed, market(null), needy, ['s']).price,
    'the NPC shop draws buyers away from a dearer ask; it is not a clamp');
// One roll among asks within 2% of the best.
const rolled = new Set(Array.from({ length: 40 }, (_, at) => PriceDecision.chooseAsk(believed, market(), needy, ['r', at]).price));
assert(rolled.size >= 1 && rolled.size <= 4, `a few near-best asks (${[...rolled]})`);

// A standing ask stays while it is among the near-best; a far one is replaced.
const fresh1 = PriceDecision.chooseAsk(believed, market(), needy, ['r', 1]);
assert.strictEqual(PriceDecision.chooseAsk(believed, market(), needy, ['r', 2], fresh1.price).price, fresh1.price);
assert.notStrictEqual(PriceDecision.chooseAsk(believed, market(), needy, ['r', 2], 5000).price, 5000);

// The bid mirrors the ask: under the bot's value, never over its cap.
const bids = Array.from({ length: 20 }, (_, at) => PriceDecision.chooseBid(believed, market(), needy, { worth: 1000, cap: 2000 }, ['b', at]));
assert(bids.every((bid) => bid.price < 1000), 'a bid under what the item is worth');
// The cap lies under the whole price grid: one adena over the buy-back.
assert.strictEqual(PriceDecision.chooseBid(believed, market(), needy, { worth: 1000, cap: 100 }, ['b'])?.price, 51,
    'a cap under the whole grid: the buy-back plus one');
// No NPC buy-back, no price over it to fall back to.
for (const buyback of [0, null, undefined]) {
    assert.strictEqual(PriceDecision.chooseBid(believed, { ...market(), buyback }, needy, { worth: 1000, cap: 100 }, ['b']), null,
        `no buy-back (${buyback}) and a cap under the grid: no bid`);
}
const patient = { ...needy, wait: 0.001 };
assert(median(Array.from({ length: 20 }, (_, at) => PriceDecision.chooseBid(believed, market(), patient, { worth: 1000, cap: 2000 }, ['p', at]).price))
    <= median(bids.map((bid) => bid.price)), 'a patient buyer bids lower');
// No ask goes at or below the NPC buy-back (50 here), so no bid sits there either.
const cheapBelief = { mu: Math.log(10), K: 10 };
const cheapBids = Array.from({ length: 20 }, (_, at) => PriceDecision.chooseBid(cheapBelief, market(), needy, { worth: 1000, cap: 2000 }, ['f', at]));
assert(cheapBids.every((bid) => bid === null || bid.price > 50), `no bid at or below the buy-back (${cheapBids.map((bid) => bid?.price)})`);
// A standing bid at the buy-back is not kept even where the near-best bids sit just above it.
const nearBuyback = PriceDecision.chooseBid({ mu: Math.log(52), K: 10 }, market(), { ...needy, wait: 1e-4 },
    { worth: 1000, cap: 2000 }, ['f', 0], 50);
assert(nearBuyback && nearBuyback.price > 50, `a standing bid at the buy-back is replaced (${nearBuyback?.price})`);
assert.strictEqual(PriceDecision.chooseBid(believed, { ...market(), purchaseCap: 50 }, needy, { worth: 1000, cap: 2000 }, ['f']), null,
    'an outside purchase at the buy-back is no bid');
assert.strictEqual(PriceDecision.chooseBid(cheapBelief, market(), needy, { worth: 1000, cap: 50 }, ['f']), null,
    'a cap under the buy-back: no bid');
// Where the price grid skips from the buy-back past the cap, the least price that fills is the bid.
const skipCap = 1000 * Math.exp(0.25 * PriceBelief.sigma(believed)) - 1;
assert(skipCap > 1001, 'the grid step above the buy-back lies past the cap');
assert.strictEqual(PriceDecision.chooseBid(believed, { ...market(), buyback: 1000 }, needy, { worth: skipCap, cap: skipCap }, ['g'])?.price, 1001,
    'one adena over the buy-back when no grid price fits under the cap');
assert.strictEqual(PriceDecision.chooseBid(believed, { ...market(), buyback: 1000 }, needy, { worth: skipCap, cap: 1000.5 }, ['g']), null,
    'the buy-back plus one over the cap: no bid');
// A grid price under the cap is the bid: one adena over the buy-back gives a
// seller nothing over the NPC (the crafter's meeting answer was a coin flip).
assert(Array.from({ length: 20 }, (_, at) => PriceDecision.chooseBid(believed, { ...market(), buyback: 1100 }, needy,
    { worth: 3000, cap: 3000 }, ['h', at]).price).every(price => price > 1101), 'a grid price under the cap, not the buy-back plus one');
// A bid standing at the buy-back plus one gives way once a grid price fits.
for (const trader of [needy, patient]) {
    assert(Array.from({ length: 20 }, (_, at) => PriceDecision.chooseBid(believed, { ...market(), buyback: 1100 }, trader,
        { worth: 3000, cap: 3000 }, ['h', at], 1101).price).every(price => price > 1101), 'a standing buy-back plus one gives way to a grid price');
}

// New listings always start at the board and keep only line cursors.
const marketContext = ctx({ trader: needy, adena: 100000, npcOffersFor: () => [], travel: () => 0, tripCost: null });
const firstChoice = MarketPricing.priceForSale(STEM, marketContext, { town: 'Giran', units: 1, rollKey: ['public', 1] });
assert(firstChoice && firstChoice.ask.price > 0);
const line = MarketPricing.lineState(STEM, marketContext, { price: firstChoice.ask.price });
assert.deepStrictEqual(Object.keys(line), ['price', 'seenCounter', 'seenAt', 'seenItem', 'rival', 'worth', 'seenFills', 'seenCount', 'sigma']);
assert.strictEqual(line.rival, 950);
assert.strictEqual(line.worth, 0);
assert.strictEqual(line.seenFills, 0);
board.put({ id: 1, ownerId: 9, storeType: SELL, town: 'Giran', lines: [{ lineId: 1, selfId: STEM, count: 5, price: 1900 }] });
const nextChoice = MarketPricing.priceForSale(STEM, marketContext, { town: 'Giran', units: 1, rollKey: ['public', 2] });
assert(nextChoice.belief.mu > firstChoice.belief.mu, 'a new quote reads the changed board, no saved belief fallback');

MarketCounters.reset();
console.log('Public prior and finite decisions: sources, width, asks, competition, loss aversion, bids, caps, standing prices passed');

// Finite physical clipping precedes probability mixing. The remaining goods
// keep their independently supported residual value in both branches.
const Valuation = require('../src/GameServer/Bot/Economy/EconomicValuation');
const Profit = require('../src/GameServer/Bot/Economy/CraftProfitPolicy');
const success = PriceDecision.saleOutcome({ units: 100, applicableUnits: 10, willingUnits: 10,
    cheaperUnits: 0, price: 100, residualUnitValue: 2 });
const failure = PriceDecision.saleOutcome({ units: 0, applicableUnits: 10, willingUnits: 10,
    cheaperUnits: 0, price: 100, residualUnitValue: 2 });
assert.deepEqual(success, { known: true, sold: 10, residual: 90, receipts: 1000, residualValue: 180 });
const outcomes = [{ probability: 0.6, receipts: success.receipts,
    monetaryResidual: success.residualValue, ownInputOpportunityValue: 100, cashNow: 20,
    actualCashFees: 10, foregoneBenefitHours: 0.25, cycleHours: 1 }, { probability: 0.4, receipts: failure.receipts,
    ownInputOpportunityValue: 100, cashNow: 20, actualCashFees: 10, foregoneBenefitHours: 0.25, cycleHours: 1 }];
const valued = Valuation.opportunity({ moneyPrice: 0.01 }, outcomes);
assert.equal(valued.expectedReceipts / 100, 6, 'one success draw then finite demand, never min(expected output,demand)');
assert.equal(valued.expectedResidual, 108);
assert(Math.abs(valued.valueHours - 5.53) < 1e-12, 'owned inputs, fees, cash and incompatible hours charged once');
const incremental = Valuation.createOpportunity({ moneyPrice: 0.01 });
for (const outcome of outcomes) assert(Valuation.addOutcome(incremental, outcome));
assert.deepEqual(Valuation.finishOpportunity(incremental), valued, 'yielded scalar outcomes retain exact accumulated value');
assert.equal(Valuation.opportunity({}, outcomes).known, false, 'missing monetary hour is explicit unknown');
assert.equal(Valuation.opportunity({ moneyPrice: 0.01 }, [{ probability: 0.6, receipts: 1 }]).known, false);
assert.equal(PriceDecision.saleOutcome({ units: 1, price: 100 }).known, false, 'missing applicability stays unknown');
assert.equal(PriceDecision.saleOutcome({ units: 1.5, applicableUnits: 10, willingUnits: 10, cheaperUnits: 0, price: 100 }).known, false);
const capped = PriceDecision.saleOutcome({ units: 100, applicableUnits: 10, willingUnits: 8,
    cheaperUnits: 3, price: 100, residualUnitValue: 2 });
assert.equal(capped.sold, 5, 'finite cheaper stock deducted once');
const before = PriceDecision.saleOutcome({ units: 7, applicableUnits: 10, willingUnits: 10, cheaperUnits: 0, price: 100 });
const after = PriceDecision.saleOutcome({ units: 107, applicableUnits: 10, willingUnits: 10, cheaperUnits: 0, price: 100 });
assert.equal(after.sold - before.sold, 3, 'added output shares the same without-case pool');
assert.deepEqual(Profit.materials([{ id: 1, selfId: STEM, amount: 6 }], {
    materials: [{ selfId: STEM, amount: 5 }, { selfId: STEM, amount: 5 }] }), null,
'one physical unit cannot serve duplicate ingredient entries');
assert.deepEqual(Profit.materials([{ id: 1, selfId: STEM, amount: 10 }, { id: 1, selfId: STEM, amount: 10 }], {
    materials: [{ selfId: STEM, amount: 5 }, { selfId: STEM, amount: 5 }] }), [{ id: 1, selfId: STEM, amount: 10 }]);
assert.equal(Profit.mpHours({ mpCost: 0 }, 1, {}), 0);
assert.equal(Profit.mpHours({ mpCost: 10 }, 1, {}), null);

const emptyBoard = new BoardIndex();
const unknownMarket = PriceDecision.marketFor(STEM, { board: emptyBoard, ownerId: 1, timestamp: now });
assert.equal(unknownMarket.known, false, 'deal counters are not item exposure/rate/lifetime');
assert(Number.isNaN(unknownMarket.buyersPerHour));
assert.equal(PriceDecision.chooseAsk(believed, unknownMarket, needy, ['unknown'], 950).price, 950,
'unknown external lifetime retains an accepted commitment');
emptyBoard.put({ id: 10, ownerId: 1, storeType: SELL, revision: 1, town: 'Giran', lines:
    Array.from({ length: 10 }, (_, at) => ({ lineId: at + 1, selfId: STEM, count: 10, price: 900 })) });
// Ten identical own lines form one physical stock (the caller's ownStock).
const stock = { known: true, groups: new Map([[`${STEM}:0`, { selfId: STEM, enchant: 0, units: 100, listedUnits: 100,
    prices: new Set([900]), scope: 'own', availability: { from: now, until: now } }]]) };
const finiteDemand = { known: true, origin: 'prepared_own_group', authority: { ownerId: 1 },
    selfId: STEM, applicableUnits: 10, delayHours: 0, availability: { from: now, until: now } };
const jointContext = { ...marketContext, ownStock: stock, demandFor: () => finiteDemand };
assert.equal(MarketPricing.priceForSale(STEM, jointContext,
    { town: 'Giran', units: 10, rollKey: ['joint'] }).market.units, 100);
stock.groups.get(`${STEM}:0`).prices.add(901);
assert.equal(MarketPricing.priceForSale(STEM, jointContext,
    { town: 'Giran', units: 10, rollKey: ['distinct'] }).market.known, false,
    'different accepted own asks cannot claim one declared exposure');
stock.groups.get(`${STEM}:0`).prices.delete(901);
stock.known = false;
assert.equal(MarketPricing.priceForSale(STEM, jointContext,
    { town: 'Giran', units: 10, rollKey: ['invalid_stock'] }).market.known, false,
    'failed physical preparation never invents a smaller profitable lot');
stock.known = true;
const directBoard = new BoardIndex();
directBoard.put({ id: 20, ownerId: 2, storeType: BUY, revision: 1, town: 'Dion',
    lines: [{ lineId: 20, selfId: STEM, count: 10, price: 200 }] });
directBoard.put({ id: 21, ownerId: 3, storeType: BUY, revision: 1, town: 'Giran',
    lines: [{ lineId: 21, selfId: STEM, count: 10, price: 100 }] });
const bestDirect = MarketPricing.bestAnswer(STEM, { ...marketContext, board: directBoard, moneyPrice: 0.0001,
    travel: () => 0, travelDetails: town => ({ known: true, hours: town === 'Dion' ? 1 : 0, fees: 0 }) }, { units: 10 });
assert.equal(bestDirect.line.town, 'Giran', 'town ranking uses the same physical time and monetary valuation as disposition');
const forbiddenLine = { ownerId: 1, recordId: 99, lineId: 99, selfId: 999999, storeType: SELL,
    count: 1, price: 100, revision: 1, pricing: { price: 100, seenCounter: 0 } };
assert.equal(MarketPricing.look({}, [forbiddenLine], { ...marketContext,
    reviewReasons: new Map([[99, 4]]), canSell: () => false }).withdrawals.length, 1,
    'known protection can withdraw an unknown-price item without inventing a prior');
// Unknown worth may only lower a bid to a cheaper outside purchase, never to the buy-back (50) or under it.
const staleBid = { ownerId: 1, recordId: 98, lineId: 98, selfId: STEM, storeType: BUY, town: 'Giran',
    count: 1, price: 400, revision: 1, pricing: { price: 400, seenCounter: 0, worth: 400 } };
const unknownWorth = (outside) => MarketPricing.look({}, [staleBid], { ...marketContext, preparedWorth: () => NaN,
    reviewReasons: new Map([[98, 4]]), purchaseCaps: new Map([[98, outside]]) });
assert.deepEqual(unknownWorth(50).reprices, [], 'unknown worth: no bid at the buy-back');
assert.equal(unknownWorth(50).withdrawals.length, 1, 'unknown worth: the ad goes instead');
assert.equal(unknownWorth(60).reprices[0].price, 60, 'unknown worth: a cheaper outside purchase above it still lowers the bid');
staleBid.price = staleBid.pricing.price = 50;
assert.equal(unknownWorth(1000)?.withdrawals.length, 1, 'unknown worth: a standing bid at the buy-back goes');
// Own standing bids outside a look (cold plan, native reviews): cash 40 a unit under the buy-back 50 withdraws.
assert.strictEqual(Alternative.lineLimit({ selfId: STEM, price: 60, count: 10, town: 'Giran' },
    { adena: 0, travelDetails: () => ({ known: true, hours: 0, fees: 200 }) }), 0, 'a cash limit under the buy-back withdraws');
assert.strictEqual(Alternative.lineLimit({ selfId: STEM, price: 60, count: 10, town: 'Giran' },
    { adena: 0, travelDetails: () => ({ known: true, hours: 0, fees: 0 }) }), null, 'a bid within the cash stands');
assert.equal(PriceDecision.marketFor(STEM, { board: emptyBoard, ownerId: 1, timestamp: now }).known, false,
'split listings never manufacture demand');
console.log('Finite outcome, owner stock and shared valuation fixtures passed');
