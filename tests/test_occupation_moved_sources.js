'use strict';
// A refresh or near work whose read source moves before it finishes is not
// begun again: it finishes and publishes once, and the slot's next request
// builds once (ColdOccupationPlanner finishesOnMove, design-rules Recompute).
const assert = require('node:assert/strict');
require('../src/Global');
const { ColdOccupationPlanner } = require('../src/GameServer/Bot/Population/ColdOccupationPlanner');

function plannerWith() {
    const tokens = new Map(), callbacks = [], published = [];
    let builds = 0;
    const planner = new ColdOccupationPlanner({ schedule: callback => callbacks.push(callback), now: () => 0,
        sourceToken: id => tokens.get(id) || 0,
        capture: (id, input, read) => { read(7); return { id, input, build: ++builds }; },
        create: captured => ({ captured, units: 0 }), step: work => ++work.units === 3,
        result: work => ({ known: true, build: work.captured.build }),
        publish: (id, input, value, meta = {}) => published.push({ id, value, meta }) });
    const drain = () => { while (callbacks.length) callbacks.shift()(); };
    // One portion: the work has begun and read item 7, it has not finished.
    const begin = input => { planner.request(1, input, { awaitResult: false }); callbacks.shift()(); };
    return { planner, tokens, published, drain, begin };
}

for (const mode of ['refresh', 'near']) {
    const { planner, tokens, published, drain, begin } = plannerWith();
    const input = { mode };
    begin(input);
    assert.equal(published.length, 0, `${mode}: the work is in flight`);
    // Many moves of the read source while it works: one event, no re-begin.
    for (let token = 1; token <= 5; token++) { tokens.set(7, token); planner.sourceChanged(7); }
    drain();
    assert.equal(published.length, 1, `${mode}: the moved work publishes once`);
    assert.equal(published[0].value.build, 1, `${mode}: the work begun first is the one published`);
    assert.notEqual(published[0].meta.stale, true, `${mode}: a finished plan is published, not a stale mark`);
    // The move schedules one recompute at the slot's next request.
    planner.request(1, input, { awaitResult: false }); drain();
    assert.equal(published.length, 2, `${mode}: the next request builds once`);
    assert.equal(published[1].value.build, 2);
    planner.request(1, input, { awaitResult: false }); drain();
    assert.equal(published.length, 2, `${mode}: the rebuilt slot is served until a source moves again`);
}

{
    // A move the source event missed (no sourceChanged) is found by the
    // check before publishing: the work still publishes, then rebuilds once.
    const { planner, tokens, published, drain, begin } = plannerWith();
    const input = { mode: 'refresh' };
    begin(input);
    tokens.set(7, 9);
    drain();
    assert.equal(published.length, 1);
    assert.equal(published[0].value.build, 1, 'a move found at the final check does not begin the work again');
    planner.request(1, input, { awaitResult: false }); drain();
    assert.equal(published.length, 2, 'the next request builds once');
}

{
    // Any other work (a meeting's proof, a step's workshop) begins again on
    // a moved source and publishes only the build decided on current reads.
    const { planner, tokens, published, drain, begin } = plannerWith();
    begin({ mode: 'occupation' });
    tokens.set(7, 1); planner.sourceChanged(7);
    drain();
    assert.equal(published.length, 1);
    assert.equal(published[0].value.build, 2, 'an occupation work begins again on a moved source');
}

console.log('PASS a refresh/near work on moved sources publishes once, then one recompute at the next request; other works begin again');
