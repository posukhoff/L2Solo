'use strict';
// A committed goal survives a preemption: a bot focused on a gear goal with
// half its inputs in the bag, pushed under by its survival stock, returns to
// that goal after restocking, and its held inputs stay its own (a rival pays
// for them). Once the goal is done the next focus is the top score (no
// roulette); a rival that beats it by more
// than the bot's loyalty takes the focus and the held inputs with it. The step
// serves the focus root. The gear nomination keeps a preempted goal's item
// (and the plan target beside it in one slot) among the slot's finalists.
const assert = require('node:assert/strict');
require('../src/Global');
const { WishNetwork, score } = require('../src/GameServer/Bot/Economy/WishNetwork');

const GOAL = 'power:101:6', RIVAL = 'power:102:6', OTHER = 'power:103:7', STOCK = 'stock:1835';
const item = (id, price) => ({ key: `item:${id}`, paths: [{ kind: 'buy', activity: 'shopping', itemId: id, price }] });
const root = (key, valueHours, progressionPriority, requirements) => ({ key, need: 'power', valueHours, progressionPriority,
    paths: [{ requirements: requirements.map(([id, amount]) => ({ key: `item:${id}`, amount })) }] });
// The goal needs 2 x item 10 (held) and 2 x item 11; the rival needs the
// same 2 x item 10 and 1 x item 12, so alone it is the cheaper root.
const nodes = ({ rivalValue = 100, stockPriority = 0, goal = true, other = false } = {}) => [
    ...(goal ? [root(GOAL, 100, 3, [[10, 2], [11, 2]])] : []),
    root(RIVAL, rivalValue, 3, [[10, 2], [12, 1]]),
    ...(other ? [root(OTHER, 100, 3, [[13, 3]])] : []),
    root(STOCK, 5, stockPriority, [[20, 1]]),
    item(10, 100), item(11, 100), item(12, 100), item(13, 100), item(20, 10)];
const stockFor = id => ({ owned: id === 10 ? 2 : 0, incoming: 0 });
const build = (characterId, previous, options = {}) => new WishNetwork().build({ actorKey: `character:${characterId}`,
    inputKey: `loyalty:${characterId}:${JSON.stringify(options)}`, remembered: false, characterId, decisionSeq: 7,
    nodes: nodes(options), roots: nodes(options).filter(node => node.need).map(node => node.key), stockFor,
    wallet: 100000, hourAdena: 100, playedHours: 10, persona: { traits: { commitment: 0.5 } }, previous, reconsider: true });
const packet = result => ({ focus: result.focus, dormant: result.dormant });
const cash = (result, key) => result.queue.find(row => row.key === key)?.price;
// The top score among the focusable roots: the queue weighs an off-focus root
// by (1 - loyalty), so its own score is valueHours / 0.5.
const topKey = result => result.queue.filter(row => row.progressionPriority === 3)
    .map(row => ({ ...row, valueHours: row.key === result.focus[0] ? row.valueHours : row.valueHours / 0.5 }))
    .sort((a, b) => score(b) - score(a) || a.key.localeCompare(b.key))[0]?.key;

const characterId = 1;
const start = { focus: [GOAL, 2, 400], dormant: [] };
// Survival stock runs out: it takes the focus.
const preempted = build(characterId, start, { stockPriority: 4 });
assert.equal(preempted.focus[0], STOCK, 'missing survival stock takes the focus');
// Restocked: the bot returns to its goal.
const restocked = build(characterId, packet(preempted));
assert.equal(restocked.focus[0], GOAL, 'the preempted goal resumes after restock');
assert.equal(cash(restocked, GOAL), 200, 'the goal keeps its held inputs and buys only what it lacks');
assert.equal(cash(restocked, RIVAL), 300, 'the rival pays for the inputs the goal holds');
assert.equal(restocked.activity?.rootKey, GOAL, 'the step serves the focus');
// A rival that beats the goal by more than the loyalty ends the hold: the
// focus goes to the top score, and takes the inputs in the bag instead of
// buying them again.
for (const previous of [start, packet(preempted)]) {
    const outscored = build(characterId, previous, { rivalValue: 1000 });
    assert.equal(outscored.focus[0], RIVAL, 'a rival beyond the loyalty margin takes the focus');
    assert.equal(cash(outscored, RIVAL), 100, 'the new focus uses the held inputs');
    assert.equal(outscored.activity?.rootKey, RIVAL, 'the step serves the new focus');
    assert.notEqual(outscored.activity?.itemId, 10, 'the bot does not buy what its bag holds');
}
// The goal done: the next focus is the top score among the rest.
const done = build(characterId, packet(restocked), { goal: false, other: true });
assert.notEqual(done.focus[0], STOCK, 'the restocked stock is not resumed');
assert.equal(done.focus[0], topKey(done), 'the focus never goes to a lower score');
// The gear nomination: a preempted gear goal stays a finalist of its slot,
// and so does the plan target sharing that slot with it.
const Data = invoke('GameServer/DataCache'); Data.init();
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const archer = { characterId: 911, level: 45, adena: 0, stats: { classId: 9 }, inventory: {} };
const role = Planner.roleFor(archer);
const priced = id => Number(Data.items.find(row => row.selfId === id)?.template.price || 0);
const view = { wallet: 1e9, survivalReserve: 0, price: priced };
const plain = Providers.gearCandidates(archer, view);
// Two stronger-than-nothing items of one slot the plain review leaves out.
let slot = 0, outside = [];
for (const [at, rows] of Providers.gearCandidates(archer)) {
    const chosen = new Set((plain.get(at) || []).map(row => row.selfId));
    const left = rows.filter(row => !chosen.has(row.selfId) && priced(row.selfId) > 0 && Planner.itemScore(row, role, 9) > 0);
    if (left.length >= 2) { slot = at; outside = left; break; }
}
assert(outside.length >= 2, 'fixture: the review leaves gear of one slot out');
const [planned, paused] = outside;
const committedArcher = { ...archer, stats: { ...archer.stats, wishFocus: [STOCK, 2, 10],
    dormantWishes: [[`power:${paused.selfId}:${slot}`, 'preempted', 0, 0, 2, 0.5]],
    equipmentPlan: { target: { selfId: planned.selfId } } } };
const finalists = Providers.gearCandidates(committedArcher, view).get(slot).map(row => row.selfId);
assert(finalists.length <= Providers.GEAR_FINALISTS_PER_SLOT);
assert(finalists.includes(paused.selfId), 'the preempted gear goal stays a finalist');
assert(finalists.includes(planned.selfId), 'the plan target in the same slot stays a finalist too');
const replaced = { ...committedArcher, stats: { ...committedArcher.stats, equipmentPlan: null,
    dormantWishes: [[`power:${paused.selfId}:${slot}`, 'superseded', 0, 0, 2, 0.5]] } };
assert(!Providers.gearCandidates(replaced, view).get(slot).some(row => row.selfId === paused.selfId),
    'a replaced goal is not nominated again');
console.log('PASS wish goal loyalty: a preempted goal resumes with its held inputs and stays nominated; done or outscored, the focus goes to the top score and the step serves it');
