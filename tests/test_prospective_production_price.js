'use strict';
const assert = require('assert');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Price = invoke('GameServer/Bot/Economy/PriceDecision');
const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
const { BoardIndex, BUY, offerFields } = require('../src/GameServer/AfkTrade/BoardIndex');
const timestamp = 1800000000000, id = 1864;
Counters.reset();
const board = new BoardIndex({ groupOf: Counters.counterOf });
board.put({ id: 71, revision: 3, custodyPolicy: 1, ownerId: 9, storeType: BUY, town: 'Giran',
    lines: [{ lineId: 72, selfId: id, count: 4, price: 1000 }] });
const line = board.records.get(71)[0];
const state = { characterId: 1, marketTrades: {}, stats: {} };
const options = { board, timestamp };
const exit = { offer: line, conditional: true, count: line.count, price: line.price, town: line.town };
const trial = Price.prospectiveExit(state, exit, options);
assert(trial.prospective.known);
assert.strictEqual(trial.conditional, true);
assert.strictEqual(trial.trial, true);
assert.strictEqual(trial.prospective.applicableUnits, 4);
assert.strictEqual(trial.prospective.willingUnits, 4, 'a posted bid takes its own count');
assert.deepStrictEqual(trial.prospective.authority, { recordId: 71, lineId: 72, revision: 3 });
assert.strictEqual(trial.prospective.observedAt, timestamp);
const Policy = invoke('GameServer/Bot/Economy/WealthCraftPolicy');
const recipe = { type: 'dwarven', productId: id, productCount: 1, successRate: 100, mpCost: 1, materials: [] };
const craftState = { ...state, adena: 1000, vitals: { mp: 10 } };
const context = { hourAdena: 100, moneyPrice: 0.01, mpPerHour: 100, existingOutput: 0 };
const basket = { cashCost: 0, ownedValue: 0, actualCashFees: 0, travelHours: 0,
    processingHours: 0, extraMp: 0, residualValue: 0, cost: 0, purchases: [], tripTowns: new Set() };
const evaluate = (exit, extra = {}) => Policy.drain(Policy.evaluatePrepared({ state: craftState,
    recipe, basket, exit, context, ...extra }));
assert(evaluate(trial).expectedSold > 0, 'a proven finite public bid can value one physical trial');
assert.strictEqual(evaluate(trial, { batches: 2 }), null, 'native recheck cannot enlarge the first trial');
assert.strictEqual(evaluate({ ...trial, offer: { ...line, revision: 2 } }), null,
    'an inconsistent authority cannot turn a conditional bid into receipts');
assert.strictEqual(evaluate({ ...trial, applicableUnits: NaN }), null, 'an unknown competitive tail stays unknown');
assert.strictEqual(evaluate(trial, { context: { ...context, existingOutput: 4 } }), null,
    'existing output occupies the finite market before another batch');
assert.strictEqual(exit.trial, undefined, 'source metadata is not mutated');
assert(Price.prospectiveExit(state, { ...exit, offer: offerFields(line) }, options).prospective,
    'main native offerFields sourceId/expectedRevision identity is supported');

const outcome = Price.saleOutcome({ units: 100, applicableUnits: trial.prospective.applicableUnits,
    willingUnits: trial.prospective.willingUnits, cheaperUnits: 1, price: 1000, residualUnitValue: trial.residualUnitValue,
    delayHours: 0, discountRate: 0 });
assert(outcome.sold <= 4 && outcome.residual >= 96, 'finite interest and competition keep unfilled physical output');
assert.strictEqual(Price.prospectiveExit({ ...state, characterId: 9 }, exit, options).prospective, undefined);
assert.strictEqual(Price.prospectiveExit(state, null, options).prospective, undefined);
assert.strictEqual(Price.prospectiveExit(state, { ...exit, count: 5 }, options).prospective, undefined);
assert.strictEqual(Price.prospectiveExit(state, { ...exit, offer: { ...line, revision: 2 } }, options).prospective, undefined);
assert.strictEqual(Price.prospectiveExit(state, { ...exit, offer: { ...line, enchant: 1 } }, options).prospective, undefined);
board.remove(71);
assert.strictEqual(Price.prospectiveExit(state, trial, options).prospective, undefined, 'withdrawal clears a saved prospective snapshot');
console.log('prospective production pricing tests passed');
