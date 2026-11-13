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
const Today = require('../scripts/economy-model/today');

// Loot 30 an hour: the per-kill yields below at the NPC's price (10 kills x (0.5 x 5 + 0.01 x 50)).
const hour = (adena, exp, shots, loot = 30) => ({ classId: 9, shotId: 1463,
    best: { spotId: 's1', kills: 10, exp, adena, shots, dropLoot: loot, spoilLoot: 0, loot, potions: 0, busyShare: 1, deaths: 0 }, top: [] });
const yields = { town: 'TownA', drop: { 57: 10, 200: 0.5, 300: 0.01 }, spoil: {} };
const snapshot = {
    header: { levels: [1, 4], rates: { adena: 1 } },
    exp: [0, 100, 300, 600, 1e12],
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
// A plain run: every main hunts its row's own kit and fires the hour's shot (Today.hunter).
const plainRun = ({ view, ...options }) => Engine.simulate({ view, hunter: Today.hunter(view), ...options });
const run = (seed, hours = 3) => plainRun({ view: Engine.viewOf(snapshot), accounts, bands, rates, hours, seed, nextArrival: hourly });

// The design mode leaves the plain and today's ledger as they were: this
// fixture's 40-hour ledger hashes to the value recorded before the design
// mode existed, moved once since: a level is read when the exp reaches the
// level's exp, as levelOf counts it, no longer one exp later.
const crypto = require('node:crypto');
// The failure counters added since are left out of the hash: every other number is as before.
const pinned = out => { const { arrivalNotAhead, unlevelableMains, ...counters } = out.counters; return { ...out, counters }; };
assert.equal(crypto.createHash('sha256').update(JSON.stringify(pinned(run(3, 40)))).digest('hex'), '235d189ec6043f27bdde6516124894160c9d1da098497ae6537ffc9e3947ccfd',
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

// A party member hunts by the game's party rule: its exp is its share of what
// the party kills (one member's row exp for each member, the 3-member bonus
// 1.39, the split by squared level), its adena and drops a solo bot's per kill;
// a member far under the party's level gets no exp.
const partied = party => Engine.hunt({ ...Engine.mainOf(accounts[0], 0, view, bands), party }, view, 100, () => 0.5);
const solo = partied(null), trio = partied({ levels: [1, 1, 1], self: 0 });
assert.equal(solo.delta.exp, 5000);
assert.equal(trio.delta.exp, 6950, 'three equal members: 1.39 x a solo bot\'s exp');
assert.equal(trio.delta.flows.huntCold, solo.delta.flows.huntCold, 'adena stays a solo bot\'s');
assert.deepEqual(trio.main.bag, solo.main.bag, 'drops stay a solo bot\'s');
assert.equal(partied({ levels: [1, 50], self: 0 }).delta.exp, 0, 'under the squared-level cut: no exp');
// The hunt is the worn kit's: a kit making half the row's kills
// gains half its exp, adena and drops an hour.
{
    const main = Engine.mainOf(accounts[0], 0, view, bands), full = Engine.hunt(main, view, 100, () => 0.5);
    const half = Engine.hunt(main, view, 100, () => 0.5, null, { bare: 0.5, shots: 0.5, blessed: 0.5 });
    assert.equal(half.delta.exp, 2500, 'half the row\'s exp');
    assert.ok(Math.abs(half.delta.flows.huntCold - full.delta.flows.huntCold / 2) <= 1, `half the row's adena: ${half.delta.flows.huntCold} of ${full.delta.flows.huntCold}`);
    assert.ok(Math.abs((half.main.bag[200] || 0) - (full.main.bag[200] || 0) / 2) <= 1, `half the row's drops: ${half.main.bag[200]} of ${full.main.bag[200]}`);
}

// A main with a no-grade weapon fires no-grade shots where the hour names D
// shots; with the D weapon it restocks D shots.
const plain = { ...Engine.mainOf(accounts[0], 0, view, bands), shots: { 1835: 1000 } };
assert.equal(plain.weapon, 100);
assert.equal(Engine.hunt(plain, view, 1, () => 0.5, Today.hunter(view).firing(plain)).main.shots[1835], 980, 'no-grade shots fired');
const armed = { ...plain, weapon: 101, shots: {} };
assert.deepEqual(Engine.errands(armed, view, { outingHours: 0.5, firing: Today.hunter(view).firing(armed) }).find(errand => errand.kind === 'shots'),
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
const atOwn = plainRun({ view: Engine.viewOf(placed), accounts: [{ ...accounts[0], spot: 's2' }], bands, rates, hours: 3, seed: 7, nextArrival: () => null });
assert.equal(atOwn.counters.startAtOwnSpot, 1);
assert.equal(atOwn.counters.leftOwnSpot, 1, 'level 2 has no hour at s2');
// Level 2 at 100 exp: 2 h at s2 (1000 an hour), the rest at the best spot (100 an hour).
assert.ok(Math.abs(atOwn.flows.totals.huntCold - (2 * 1000 + 1 * 100)) <= 3, `hunt adena ${atOwn.flows.totals.huntCold}`);
assert.deepEqual(atOwn.huntHours, { ownSpot: 2, bestSpot: 1 });

// The time of an arrival is nextArrival's alone: the band's visit rate does
// not send a main to town. The rule is asked at the start and again after each
// committed event that changes the main, a visit and a level-up, on the main as
// it is then (a visit has emptied the bag), and its answer is the one pending arrival.
const asked = [];
const at = times => (main, state) => { asked.push({ ...state, bag: Object.keys(main.bag).length, level: main.level }); return times.find(time => time > state.now) ?? null; };
const silent = { default: { huntShare: 1, visitsPerBotHour: 0 } }, busy = { default: { huntShare: 1, visitsPerBotHour: 100 } };
const ruled = plainRun({ view: Engine.viewOf(snapshot), accounts, bands, rates: silent, hours: 3, seed: 7, nextArrival: at([0.5, 2.5]) });
assert.equal(ruled.counters.visits - ruled.counters.onwardHops, 2, 'arrivals at 0.5 h and 2.5 h at a visit rate of 0');
assert.deepEqual(asked.map(state => [state.now, state.event]), [[0, 'start'], [0.5, 'visit'], [2, 'level_up'], [2.5, 'visit']]);
assert.equal(asked[2].pending, 2.5, 'the level-up is asked with the arrival pending');
assert.equal(asked[2].level, 2);
assert.ok(asked.filter(state => state.event === 'visit').every(state => state.bag === 0), 'asked after the visit committed: the bag is sold');
assert.equal(asked[1].hour.exp, 50, 'the rule reads the main\'s hour row');
assert.equal(asked[1].shotsPerHour, snapshot.hours[9][1].best.shots);

// A level-up asks again and its answer replaces the pending arrival: the main
// levels at 2 h; the start answered 1.5, the level-up moves it to 2.9.
const levelAsked = [];
const replaced = plainRun({ view: Engine.viewOf(snapshot), accounts: [accounts[0]], bands, rates: silent, hours: 3, seed: 7,
    nextArrival: (main, state) => { levelAsked.push([state.event, state.now, state.pending]); return state.event === 'start' ? 1.5 : state.event === 'level_up' ? 2.9 : null; } });
assert.deepEqual(levelAsked.map(row => row[0]), ['start', 'visit', 'level_up', 'visit'], 'asked after the visit at 1.5 h, the level-up and the visit at 2.9 h');
assert.equal(replaced.counters.visits - replaced.counters.onwardHops, 2, 'arrivals at 1.5 h and 2.9 h');
assert.equal(plainRun({ view: Engine.viewOf(snapshot), accounts, bands, rates: busy, hours: 3, seed: 7, nextArrival: () => null }).counters.visits, 0,
    'a visit rate of 100 an hour sends nobody when the rule says never');
assert.throws(() => plainRun({ view: Engine.viewOf(snapshot), accounts, bands, rates, hours: 3 }), /nextArrival/);

// A spot row with spoil loot where the snapshot holds no spoil yields loses
// that loot: the kills are counted, not dropped silently.
const lossy = { ...snapshot, spotHours: { rows: { 9: { 1: { s2: { ...own, spoilLoot: 40 } } } } }, yields: { ...snapshot.yields, 's2@1': { town: 'TownA', drop: { 57: 100 }, spoil: {} } } };
const lost = plainRun({ view: Engine.viewOf(lossy), accounts: [{ ...accounts[0], spot: 's2' }], bands, rates, hours: 1, seed: 7, nextArrival: () => null });
assert.equal(lost.counters.spoilUnyielded, 10, 'ten kills with spoil loot and no spoil yields');
assert.equal(atOwn.counters.spoilUnyielded, 0, 'no spoil loot, nothing lost');

// A main out of its hour's shot hunts the row's hour without shots (fewer
// kills, less exp and adena) and counts the shots it wanted; a worn kit
// making half the reference kit's kills and firing half its shots earns half
// the adena and fires half the shots.
{
    const row = { ...hour(100, 50, 20).best, shotless: { kills: 5, exp: 25, adena: 50 } }, line = { ...hour(100, 50, 20), best: row };
    const dry = { ...snapshot, hours: { 9: { 1: line, 2: line, 3: line, 4: line } } }, at = Engine.viewOf(dry);
    const out = Engine.simulate({ view: at, accounts: [accounts[0]], bands, rates: silent, hours: 2, seed: 7, nextArrival: () => null, hunter: Today.hunter(at) });
    assert.ok(Math.abs(out.flows.totals.huntCold - 100) <= 1, `the shotless hour's adena, 2 x 50: ${out.flows.totals.huntCold}`);
    assert.equal(out.progress.stageBands.low.expPerBotHour, 25, 'the shotless hour\'s exp');
    assert.deepEqual([out.shots.used, out.shots.wanted], [0, 40], 'none fired, 2 hours of 20 wanted');
    const stocked = [{ ...accounts[0], shots: { 1835: 1000 } }];
    const worn = factors => Engine.simulate({ view: at, accounts: stocked, bands, rates: silent, hours: 2, seed: 7, nextArrival: () => null, hunter: Today.hunter(at, () => factors) });
    const full = worn(null), half = worn({ shots: { kills: 0.5, shots: 0.5 } });
    assert.deepEqual([full.flows.totals.huntCold, full.shots.used], [200, 40], 'the row\'s kit: its adena and shots');
    assert.deepEqual([half.flows.totals.huntCold, half.shots.used], [100, 20], 'half the kills and shots: half the adena and shots');
}

// A spot its occupation chose (the design mode's, one of its line's top
// spots at its level) is where the main hunts; without one, its own spot or
// its line's best.
{
    const top = { ...own, spotId: 's3', adena: 5000 };
    const ranked = { ...snapshot, hours: { 9: { ...snapshot.hours[9], 1: { ...snapshot.hours[9][1], top: [top] } } } };
    const at = Engine.viewOf(ranked), base = Engine.mainOf(accounts[0], 0, at, bands);
    assert.equal(Engine.spotRowOf(at, { ...base, occupied: 's3' }).spotId, 's3');
    assert.equal(Engine.spotRowOf(at, base).spotId, 's1', 'no occupation: the line\'s best');
    assert.equal(Engine.spotRowOf(at, { ...base, occupied: 's9' }).spotId, 's1', 'a spot with no hour at its level is not hunted');
}

// A bot is in one state at a time: an arrival answered { at, away } leaves
// the spot at at - away, and the way is not hunted (adena, exp, shots
// wanted); an arrival it has left for is not decided again by a later
// event; a visit's onward stops keep it in town their hours. A plane that
// fires 20 shots an hour and visits as the plain mode does (its hunt
// credits no adena on this snapshot: the adena is read from the plain mode).
{
    const planeOf = (rule, { afterHours = 0, onHour = null } = {}) => {
        const seen = { hunts: [], visits: [], asked: [], levels: [] };
        const design = { sinks: [], start: context => ({
            hunt: (main, delta, now) => seen.hunts.push({ now, exp: delta.exp, wanted: delta.shotsWanted, spot: delta.spotHours, way: delta.wayHours }),
            visit: (main, now, options) => { seen.visits.push(now); return { ...Engine.visit(main, Engine.viewOf(snapshot), options), afterHours }; },
            nextArrival: (main, ev) => { seen.asked.push([ev.event, ev.now]); return rule(main, ev); },
            firing: () => ({ id: 1463, perHour: 20 }), kills: () => null, levelUp: (main, now) => { seen.levels.push([Math.round(now * 100) / 100, main.level]); return main; }, event() {},
            hour: now => { if (onHour) onHour(context, now); return 0; },
            finish: () => ({ money: { start: 0, end: 0 }, design: {} }) }) };
        return { design, seen };
    };
    const total = (seen, field) => seen.hunts.reduce((sum, row) => sum + row[field], 0);
    const once = answer => (main, ev) => (ev.event === 'visit' ? null : answer);

    const trip = planeOf(once({ at: 10, away: 2 }));
    Engine.simulate({ view: Engine.viewOf(snapshot), accounts: [accounts[0]], bands, rates: silent, hours: 10, seed: 7, design: trip.design });
    assert.deepEqual(trip.seen.visits, [10]);
    const plainTrip = plainRun({ view: Engine.viewOf(snapshot), accounts: [accounts[0]], bands, rates: silent, hours: 10, seed: 7, nextArrival: once({ at: 10, away: 2 }) });
    assert.ok(Math.abs(plainTrip.flows.totals.huntCold - 800) <= 3, `8 hours of hunt adena, not 10: ${plainTrip.flows.totals.huntCold}`);
    assert.ok(Math.abs(total(trip.seen, 'exp') - 400) <= 1, `8 hours of exp: ${total(trip.seen, 'exp')}`);
    assert.ok(Math.abs(total(trip.seen, 'wanted') - 160) <= 2, `8 hours of shots wanted: ${total(trip.seen, 'wanted')}`);
    assert.ok(Math.abs(total(trip.seen, 'way') - 2) < 1e-9, 'the 2 hours away are the way\'s');

    // A line raised at 9 h (after it left at 8 h) asks nothing: the arrival at 10 h holds.
    const held = planeOf((main, ev) => (ev.event === 'visit' ? null : ev.now >= 9 ? { at: 9.5, away: 0.1 } : { at: 10, away: 2 }),
        { onHour: (context, now) => { if (now === 9) context.rearrive(0, now, 'offer_posted'); } });
    Engine.simulate({ view: Engine.viewOf(snapshot), accounts: [accounts[0]], bands, rates: silent, hours: 10, seed: 7, design: held.design });
    assert.deepEqual(held.seen.visits, [10], 'the departed arrival is kept');
    assert.ok(!held.seen.asked.some(([event]) => event === 'offer_posted'), 'not decided again on its way');

    // One onward stop (0.2 h): it hunts again 0.2 h after the arrival at 2.5 h.
    const onward = planeOf(once(2.5), { afterHours: 0.2 });
    Engine.simulate({ view: Engine.viewOf(snapshot), accounts: [accounts[0]], bands, rates: silent, hours: 4, seed: 7, design: onward.design });
    assert.ok(Math.abs(total(onward.seen, 'exp') - 190) <= 1, `3.8 hours of exp over 4 h: ${total(onward.seen, 'exp')}`);
    assert.deepEqual(onward.seen.asked.find(([event]) => event === 'visit'), ['visit', 2.7], 'asked again from the hour it hunts again');

    // Level 3 (300 exp) would come at 6 h, inside the way from 5 h to 7 h: at
    // 5 h it has 250 exp, so it reaches level 3 50 exp after its arrival
    // (8 h), read once then; no level-up is read on its way.
    const level = planeOf(once({ at: 7, away: 2 }));
    Engine.simulate({ view: Engine.viewOf(snapshot), accounts: [accounts[0]], bands, rates: silent, hours: 9, seed: 7, design: level.design });
    assert.deepEqual(level.seen.levels, [[2, 2], [8, 3]], 'level 2 at 2 h, level 3 once after the arrival, none on the way');

    // A departure set after the level was scheduled: level 2 was due at 2 h,
    // the situation read at 0.5 h sends it away from 1 h to 3 h, so it has 50
    // exp when it leaves and reaches level 2 50 exp after its arrival (4 h).
    const late = planeOf((main, ev) => (ev.event === 'start' ? { at: 0.5, read: true } : ev.event === 'situation' ? { at: 3, away: 2 } : null));
    Engine.simulate({ view: Engine.viewOf(snapshot), accounts: [accounts[0]], bands, rates: silent, hours: 5, seed: 7, design: late.design });
    assert.deepEqual(late.seen.levels, [[4, 2]], 'the level moves after the arrival when the departure comes after it was scheduled');

    // A level due on the spot before the departure is read there: the
    // situation read at 1.9 h sends it away at 2.1 h, level 2 comes at 2 h.
    const before = planeOf((main, ev) => (ev.event === 'start' ? { at: 1.9, read: true } : ev.event === 'visit' ? null : { at: 3, away: 0.9 }));
    Engine.simulate({ view: Engine.viewOf(snapshot), accounts: [accounts[0]], bands, rates: silent, hours: 5, seed: 7, design: before.design });
    assert.deepEqual(before.seen.levels, [[2, 2]], 'a level reached on the spot before it leaves is read once, on the spot');
}

// A level crossed at a large exp is read once although the float credit to
// its hour falls short: the main hunts to 4 ulps under level 2 (1e9 exp) by
// its visit at 0.5 h, whose onward stops keep it in town to 100.5 h, so the
// crossing's hour rounds to 100.5 and the hunt to it credits nothing. The
// plane stops the run after 100 reads, so a read that does not reach the
// level fails here instead of hanging.
{
    const T = 1e9, rate = 2 * (T - 4 * 2 ** -23), row = hour(100, rate, 20);
    const big = { ...snapshot, exp: [0, T, 4 * T, 9 * T, 1e12 * T], hours: { 9: { 1: row, 2: row, 3: row, 4: row } } }, at = Engine.viewOf(big), levels = [];
    const design = { sinks: [], start: () => ({ hunt() {}, visit: (main, now, options) => ({ ...Engine.visit(main, at, options), afterHours: 100 }),
        nextArrival: (main, ev) => (ev.event === 'start' ? 0.5 : null), firing: () => null, kills: () => null, event() {}, hour: () => 0,
        levelUp: (main, now) => { levels.push([now, main.level]); if (levels.length > 100) throw new Error(`100 level reads, level ${main.level} at ${now} h`); return main; },
        finish: () => ({ money: { start: 0, end: 0 }, design: {} }) }) };
    Engine.simulate({ view: at, accounts: [accounts[0]], bands, rates: silent, hours: 101, seed: 7, design });
    assert.deepEqual(levels, [[100.5, 2]], 'level 2 read once, at the hour it hunts again');
}

// The level is read when the exp the hunt credits reaches it: the main fires
// its 40 shots (20 an hour) at 50 exp an hour, then hunts bare at 25; its row
// has a blessed hour of 100 exp it does not fire. Level 2 (100 exp) comes at
// 2 h, level 3 (300 exp) 8 bare hours later; no read comes before its level,
// and a read gains only the level it hunted.
{
    const row = { ...hour(100, 50, 20).best, shotless: { exp: 25 }, blessed: { exp: 100 } }, line = { ...hour(100, 50, 20), best: row };
    const fired = { ...snapshot, hours: { 9: { 1: line, 2: line, 3: line, 4: line } } }, at = Engine.viewOf(fired), levels = [];
    const design = { sinks: [], start: () => ({ hunt() {}, visit: (main, now, options) => Engine.visit(main, at, options), nextArrival: () => null,
        firing: () => ({ id: 1463, perHour: 20 }), kills: () => ({ shots: 1, bare: 1, blessed: 1 }), event() {}, hour: () => 0,
        levelUp: (main, now) => { levels.push([Math.round(now * 1e6) / 1e6, main.level, Math.round(main.exp * 1e6) / 1e6]); return main; },
        finish: () => ({ money: { start: 0, end: 0 }, design: {} }) }) };
    Engine.simulate({ view: at, accounts: [{ ...accounts[0], shots: { 1463: 40 } }], bands, rates: silent, hours: 11, seed: 7, design });
    assert.deepEqual(levels, [[2, 2, 100], [10, 3, 300]], 'each level read once, at the hour its hunted exp reaches it, with that exp');
}

// The hunt rule is pure: the main it is given is left as it was.
const main = Engine.mainOf(accounts[0], 0, Engine.viewOf(snapshot), bands);
const frozen = JSON.stringify(main);
Engine.hunt(main, Engine.viewOf(snapshot), 2, () => 0.5);
assert.equal(JSON.stringify(main), frozen);

// No failure passes unseen: an arrival answer at or before now is dropped and
// counted, a main below the max level that can never level is counted once,
// an event of an unknown kind throws naming its kind.
const late = plainRun({ view: Engine.viewOf(snapshot), accounts, bands, rates, hours: 3, seed: 7, nextArrival: (main, state) => state.now });
assert.equal(late.counters.arrivalNotAhead, 2, 'the start and the level-up at 2 h each answered now');
assert.equal(late.counters.visits, 0, 'a dropped answer sends nobody');
for (const bad of [undefined, NaN, Infinity, { at: undefined, read: true }]) {
    assert.throws(() => plainRun({ view: Engine.viewOf(snapshot), accounts, bands, rates, hours: 3, seed: 7, nextArrival: () => bad }),
        new RegExp(`arrival rule answered ${typeof bad === 'object' ? '\\{' : String(bad)}.* for main 1 at 0 h \\(start\\)`), `an answer of ${JSON.stringify(bad) ?? 'undefined'} throws naming the main`);
}
const idle = plainRun({ view: Engine.viewOf(snapshot), accounts, bands, rates: { default: { huntShare: 0, visitsPerBotHour: 0 } }, hours: 3, seed: 7, nextArrival: () => null });
assert.equal(idle.counters.unlevelableMains, 1, 'the hunting main with no hunting share never levels; the station is not a hunting main');
assert.equal(run(3, 40).counters.unlevelableMains, 0, 'a main that levels is not counted');
const bogus = { sinks: [], start: ({ push }) => { push({ at: 0.5, kind: 'bogus', who: 0 }); return { nextArrival: () => null, kills: () => null, firing: () => null, hunt() {}, hour: () => 0 }; } };
assert.throws(() => Engine.simulate({ view: Engine.viewOf(snapshot), accounts, bands, rates, hours: 3, seed: 7, design: bogus }), /unknown kind: bogus/);

console.log('economy model engine: ok');
