'use strict';
// A far bot's plan edges (ColdEconomyPlan.edges, the worker's ask for a
// prepared plan): a crossing that happened while the bot rested, travelled
// or was in a party is seen at the first step that can act again, also when
// the stretch ended outside edges (main released the party); a stretch where
// nothing crossed asks nothing.
const assert = require('node:assert/strict');
require('../src/Global');
const Plan = require('../src/GameServer/Bot/Population/ColdEconomyPlan');

// The next wish costs 1000 with a 500 funded price: reached at 1500 adena.
const money = [100, 0, 0, 1000, 1, 500, 0];
function state(activity, adena, items = {}, extra = {}) {
    const inventory = { 57: { selfId: 57, amount: adena } };
    for (const [id, amount] of Object.entries(items)) inventory[id] = { selfId: Number(id), amount };
    return { characterId: 1, activity, level: 30, adena, inventory, stats: { money: [...money] }, ...extra };
}
const at = (row, revision) => ({ ...row, simulation: { revision } });
// One worker record across the steps, as the kernel keeps it. Each step
// starts from the state its previous step committed: one revision later.
function walk(steps, record = {}) {
    const bits = [];
    for (let step = 1; step < steps.length; step++) bits.push(edges(at(steps[step - 1], step), steps[step], record));
    return bits;
}
const edges = (before, after, record) => Plan.edges(before, after, { record, buyOrderEscrow: 0, stockFor: () => null });

// Money reached and loot taken inside a party are seen when it ends, once.
{
    const party = { partyId: 7 };
    const bits = walk([
        state('hunting', 1000),
        state('hunting', 1000, {}, party),
        state('hunting', 2000, { 1867: 5 }, party),
        state('hunting', 2000, { 1867: 5 }),
        state('hunting', 2000, { 1867: 5 })
    ]);
    assert.equal(bits[0], 0);
    assert.equal(bits[1], 0);
    assert.equal(bits[2] & 1, 1, 'loot from the party stretch');
    assert.equal(bits[2] & 4, 4, 'money reached in the party stretch');
    assert.equal(bits[3], 0, 'the next step compares against its own before');
}

// A party main releases between two steps: the next step starts out of the
// party (its before unblocked), and still sees what crossed inside it; a
// recompute of that step (the same before) sees it again, the step after
// it does not.
{
    const record = {};
    const party = { partyId: 8 };
    assert.equal(edges(at(state('hunting', 1000), 1), state('hunting', 1000, {}, party), record), 0);
    assert.equal(edges(at(state('hunting', 1000, {}, party), 2), state('hunting', 2000, { 1867: 5 }, party), record), 0);
    const released = at(state('hunting', 2000, { 1867: 5 }), 4);
    const exit = edges(released, state('hunting', 2000, { 1867: 5 }), record);
    assert.equal(exit & 5, 5, 'loot and money of a party main released are seen at the next step');
    assert.equal(edges(released, state('hunting', 2000, { 1867: 5 }), record) & 5, 5, 'a recomputed exit step reads the basis again');
    assert.equal(edges(at(state('hunting', 2000, { 1867: 5 }), 5), state('hunting', 2000, { 1867: 5 }), record), 0,
        'a step past the exit compares against its own before');
}

// A trip the kernel plans before the step (its before already travelling)
// after a spent stretch takes a fresh basis, not the old one: the arrival
// raises only what crossed on the trip.
{
    const record = {};
    walk([state('hunting', 1000), state('resting', 1000), state('hunting', 1000, { 1867: 5 })], record);
    assert.equal(edges(at(state('traveling', 1000, { 1867: 5 }), 10), state('traveling', 1000, { 1867: 5 }), record), 0);
    assert.equal(edges(at(state('traveling', 1000, { 1867: 5 }), 11), state('hunting', 1000, { 1867: 5 }), record), 0,
        'loot the exit already saw raises nothing at the next arrival');
}

// A level gained on a trip is seen at the arrival step.
{
    const bits = walk([
        state('hunting', 1000),
        state('traveling', 1000),
        state('traveling', 1000, {}, { level: 31 }),
        state('hunting', 1000, {}, { level: 31 })
    ]);
    assert.equal(bits[2] & 16, 16);
}

// Nothing crossed during a rest: leaving it asks for no plan.
{
    const bits = walk([
        state('hunting', 1000, { 1867: 5 }),
        state('resting', 1000, { 1867: 5 }),
        state('resting', 1000, { 1867: 5 }),
        state('hunting', 1000, { 1867: 5 })
    ]);
    assert.deepEqual(bits, [0, 0, 0]);
}

// A rest with no basis (begun before the worker started) asks once when left.
assert.equal(edges(at(state('resting', 1000), 3), state('hunting', 1000), {}) & 8, 8);

// Money that crossed and fell back during a party stretch is no crossing.
{
    const party = { partyId: 9 };
    const bits = walk([
        state('hunting', 1000),
        state('hunting', 2000, {}, party),
        state('hunting', 1000, {}, party),
        state('hunting', 1000)
    ]);
    assert.deepEqual(bits, [0, 0, 0]);
}

console.log('cold economy edge basis: ok');
