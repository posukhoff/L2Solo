'use strict';
// design-rules Recompute, "own outputs are not inputs": a held economy
// decision whose build bumped the bot's decision sequence (a new focus) still
// holds while the state carries the decision the build read (its packet not
// yet written back), as it does once the packet is written. A real move of
// the decision (another build's sequence, another leaf, a raise) refuses it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(process.env.N53_GAME_ROOT || path.join(__dirname, '..'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'held-own-decision-'));
const oldCwd = process.cwd();
const oldConfig = process.env.L2NODE_CONFIG_FILE;
const oldShared = process.env.L2NODE_SHARED_CONFIG_FILE;
const config = path.join(dir, 'config.ini');
fs.writeFileSync(config, fs.readFileSync(path.join(root, 'config/default.ini'), 'utf8')
    + `\n[Database]\npath=${path.join(dir, 'world.sqlite')}\nhistoryPath=${path.join(dir, 'history.sqlite')}\n`);
process.env.L2NODE_CONFIG_FILE = config;
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.chdir(root);
let Economy, generation = null;
const Generation = require('../src/GameServer/Bot/Population/RecomputeGeneration');
async function run() {
    require(path.join(root, 'src/Global'));
    const Data = invoke('GameServer/DataCache'); Data.init();
    const Config = invoke('GameServer/Bot/Population/PopulationConfig');
    const DecisionEvents = invoke('GameServer/Bot/AI/DecisionEvents');
    Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    invoke('GameServer/Bot/Economy/PersonalWarehouseIndex').useRowSource(() => null, () => true);
    generation = Generation.metadata();
    Generation.configure({ code: '1'.repeat(40), config: '2'.repeat(64) });
    const Board = invoke('GameServer/AfkTrade/BoardIndex').BoardIndex;
    const board = new Board();
    // T43 spawns: 711, 485, 79 and 344 have no coordinate spawns; the fields of test_detour_own_trip.
    const spots = require('./helpers/wishSectionSpots')([600, 1011, 924, 755, 609]);
    Economy.configure({ board: () => board, spots: () => spots });
    Config.knowledgeErrorsEnabled = false;
    // A level-35 warrior in the gear its level plans, idle on a field it may hunt.
    const inventory = {};
    for (const row of invoke('GameServer/Bot/AI/BotGear').planFor({ classId: 1, level: 35 }).items) {
        const slots = [...inventory[row.selfId]?.equippedSlots || [], row.slot];
        inventory[row.selfId] = { ...row, amount: slots.length, equipped: true, equippedCount: slots.length, equippedSlots: slots };
    }
    const spot = spots.find(row => String(row.id) === '-5_16');
    assert(spot?.center, 'fixture: spot -5_16');
    const native = { phase: 'cold', activity: 'idle', level: 35, adena: 50, inventory, characterId: 990201,
        spotId: spot.id, currentRegion: spot.name, loc: { ...spot.center },
        stats: { classId: 1, exp: Data.experience[34], persona: { traits: { commitment: .5, caution: .5,
            resilience: .5, ambition: .5, empathy: .5, sociability: .5, assertiveness: .5 }, understanding: .8 } },
        timing: {}, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } };
    const T = Date.now();
    const held = Economy.forState(native, { timestamp: T });
    const packet = held.statsPacket, leaf = held.network.activity, proof = held.eventProof();
    assert(leaf?.activity, 'fixture: the build chose an activity');
    assert.notEqual(Number(packet.decisionSeq || 0), 0, 'fixture: the build bumped its own sequence (a new focus)');
    // The decision the build read: the native state's (no sequence, leaf or focus yet).
    const input = [0, 0, null];
    // The money the held build passes (EconomyContext heldMoney): a state
    // at the build's input reads the build's own packet, as at its output.
    const verdict = state => Economy.eventProofHolds(state, proof, { timestamp: T },
        { baseline: packet.wishSections, leaf, timestamp: T, input, money: packet.money });
    const withStats = stats => ({ ...native, stats: { ...native.stats, ...stats } });

    assert.equal(verdict(native), true, 'the state still carrying the decision the build read holds: its own bump is no input');
    assert.equal(verdict(withStats(packet)), true, 'the state carrying the written packet holds');
    console.log('PASS the held build\'s own sequence bump keeps it');

    assert.equal(verdict(withStats({ decisionSeq: Number(packet.decisionSeq) + 4 })), false,
        'a sequence another build wrote refuses');
    assert.equal(verdict(withStats({ activityLeaf: 12345 })), false, 'another leaf at the input sequence refuses');
    const raised = withStats({});
    DecisionEvents.applyRaise(raised.stats, 1);
    assert.equal(verdict(raised), false, 'a raise after the build refuses');
    console.log('PASS a real move of the decision refuses the held build');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    Economy?.reset();
    invoke('GameServer/Bot/Economy/PersonalWarehouseIndex').useRowSource(null);
    if (generation) Generation.configure(generation);
    process.chdir(oldCwd);
    if (oldConfig === undefined) delete process.env.L2NODE_CONFIG_FILE; else process.env.L2NODE_CONFIG_FILE = oldConfig;
    if (oldShared === undefined) delete process.env.L2NODE_SHARED_CONFIG_FILE; else process.env.L2NODE_SHARED_CONFIG_FILE = oldShared;
    fs.rmSync(dir, { recursive: true, force: true });
});
