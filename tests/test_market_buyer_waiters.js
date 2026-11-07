'use strict';
// The board's buyers: a bot's held build registers what it wants from player supply
// (its card's watch rows), a new or cheaper SELL line wakes at most five buyers of its
// item within their budgets (offer_posted at the bot's next step), and a woken want
// waits for the next build. No clock.
require('../src/Global');
const assert = require('node:assert/strict');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const { MarketBuyerWaiters, MAX_WANTS } = require('../src/GameServer/Bot/Economy/MarketBuyerWaiters');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');

async function main() {
    const now = 100000;
    const kernel = new ColdSimulationKernel({ now: () => now,
        planLifecycle: ({ state }) => ({ plannedState: state }),
        resolveSolo: () => ({ patch: {}, events: [], materialize: { items: [] }, nextResolveAt: now + 60000 }),
        emit: () => true });
    let capped = 0;
    const waiters = new MarketBuyerWaiters({ wake: (id, offer) => kernel.boardWake(id, offer), capped: () => capped++ });
    kernel.buyerEvents = waiters;
    const state = (id, overrides = {}) => ({ characterId: id, phase: 'cold', activity: 'hunting', level: 1,
        adena: 2000, inventory: {}, vitals: { hp: 100 }, stats: {},
        timing: { lastResolvedAt: now - 60000, nextResolveAt: now + 3600000 },
        updatedAt: now, simulation: { revision: 1 }, ...overrides });
    const board = new BoardIndex();
    const record = (id, price = 100, count = 10, lines = null) => ({ id, ownerId: 900, storeType: 1,
        lines: lines || [{ lineId: 7, selfId: 99, count, price }] });
    const publish = row => {
        const previous = board.records.get(row.id) || [];
        board.put(row);
        return waiters.recordChanged(row, previous);
    };
    try {
        for (let id = 1; id <= 12; id++) { kernel.upsert(state(id)); waiters.register(id, [{ itemId: 99, budget: 1500 }]); }
        for (let id = 100; id < 104; id++) { kernel.upsert(state(id)); waiters.register(id, [{ itemId: 1000 + id, budget: 1500 }]); }
        kernel.upsert(state(21, { phase: 'hot' })); waiters.register(21, [{ itemId: 99, budget: 1500 }]);
        assert.deepEqual(publish(record(1)), [1, 2, 3, 4, 5], 'a new offer wakes five buyers of its item');
        assert.deepEqual(kernel.states.get(1).boardWake, { seq: 1, itemId: 99, price: 100 }, 'raised at the next step: the offer');
        assert.equal(kernel.inFlight.size + kernel.commanding.size, 0, 'a wake starts no step: the bot hears it at its next one');
        assert.deepEqual(publish(record(1)), [], 'a metadata refresh is not a new offer');
        assert.deepEqual(publish(record(1, 100, 9)), [], 'a sale wakes no buyer');
        assert.deepEqual(publish(record(1, 90, 9)), [6, 7, 8, 9, 10], 'a cheaper line is a new offer');
        assert.deepEqual(publish(record(2, 10000)), [], 'an offer above every budget wakes none');
        assert.deepEqual(publish(record(3, 100, 10, [{ lineId: 1, selfId: 99, count: 5, price: 100 },
            { lineId: 2, selfId: 1100, count: 5, price: 100 }])), [11, 12, 100], 'one record wakes at most five');
        assert.deepEqual(publish(record(4, 100, 10, [{ lineId: 3, selfId: 99, count: 5, price: 100 }])), [],
            'a hot body is not woken: its wants are not a far bot\'s');
        // A woken want waits for the next build: the same offer again wakes nobody.
        assert.deepEqual(publish(record(5, 80, 10)), [], 'woken wants left the index until the next build');
        waiters.register(1, [{ itemId: 99, budget: 1500 }]);
        assert.deepEqual(publish(record(5, 70, 10)), [1], 'the next build registers its wants again');
        assert.equal(kernel.states.get(1).boardWake.seq, 2, 'a newer wake replaces the pending one');
        // A step that raised it commits: answered; a newer one waits.
        kernel.boardWakeAnswered(kernel.states.get(1), 1);
        assert(kernel.states.get(1).boardWake, 'an older step does not answer a newer wake');
        kernel.boardWakeAnswered(kernel.states.get(1), 2);
        assert.equal(kernel.states.get(1).boardWake, null);
        // At most MAX_WANTS a bot, the rest counted.
        waiters.register(200, Array.from({ length: MAX_WANTS + 2 }, (_, at) => ({ itemId: 500 + at, budget: 10 })));
        assert.equal(waiters.owners.get(200).length, MAX_WANTS);
        assert.equal(capped, 1, 'the wants past the cap are counted');
        kernel.remove(103);
        assert.deepEqual(publish(record(6, 100, 10, [{ lineId: 3, selfId: 1103, count: 5, price: 100 }])), [], 'a removed bot waits no more');
        console.log('market buyer waiters: PASS (wants of the build, bounded wakes at the next step, no clock)');
    } finally {
        await kernel.shutdown();
        assert.equal(waiters.items.size, 0);
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
