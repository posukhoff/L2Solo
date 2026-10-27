'use strict';
// craftfocus + T01: plans follow the focus root; every bag consumer reads one
// held reader (the focus plan and the claims of the decision the state
// carries, stats.heldClaims: one answer on either thread, with or without a
// card); inside a build the network splits held stock itself and its
// liquidation preview takes off the claims of the same build, per unit.
// Runs on the main thread, then once more in a worker thread.
const assert = require('node:assert/strict');
const { Worker, isMainThread, parentPort } = require('node:worker_threads');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
Data.init();
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const ShotCraft = invoke('GameServer/Bot/Economy/ShotCraftPolicy');
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Crystals = invoke('GameServer/Bot/Economy/BotCrystallization');
const { WishNetwork } = require('../src/GameServer/Bot/Economy/WishNetwork');

const CRYSTAL_D = 1458, STEM = 1864, BONE = 1872;
const base = (id, inventory, stats = {}) => ({ characterId: id, level: 30, phase: 'cold', activity: 'hunting',
    adena: 1000, inventory, vitals: { hp: 500, maxHp: 500, mp: 300, maxMp: 300 },
    stats: { classId: 56, decisionSeq: 3, activityLeaf: 1, wishFocus: ['power:2:7'], ...stats } });
const material = (selfId, amount) => ({ selfId, amount, kind: 'Other.Material' });
const saleCount = (state, id) => Disposition.saleCandidates(state, { unlimited: true })
    .filter(row => row.selfId === id).reduce((sum, row) => sum + row.count, 0);

function verify(thread) {
    // 1. The decision's claims hold with no card on either thread: the sale
    // and the warehouse leave them (B1, B2); the decision's own executors
    // (shot craft, crystallize) take what its split gave them, a goal's claim
    // covering its own inputs too.
    {
        const inventory = { [CRYSTAL_D]: { selfId: CRYSTAL_D, amount: 10 }, [STEM]: material(STEM, 30) };
        const open = base(990101, inventory), held = base(990101, inventory, { heldClaims: [[CRYSTAL_D, 6], [STEM, 12, 1]] });
        assert.equal(Disposition.heldAmounts(held)[CRYSTAL_D], 6, `${thread}: every goal's claim is held`);
        assert(saleCount(open, STEM) > 12, 'fixture: the stems are for sale without a claim');
        assert.equal(saleCount(held, STEM), saleCount(open, STEM) - 12, `${thread}: the sale leaves the claimed stems`);
        assert.equal(Disposition.unreservedActorItems(open, [{ selfId: STEM, amount: 30 }]).length, 1, 'fixture: a free stack');
        assert.equal(Disposition.unreservedActorItems(held, [{ selfId: STEM, amount: 30 }]).length, 0,
            `${thread}: a partly claimed stack stays out of a town task`);
        assert.equal(ShotCraft.availableMaterial(held, CRYSTAL_D), ShotCraft.availableMaterial(open, CRYSTAL_D),
            `${thread}: the decision's shot craft is not blocked by its own goal's claim`);
        assert.equal(Crystals.freeReader(held)(STEM), Crystals.freeReader(open)(STEM),
            `${thread}: the decision's crystallize is not blocked by its own goal's claim`);
    }
    // 2. The focus plan part and the claims merge by the larger amount per
    // item; a claim is capped by the bag.
    {
        const plan = { equipmentPlan: { status: 'active', strategy: 'craft', recipeId: 1, target: { selfId: 2 },
            materials: [{ selfId: STEM, amount: 12 }] } };
        const held = claims => Disposition.heldAmounts(base(990102, { [STEM]: material(STEM, 30) }, { ...plan, heldClaims: claims }))[STEM];
        assert.equal(held([[STEM, 5]]), 12);
        assert.equal(held([[STEM, 20]]), 20);
        assert.equal(held([[STEM, 40]]), 30, 'a claim is capped by the bag');
    }
    // 3. The craft plan target is the focus: a leaf serving another root gives no plan.
    {
        const state = base(990103, {});
        const network = { focus: ['power:2:7'], queue: [], plans: new Map(),
            activity: { activity: 'crafting', rootKey: 'power:3:7', recipeId: 1 } };
        assert.equal(Providers.personalCraftPlan(state, { network }), null, 'a step for another root makes no plan');
        const focus = Providers.focusWish({ network });
        assert.equal(focus.wish.object.itemId, 2, 'the plan target is the focus item');
        assert.equal(focus.serving, false);
        assert.equal(Providers.focusWish({ network: { ...network, activity: { ...network.activity, rootKey: 'power:2:7' } } }).serving, true);
    }
    // 4. The liquidation preview reads no claims of an earlier decision (B3):
    // the same rows with or without them, and its check re-run on the proof's
    // own basis gives the same rows.
    {
        const inventory = { [STEM]: material(STEM, 40) };
        const basis = { shots: { itemId: 1835, target: 0, beginnerCurrent: 0 }, potions: { target: 0 }, excluded: [] };
        const open = Providers.liquidationInputs(base(990104, inventory), basis);
        const held = Providers.liquidationInputs(base(990104, inventory, { heldClaims: [[STEM, 40]] }), basis);
        assert(open.candidates.some(row => Number(row.selfId) === STEM), 'fixture: a free material funds the visit');
        assert.deepEqual(held.proof.rows, open.proof.rows, 'an earlier decision\'s claims are no input of the next build');
        assert.deepEqual(Providers.liquidationInputs(base(990104, inventory), held.proof.basis).proof.rows, open.proof.rows);
    }
    // 5. The network's funding sale keeps what its own goals claim, per unit
    // (B3, B4): of 200 bones a craft claims 20, the sale funds the gap with
    // the other 180; claimed beyond the bag, it sells none.
    {
        const craft = { key: 'power:2453:10', need: 'power', object: { itemId: 2453, slot: 10 }, valueHours: 100, price: 24000,
            paths: [{ kind: 'craft', activity: 'crafting', quoted: true, costHours: .1,
                grossRequirements: [{ key: `item:${BONE}`, amount: 20 }], requirements: [{ key: `item:${BONE}`, amount: 20 }] }] };
        const bone = { key: `item:${BONE}`, object: BONE, price: 10, paths: [{ kind: 'npc', activity: 'shopping',
            itemId: BONE, price: 10, costHours: .01, quoted: true }] };
        const upgrade = { key: 'upgrade', need: 'power', progressionPriority: 2, valueHours: 1000, price: 254442,
            paths: [{ activity: 'shopping', price: 254442 }] };
        const build = (owned, sale) => new WishNetwork().build({ actorKey: 'bones', inputKey: JSON.stringify([owned, sale]),
            remembered: false, nodes: [upgrade, craft, bone], roots: [upgrade.key, craft.key], wallet: 10, hourAdena: 0,
            stockFor: id => ({ owned: id === BONE ? owned : 0, incoming: 0 }),
            moneyPaths: [{ activity: 'selling', kind: 'liquidate', repeatable: false, cashFees: 0, actionHours: .25, sale }] });
        const funded = build(200, [[BONE, 200, 200, 10]]);
        assert(funded.heldClaims?.some(([id, units]) => id === BONE && units === 20), 'fixture: the craft claims 20 bones');
        assert.equal(funded.activity?.funding, true, 'fixture: the sale funds the upgrade');
        assert.equal(funded.activity.contribution, 1800, `${thread}: the sale keeps the 20 claimed bones`);
        assert.deepEqual(funded.activity.items, [BONE]);
        // Two enchant groups of one item share one free budget.
        assert.equal(build(200, [[BONE, 150, 200, 10], [BONE, 50, 200, 10]]).activity.contribution, 1800,
            `${thread}: the claim comes off the item once, not off each row`);
        const short = build(15, [[BONE, 15, 15, 10]]);
        assert.notEqual(short.activity?.funding, true, `${thread}: a bag the goals claim whole funds nothing`);
    }
    console.log(`test_craftfocus ok (${thread})`);
}
verify(isMainThread ? 'main' : 'worker');
if (isMainThread) {
    const worker = new Worker(__filename);
    worker.on('error', error => { console.error(error); process.exitCode = 1; });
    worker.on('exit', code => { if (code) process.exitCode = code; });
} else parentPort.postMessage('verified');
