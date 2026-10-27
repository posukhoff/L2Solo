'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Counters = require('../src/GameServer/Bot/Economy/MarketCounters');
const Flow = require('../src/GameServer/Bot/Economy/MarketDemand');
const Telemetry = require('../src/GameServer/Bot/Economy/MarketTelemetry');
const now = Date.now(), rows = new Map();
invoke('GameServer/AfkTrade/AfkTradeService');
Counters.reset();
Counters.publish({ register: (_name, source) => source.allRows().forEach(row => rows.set(row[0], row)),
    changed: (_name, row) => rows.set(row[0], row) });
const board = [{ selfId: 1464, quantity: 100, unitPrice: 80, town: 'Giran', occurredAt: now - 1000 }];
const fixed = [{ selfId: 1464, quantity: 1000, town: 'Giran', occurredAt: now - 600000 },
    { selfId: 1464, quantity: 2000, town: 'Giran', occurredAt: now - 300000 }];
Counters.load(board, fixed);
const replayed = Flow.forecast(1464, 'Giran', now);
assert(replayed.applicableUnits > 1000, 'fixed merchants reveal the shot flow despite almost no peer sales');
assert.equal(Counters.itemDeals(1464).deals, 1, 'supply receipts do not inflate peer trading experience');
assert.deepEqual(Counters.itemDeals(1464).prices, [80], 'fixed prices do not become peer price evidence');
const obsolete = [2, 3].map(days => ({ selfId: 2275, quantity: 100, unitPrice: 20000,
    town: 'Giran', occurredAt: now - days * 24 * 3600000 }));
Counters.reset(); Counters.load([...obsolete, ...board], fixed);
assert.equal(Counters.itemDeals(2275).deals, 2, 'old price observations remain available');
assert.equal(Flow.forecast(2275, 'Giran', now), null, 'restart does not revive demand for obsolete recipes');
// The same receipts in any order give the same flow: a late receipt adds its
// own decayed share instead of inflating the earlier flow.
const liveReceipts = [...board, ...fixed].map((row, at) => ({ ...row, occurredAt: now + (at + 1) * 1000 }));
const replay = list => { Flow.reset(); for (const row of list) Flow.deal(row.selfId, row.quantity, row.town, row.occurredAt); };
replay(liveReceipts);
const ordered = Flow.forecast(1464, 'Giran', now + 3000);
replay(liveReceipts.slice().reverse());
const late = Flow.forecast(1464, 'Giran', now + 3000);
assert.equal(late.applicableUnits, ordered.applicableUnits);
assert(Math.abs(late.arrivalsPerHour - ordered.arrivalsPerHour) < 1e-12,
    'a late receipt is decayed to the current observation instead of inflating earlier flow');
Counters.reset();
const offer = { selfId: 2511, price: 1750, town: 'Giran', sourceType: 'configured_store', sellerKind: 'fixed' };
Telemetry.purchase(offer, 1000); Telemetry.purchase(offer, 1000);
assert(Flow.forecast(2511, 'Giran'), 'live completed fixed purchases reach the producer forecast');
assert.equal(Counters.itemDeals(2511).deals, 0);
assert.equal(Flow.forecast(2511, 'Dion'), null, 'public flow retains its actual town');
Counters.deal(1881, 9000, 100, now - 1000, 11, 'Giran', 12);
Counters.deal(1881, 9000, 100, now, 11, 'Giran', 13);
assert(Flow.forecast(1881, 'Giran', now), 'completed material purchases inform ordinary listings too');
assert.equal(Flow.forecast(2275, 'Giran', now), null, 'listing an unpopular recipe creates no buyer flow');
assert.equal(Flow.forecast(1881, 'Giran', now + 24 * 3600000), null, 'old purchases decay out');
const native = Flow.forecast(1881, 'Giran', now);
Flow.useTable(() => rows);
assert.deepEqual(Flow.forecast(1881, 'Giran', now), native, 'worker and main see the same public aggregate');
Flow.reset();
console.log('PASS public fixed/peer flow, receipt order, material visibility and worker parity');
