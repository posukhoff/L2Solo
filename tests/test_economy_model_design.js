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
    assert.equal(Supply.stuck(broke), !fightsBare);
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
const near = row('s1', 100, 200, { deaths: 0.1, shotless: { kills: 0, exp: 0, adena: 0, dropLoot: 0, loot: 0, deaths: 0 } }), far = row('s2', 60, 100);
const drops = { town: 'TownA', drop: { 57: 10, [DROP]: 0.5 }, spoil: {} };
const view = Engine.viewOf({ header: { levels: [1, 2] }, exp: [0, 100], hours: { 9: { 1: { classId: 9, shotId: SHOT, best: near, top: [near, far] } } },
    kits: { 9: { 1: [] } }, yields: { 's1@1': drops, 's2@1': drops }, items: { [DROP]: { kind: 'Other.Material', npcBuy: 5 }, [SHOT]: { kind: 'Other.Shot', npcBuy: 2 } },
    npcOffers: { preset: {} }, deathExp: [15, 30] });
const main = { line: 9, level: 1, spot: null, shots: {}, bag: {} };
const kit = deaths => ({ bare: { kills: 1, deaths }, shots: { kills: 1, deaths }, blessed: { kills: 1, deaths } });
const persona = { primaryDrive: 'progression', traits: { caution: 0 } };
// Exp 100 of the best 100 and income 250 (200 adena + 50 drop) of the best 250, half each; a death costs 15 exp of 100
// and the way back from its respawn town (0.3 h), no respawn wait (the row's death rate holds it).
const way = { wayBackHours: 0.3 };
const risk = 0.1 * (0.3 + 15 / 100);
assert.ok(Math.abs(Value.hourValue(view, main, 'shots', kit(1), persona, way) - (100 / 100 * 0.5 + 0.5 - risk)) < 1e-9);
assert.ok(Math.abs(Value.hourValue(view, main, 'shots', kit(1), persona, { ...way, withoutDrop: true }) - (100 / 100 * 0.5 + 200 / 250 * 0.5 - risk)) < 1e-9);
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
// An out fact with the bag already full (its fact declined earlier; bagHoursBare 0) is both at once: the outing's hours of
// each loss, not a 0-hour out loss, so the bare shortfall over the outing beats the trip's price.
const standingFull = { hour: 0.8, bare: 0.2, withoutDrop: 0.7, bagHoursBare: 0, outHours: 2, M: 25000, moneyWeight: 0.5 };
assert.deepEqual(brief(Supply.supplyChoice(out, formula({ value: { ...standingFull, bagFull: true } }))).map(a => a.kind), ['go']);
assert.deepEqual(brief(Supply.supplyChoice(out, formula({ value: { ...standingFull, bagFull: false } }))).map(a => [a.kind, a.reason]), [['stay', 'trip_costs_more']]);
// The same road where the bare hour keeps 0.6 of it and the bag fills in an hour: it stays.
assert.deepEqual(brief(Supply.supplyChoice(out, formula({ ...longRoad, value: { ...zeroBare, bare: zeroBare.hour * 0.6, bagHoursBare: 1 } }))).map(a => a.kind), ['stay']);

// Needs: an outing's target of the shots it fires; it spares its bag, the shots it does not fire and those above target.
const holder = { shots: { [SHOT]: 250, 1463: 5 }, bag: { [DROP]: 4 } };
assert.deepEqual(Needs.consumable(holder, { id: SHOT, perHour: 99.5 }), { id: SHOT, perHour: 99.5, target: 199, held: 250, short: -51 });
assert.equal(Needs.consumable(holder, null), null);
assert.deepEqual(Needs.surplus(holder, Needs.consumable(holder, { id: SHOT, perHour: 100 })), [[DROP, 4], [1463, 5], [SHOT, 50]]);
assert.deepEqual(Needs.surplus({ shots: { [SHOT]: 120 }, bag: {} }, Needs.consumable({ shots: { [SHOT]: 120 } }, { id: SHOT, perHour: 100 })), []);
// The beginner shots that charge the shot it fires count as held of it; they are never spare (no sale, trade or drop).
const starterHolder = { shots: { 5789: 150, [SHOT]: 20 }, bag: {} };
assert.deepEqual(Needs.consumable(starterHolder, { id: SHOT, perHour: 100, beginner: 5789 }), { id: SHOT, perHour: 100, target: 200, held: 170, short: 30 });
assert.deepEqual(Needs.surplus(starterHolder, null), [[SHOT, 20]], 'the beginner shots are never surplus');

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
// Line 10's other candidate, s2, is worth less to it than s3 (nothing bare either).
const dull = row('s2', 10, 100, { shotless: { kills: 0, exp: 0, adena: 0, dropLoot: 0, loot: 0, deaths: 0 } });
const world = Engine.viewOf({ header: { levels: [1, 2] }, exp: [0, 1e9], kits: { 9: { 1: [] }, 10: { 1: [] } },
    hours: { 9: { 1: { classId: 9, shotId: SHOT, best: near, top: [near, far] } }, 10: { 1: { classId: 10, shotId: SHOT, best: quiet, top: [quiet, dull] } } },
    yields: { 's1@1': drops, 's2@1': drops, 's3@1': { town: 'TownA', drop: {}, spoil: {} } },
    items: { [DROP]: { kind: 'Other.Material', npcBuy: 5 }, [SHOT]: { kind: 'Other.Shot', npcBuy: 2 } },
    npcOffers: { preset: { [SHOT]: [{ town: 'TownA', price: 7 }] } }, deathExp: [15, 30],
    tripHours: { to: { s1: 0.2, s2: 0.2, s3: 0.2 }, back: { s1: { TownA: 0.3 }, s2: { TownA: 0.3 }, s3: { TownA: 0.3 } } }, bags: { 9: { slots: 80, maxLoad: 1e6 }, 10: { slots: 80, maxLoad: 1e6 } } });
const freshBot = (line, over = {}) => ({ id: 1, station: false, line, level: 1, exp: 0, money: 0, spot: null, shots: {}, held: [], worn: {},
    persona: { primaryDrive: 'progression', traits: { caution: 0.5, commitment: 0.5 } }, ...over });
// The kit's factors (the reference kit's: 1), deaths times dies.
const kitAt = dies => ({ spotFactors: () => ({ bare: { kills: 1, shots: 1, deaths: dies }, shots: { kills: 1, shots: 1, deaths: dies }, blessed: { kills: 1, shots: 1, deaths: dies } }), shotScale: () => 1, stats: { spotUnstated: 0 } });
// One run through the plane, its visits seen as the engine calls them.
function run(account, supply, hours, dies = 0, view = world) {
    const visits = [], levels = [], made = Plane.plane({ view, kitHours: kitAt(dies), variant: supply, accounts: [account] });
    const seen = { ...made, start: context => {
        const hooks = made.start(context);
        return { ...hooks, visit: (main, now, info) => { const done = hooks.visit(main, now, info); visits.push({ now, info, before: main, ...done }); return done; },
            levelUp: (main, now) => { const done = hooks.levelUp(main, now); levels.push({ now, before: main, main: done }); return done; } };
    } };
    const result = Engine.simulate({ view, accounts: [account], bands: [['all', 1]], rates: { default: { huntShare: 1 } }, hours, seed: 3, plane: seen });
    return { result, visits, levels };
}
const close = (a, b) => Math.abs(a - b) < 1e-6;
// The world with SHOT as the no-grade Soulshot: Soulshots for Beginners (5789) charge it.
const BEGINNER = 5789, taught = { ...world, shotFamilies: { grades: ['NONE'], ids: [[SHOT]] } };
// Holding both, a hunt fires the beginner shots first, then the bought ones.
{
    const both = Engine.mainOf(freshBot(9, { shots: { [BEGINNER]: 20, [SHOT]: 60 } }), 0, taught, [['all', 1]]);
    const firing = { id: SHOT, perHour: 30, beginner: Engine.beginnerOf(taught, SHOT) };
    assert.deepEqual(Engine.hunt(both, taught, 0.5, () => 0.5, firing).main.shots, { [BEGINNER]: 5, [SHOT]: 60 }, 'half an hour spends beginner shots only');
    assert.deepEqual(Engine.hunt(both, taught, 1, () => 0.5, firing).main.shots, { [BEGINNER]: 0, [SHOT]: 50 }, 'an hour spends the beginner shots, then 10 bought');
}
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
    // a fresh bot born with 45 beginner shots and none bought hunts with them first (1.5 h at 30 an hour), never sells
    // them, and only when they run out walks to town and buys no-grade shots with what its drop sold for.
    const starter = run(freshBot(9, { shots: { [BEGINNER]: 45 } }), supply, 3, 0, taught);
    const restock = starter.visits[1];
    assert.ok(restock && close(restock.now, 0.3 + 1.5 + 0.2), `${supply}: it hunts its beginner shots first and walks to town when they run out (${restock?.now})`);
    assert.deepEqual([restock.before.shots[BEGINNER], restock.main.shots[SHOT] > 0], [0, true], `${supply}: it buys its no-grade shots once the beginner shots are spent`);
    assert.ok(starter.visits.every(visit => !visit.delta.shotsSoldNpc), `${supply}: it never sells a beginner shot`);
    // with no money, nothing to sell and a zero bare hour it stays and stuck counts 1 with reason no_bare_hour
    const broke = run(freshBot(10, { shots: { [SHOT]: 60 } }), supply, 10);
    assert.equal(broke.visits.length, 1, `${supply}: it never goes to town`);
    assert.equal(broke.result.counters.stuckNoBareHour, 1, `${supply}: stuck once`);
    // a death puts the bot in its respawn town where the town chain runs; the death fact alone moves no money (s1 its
    // only row: it would not hold a spot that kills it so often where a safe one is)
    const dying = run(freshBot(9, { shots: { [SHOT]: 60 }, money: 1000 }), supply, 3, 40, { ...world, hours: { ...world.hours, 9: { 1: { classId: 9, shotId: SHOT, best: near, top: [near] } } } });
    const death = dying.visits.find(visit => visit.info.died);
    assert.ok(death && death.delta.towns[0] === 'TownA' && close(death.afterHours, 0.3), `${supply}: the respawn town runs the town chain and walks back`);
    assert.equal(death.main.money - death.before.money, death.delta.flows.npcSales + death.delta.flows.npcBuys, `${supply}: only the town chain moves money`);
}

// A held spot is re-taken at every new level: its row still exists there, but the spot worth most at the new level is another one.
const richer = row('s2', 300, 400);
const growth = Engine.viewOf({ header: { levels: [1, 2] }, exp: [0, 50], kits: { 9: { 1: [], 2: [] } },
    hours: { 9: { 1: { classId: 9, shotId: SHOT, best: near, top: [near, far] }, 2: { classId: 9, shotId: SHOT, best: richer, top: [richer, near] } } },
    yields: { 's1@1': drops, 's2@1': drops, 's1@2': drops, 's2@2': drops },
    items: { [DROP]: { kind: 'Other.Material', npcBuy: 5 }, [SHOT]: { kind: 'Other.Shot', npcBuy: 2 } },
    npcOffers: { preset: { [SHOT]: [{ town: 'TownA', price: 7 }] } }, deathExp: [15, 30],
    tripHours: { to: { s1: 0.2, s2: 0.2 }, back: { s1: { TownA: 0.3 }, s2: { TownA: 0.3 } } }, bags: { 9: { slots: 80, maxLoad: 1e6 } } });
for (const supply of ['table', 'formula']) {
    const grown = run(freshBot(9, { shots: { [SHOT]: 600 } }), supply, 1, 0, growth);
    assert.ok(grown.result.progress.stageBands.all.levelUps >= 1, `${supply}: it reached level 2`);
    assert.equal(grown.result.counters.leftOwnSpot, 0, `${supply}: the held row still exists at level 2`);
    const levelled = grown.levels.find(level => level.main.level === 2);
    assert.deepEqual([levelled.before.spot, levelled.main.spot], ['s1', 's2'], `${supply}: it holds the spot worth most at the new level`);
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
// Its bare hour carries no deaths of its own (the game spot table's shape), so it dies at the row's.
const mortal = row('s3', 100, 0, { deaths: 1, shotless: { kills: 0, exp: 0, adena: 0, dropLoot: 0, loot: 0 }, dropLoot: 0, loot: 0 });
const mortalWorld = { ...world, hours: { ...world.hours, 10: { 1: { classId: 10, shotId: SHOT, best: mortal, top: [mortal, { ...dull, deaths: 1 }] } } } };
const stuckDying = run(freshBot(10, { shots: { [SHOT]: 20 } }), 'table', 10, 2, mortalWorld);
assert.ok(stuckDying.visits.filter(visit => visit.info.died && visit.before.shots[SHOT] === 0).length >= 3, 'the stuck bot dies and respawns several times after it stands');
assert.equal(stuckDying.result.counters.stuckNoBareHour, 1, 'stuck once for the one run-out');

// Stuck is the bot's state, not the fact that woke it: a fresh bot born with no shots and no adena at a row that kills nothing bare
// stands from birth and counts once, and its deaths and respawn visits do not count it again.
for (const supply of ['table', 'formula']) {
    const fresh = run(freshBot(10), supply, 4, 0, mortalWorld);
    assert.equal(fresh.result.counters.stuckNoBareHour, 1, `${supply}: stuck from birth counts once`);
    const dies = run(freshBot(10), supply, 10, 2, mortalWorld);
    assert.ok(dies.visits.filter(visit => visit.info.died).length >= 3, `${supply}: the standing bot dies and respawns`);
    assert.equal(dies.result.counters.stuckNoBareHour, 1, `${supply}: its deaths do not count it again`);
}
assert.equal(Supply.stuck({ ...field({ wallet: 0, fightsBare: false }), need: { ...field().need, held: 5 } }), false, 'a bot that holds shots is not stuck');

// The held spot is the bot's best row in the form it can hunt: line 9's best row s1 kills nothing without shots, its
// bare best is s2. A bot born holding none of its shots holds s2 and hunts there bare; after the town chain that bought shots
// it holds s1 (the chain's end takes the held spot again).
// bareBest is an hour row of the shape the extract writes: the spot's hour with shots at the top level (shots 30), the bare reading in shotless.
const farBare = row('s2', 60, 100, { shotless: { kills: 10, exp: 60, adena: 40, dropLoot: 20, loot: 20, deaths: 0 } });
const bareWorld = { ...world, tripHours: { to: { ...world.tripHours.to, s2: 0.2 }, back: { ...world.tripHours.back, s2: { TownA: 0.3 } } }, hours: { ...world.hours, 9: { 1: { classId: 9, shotId: SHOT, best: near, bareBest: farBare, top: [near, far] } } } };
for (const supply of ['table', 'formula']) {
    const poor = run(freshBot(9), supply, 4, 0, bareWorld);
    assert.equal(poor.visits[0].main.spot, 's2', `${supply}: born with no shots it holds its bare best`);
    assert.equal(poor.result.counters.stuckNoBareHour, 0, `${supply}: it hunts bare, not stuck`);
    assert.ok(poor.result.huntHours.ownSpot + poor.result.huntHours.bestSpot > 3.5 && poor.result.progress.stageBands.all.expPerBotHour > 0, `${supply}: it hunts and gains exp`);
    const funded = run(freshBot(9, { money: 5000 }), supply, 4, 0, bareWorld);
    assert.equal(funded.visits[0].before.spot, null);
    assert.ok(funded.visits[0].main.shots[SHOT] > 0, `${supply}: the birth chain buys its shots`);
    assert.equal(funded.visits[0].main.spot, 's1', `${supply}: after the chain that bought shots it holds the shots best`);
}

// At a level where the held bare best has no row the bot takes the new level's bare best (the form it can hunt now), not the line's
// best row with shots: line 9 holds s2 bare at level 1; at level 2 its rows are s1 (kills nothing bare) and the bare best s3.
const farBare2 = row('s3', 150, 100, { shotless: { kills: 10, exp: 60, adena: 40, dropLoot: 20, loot: 20, deaths: 0 } });
const stepWorld = Engine.viewOf({ header: { levels: [1, 2] }, exp: [0, 50], kits: { 9: { 1: [], 2: [] } },
    hours: { 9: { 1: { classId: 9, shotId: SHOT, best: near, bareBest: farBare, top: [near, far] }, 2: { classId: 9, shotId: SHOT, best: near, bareBest: farBare2, top: [near] } } },
    yields: { 's1@1': drops, 's2@1': drops, 's1@2': drops, 's2@2': drops, 's3@2': drops },
    items: { [DROP]: { kind: 'Other.Material', npcBuy: 5 }, [SHOT]: { kind: 'Other.Shot', npcBuy: 2 } },
    npcOffers: { preset: { [SHOT]: [{ town: 'TownA', price: 7 }] } }, deathExp: [15, 30],
    tripHours: { to: { s1: 0.2, s2: 0.2, s3: 0.2 }, back: { s1: { TownA: 0.3 }, s2: { TownA: 0.3 }, s3: { TownA: 0.3 } } }, bags: { 9: { slots: 80, maxLoad: 1e6 } } });
for (const supply of ['table', 'formula']) {
    const levelled = [], made = Plane.plane({ view: stepWorld, kitHours: kitAt(0), variant: supply, accounts: [freshBot(9)] });
    const seen = { ...made, start: context => {
        const hooks = made.start(context);
        return { ...hooks, levelUp: (main, now) => { const next = hooks.levelUp(main, now); levelled.push({ level: main.level, before: main.spot, spot: next.spot }); return next; } };
    } };
    const result = Engine.simulate({ view: stepWorld, accounts: [freshBot(9)], bands: [['all', 1]], rates: { default: { huntShare: 1 } }, hours: 4, seed: 3, plane: seen });
    assert.ok(result.progress.stageBands.all.levelUps >= 1 && levelled.length >= 1, `${supply}: it reached level 2`);
    assert.deepEqual([levelled[0].level, levelled[0].before, levelled[0].spot], [2, null, 's3'], `${supply}: the level's bare best, not the shots best s1`);
    assert.equal(result.counters.stuckNoBareHour, 0, `${supply}: not stuck`);
}

// A level that changes the shot it fires to one it holds none of is the run-out the hunt raises when it spends the last shot: line 9
// fires the no-grade Spiritshot 2509 at level 1 (Spiritshots for Beginners 5790 charge it, 600 held) and the no-grade Soulshot 1835 at
// level 2 (5789 charges it, none held). Rooms are roomy so no bag fact comes in the run.
const classWorld = (shotAtTwo) => Engine.viewOf({ header: { levels: [1, 2] }, exp: [0, 50], kits: { 9: { 1: [], 2: [] } },
    shotFamilies: { grades: ['NONE'], ids: [[1835], [2509]] },
    hours: { 9: { 1: { classId: 9, shotId: 2509, best: near, bareBest: farBare, top: [near, far] }, 2: { classId: 9, shotId: shotAtTwo, best: near, bareBest: farBare2, top: [near] } } },
    yields: { 's1@1': drops, 's2@1': drops, 's1@2': drops, 's2@2': drops, 's3@2': drops },
    items: { [DROP]: { kind: 'Other.Material', npcBuy: 5 }, 1835: { kind: 'Other.Shot', npcBuy: 2 }, 2509: { kind: 'Other.Shot', npcBuy: 2 } },
    npcOffers: { preset: { 1835: [{ town: 'TownA', price: 7 }], 2509: [{ town: 'TownA', price: 7 }] } }, deathExp: [15, 30],
    tripHours: { to: { s1: 0.2, s2: 0.2, s3: 0.2 }, back: { s1: { TownA: 0.3 }, s2: { TownA: 0.3 }, s3: { TownA: 0.3 } } }, bags: { 9: { slots: 80, maxLoad: 1e6 } } });
{
    const changed = run(freshBot(9, { shots: { 5790: 600 } }), 'table', 4, 0, classWorld(1835));
    assert.ok(changed.result.progress.stageBands.all.levelUps >= 1, 'it reached level 2');
    const trip = changed.visits.find(visit => !visit.info.born && visit.before.level >= 2);
    // a. at level 2 it holds none of the Soulshot it now fires: it goes to town and buys it (old code: no fact, no visit)
    assert.ok(trip && trip.delta.shotsBoughtNpc > 0 && trip.main.shots[1835] > 0, 'the level that changed its shot sends it to town to buy the new shot');
    assert.equal(changed.result.design.bareBeforeFirstBuy[0].bought, 1, 'its first buy is counted');
    // b. a level that keeps the shot (still 2509, 600 held) sends it nowhere
    const kept = run(freshBot(9, { shots: { 5790: 600 } }), 'table', 4, 0, classWorld(2509));
    assert.ok(kept.result.progress.stageBands.all.levelUps >= 1, 'control: it reached level 2');
    assert.equal(kept.visits.filter(visit => !visit.info.born).length, 0, 'a level that keeps the shot sends it nowhere');
    // c. a level whose row fires no shot sends it nowhere (nothing to buy)
    const none = run(freshBot(9, { shots: { 5790: 600 } }), 'table', 4, 0, classWorld(0));
    assert.ok(none.result.progress.stageBands.all.levelUps >= 1, 'control: it reached level 2');
    assert.equal(none.visits.filter(visit => !visit.info.born).length, 0, 'a level that fires no shot sends it nowhere');
    // d. it held none of the shot before the level: the level is no run-out (it hunts bare, adena 1 buys nothing at birth)
    const bareBefore = run(freshBot(9, { shots: {}, money: 1 }), 'table', 4, 0, classWorld(1835));
    assert.ok(bareBefore.result.progress.stageBands.all.levelUps >= 1, 'control: it reached level 2');
    assert.equal(bareBefore.visits.filter(visit => !visit.info.born).length, 0, 'a main that held none before the level goes nowhere at it');
}

// The held spot is the one worth most to the bot by its persona's weights (exp against money, less its death risk), not
// the most income: line 9 at level 1 has sE (exp 200, 20 adena an hour) and sM (exp 50, 300 adena; the line's best by
// income). A bot driven by progression and cautious (money weight 1/3) holds sE; one driven by wealth (2/3) holds sM.
{
    const keen = row('sE', 200, 20), rich = row('sM', 50, 300);
    const choice = Engine.viewOf({ header: { levels: [1, 2] }, exp: [0, 1e9], kits: { 9: { 1: [] } },
        hours: { 9: { 1: { classId: 9, shotId: SHOT, best: rich, top: [rich, keen] } } }, yields: { 'sE@1': drops, 'sM@1': drops },
        items: { [DROP]: { kind: 'Other.Material', npcBuy: 5 }, [SHOT]: { kind: 'Other.Shot', npcBuy: 2 } },
        npcOffers: { preset: { [SHOT]: [{ town: 'TownA', price: 7 }] } }, deathExp: [15, 30],
        tripHours: { to: { sE: 0.2, sM: 0.2 }, back: { sE: { TownA: 0.3 }, sM: { TownA: 0.3 } } }, bags: { 9: { slots: 80, maxLoad: 1e6 } } });
    const levelling = { primaryDrive: 'progression', traits: { caution: 1 } }, earning = { primaryDrive: 'wealth', traits: { caution: 0 } };
    assert.deepEqual([Value.moneyWeight(levelling), Value.moneyWeight(earning)].map(weight => weight.toFixed(3)), ['0.333', '0.667']);
    for (const supply of ['table', 'formula']) {
        const heldBy = persona => run(freshBot(9, { shots: { [SHOT]: 60 }, persona }), supply, 1, 0, choice).visits[0].main.spot;
        assert.deepEqual([heldBy(levelling), heldBy(earning)], ['sE', 'sM'], `${supply}: two personas hold different spots on the same line and level`);
    }
}

// The run report (finish().design): trips, road hours and wall hours are counted at levels 1-19 and 20+ apart, an empty trip is
// one that bought none of the need it went for, and the shadow names the rows where the two variants answer differently.
// levelWorld: line 9 at levels first..last (a level starts every 50 exp; the row gives 100 exp an hour with shots), its shots
// sold at price, the road to town and back as given.
const levelWorld = (first, last, price = 7, road = { to: 0.2, back: 0.3 }) => {
    const levels = Array.from({ length: last - first + 1 }, (_, at) => first + at), per = fill => Object.fromEntries(levels.map(level => [level, fill(level)]));
    return Engine.viewOf({ header: { levels: [1, last] }, exp: Array.from({ length: last }, (_, at) => at * 50), kits: { 9: per(() => []) },
        hours: { 9: per(() => ({ classId: 9, shotId: SHOT, best: near, top: [near, far] })) },
        yields: Object.fromEntries(levels.flatMap(level => [[`s1@${level}`, drops], [`s2@${level}`, drops]])),
        items: { [DROP]: { kind: 'Other.Material', npcBuy: 5 }, [SHOT]: { kind: 'Other.Shot', npcBuy: 2 } },
        npcOffers: { preset: { [SHOT]: [{ town: 'TownA', price }] } }, deathExp: Array(last).fill(15),
        tripHours: { to: { s1: road.to, s2: road.to }, back: { s1: { TownA: road.back }, s2: { TownA: road.back } } }, bags: { 9: { slots: 80, maxLoad: 1e6 } } });
};
for (const supply of ['table', 'formula']) {
    // a trip that buys its shots is not empty: the born walk 0.3 h, the walk to town 0.2 h and the walk back 0.3 h are the road
    const bought = run(freshBot(9, { shots: { [SHOT]: 60 } }), supply, 3, 0, levelWorld(1, 3)).result.design.levels;
    assert.deepEqual([bought.low.consumableTrips, bought.low.emptyTrips], [1, 0], `${supply}: one trip, it bought`);
    assert.ok(close(bought.low.roadHours, 0.8) && close(bought.low.wallHours, 3) && close(bought.low.roadShare, 0.8 / 3), `${supply}: road ${bought.low.roadHours} of ${bought.low.wallHours}`);
    // shots no adena buys: the table's trips are all empty (the formula sees the trip buys nothing and stays)
    const empty = run(freshBot(9, { shots: { [SHOT]: 60 } }), supply, 6, 0, levelWorld(1, 3, 1e9)).result.design.levels;
    if (supply === 'table') {
        assert.ok(empty.low.consumableTrips >= 1 && empty.low.emptyTrips === empty.low.consumableTrips, `table: it bought none of its need (${empty.low.emptyTrips} of ${empty.low.consumableTrips})`);
        assert.equal(empty.low.emptyShare, 1);
    } else assert.equal(empty.low.consumableTrips, 0, 'formula: no trip for shots it cannot buy');
    // a bot at level 20 is in the 20+ numbers only
    const high = run(freshBot(9, { level: 20, exp: 950, shots: { [SHOT]: 60 } }), supply, 3, 0, levelWorld(20, 25)).result.design.levels;
    assert.deepEqual([high.low.wallHours, high.low.roadHours, high.low.consumableTrips, high.low.emptyTrips], [0, 0, 0, 0], `${supply}: nothing at 1-19`);
    assert.ok(high.high.consumableTrips >= 1 && close(high.high.wallHours, 3), `${supply}: its trips and hours are 20+`);
    // a bot that crosses level 20 splits its hours at the crossing (0.3 h walk out, 0.5 h to its 50 exp)
    const crossing = run(freshBot(9, { level: 19, exp: 900, shots: { [SHOT]: 60 } }), supply, 3, 0, levelWorld(19, 25)).result.design.levels;
    assert.ok(Math.abs(crossing.low.wallHours - 0.8) < 1e-3 && close(crossing.low.wallHours + crossing.high.wallHours, 3), `${supply}: low ${crossing.low.wallHours} h, high ${crossing.high.wallHours} h`);
    // its walk out is the only road at level 19; the trip it makes after its shots run out starts at level 20+ and is counted there
    assert.ok(close(crossing.low.roadHours, 0.3) && crossing.low.consumableTrips === 0 && crossing.high.consumableTrips === 1, `${supply}: the walk out at 19, the trip at 20+`);
}
// A trip is counted by the facts in its chain: a bot hunting bare (no shot to run out, so no out fact; its need is short) with a
// bag of one slot goes to town for its bag (`bare`: a bag trip, not a consumable trip, and not an empty trip however little it buys); a bot whose shots end goes for its need.
for (const supply of ['table', 'formula']) {
    const bagOnly = run(freshBot(9), supply, 0.5, 0, bare).result.design.levels.low;
    assert.deepEqual([bagOnly.consumableTrips, bagOnly.bothTrips, bagOnly.emptyTrips], [0, 0, 0], `${supply}: no out fact, so no consumable trip`);
    assert.ok(bagOnly.bagTrips >= 1, `${supply}: the full bag sends it to town (${bagOnly.bagTrips} bag trips)`);
    const needed = run(freshBot(9, { shots: { [SHOT]: 60 } }), supply, 3, 0, levelWorld(1, 3)).result.design.levels.low;
    assert.deepEqual([needed.consumableTrips, needed.bagTrips, needed.bothTrips], [1, 0, 0], `${supply}: the out fact is a consumable trip only`);
}
// Two variants on the same facts: where they agree the shadow lists nothing, where the table goes and the formula stays on a
// road of 3 h each way the differ row names the table's row and both answers, whichever variant runs.
const agree = run(freshBot(9, { shots: { [SHOT]: 60 } }), 'table', 3, 0, levelWorld(1, 3)).result.design.shadow;
assert.ok(agree.decisions >= 1 && agree.differ.length === 0, 'the variants agree on a short road');
for (const supply of ['table', 'formula']) {
    const shadow = run(freshBot(9, { shots: { [SHOT]: 60 } }), supply, 8, 0, levelWorld(1, 3, 7, { to: 3, back: 3 })).result.design.shadow;
    assert.ok(shadow.decisions >= 1 && shadow.differ.length >= 1, `${supply}: the variants disagree on a long road`);
    assert.match(shadow.differ[0].reason, /^table go \/ formula stay:trip_costs_more$/, supply);
    assert.ok(shadow.differ[0].count >= 1 && typeof shadow.differ[0].row === 'string' && shadow.differ[0].row.length > 0, supply);
}
// The bare hours before a line's first purchase: a funded bot buys at birth (0 h), an unfunded one hunts bare until it can pay.
for (const supply of ['table', 'formula']) {
    const funded = run(freshBot(9, { money: 5000 }), supply, 3, 0, bareWorld).result.design.bareBeforeFirstBuy;
    assert.deepEqual([funded[0].line, funded[0].bought, funded[0].meanHoursBeforeFirstBuy], [9, 1, 0], `${supply}: bought at birth`);
    const poor = run(freshBot(9), supply, 3, 0, bareWorld).result.design.bareBeforeFirstBuy;
    assert.equal(poor[0].bought, 0, `${supply}: no purchase yet`);
    assert.ok(poor[0].meanHoursNeverBought > 2, `${supply}: it hunted ${poor[0].meanHoursNeverBought} h bare`);
}

// A main whose level has no spot row for its line stands: one stuck episode with its own reason and its hours, and the road share
// is over the wall hours of the mains that hold a row (line 9 has rows from level 2 only; line 11 hunts and walks to town).
const noRow = Engine.viewOf({ header: { levels: [1, 2] }, exp: [0, 1e9], kits: { 9: { 1: [], 2: [] }, 11: { 1: [] } },
    hours: { 9: { 2: { classId: 9, shotId: SHOT, best: near, top: [near, far] } }, 11: { 1: { classId: 11, shotId: SHOT, best: near, top: [near, far] } } },
    yields: { 's1@1': drops, 's2@1': drops, 's1@2': drops, 's2@2': drops },
    items: { [DROP]: { kind: 'Other.Material', npcBuy: 5 }, [SHOT]: { kind: 'Other.Shot', npcBuy: 2 } },
    npcOffers: { preset: { [SHOT]: [{ town: 'TownA', price: 7 }] } }, deathExp: [15, 30],
    tripHours: { to: { s1: 0.2, s2: 0.2 }, back: { s1: { TownA: 0.3 }, s2: { TownA: 0.3 } } }, bags: { 9: { slots: 80, maxLoad: 1e6 }, 11: { slots: 80, maxLoad: 1e6 } } });
for (const supply of ['table', 'formula']) {
    const accounts = [freshBot(9, { id: 1 }), freshBot(11, { id: 2, shots: { [SHOT]: 60 } })];
    const { design, counters } = Engine.simulate({ view: noRow, accounts, bands: [['all', 1]], rates: { default: { huntShare: 1 } }, hours: 3, seed: 3,
        plane: Plane.plane({ view: noRow, kitHours: kitAt(0), variant: supply, accounts }) });
    const low = design.levels.low;
    assert.deepEqual(low.stuckEpisodes, { no_spot_row: 1 }, `${supply}: the main with no row is one stuck episode`);
    assert.ok(close(low.stuckHoursByReason.no_spot_row, 3) && close(low.stuckHours, 3), `${supply}: it stands its 3 hours`);
    assert.equal(counters.stuckNoBareHour, 0, `${supply}: the no-bare-hour counter is the supply rule's`);
    assert.ok(close(low.wallHours, 6) && close(low.decidingHours, 3), `${supply}: ${low.decidingHours} h of mains with a row`);
    assert.ok(close(low.roadShare, 0.8 / 3) && close(low.roadShareAllMains, 0.8 / 6), `${supply}: the road share leaves its hours out (${low.roadShare}, all ${low.roadShareAllMains})`);
}

// A bag at the game's full rule takes no item drop: the hunt credits its exp and adena as usual and counts the drop it did not take
// at the NPC's price (hunt's full).
{
    const hunter = freshBot(9, { shots: {}, bag: {}, spot: 's2' });
    const start = Engine.mainOf(hunter, 0, bare, [['all', 1]]);
    const open = Engine.hunt(start, bare, 2, () => 0.5), shut = Engine.hunt(start, bare, 2, () => 0.5, null, null, true);
    assert.ok(open.main.bag[DROP] > 0, 'an open bag takes the drop');
    assert.equal(shut.main.exp, open.main.exp, 'a full bag gains the exp of the hunt');
    assert.equal(shut.main.money, open.main.money, 'a full bag gains the adena of the hunt');
    assert.ok(!shut.main.bag[DROP] && shut.delta.drops.length === 0, 'a full bag takes no item');
    assert.equal(open.delta.lostDrop, 0, 'an open bag loses none');
    assert.ok(Math.abs(shut.delta.lostDrop - 2 * Engine.rowItems(bare, start, far, 'bare').loot) < 1e-6, 'the drop it left is counted at the NPC buy price');
}

// The design plane tells the engine its bag is full from the hunt that fills it until a town visit: a bot that is read every half
// hour and never goes keeps its filled bag as it was and loses the drop of the hours after.
{
    const hunted = hours => {
        const made = Plane.plane({ view: bare, kitHours: kitAt(0), variant: 'formula', accounts: [freshBot(9)] });
        const lingering = { ...made, start: context => ({ ...made.start(context), nextArrival: (main, { now }) => ({ at: now + 0.5, read: true }) }) };
        return Engine.simulate({ view: bare, accounts: [freshBot(9)], bands: [['all', 1]], rates: { default: { huntShare: 1 } }, hours, seed: 3, plane: lingering });
    };
    const short = hunted(3), long = hunted(6);
    assert.ok(short.counters.fullBagHuntHours > 0 && short.counters.fullBagLostDrop > 0, 'a full bag hunts and loses the drop');
    assert.equal(long.drops.byItem[DROP], short.drops.byItem[DROP], 'a full bag takes no item in the later hours');
    assert.ok(long.counters.fullBagLostDrop > short.counters.fullBagLostDrop, 'each later hour loses more drop');
}

// A bag that filled goes to town (the table variant at once), sells its drop there and takes drop again after the visit: the
// drops grow past what it held at the visit, and it never hunted with the bag full.
const roomy = { ...bare, bags: { 9: { slots: 2, maxLoad: 1e6 } } };
for (const supply of ['table', 'formula']) {
    const trips = run(freshBot(9, { shots: { [SHOT]: 40 } }), supply, 6, 0, roomy), visits = trips.visits.filter(visit => !visit.info.born);
    assert.ok(visits.length >= 2 && !visits[0].main.bag[DROP], `${supply}: it visits town and leaves with its bag emptied`);
    assert.ok(trips.result.drops.byItem[DROP] > visits[0].before.bag[DROP], `${supply}: it takes drop again after the visit`);
    if (supply === 'table') assert.ok(trips.result.counters.fullBagHuntHours < 1e-9, 'the table variant goes at the fill: no hour hunted full');
}

// The model's hunting table at level 1 (run.js tableHours over rules/hunt-rows.js), cells as measured: a level-1 orc
// mystic (line 51, key 49), for which the game's spot table has no row at level 1, holds the gremlin spot (-12_43) and
// hunts it at its measured kills; a level-1 human mystic (line 12, key 10) without spiritshots holds its bare best and
// hunts it at the bare cell's kills, its bare hour with the bare cell's own deaths (not the shots hour's). A spot whose
// only species dies over the kill-death limit is cut (SPOT.6) and counted; a table of another stamp is refused by name.
{
    const Run = require('../scripts/economy-model/run');
    const GREMLIN = '5198', DEADLY = '20001', SPIRIT = 2509;
    const fields = ['kills', 'deaths', 'fight', 'rest', 'other', 'walk', 'exp', 'shots', 'potions', 'pull'];
    const orc = [41.5, 0.04819, 11.86, 51.53, 22.52, 0.8434, 29, 0, 0.1687, 1];
    const humanBare = [106.5, 0.02, 7.039, 15.59, 10.6, 0.581, 29, 0, 0, 1], humanShots = [149.5, 0, 6.632, 11.18, 5.69, 0.581, 29, 1.027, 0.003344, 1];
    const deadly = [20, 0.5, 30, 60, 90, 1, 40, 0, 0, 1];
    const body = classId => ({ classId, runSpd: 121.2, reach: 40, point: { attack: 7, defence: 54 } });
    const file = { stamp: 'abc', range: [1, 1], fields, forms: ['bare', 'shots'], bodies: { '49|1|7/54': body(49), '10|1|7/54': body(10) },
        spots: { '-12_43': { area: 488157, density: 10, species: { [GREMLIN]: { level: 1, count: 10, production: 2400 } } },
            cut: { area: 488157, density: 10, species: { [DEADLY]: { level: 3, count: 10, production: 2400 } } } },
        cells: { '49|1|7/54': { '-12_43': { [GREMLIN]: [orc, orc] }, cut: { [DEADLY]: [deadly, deadly] } },
            '10|1|7/54': { '-12_43': { [GREMLIN]: [humanBare, humanShots] }, cut: { [DEADLY]: [deadly, deadly] } } } };
    const gameRow = row('s1', 100, 200);
    const snapshot = { header: { levels: [1, 2], rates: { exp: 1 }, huntTable: { name: 'hunt-1-1-abc.json', stamp: 'abc', range: [1, 1], spots: ['-12_43', 'cut'] } },
        exp: [0, 1e9], kits: { 51: { 1: [] }, 12: { 1: [] } },
        hours: { 51: { 1: { classId: 49, shotId: SPIRIT, best: null, bareBest: null, top: [] }, 2: { classId: 49, shotId: SPIRIT, best: gameRow, top: [gameRow] } },
            12: { 1: { classId: 10, shotId: SPIRIT, best: gameRow, top: [gameRow] } } },
        speciesYields: { [`${GREMLIN}@1@0`]: { drop: { 57: 4, [DROP]: 0.1 }, spoil: {} }, [`${DEADLY}@1@0`]: { drop: { 57: 9 }, spoil: {} } },
        yields: { '-12_43@1': { town: 'TownA', drop: { 57: 4, [DROP]: 0.1 }, spoil: {} }, 's1@2': drops },
        items: { [DROP]: { kind: 'Other.Material', npcBuy: 5 }, [SPIRIT]: { kind: 'Other.Shot', npcBuy: 2 } },
        npcOffers: { preset: { [SPIRIT]: [{ town: 'TownA', price: 7 }] } }, deathExp: [15, 30],
        tripHours: { to: { '-12_43': 0.2 }, back: { '-12_43': { TownA: 0.3 } } }, bags: { 51: { slots: 80, maxLoad: 1e6 }, 12: { slots: 80, maxLoad: 1e6 } } };
    const read = (over = {}) => Run.tableHours({ snapshot, file, name: 'test table', lines: ['51', '12'], keyOf: line => (line === '51' ? '49' : '10'),
        spoilLevelOf: () => 0, gapFactor: () => 1, ...over });
    assert.throws(() => read({ file: { ...file, stamp: 'other' } }), /hunt table test table: stamp other, but the snapshot was built with hunt-1-1-abc\.json \(stamp abc\)/, 'another table stamp is refused by name');
    assert.throws(() => read({ file: { ...file, range: [1, 2] } }), /hunt table test table: levels 1-2, but the snapshot was built with hunt-1-1-abc\.json \(levels 1-1\)/, 'another level range is refused by name');
    const { cut, ...onlyGremlin } = file.spots;
    assert.throws(() => read({ file: { ...file, spots: onlyGremlin } }), /hunt table test table: 1 spots, but the snapshot was built with hunt-1-1-abc\.json \(2 spots, not the same set\)/, 'a table of fewer spots (a pick) is refused by name');
    assert.throws(() => read({ file: { ...file, spots: { ...onlyGremlin, other: cut } } }), /hunt table test table: 2 spots, but the snapshot was built with .* not the same set/, 'a table of as many other spots is refused too');
    const table = read();
    assert.deepEqual(table.cannot, { shots: 2, bare: 2 }, 'the spot whose species dies over the limit is cut in both forms for both lines, and counted');
    assert.equal(snapshot.hours[51][1].best, null, 'the snapshot\'s hours are not edited');
    assert.equal(table.hours[51][2], snapshot.hours[51][2], 'above the table\'s range the game\'s row stays');
    const orcHour = table.hours[51][1], humanHour = table.hours[12][1];
    assert.deepEqual([orcHour.top.map(held => held.spotId), orcHour.bareTop.map(held => held.spotId)], [['-12_43'], ['-12_43']], 'the candidates per form: the cut spot is none');
    assert.deepEqual(humanHour.bareTop.map(held => held.spotId), ['-12_43']);
    assert.equal(orcHour.best, undefined, 'no line-wide best: each bot ranks the candidates by its own hour value');
    const tableView = Engine.viewOf({ ...snapshot, hours: table.hours });
    // The game's kit readers: no factor at the table's levels, and the game's shot scale has no row there (null).
    const kitsOf = { spotFactors: () => assert.fail('the table\'s levels read no game kit factor'), shotScale: () => null, stats: { spotUnstated: 0 } };
    const creation = { range: [1, 1], creation: () => ({}) };
    const firedBy = {}, diedBy = {};
    for (const [line, cell, spiritshots] of [['51', orc, { [SPIRIT]: 100 }], ['12', humanBare, {}], ['12', humanBare, { [SPIRIT]: 1000 }]]) {
        const account = freshBot(line, { shots: spiritshots }), visits = [];
        const made = Plane.plane({ view: tableView, kitHours: kitsOf, variant: 'table', accounts: [account], table: creation });
        let held = null;
        const seen = { ...made, start: context => { const hooks = held = made.start(context); return { ...hooks, visit: (main, now, info) => { const done = hooks.visit(main, now, info); visits.push({ ...done, died: info.died === true }); return done; } }; } };
        const result = Engine.simulate({ view: tableView, accounts: [account], bands: [['all', 1]], rates: { default: { huntShare: 1 } }, hours: 3, seed: 3, plane: seen });
        assert.equal(visits[0].main.spot, '-12_43', `line ${line} holds the gremlin spot`);
        const main = { ...visits[0].main, shots: {} }, hunted = Engine.hunt(main, tableView, 1, () => 0.5, null).delta;
        const kills = 3600 / (cell[2] + cell[3] + cell[4] + cell[5]);
        assert.ok(Math.abs(hunted.exp - kills * 29) < 1e-6, `line ${line} hunts bare at its cell's kills (${hunted.exp / 29} vs ${kills})`);
        assert.equal(result.design.offGrid, 0, 'the creation kit is the measured point');
        firedBy[`${line}:${Object.keys(spiritshots).length}`] = held.firing(visits[0].main)?.perHour || 0;
        diedBy[`${line}:${Object.keys(spiritshots).length}`] = visits.filter(visit => visit.died).length;
    }
    // The human mystic dies at the form it hunts in: bare (0.02 a kill, some 2 an hour) it dies within 3 h, firing its
    // spiritshots (1000 last over 6 h; no death a kill) it does not.
    assert.ok(diedBy['12:0'] > 0, `the bare human mystic dies at its bare hour's deaths (${diedBy['12:0']} deaths)`);
    assert.equal(diedBy['12:1'], 0, 'firing its spiritshots it dies at its shots hour\'s (none)');
    const shotsKills = 3600 / (6.632 + 11.18 + 5.69 + 0.581);
    assert.ok(Math.abs(firedBy['12:1'] - shotsKills * 1.027) < 1e-9, `the human mystic with spiritshots fires its shots cell's count (${firedBy['12:1']})`);
    assert.ok(Math.abs(humanHour.bareTop[0].shotless.deaths - 3600 / (7.039 + 15.59 + 10.6 + 0.581) * 0.02) < 1e-9, 'the bare hour carries the bare cell\'s own deaths');
    assert.equal(humanHour.bareTop[0].deaths, 0, 'the shots hour its own (none)');
    // The creation kit is the measured point: a main wearing exactly it (non-empty) is on the grid, one wearing another piece is counted off it.
    {
        const worn = Engine.viewOf({ ...snapshot, hours: table.hours, kits: { 51: { 1: [{ slot: 6, selfId: 1001 }] }, 12: { 1: [] } }, items: { ...snapshot.items, 1001: { kind: 'Armor.Chest', npcBuy: 1 } } });
        const offGrid = measured => {
            const account = freshBot('51', { held: [1001] });
            const made = Plane.plane({ view: worn, kitHours: kitsOf, variant: 'table', accounts: [account], table: { range: [1, 1], creation: () => measured } });
            return Engine.simulate({ view: worn, accounts: [account], bands: [['all', 1]], rates: { default: { huntShare: 1 } }, hours: 1, seed: 3, plane: made }).design.offGrid;
        };
        assert.equal(offGrid({ 6: 1001 }), 0, 'wearing exactly the creation kit counts no main off the grid');
        assert.equal(offGrid({ 6: 1002 }), 1, 'wearing another piece counts the main off the grid');
    }
}

// The held spot's candidates are the line's best row and its top: a game best outside top is held when its value is the
// highest, and a best that kills its bot loses to a safe top row under the risk term.
{
    const bestOut = row('s1', 400, 800), safe = row('s2', 60, 100), deadly = row('s1', 400, 800, { deaths: 200 });
    const outside = (best, top) => Engine.viewOf({ header: { levels: [1, 2] }, exp: [0, 1e9], kits: { 9: { 1: [] } },
        hours: { 9: { 1: { classId: 9, shotId: SHOT, best, top } } }, yields: { 's1@1': drops, 's2@1': drops },
        items: { [DROP]: { kind: 'Other.Material', npcBuy: 5 }, [SHOT]: { kind: 'Other.Shot', npcBuy: 2 } },
        npcOffers: { preset: { [SHOT]: [{ town: 'TownA', price: 7 }] } }, deathExp: [15, 30],
        tripHours: { to: { s1: 0.2, s2: 0.2 }, back: { s1: { TownA: 0.3 }, s2: { TownA: 0.3 } } }, bags: { 9: { slots: 80, maxLoad: 1e6 } } });
    for (const supply of ['table', 'formula']) {
        const held = best => run(freshBot(9, { shots: { [SHOT]: 600 } }), supply, 1, 1, outside(best, [safe])).visits[0].main.spot;
        assert.equal(held(bestOut), 's1', `${supply}: the best outside top is held when it is worth most`);
        assert.equal(held(deadly), 's2', `${supply}: a best that kills its bot loses to the safe top row`);
    }
}

console.log('economy model design: ok');
