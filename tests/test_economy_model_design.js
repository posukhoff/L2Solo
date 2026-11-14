'use strict';

// The economy model design's decision layer on plain fixtures: a bot out of
// shots goes to the town that sells them when it can pay, stays stuck when it
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
    offers: { town: 'TownA', price: 7 }, variant: 'table',
    value: { hour: 0.8, bare: 0.2, withoutDrop: 0.7, bagHoursBare: 2, outHours: 2, M: 25000, moneyWeight: 0.5 }, ...over });
const inTown = over => field({ place: 'town', town: 'TownA', ...over });
const brief = actions => actions.map(({ kind, town, id, count, price, reason, row }) => ({ kind, town, id, count, price, reason, row }));

// Table: out of shots with adena, to the town that sells them; with nothing, stuck.
assert.deepEqual(brief(Supply.supplyChoice(out, field())), [{ kind: 'go', town: 'TownA', id: undefined, count: undefined, price: undefined, reason: undefined, row: 'F1' }]);
assert.deepEqual(brief(Supply.supplyChoice(out, field({ wallet: 0 }))).map(a => [a.kind, a.reason, a.row]), [['stay', 'stuck', 'F2']]);
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
// Out of shots, nothing to pay with and a bare hour worth nothing: stuck, as in the table.
assert.deepEqual(brief(Supply.supplyChoice(out, formula({ wallet: 0, value: { ...field().value, bare: 0 } }))).map(a => [a.kind, a.reason]), [['stay', 'stuck']]);
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

console.log('economy model design: ok');
