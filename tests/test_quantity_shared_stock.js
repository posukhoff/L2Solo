'use strict';
// A held build keeps its quantity proof when many roots read the same bag
// counts (one row per stock fact, WishNetwork createQuantityInputs), and a
// count crossing a threshold any of those roots compared still refuses it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(process.env.N53_GAME_ROOT || path.join(__dirname, '..'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quantity-shared-stock-'));
const oldCwd = process.cwd();
const oldConfig = process.env.L2NODE_CONFIG_FILE;
const oldShared = process.env.L2NODE_SHARED_CONFIG_FILE;
const config = path.join(dir, 'config.ini');
fs.writeFileSync(config, fs.readFileSync(path.join(root, 'config/default.ini'), 'utf8')
    + `\n[Database]\npath=${path.join(dir, 'world.sqlite')}\nhistoryPath=${path.join(dir, 'history.sqlite')}\n`);
process.env.L2NODE_CONFIG_FILE = config;
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.chdir(root);
const Generation = require('../src/GameServer/Bot/Population/RecomputeGeneration');
let Economy, generation = null;
try {
    require(path.join(root, 'src/Global'));
    const Data = invoke('GameServer/DataCache'); Data.init();
    Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const Network = invoke('GameServer/Bot/Economy/WishNetwork');
    invoke('GameServer/Bot/Economy/PersonalWarehouseIndex').useRowSource(() => null, () => true);
    generation = Generation.metadata();
    Generation.configure({ code: '1'.repeat(40), config: '2'.repeat(64) });
    const board = new (invoke('GameServer/AfkTrade/BoardIndex').BoardIndex)();
    const spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure();
    Economy.configure({ board: () => board, spots: () => spots });
    const stem = 1864, ore = 1869;
    const native = { characterId: 990301, phase: 'cold', activity: 'hunting', level: 35, adena: 50,
        inventory: { 1: { selfId: 1, amount: 1, equipped: true, equippedCount: 1, slot: 7 },
            [stem]: { selfId: stem, amount: 10, stackable: true }, [ore]: { selfId: ore, amount: 6, stackable: true } },
        loc: { locX: 80000, locY: 148000, locZ: -3500 }, currentRegion: 'Giran',
        stats: { classId: 1, exp: Data.experience[34], persona: { traits: { commitment: .5, caution: .5,
            resilience: .5, ambition: .5, empathy: .5, sociability: .5, assertiveness: .5 }, understanding: .8 } },
        timing: {}, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } };
    const T = Date.now();
    const deps = () => ({ timestamp: T, memoryIdentity: 'fixture-memory', sourceReady: true });
    const held = Economy.forState(native, deps());
    const packet = held.statsPacket, published = { ...native, stats: { ...native.stats, ...packet } };
    const plan = held.plan;
    // 40 gear roots each read the free count of the same 60 materials, as a
    // build's allocations do (EconomyContext stockFor): 2400 reads, more
    // than the proof's row limit (2048) unless one row serves every root.
    const quantities = Network.createQuantityInputs();
    const roots = Array.from({ length: 40 }, (_, at) => `power:${2000 + at}:7`);
    const items = [stem, ore, ...Array.from({ length: 58 }, (_, at) => 1880 + at)];
    for (const rootKey of roots) {
        for (const id of items) {
            const owned = Number(native.inventory[id]?.amount || 0);
            quantities.stock(id, rootKey, { owned, incoming: 0 }, '');
            quantities.atLeast('stock', id, 1, rootKey);
        }
    }
    // Two roots compared the stems with their own counts: 5 and 12.
    quantities.atLeast('stock', stem, 5, roots[3]);
    quantities.atLeast('stock', stem, 12, roots[17]);
    plan.quantityInputs = quantities.finish(); plan.quantityThresholds = quantities.thresholds();
    // The fixture's roots read these items, so they are no unused loot: the
    // build's free-loot bands (EconomyContext quantityBands) cover only stacks
    // absent from every admitted requirement, and a real build reading them
    // would carry none on them.
    plan.quantityBands = plan.quantityBands.filter(band => !items.includes(band[0]));
    plan.eventProof = Economy.captureEventProof(published, deps(), { plan });
    assert(plan.eventProof, 'a build whose roots read the same bag counts keeps its proof');
    const options = { baseline: packet.wishSections, leaf: held.network.activity, timestamp: T };
    const bag = amounts => ({ ...published, inventory: { ...published.inventory,
        ...Object.fromEntries(Object.entries(amounts).map(([id, amount]) => [id, { selfId: Number(id), amount, stackable: true }])) } });
    const reason = state => Economy.heldBuildVerdict(state, plan.eventProof,
        { ...deps(), gearThreatMask: held.gearThreatMask }, options).reason || 'valid';
    assert.equal(reason(bag({})), 'valid', 'the unchanged bag holds the build');
    assert.equal(reason(bag({ [stem]: 13 })), 'quantity', 'stems crossing one root\'s threshold (12) refuse');
    assert.equal(reason(bag({ [stem]: 4 })), 'quantity', 'stems crossing another root\'s threshold (5) refuse');
    assert.equal(reason(bag({ [ore]: 0 })), 'quantity', 'a read count running out refuses');
    console.log('PASS shared stock rows: many roots keep one proof / every root\'s threshold still refuses');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    Economy?.reset();
    invoke('GameServer/Bot/Economy/PersonalWarehouseIndex').useRowSource(null);
    if (generation) Generation.configure(generation);
    process.chdir(oldCwd);
    if (oldConfig === undefined) delete process.env.L2NODE_CONFIG_FILE; else process.env.L2NODE_CONFIG_FILE = oldConfig;
    if (oldShared === undefined) delete process.env.L2NODE_SHARED_CONFIG_FILE; else process.env.L2NODE_SHARED_CONFIG_FILE = oldShared;
    fs.rmSync(dir, { recursive: true, force: true });
}
