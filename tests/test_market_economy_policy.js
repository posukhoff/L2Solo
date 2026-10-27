const assert = require('assert');
const { useRate } = require('./helpers/progressionRate');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('market-economy-policy');
require('../src/Global');
isolated.assertConfigured(options.default);
useRate('x10');
const Data = invoke('GameServer/DataCache'); Data.init();
const Policy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const Lot = invoke('GameServer/Bot/Economy/MarketLotPolicy');
(async () => {
    // No fixed lot minimum by quantity or value (45a13735): every safe
    // physical count reaches the seller's economic decision.
    assert(Lot.viable({ selfId: 1865, count: 3, price: 100000000 }), 'a small lot reaches the economic decision');
    assert(Lot.viable({ selfId: 1804, count: 1, price: 40000 }), 'a single recipe is useful stock');
    for (const selfId of [1463, 1464, 2510, 3948]) {
        assert(Lot.viable({ selfId, count: 499, price: 1000000 }), 'a shot lot below 500 is not refused by count');
        assert(Lot.viable({ selfId, count: 500, price: 60 }), '500 shots is a valid batch');
    }
    // A viable material lot is the market's: no fixed shelf of 200 units and
    // no seller limit; each seller's expected value decides (group E).
    const material = { selfId: 1865, kind: 'Other.Material', count: 100, price: 1400, basePrice: 200 };
    const state = { characterId: 1, level: 40, stats: {} };
    assert.strictEqual(Policy.classify(state, material).action, 'market');
    assert.strictEqual(Policy.classify(state, { ...material, count: 3 }).action, 'market', 'a small lot is the market\'s too');
    console.log('Market lots and material lots for the market passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    fs.rmSync(isolated.directory, { recursive: true, force: true });
});
