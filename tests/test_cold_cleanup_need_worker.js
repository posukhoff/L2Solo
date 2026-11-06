const assert = require('assert');
require('../src/Global');
invoke('GameServer/DataCache').init();

const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const Data = invoke('GameServer/DataCache');

// The cleanup trip is decided by the far bot's build (situations step 4 C4: its
// bag_full woke it, the step's plan says cleanupDue): that step's proposal
// carries the bag's need, judged on the fight's result; main only starts the
// trip. A step whose build decided nothing carries none (no per-step bag check).
const book = Data.items.find(item => item.template.kind === 'Other.Spellbook');
assert(book, 'the native catalogue supplies a nonstackable book');
// 81 single books: over the native 80-slot floor.
const fullBag = { [book.selfId]: { selfId: book.selfId, name: book.template.name, kind: book.template.kind,
    amount: 81, stackable: false,
    instances: Array.from({ length: 81 }, (_, i) => ({ id: 9700000 + i, amount: 1, equipped: false })) } };

function bot(characterId, overrides = {}) {
    return { characterId, name: `Bag${characterId}`, phase: 'cold', activity: 'hunting', level: 40,
        vitals: { hp: 1000, maxHp: 1000, mp: 500, maxMp: 500 }, inventory: fullBag,
        timing: { lastResolvedAt: 1000, nextResolveAt: 2000 }, stats: { classId: 0 },
        simulation: { revision: 3 }, updatedAt: 1000, ...overrides };
}

const result = ({ timestamp }) => ({ patch: {}, materialize: { exp: 0, sp: 0, adena: 0, items: [] },
    events: [], nextResolveAt: timestamp + 30000, debug: {} });

// One step of each bot; the proposals the worker sends main, by bot.
async function step(states, { project = state => state, decided = true } = {}) {
    const sent = new Map();
    const spots = new Map();
    const kernel = new ColdSimulationKernel({
        now: () => 3000,
        spotOf: value => spots.get(Number(value?.characterId)) || null,
        resolveSolo: result,
        planLifecycle: async () => (decided ? { cleanupDue: true } : {}),
        projectResolve: state => ({ state: project(state) }),
        emit: (type, payload) => {
            if (type === 'proposal_batch') for (const proposal of payload.proposals) sent.set(proposal.characterId, proposal);
        }
    });
    for (const state of states) {
        spots.set(Number(state.characterId), { id: 'bag-spot', rewards: {} });
        kernel.upsert({ state });
    }
    kernel.tick();
    await kernel.resolveChain;
    kernel.flush(null, true);
    return sent;
}

(async () => {
    // A solo hunter over the slot limit: the proposal carries the need.
    const solo = (await step([bot(501)])).get(501);
    assert(solo, 'the step reaches main');
    assert.strictEqual(solo.cleanupNeed?.reason, 'inventory_capacity', 'a full bag sends the bot to sell');
    assert.strictEqual(solo.cleanupNeed.slots, 81);
    // The same bag on a step whose build did not decide the trip: nothing (the step does not read the bag).
    const held = (await step([bot(507)], { decided: false })).get(507);
    assert(held, 'the step reaches main');
    assert.strictEqual(held.cleanupNeed, undefined, 'only the build that decided it starts the trip');

    // A route trip this step started does not hide the need: the cleanup outranks it.
    const routed = (await step([bot(502)], { project: state => ({ ...state, activity: 'traveling',
        stats: { ...state.stats, travel: { spotId: 'elsewhere', reason: 'level_replan', arrivalAt: 90000 } } }) })).get(502);
    assert.strictEqual(routed.cleanupNeed?.reason, 'inventory_capacity');

    // A bot that died in the fight waits: no need.
    const died = (await step([bot(503)], { project: state => ({ ...state, activity: 'dead',
        vitals: { ...state.vitals, hp: 0 } }) })).get(503);
    assert(died, 'the step reaches main');
    assert.strictEqual(died.cleanupNeed, undefined, 'a dead bot does not start a cleanup trip');

    // A bot already on a trip when the step started: no need.
    const traveling = (await step([bot(504, { activity: 'traveling',
        stats: { classId: 0, travel: { spotId: 'elsewhere', reason: 'level_replan', arrivalAt: 2500 } } })])).get(504);
    assert(traveling, 'the step reaches main');
    assert.strictEqual(traveling.cleanupNeed, undefined, 'a traveling bot keeps its trip');

    // A half-full bag sends the bot to sell, unless its last visit could not
    // place these goods and nothing new came (stats.marketSellSeen): then it hunts on.
    const halfFull = Object.fromEntries(Array.from({ length: 40 }, (_, index) => {
        const selfId = 1864 + index;
        return [selfId, { selfId, name: `Material ${selfId}`, kind: 'Other.Material', stackable: true, amount: 1 }];
    }));
    const selling = (await step([bot(505, { inventory: halfFull })])).get(505);
    assert.strictEqual(selling.cleanupNeed?.reason, 'inventory_half_full');
    const paused = (await step([bot(506, { inventory: halfFull,
        stats: { classId: 0, marketSellSeen: { items: Object.keys(halfFull).map(Number), buyers: null } } })])).get(506);
    assert(paused, 'the step reaches main');
    assert.strictEqual(paused.cleanupNeed, undefined, 'a sell pause holds the half-full trip');

    // The bag fact is the cleanup rule's verdict (situations.md F2): a step whose bag comes to
    // need a town trip raises bag_full once (it wakes the build), a bag that stays full raises nothing more.
    const Situations = invoke('GameServer/Bot/Situations');
    const empty = bot(508, { inventory: {} }), full = bot(508);
    assert(Situations.detect(empty, full).includes('bag_full'), 'the bag coming to need town raises bag_full');
    assert(!Situations.detect(full, { ...full, updatedAt: 2000 }).includes('bag_full'), 'a bag that stays full raises nothing');
    assert(!Situations.detect(empty, { ...empty, updatedAt: 2000 }).includes('bag_full'));

    // A body near a player: the decision its bag_full woke carries the full bag to it
    // (DecisionEvents.nearFields: the slot and weight floor), the body takes it to town;
    // no body checks its bag every tick. A party member's carries none.
    const Events = invoke('GameServer/Bot/AI/DecisionEvents');
    const near = { statsPacket: {}, stock: () => ({ itemId: 0 }), network: { activity: null, plans: new Map(), queue: [] } };
    const body = { ...bot(509), phase: 'hot' };
    assert.strictEqual(Events.nearFields(near, body).unload, 'no_slot', 'the near decision names the full bag');
    assert.strictEqual(Events.nearFields(near, { ...body, inventory: {} }).unload, null);
    assert.strictEqual(Events.nearFields(near, { ...body, partyId: 'p' }).unload, null);

    console.log('Cold worker cleanup need checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
