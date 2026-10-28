'use strict';
// The census main publishes (DemandCensus) for a world at D: 30 level-25
// bots without gear of each of nine classes, whose kits want D pieces.
// rows(): the 'market' table rows the worker mirrors ([key, row]).
const Demand = invoke('GameServer/Bot/Economy/MarketDemand');
const Census = require('../../src/GameServer/Bot/Economy/DemandCensus');

function start() {
    const states = [];
    for (const [at, classId] of [0, 10, 18, 25, 31, 38, 44, 49, 53].entries()) for (let n = 0; n < 30; n++)
        states.push({ characterId: 930000 + at * 100 + n, level: 25, stats: { classId }, adena: 10000, inventory: {} });
    Census.start({ subscribePublications(listener, options) {
        for (const state of states) listener({ characterId: state.characterId, state, kind: 'put' });
        options.onReplayed?.();
        return () => {};
    } });
    Census.flush();
}
const rows = () => Demand.rows().map(row => [row[0], row]);
module.exports = { start, rows, stop: () => Census.stop() };
