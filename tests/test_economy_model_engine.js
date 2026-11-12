'use strict';

// The economy model's engine on an inline snapshot: a run is reproducible
// from its seed, the money stock moves by exactly the flows' net, and one
// hunting main levels, sells its loot, and travels to the town that sells
// its next kit piece while a craft station holds still. Items come in the
// amount of the hour's loot, spoils only to a line with Spoil, a main hunts
// the spot its bot stood at while that spot has an hour, fires the shots of
// its weapon's grade, and comes to town when the run's arrival rule says.
const assert = require('node:assert/strict');
const Engine = require('../scripts/economy-model/engine');

// Loot 30 an hour: the per-kill yields below at the NPC's price (10 kills x (0.5 x 5 + 0.01 x 50)).
const hour = (adena, exp, shots, loot = 30) => ({ classId: 9, shotId: 1463,
    best: { spotId: 's1', kills: 10, exp, adena, shots, dropLoot: loot, spoilLoot: 0, loot, potions: 0, busyShare: 1, deaths: 0 }, top: [] });
const yields = { town: 'TownA', drop: { 57: 10, 200: 0.5, 300: 0.01 }, spoil: {} };
const snapshot = {
    header: { levels: [1, 4], rates: { adena: 1 } },
    exp: [0, 100, 300, 600],
    hours: { 9: { 1: hour(100, 50, 20), 2: hour(100, 50, 20), 3: hour(100, 50, 20), 4: hour(100, 50, 20) } },
    kits: { 9: { 1: [{ selfId: 100, slot: 7 }], 2: [{ selfId: 101, slot: 7 }], 3: [{ selfId: 101, slot: 7 }], 4: [{ selfId: 101, slot: 7 }] } },
    yields: { 's1@1': yields, 's1@2': yields, 's1@3': yields, 's1@4': yields },
    items: {
        100: { kind: 'Weapon.Sword', grade: 'NONE', ref: 1000, npcBuy: 500 },
        101: { kind: 'Weapon.Sword', grade: 'D', ref: 2000, npcBuy: 1000 },
        200: { kind: 'Other.Material', grade: 'NONE', ref: 10, npcBuy: 5 },
        300: { kind: 'Other.Recipe', grade: 'NONE', ref: 100, npcBuy: 50 },
        1463: { kind: 'Other.Shot', grade: 'NONE', ref: 10, npcBuy: 5 },
        1835: { kind: 'Other.Shot', grade: 'NONE', ref: 5, npcBuy: 2 }
    },
    shotFamilies: { grades: ['NONE', 'D', 'C', 'B', 'A', 'S'], ids: [[1835, 1463, 1464, 1465, 1466, 1467]] },
    npcOffers: { preset: { 101: [{ town: 'TownB', price: 3000 }] }, x1: {} },
    recipes: [{ recipeItemId: 300, productId: 101 }],
    fares: { TownA: { TownA: 0, TownB: 5000 }, TownB: { TownA: 5000, TownB: 0 } }
};
const bands = [['low', 1], ['high', 2]];
const rates = { default: { huntShare: 1, visitsPerBotHour: 1 } };
// Once an hour, the first at a seeded share of the hour.
const hourly = (main, { event, now, pending, roll }) => (event === 'level_up' ? pending : now + (event === 'start' ? roll : 1));
const accounts = [
    { id: 1, station: false, classId: 9, line: '9', level: 1, exp: 0, money: 10000, shots: {}, held: [100], worn: { 7: 100 } },
    { id: 2, station: true, classId: 57, line: null, level: 40, exp: 0, money: 777, shots: {}, held: [], worn: {} }
];
const run = (seed, hours = 3) => Engine.simulate({ view: Engine.viewOf(snapshot), accounts, bands, rates, hours, seed, nextArrival: hourly });

// The design mode leaves the plain and today's ledger as they were: this
// fixture's 40-hour ledger hashes to the value recorded before the design
// mode existed.
const crypto = require('node:crypto');
assert.equal(crypto.createHash('sha256').update(JSON.stringify(run(3, 40))).digest('hex'), 'c8d5027d85bfd9ee63c979f9d53871285ec8f9731abfaa2bb1c4dee1d14f5888',
    'the ledger without the design mode is unchanged');

// The same seed gives the same ledger; another seed rolls other drops.
const first = run(7);
assert.deepEqual(run(7), first, 'a run is a function of its seed');
assert.notDeepEqual(run(4, 40), run(3, 40), 'another seed draws other drops');

// The money stock moves by the flows' net, to the adena.
for (const out of [first, run(3, 40)]) {
    assert.equal(out.money.delta, out.flows.net, 'money delta equals faucets plus sinks');
    assert.equal(out.money.closureGap, 0);
    assert.equal(out.flows.net, out.flows.faucets + out.flows.sinks);
}

// The hunting main: 3 h at 100 adena and 50 exp an hour, level 2 at 100 exp
// and 3 at 300 (6 h, beyond the run).
const hunter = first.progress.stageBands.low;
assert.equal(hunter.bots, 1);
assert.equal(hunter.levelUps, 1, 'level 2 after 2 hunting hours');
assert.equal(hunter.bandExits, 1, 'the main leaves its start band at level 2');
assert.ok(Math.abs(first.flows.totals.huntCold - 300) <= 3, `hunt adena ${first.flows.totals.huntCold} is the hour's adena times the hours, to a rounding per situation`);
assert.equal(hunter.expPerBotHour, 50);
// At level 2 its plan names piece 101, which only TownB's NPC sells: it pays
// the gatekeeper fare from its spot's town, buys the piece and sells the old one to the NPC.
assert.equal(first.flows.totals.fares, -5000);
assert.equal(first.flows.totals.npcBuys, -3000);
assert.equal(first.gear.boughtNpcUnits, 1);
assert.ok(first.gear.toNpcUnits >= 1, 'the replaced piece goes to the NPC');
assert.deepEqual(first.visits.towns.map(row => row.town).sort(), ['TownA', 'TownB']);
// Loot goes to the NPC at its buy price; nobody sells the hour's shots, so the restock stays open.
assert.ok(first.flows.totals.npcSales >= 500, 'the old piece and the materials sold');
assert.ok(first.counters.missingShots >= 1);
assert.equal(first.shots.used, 0, 'no shots held, none fired');
// The station hunts nothing and keeps its money.
assert.equal(first.progress.stageBands.station.money.meanEnd, 777);
assert.equal(first.population.botHours, 6);

// A recipe drop counts under its product's grade.
const long = run(3, 40);
assert.ok(long.recipes.droppedTotal > 0 && long.recipes.dropped.d === long.recipes.droppedTotal, 'recipes by product grade');

// Rare items arrive whole at their mean rate.
let sum = 0;
for (let i = 0; i < 20000; i++) sum += Engine.wholeCount(0.3, (() => { let s = i * 7919 + 1; return () => (s = (s * 16807) % 2147483647) / 2147483647; })());
assert.ok(Math.abs(sum / 20000 - 0.3) < 0.02, `mean whole count ${sum / 20000}`);

// Item amounts follow the hour's loot: twice the loot, twice the items.
const view = Engine.viewOf(snapshot);
const lootOf = loot => {
    const richer = { ...snapshot, hours: { 9: { ...snapshot.hours[9], 1: hour(100, 50, 20, loot) } } };
    return Engine.hunt(Engine.mainOf(accounts[0], 0, Engine.viewOf(richer), bands), Engine.viewOf(richer), 100, () => 0.5).main.bag[200];
};
assert.equal(lootOf(30), 500, '0.5 per kill x 10 kills x 100 h');
assert.equal(lootOf(60), 1000);
assert.equal(lootOf(0), undefined, 'an hour without loot drops nothing');

// A main with a no-grade weapon fires no-grade shots where the hour names D
// shots; with the D weapon it restocks D shots.
const plain = { ...Engine.mainOf(accounts[0], 0, view, bands), shots: { 1835: 1000 } };
assert.equal(plain.weapon, 100);
assert.equal(Engine.hunt(plain, view, 1, () => 0.5).main.shots[1835], 980, 'no-grade shots fired');
const armed = { ...plain, weapon: 101, shots: {} };
assert.deepEqual(Engine.errands(armed, view, snapshot.hours[9][1], { outingHours: 0.5 }).find(errand => errand.kind === 'shots'),
    { kind: 'shots', id: 1463, amount: 20 }, 'D shots, one hour of use');

// A spot's spoils (written at the highest Spoil level of any line there)
// reach only a row with spoil loot, at that loot.
const spoiled = { ...snapshot, yields: { ...snapshot.yields, 's1@1': { ...yields, spoil: { 201: 1 } } },
    items: { ...snapshot.items, 201: { kind: 'Other.Material', grade: 'NONE', ref: 20, npcBuy: 10 } } };
const bagOf = row => {
    const richer = { ...spoiled, hours: { 9: { ...spoiled.hours[9], 1: { ...hour(100, 50, 20), best: { ...hour(100, 50, 20).best, ...row } } } } };
    const at = Engine.viewOf(richer);
    return Engine.hunt(Engine.mainOf(accounts[0], 0, at, bands), at, 100, () => 0.5).main.bag;
};
assert.equal(bagOf({}).hasOwnProperty(201), false, 'a line without Spoil gets no spoil');
assert.equal(bagOf({ spoilLoot: 50, loot: 80 })[201], 500, 'spoil loot 50 an hour at 10 kills x 1 x 10 adena: half of the spawn mix\'s spoils');
assert.equal(bagOf({ spoilLoot: 50, loot: 80 })[200], 500, 'the drops follow the drop loot alone');

// A main hunts the spot its bot stood at while the snapshot has that spot's
// hour for its line and level, and moves to its line's best when a level-up
// leaves it without one.
const own = { spotId: 's2', kills: 10, exp: 50, adena: 1000, shots: 20, dropLoot: 0, spoilLoot: 0, loot: 0, potions: 0, busyShare: 1, deaths: 0 };
const placed = { ...snapshot, spotHours: { rows: { 9: { 1: { s2: own }, 2: { s2: null } } } },
    yields: { ...snapshot.yields, 's2@1': { town: 'TownA', drop: { 57: 100 }, spoil: {} } } };
const atOwn = Engine.simulate({ view: Engine.viewOf(placed), accounts: [{ ...accounts[0], spot: 's2' }], bands, rates, hours: 3, seed: 7, nextArrival: () => null });
assert.equal(atOwn.counters.startAtOwnSpot, 1);
assert.equal(atOwn.counters.leftOwnSpot, 1, 'level 2 has no hour at s2');
// Level 2 at 101 exp: 2.02 h at s2 (1000 an hour), the rest at the best spot (100 an hour).
assert.ok(Math.abs(atOwn.flows.totals.huntCold - (2.02 * 1000 + 0.98 * 100)) <= 3, `hunt adena ${atOwn.flows.totals.huntCold}`);
assert.deepEqual(atOwn.huntHours, { ownSpot: 2, bestSpot: 1 });

// The time of an arrival is nextArrival's alone: the band's visit rate does
// not send a main to town. The rule is asked at the start and again after each
// committed event that changes the main, a visit and a level-up, on the main as
// it is then (a visit has emptied the bag), and its answer is the one pending arrival.
const asked = [];
const at = times => (main, state) => { asked.push({ ...state, bag: Object.keys(main.bag).length, level: main.level }); return times.find(time => time > state.now) ?? null; };
const silent = { default: { huntShare: 1, visitsPerBotHour: 0 } }, busy = { default: { huntShare: 1, visitsPerBotHour: 100 } };
const ruled = Engine.simulate({ view: Engine.viewOf(snapshot), accounts, bands, rates: silent, hours: 3, seed: 7, nextArrival: at([0.5, 2.5]) });
assert.equal(ruled.counters.visits - ruled.counters.onwardHops, 2, 'arrivals at 0.5 h and 2.5 h at a visit rate of 0');
assert.deepEqual(asked.map(state => [state.now, state.event]), [[0, 'start'], [0.5, 'visit'], [2.02, 'level_up'], [2.5, 'visit']]);
assert.equal(asked[2].pending, 2.5, 'the level-up is asked with the arrival pending');
assert.equal(asked[2].level, 2);
assert.ok(asked.filter(state => state.event === 'visit').every(state => state.bag === 0), 'asked after the visit committed: the bag is sold');
assert.equal(asked[1].hour.exp, 50, 'the rule reads the main\'s hour row');
assert.equal(asked[1].shotsPerHour, snapshot.hours[9][1].best.shots);

// A level-up asks again and its answer replaces the pending arrival: the main
// levels at 2 h; the start answered 1.5, the level-up moves it to 2.9.
const levelAsked = [];
const replaced = Engine.simulate({ view: Engine.viewOf(snapshot), accounts: [accounts[0]], bands, rates: silent, hours: 3, seed: 7,
    nextArrival: (main, state) => { levelAsked.push([state.event, state.now, state.pending]); return state.event === 'start' ? 1.5 : state.event === 'level_up' ? 2.9 : null; } });
assert.deepEqual(levelAsked.map(row => row[0]), ['start', 'visit', 'level_up', 'visit'], 'asked after the visit at 1.5 h, the level-up and the visit at 2.9 h');
assert.equal(replaced.counters.visits - replaced.counters.onwardHops, 2, 'arrivals at 1.5 h and 2.9 h');
assert.equal(Engine.simulate({ view: Engine.viewOf(snapshot), accounts, bands, rates: busy, hours: 3, seed: 7, nextArrival: () => null }).counters.visits, 0,
    'a visit rate of 100 an hour sends nobody when the rule says never');
assert.throws(() => Engine.simulate({ view: Engine.viewOf(snapshot), accounts, bands, rates, hours: 3 }), /nextArrival/);

// A spot row with spoil loot where the snapshot holds no spoil yields loses
// that loot: the kills are counted, not dropped silently.
const lossy = { ...snapshot, spotHours: { rows: { 9: { 1: { s2: { ...own, spoilLoot: 40 } } } } }, yields: { ...snapshot.yields, 's2@1': { town: 'TownA', drop: { 57: 100 }, spoil: {} } } };
const lost = Engine.simulate({ view: Engine.viewOf(lossy), accounts: [{ ...accounts[0], spot: 's2' }], bands, rates, hours: 1, seed: 7, nextArrival: () => null });
assert.equal(lost.counters.spoilUnyielded, 10, 'ten kills with spoil loot and no spoil yields');
assert.equal(atOwn.counters.spoilUnyielded, 0, 'no spoil loot, nothing lost');

// The hunt rule is pure: the main it is given is left as it was.
const main = Engine.mainOf(accounts[0], 0, Engine.viewOf(snapshot), bands);
const frozen = JSON.stringify(main);
Engine.hunt(main, Engine.viewOf(snapshot), 2, () => 0.5);
assert.equal(JSON.stringify(main), frozen);

console.log('economy model engine: ok');
