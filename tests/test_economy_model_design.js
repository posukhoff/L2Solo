'use strict';

// The economy model design's decision layer on plain fixtures: a bot out of
// shots goes to the town that sells them when it can pay, stays when it
// has nothing; in town it sells what it can spare to the NPC, buys up to its
// outing's target with what it has and walks back. The formula variant goes
// only when the trip prevents more loss than it costs. Facts raised on the
// road are heard on arrival with the town's, a death decides nothing, and the
// shadow names the table row where the two variants answer differently.
const assert = require('node:assert/strict');
const Engine = require('../scripts/economy-model/engine');
const Catalog = require('../scripts/economy-model/design/catalog');
const Attention = require('../scripts/economy-model/design/attention');
const Needs = require('../scripts/economy-model/design/needs');
const Value = require('../scripts/economy-model/design/value');
const Supply = require('../scripts/economy-model/design/supply');

const SHOT = 1835, DROP = 200;
const out = [{ kind: 'out', who: 7, at: 3 }], bag = [{ kind: 'bag', who: 7, at: 3 }], town = [{ kind: 'town', who: 7, at: 4 }];
// A level-1 bot out of its 200-shot target in the field, its spot's town selling the shots at 7.
const field = (over = {}) => ({ place: 'hunt', town: null, spotTown: 'TownA', need: { id: SHOT, perHour: 100, target: 200, held: 0, short: 200 },
    surplus: [], npcBuy: { [DROP]: 5, [SHOT]: 2 }, wallet: 2000, roadMoney: 0, toHours: 0.1, backHours: 0.1,
    offers: { town: 'TownA', price: 7 }, fightsBare: true, variant: 'table',
    value: { hour: 0.8, bare: 0.2, withoutDrop: 0.7, bagHoursBare: 2, outHours: 2, M: 25000, moneyWeight: 0.5 }, ...over });
const inTown = over => field({ place: 'town', town: 'TownA', ...over });
const brief = actions => actions.map(({ kind, town, id, count, price, reason, row }) => ({ kind, town, id, count, price, reason, row }));

// Table: out of shots with adena, to the town that sells them; with nothing it stays, stuck only where it kills nothing bare.
assert.deepEqual(brief(Supply.supplyChoice(out, field())), [{ kind: 'go', town: 'TownA', id: undefined, count: undefined, price: undefined, reason: undefined, row: 'F1' }]);
assert.deepEqual(brief(Supply.supplyChoice(out, field({ wallet: 0 }))).map(a => [a.kind, a.reason, a.row]), [['stay', 'no_money', 'F2']]);
assert.deepEqual(brief(Supply.supplyChoice(out, field({ wallet: 0, fightsBare: false }))).map(a => [a.kind, a.reason, a.row]), [['stay', 'no_bare_hour', 'F2']]);
// Its bag full with shots held: to the nearest town (where no NPC sells its shots, the held spot's town).
const bagFull = field({ need: { id: SHOT, perHour: 100, target: 200, held: 150, short: 50 }, surplus: [[DROP, 40]] });
assert.deepEqual(brief(Supply.supplyChoice(bag, bagFull)).map(a => [a.kind, a.town, a.row]), [['go', 'TownA', 'F1']]);
assert.deepEqual(brief(Supply.supplyChoice(bag, { ...bagFull, offers: null, spotTown: 'TownB' })).map(a => [a.kind, a.town]), [['go', 'TownB']]);
// A death or nothing to act on in the field: it keeps hunting.
assert.deepEqual(Supply.supplyChoice([{ kind: 'died', who: 7, at: 3 }], field()), []);

// Table in town with 0 adena and 40 drop: sells all at the NPC's buy price, buys
// with the 200 adena the sale brought (28 of 200: partial), walks back, in that order.
const broke = inTown({ wallet: 0, surplus: [[DROP, 40]] });
assert.deepEqual(brief(Supply.supplyChoice(town, broke)).map(a => [a.kind, a.id, a.count, a.price, a.row]),
    [['sell', DROP, 40, 5, 'T1'], ['buy', SHOT, 28, 7, 'T2'], ['back', undefined, undefined, undefined, 'T4']]);
// With enough adena it buys exactly up to the target.
assert.deepEqual(brief(Supply.supplyChoice(town, inTown({ wallet: 10000 }))).map(a => [a.kind, a.count]), [['buy', 200], ['back', undefined]]);
// A reserved kit row is accepted and does nothing; a row naming an action outside the closed set throws by name.
assert.deepEqual(Supply.table(town, broke, { FIELD: [], TOWN: [{ id: 'T3', reserved: 'kit' }] }), []);
assert.throws(() => Supply.table(out, field(), { FIELD: [{ id: 'X1', when: ['out'], then: 'teleport' }], TOWN: [] }), /row X1: action 'teleport' is not in the closed set/);
assert.throws(() => Supply.supplyChoice(out, field({ variant: 'guess' })), /no supply variant 'guess'/);

// Formula: out of shots, the road's price below the loss of 2 bare hours: it goes.
const formula = over => field({ variant: 'formula', ...over });
assert.deepEqual(brief(Supply.supplyChoice(out, formula())).map(a => [a.kind, a.town, a.row]), [['go', 'TownA', 'formula']]);
// A near-full stock and a long road: the trip costs more than the drop it would save.
const nearFull = formula({ need: { id: SHOT, perHour: 100, target: 200, held: 190, short: 10 }, surplus: [[DROP, 40]], toHours: 1, backHours: 1,
    value: { hour: 0.8, bare: 0.2, withoutDrop: 0.7, bagHoursBare: 2, outHours: 1.9, M: 25000, moneyWeight: 0.5 } });
assert.deepEqual(brief(Supply.supplyChoice(bag, nearFull)).map(a => [a.kind, a.reason]), [['stay', 'trip_costs_more']]);
// A partial wallet scales the loss the trip prevents: 70 adena buys 10 of 200 shots, and the same trip no longer pays.
assert.deepEqual(brief(Supply.supplyChoice(out, formula({ wallet: 70 }))).map(a => [a.kind, a.reason]), [['stay', 'trip_costs_more']]);
// With 0 adena and 400 drop the trip spends what the drop sells for there (2000 adena: the whole target), as the town rows
// do: it goes under both variants, and the shadow sees no difference.
const dropOnly = field({ wallet: 0, surplus: [[DROP, 400]] });
assert.deepEqual(brief(Supply.supplyChoice(out, { ...dropOnly, variant: 'formula' })).map(a => [a.kind, a.town]), [['go', 'TownA']]);
assert.equal(Supply.shadow(out, dropOnly).differ, null);
// Out of shots with nothing to pay with, both variants stay for the same reason: stuck only where it kills nothing bare.
for (const fightsBare of [true, false]) {
    const broke = field({ wallet: 0, fightsBare, value: { ...field().value, bare: fightsBare ? 0.2 : 0 } });
    const both = Supply.shadow(out, broke);
    assert.equal(both.differ, null);
    assert.deepEqual(brief(both.other).map(a => [a.kind, a.reason]), [['stay', fightsBare ? 'no_money' : 'no_bare_hour']]);
    assert.equal(Supply.stuck(new Set(['out']), broke), !fightsBare);
}
// In town the formula takes the same levers in the same order.
assert.deepEqual(brief(Supply.supplyChoice(town, { ...broke, variant: 'formula' })).map(a => [a.kind, a.count]), [['sell', 40], ['buy', 28], ['back', undefined]]);

// The shadow names the table row where the variants differ, and nothing where they agree.
const differ = Supply.shadow(bag, nearFull);
assert.deepEqual(brief(differ.actions).map(a => a.kind), ['stay']);
assert.deepEqual(differ.differ, { row: 'F1', reason: 'table go / formula stay:trip_costs_more' });
assert.equal(Supply.shadow(out, field()).differ, null);

// The hour value on a view: a row whose line fights nothing without shots is
// worth nothing bare, and with a long road the formula goes there all the same
// (the bag never fills bare: its loss is the whole outing).
const row = (spotId, exp, adena, extra = {}) => ({ spotId, kills: 10, exp, adena, shots: 30, dropLoot: 50, spoilLoot: 0, loot: 50, potions: 0, busyShare: 1, deaths: 0, ...extra });
const near = row('s1', 100, 200, { deaths: 0.1, shotless: { kills: 0, exp: 0, adena: 0, dropLoot: 0, loot: 0, deaths: 0 } }), far = row('s2', 150, 100);
const drops = { town: 'TownA', drop: { 57: 10, [DROP]: 0.5 }, spoil: {} };
const view = Engine.viewOf({ header: { levels: [1, 2] }, exp: [0, 100], hours: { 9: { 1: { classId: 9, shotId: SHOT, best: near, top: [near, far] } } },
    kits: { 9: { 1: [] } }, yields: { 's1@1': drops, 's2@1': drops }, items: { [DROP]: { kind: 'Other.Material', npcBuy: 5 }, [SHOT]: { kind: 'Other.Shot', npcBuy: 2 } },
    npcOffers: { preset: {} }, deathExp: [15, 30] });
const main = { line: 9, level: 1, spot: null, shots: {}, bag: {} };
const kit = deaths => ({ bare: { kills: 1, deaths }, shots: { kills: 1, deaths }, blessed: { kills: 1, deaths } });
const persona = { primaryDrive: 'progression', traits: { caution: 0 } };
// Exp 100 of the best 150 and income 250 (200 adena + 50 drop) of the best 250, half each; a death costs 15 exp of 150
// and the way back from its respawn town (0.3 h), no respawn wait (the row's death rate holds it).
const way = { wayBackHours: 0.3 };
const risk = 0.1 * (0.3 + 15 / 150);
assert.ok(Math.abs(Value.hourValue(view, main, 'shots', kit(1), persona, way) - (100 / 150 * 0.5 + 0.5 - risk)) < 1e-9);
assert.ok(Math.abs(Value.hourValue(view, main, 'shots', kit(1), persona, { ...way, withoutDrop: true }) - (100 / 150 * 0.5 + 200 / 250 * 0.5 - risk)) < 1e-9);
assert.ok(Math.abs(Value.hourValue(view, main, 'shots', kit(1), persona, way) - Value.hourValue(view, main, 'shots', kit(2), persona, way) - risk) < 1e-9);
assert.equal(Value.hourValue(view, main, 'bare', kit(1), persona, way), 0);
// A wealth-driven, cautious-free persona weighs money above exp.
assert.ok(Value.moneyWeight({ primaryDrive: 'wealth', traits: { caution: 0 } }) > Value.moneyWeight(persona));
const hourOf = form => Value.hourValue(view, main, form, kit(1), persona, way);
assert.throws(() => Value.hourValue(view, main, 'shots', kit(1), persona, {}), /no trip hours for the way back/);
const zeroBare = { hour: hourOf('shots'), bare: hourOf('bare'), withoutDrop: 0, bagHoursBare: Infinity, outHours: 0, M: Value.bestOf(view, main).npc, moneyWeight: Value.moneyWeight(persona) };
// Shots at a tenth of an adena against the view's best income of 250 an hour.
const longRoad = { toHours: 0.4, backHours: 0.4, offers: { town: 'TownA', price: 0.1 } };
assert.deepEqual(brief(Supply.supplyChoice(out, formula({ ...longRoad, value: zeroBare }))).map(a => a.kind), ['go']);
// The same road where the bare hour keeps 0.6 of it and the bag fills in an hour: it stays.
assert.deepEqual(brief(Supply.supplyChoice(out, formula({ ...longRoad, value: { ...zeroBare, bare: zeroBare.hour * 0.6, bagHoursBare: 1 } }))).map(a => a.kind), ['stay']);

// Needs: an outing's target of the shots it fires; it spares its bag, the shots it does not fire and those above target.
const holder = { shots: { [SHOT]: 250, 1463: 5 }, bag: { [DROP]: 4 } };
assert.deepEqual(Needs.consumable(holder, { id: SHOT, perHour: 99.5 }), { id: SHOT, perHour: 99.5, target: 199, held: 250, short: -51 });
assert.equal(Needs.consumable(holder, null), null);
assert.deepEqual(Needs.surplus(holder, Needs.consumable(holder, { id: SHOT, perHour: 100 })), [[DROP, 4], [1463, 5], [SHOT, 50]]);
assert.deepEqual(Needs.surplus({ shots: { [SHOT]: 120 }, bag: {} }, Needs.consumable({ shots: { [SHOT]: 120 } }, { id: SHOT, perHour: 100 })), []);

// Attention: a stock run out on the road waits and is heard on arrival in one chain with the town fact.
let account = { id: 1, led: 7, place: 'road', queue: [] };
account = Attention.push(account, out[0]);
const onRoad = Attention.heard(account);
assert.deepEqual(onRoad.chain, []);
account = Attention.push({ ...onRoad.account, place: 'town' }, town[0]);
const arrived = Attention.heard(account);
assert.deepEqual(arrived.chain.map(fact => fact.kind), ['out', 'town']);
assert.deepEqual(arrived.account.queue, []);
assert.deepEqual(Catalog.woken(arrived.chain), ['supply']);
// Out of shots while hunting is heard at once.
assert.deepEqual(Attention.heard(Attention.push({ id: 1, led: 7, place: 'hunt', queue: [] }, out[0])).chain.map(fact => fact.kind), ['out']);
// A death is heard at once and wakes no decision.
const died = Attention.heard(Attention.push({ id: 1, led: 7, place: 'hunt', queue: [] }, { kind: 'died', who: 7, at: 5 }));
assert.deepEqual(died.chain.map(fact => fact.kind), ['died']);
assert.deepEqual(Catalog.woken(died.chain), []);
// The same fact twice is one entry; the led character is the beneficiary; an unknown fact throws by name.
const twice = Attention.push(Attention.push({ id: 1, led: 7, place: 'road', queue: [] }, out[0]), { ...out[0], at: 4 });
assert.equal(twice.queue.length, 1);
assert.equal(Attention.ledOf({ id: 1, led: 8, place: 'hunt', queue: [] }, [{ id: 7 }, { id: 8 }]).id, 8);
assert.throws(() => Attention.push(twice, { kind: 'rumour', who: 7, at: 1 }), /no situation 'rumour'/);

// The design plane on the engine, one town and a fixture world: line 9 hunts s1 (adena and drop with shots, nothing
// bare), line 10 hunts s3 (exp only: no adena, no drop, nothing bare). Both spots' town is TownA: 0.2 h to it, 0.3 h back.
const Plane = require('../scripts/economy-model/design/plane');
const quiet = row('s3', 100, 0, { shotless: { kills: 0, exp: 0, adena: 0, dropLoot: 0, loot: 0, deaths: 0 }, dropLoot: 0, loot: 0 });
const world = Engine.viewOf({ header: { levels: [1, 2] }, exp: [0, 1e9], kits: { 9: { 1: [] }, 10: { 1: [] } },
    hours: { 9: { 1: { classId: 9, shotId: SHOT, best: near, top: [near, far] } }, 10: { 1: { classId: 10, shotId: SHOT, best: quiet, top: [quiet, far] } } },
    yields: { 's1@1': drops, 's2@1': drops, 's3@1': { town: 'TownA', drop: {}, spoil: {} } },
    items: { [DROP]: { kind: 'Other.Material', npcBuy: 5 }, [SHOT]: { kind: 'Other.Shot', npcBuy: 2 } },
    npcOffers: { preset: { [SHOT]: [{ town: 'TownA', price: 7 }] } }, deathExp: [15, 30],
    tripHours: { to: { s1: 0.2, s3: 0.2 }, back: { s1: { TownA: 0.3 }, s3: { TownA: 0.3 } } }, bags: { 9: { slots: 80, maxLoad: 1e6 }, 10: { slots: 80, maxLoad: 1e6 } } });
const freshBot = (line, over = {}) => ({ id: 1, station: false, line, level: 1, exp: 0, money: 0, spot: null, shots: {}, held: [], worn: {},
    persona: { primaryDrive: 'progression', traits: { caution: 0.5, commitment: 0.5 } }, ...over });
// The kit's factors (the reference kit's: 1), deaths times dies.
const kitAt = dies => ({ spotFactors: () => ({ bare: { kills: 1, shots: 1, deaths: dies }, shots: { kills: 1, shots: 1, deaths: dies }, blessed: { kills: 1, shots: 1, deaths: dies } }), shotScale: () => 1 });
// One run through the plane, its visits seen as the engine calls them.
function run(account, supply, hours, dies = 0, view = world) {
    const visits = [], made = Plane.plane({ view, kitHours: kitAt(dies), variant: supply, accounts: [account] });
    const seen = { ...made, start: context => {
        const hooks = made.start(context);
        return { ...hooks, visit: (main, now, info) => { const done = hooks.visit(main, now, info); visits.push({ now, info, before: main, ...done }); return done; } };
    } };
    const result = Engine.simulate({ view, accounts: [account], bands: [['all', 1]], rates: { default: { huntShare: 1 } }, hours, seed: 3, plane: seen });
    return { result, visits };
}
const close = (a, b) => Math.abs(a - b) < 1e-6;
// Both variants from one simulate call, only the variant changed.
for (const supply of ['table', 'formula']) {
    // a fresh bot that runs out of shots walks to its spot's town, buys up to its target, sells its drop, walks back:
    // born with its 60-shot target (30 an hour, two hours) and no adena, it walks out 0.3 h, hunts 2 h, walks 0.2 h to town,
    // sells its drop, buys 60 shots and walks 0.3 h back; by 3 h it has hunted 2 + 0.2 hours (road hours = to + back).
    const { result, visits } = run(freshBot(9, { shots: { [SHOT]: 60 } }), supply, 3);
    assert.deepEqual(visits.map(visit => [visit.info.born === true, visit.delta.towns[0], close(visit.afterHours, 0.3)]), [[true, 'TownA', true], [false, 'TownA', true]], supply);
    const trip = visits[1];
    assert.ok(close(trip.now, 0.3 + 2 + 0.2), `${supply}: it arrives the walk to town after its shots ran out (${trip.now})`);
    assert.equal(trip.before.shots[SHOT], 0);
    assert.ok(trip.before.bag[DROP] > 0 && !trip.main.bag[DROP], `${supply}: it sells its drop at the NPC`);
    assert.equal(trip.delta.flows.npcSales, trip.before.bag[DROP] * 5);
    assert.equal(trip.main.shots[SHOT], 60, `${supply}: it buys up to its outing's target`);
    assert.equal(trip.main.money, trip.before.money + trip.delta.flows.npcSales - 60 * 7);
    assert.ok(close(result.huntHours.ownSpot + result.huntHours.bestSpot, 2.2), `${supply}: hunted ${result.huntHours.ownSpot + result.huntHours.bestSpot} h`);
    assert.equal(result.money.closureGap, 0);
    // with no money, nothing to sell and a zero bare hour it stays and stuck counts 1 with reason no_bare_hour
    const broke = run(freshBot(10, { shots: { [SHOT]: 60 } }), supply, 10);
    assert.equal(broke.visits.length, 1, `${supply}: it never goes to town`);
    assert.equal(broke.result.counters.stuckNoBareHour, 1, `${supply}: stuck once`);
    // a death puts the bot in its respawn town where the town chain runs; the death fact alone moves no money
    const dying = run(freshBot(9, { shots: { [SHOT]: 60 }, money: 1000 }), supply, 3, 40);
    const death = dying.visits.find(visit => visit.info.died);
    assert.ok(death && death.delta.towns[0] === 'TownA' && close(death.afterHours, 0.3), `${supply}: the respawn town runs the town chain and walks back`);
    assert.equal(death.main.money - death.before.money, death.delta.flows.npcSales + death.delta.flows.npcBuys, `${supply}: only the town chain moves money`);
}

// A held spot stays through a level while its row exists there (the line's best at the new level is another spot).
const growth = Engine.viewOf({ header: { levels: [1, 2] }, exp: [0, 50], kits: { 9: { 1: [], 2: [] } },
    hours: { 9: { 1: { classId: 9, shotId: SHOT, best: near, top: [near, far] }, 2: { classId: 9, shotId: SHOT, best: far, top: [far, near] } } },
    yields: { 's1@1': drops, 's2@1': drops, 's1@2': drops, 's2@2': drops },
    items: { [DROP]: { kind: 'Other.Material', npcBuy: 5 }, [SHOT]: { kind: 'Other.Shot', npcBuy: 2 } },
    npcOffers: { preset: { [SHOT]: [{ town: 'TownA', price: 7 }] } }, deathExp: [15, 30],
    tripHours: { to: { s1: 0.2, s2: 0.2 }, back: { s1: { TownA: 0.3 }, s2: { TownA: 0.3 } } }, bags: { 9: { slots: 80, maxLoad: 1e6 } } });
for (const supply of ['table', 'formula']) {
    const grown = run(freshBot(9, { shots: { [SHOT]: 600 } }), supply, 1, 0, growth);
    assert.ok(grown.result.progress.stageBands.all.levelUps >= 1, `${supply}: it reached level 2`);
    assert.equal(grown.result.counters.leftOwnSpot, 0, `${supply}: it keeps the spot it holds through the level`);
}

// A bot with no shots, no adena and a bag that fills: it hunts bare at a row that kills bare, and the formula goes to town for the shots
// (with no shot to run out there is no out fact, the outing's hours stand in for it); the same as the table.
const bare = Engine.viewOf({ header: { levels: [1, 2] }, exp: [0, 1e9], kits: { 9: { 1: [] } }, hours: { 9: { 1: { classId: 9, shotId: SHOT, best: far, top: [far] } } },
    yields: { 's2@1': drops }, items: { [DROP]: { kind: 'Other.Material', npcBuy: 5 }, [SHOT]: { kind: 'Other.Shot', npcBuy: 2 } },
    npcOffers: { preset: { [SHOT]: [{ town: 'TownA', price: 7 }] } }, deathExp: [15, 30],
    tripHours: { to: { s2: 0.02 }, back: { s2: { TownA: 0.03 } } }, bags: { 9: { slots: 1, maxLoad: 1e6 } } });
for (const supply of ['table', 'formula']) {
    const filled = run(freshBot(9), supply, 3, 0, bare);
    const trip = filled.visits.find(visit => !visit.info.born);
    assert.ok(trip && trip.before.bag[DROP] > 0, `${supply}: it goes to town when its bag is full with no shots`);
    assert.ok(trip.main.shots[SHOT] > 0, `${supply}: it buys shots with what its drop sold for`);
}

// A bot stuck out of shots is counted once: its death and respawn visit change neither its shots, its money nor its bag.
const mortal = row('s3', 100, 0, { deaths: 1, shotless: { kills: 0, exp: 0, adena: 0, dropLoot: 0, loot: 0, deaths: 0 }, dropLoot: 0, loot: 0 });
const mortalWorld = { ...world, hours: { ...world.hours, 10: { 1: { classId: 10, shotId: SHOT, best: mortal, top: [mortal, far] } } } };
const stuckDying = run(freshBot(10, { shots: { [SHOT]: 20 } }), 'table', 10, 2, mortalWorld);
assert.ok(stuckDying.visits.filter(visit => visit.info.died && visit.before.shots[SHOT] === 0).length >= 3, 'the stuck bot dies and respawns several times after it stands');
assert.equal(stuckDying.result.counters.stuckNoBareHour, 1, 'stuck once for the one run-out');

console.log('economy model design: ok');
