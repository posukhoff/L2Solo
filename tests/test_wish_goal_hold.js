'use strict';
// A committed gear goal stays a goal while it is valid (goalhold): the gear
// admission keeps one winner per slot family, and a held goal beaten for its
// family is still a root beside that winner, so the network's loyalty (not the
// source's cut) decides whether the bot keeps it. A goal that is no longer
// valid (the item is worn) is not pinned.
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('wish-goal-hold');
require('../src/Global');
fixture.assertConfigured(options.default);
const Data = invoke('GameServer/DataCache'); Data.init();
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Market = invoke('GameServer/Bot/Economy/MarketOpportunity');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const board = new BoardIndex();
const trip = town => town === 'Dion' ? 0 : Infinity;
trip.details = town => ({ known: town === 'Dion', hours: 0, fees: 0 });
const state = { characterId: 912, name: 'HoldArcher', accountName: 'bot_912',
    phase: 'cold', activity: 'hunting', level: 45, adena: 3000000, currentRegion: 'Dion',
    loc: { locX: 19223, locY: 146228, locZ: -3069 }, timing: {},
    vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
    stats: { classId: 9, exp: Data.experience[44] + 1, generatedCold: true, decisionSeq: 1,
        persona: { primaryDrive: 'progression', understanding: 1, traits: { ambition: 0, commitment: 0.5,
            caution: .5, resilience: .5, assertiveness: .5, empathy: .5, sociability: .5 } } },
    inventory: { 1835: { selfId: 1835, amount: 1000000 }, 13: { selfId: 13, amount: 1, slot: 14, equipped: true, equippedCount: 1 } } };
const deps = { spots: [], board, tripCost: trip, knowledgeEnabled: false,
    npcOffersFor: id => Market.npcOffers(id, 'Dion'), timestamp: 1791464400000 };
const gearKey = (id, slot) => `power:${id}:${slot}`;
const context = Economy.forState(state, deps);
const plain = Providers.build(state, context, deps);
const roots = new Set(plain.roots);
// Shortlisted items of a slot whose family already has a gear root: each one
// that is not itself a root lost its family to that winner.
const beaten = [];
for (const [slot, items] of Providers.gearCandidates(state, context)) {
    const winner = plain.roots.find(key => key.startsWith('power:') && key.endsWith(`:${slot}`));
    if (!winner) continue;
    for (const item of items) if (!roots.has(gearKey(item.selfId, slot))) beaten.push({ key: gearKey(item.selfId, slot), item, slot, winner });
}
assert(beaten.length, 'fixture: a slot family has a winner and a beaten finalist');
let held = 0;
for (const row of beaten.slice(0, 6)) {
    const committed = Providers.build(state, { ...context, committedKeys: [row.key], nominationBasis: [0, row.item.selfId] }, deps);
    held++;
    assert(committed.roots.includes(row.key), `${row.key}: a held goal beaten for its family stays a root`);
    assert(committed.roots.includes(row.winner), `${row.key}: the held goal stands beside its family's winner`);
    // Through the build: the held goal stays live (the focus, or preempted
    // under a higher priority), never dropped as gone.
    const holding = { ...state, stats: { ...state.stats, decisionSeq: 100 + held, wishFocus: [row.key, 0, 1] } };
    const network = Economy.forState(holding, deps).network;
    assert(network.focus?.[0] === row.key || network.dormant.some(dormant => dormant[0] === row.key && dormant[1] === 'preempted'),
        `${row.key}: the held gear goal stays the focus or preempted`);
    if (held >= 3) break;
}
assert(held >= 1, 'fixture: a beaten finalist to hold');
// A gear goal pushed below by higher-priority roots that fill the root cap
// stays committed ('preempted'): the cut keeps the roots the build keeps
// first, and a committed goal it leaves out is still a goal, never gone.
const goal = plain.roots.find(key => key.startsWith('power:'));
const goalPriority = Number(plain.nodes.find(node => node.key === goal)?.progressionPriority) || 0;
assert(goalPriority > 0, 'fixture: a progression gear root');
const flood = [];
for (let at = 0; at < 13; at++) {
    flood.push({ key: `item:${990000 + at}`, paths: [{ kind: 'buy', activity: 'shopping', itemId: 990000 + at, price: 10 }] });
    flood.push({ key: `care:flood:${at}`, need: 'care', valueHours: 1000, progressionPriority: goalPriority + 1,
        paths: [{ requirements: [{ key: `item:${990000 + at}`, amount: 1 }] }] });
}
const pushed = Economy.forState({ ...state, stats: { ...state.stats, decisionSeq: 200, wishFocus: [goal, 0, 1] } },
    { ...deps, nodes: flood, rememberContext: false }).network;
assert.notEqual(pushed.focus?.[0], goal, 'fixture: the higher roots take the focus');
assert(pushed.dormant.some(row => row[0] === goal && row[1] === 'preempted'),
    'a gear goal the root cap leaves out under higher roots stays preempted');
// The root cut's order: a committed goal goes first of the roots of its
// place, and a committed earning root (it stands at the top priority it
// pays for) still follows the needed root it funds, so it never takes that
// root's room in the cut.
const top = goalPriority + 2;
const gap = { key: 'care:gap', need: 'care', valueHours: 10, progressionPriority: top,
    paths: [{ requirements: [{ key: 'item:990100', amount: 1 }] }] };
const rival = { ...gap, key: 'care:rival', valueHours: 1000, paths: [{ requirements: [{ key: 'item:990101', amount: 1 }] }] };
const earner = { key: 'care:earner', need: 'care', progressionFunding: true, valueHours: 1000,
    paths: [{ requirements: [{ key: 'item:990102', amount: 1 }] }] };
// The flood roots below them keep the review over MAX_ROOTS, so the cut ranks by score.
const injected = [gap, rival, earner, ...flood, ...[990100, 990101, 990102].map(id =>
    ({ key: `item:${id}`, paths: [{ kind: 'buy', activity: 'shopping', itemId: id, price: 10 }] }))];
const cutOrder = committedKeys => Providers.build(state, { ...context, committedKeys }, { ...deps, nodes: injected }).roots;
const loose = cutOrder([]);
assert(loose.indexOf(rival.key) >= 0 && loose.indexOf(rival.key) < loose.indexOf(gap.key), 'fixture: the rival outranks the gap');
const order = cutOrder([gap.key, earner.key]);
assert(order.indexOf(gap.key) < order.indexOf(rival.key), 'a committed goal goes before a rival of its place');
assert(order.indexOf(gap.key) < order.indexOf(earner.key) && order.indexOf(rival.key) < order.indexOf(earner.key),
    'a committed earning root follows the needed roots it funds');
// The worn bow is no valid goal: committing it pins nothing.
const worn = gearKey(13, 14);
assert(!Providers.build(state, { ...context, committedKeys: [worn], nominationBasis: [0, 13] }, deps).roots.includes(worn),
    'a worn item is no goal to hold');
require('node:fs').rmSync(fixture.directory, { recursive: true, force: true });
console.log('PASS wish goal hold: a held gear goal beaten for its family stays a root beside the winner and stays the focus; a root cut does not drop a preempted goal, a committed earning root follows the root it funds; a worn item is not held');
