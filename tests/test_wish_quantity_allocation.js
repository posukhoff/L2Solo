'use strict';
const assert = require('node:assert/strict');
const { WishNetwork, createQuantityInputs, quantityInputsHold, eachQuantityRow,
    QUANTITY_INPUT_LIMIT, QUANTITY_INPUT_BYTES } = require('../src/GameServer/Bot/Economy/WishNetwork');
const Intent = require('../src/GameServer/Bot/Economy/TradeIntent');
function build(nodes, roots, stockFor) {
    return new WishNetwork().build({ actorKey: 'quantity', inputKey: 'fresh', nodes, roots, stockFor,
        wallet: 10000, hourAdena: 100, persona: { traits: { commitment: 0 } }, remembered: false });
}
const material = { key: 'item:202', price: 2, paths: [{ kind: 'buy', activity: 'shopping', price: 2,
    itemId: 202, executable: true, quoted: true, availableUnits: 100 }] };
const product = { key: 'item:101', price: 500, paths: [{ kind: 'craft', activity: 'crafting', costHours: .1,
    itemId: 101, productCount: 2, recipeId: 7, grossRequirements: [{ key: 'item:202', amount: 10 }],
    requirements: [{ key: 'item:202', amount: 6 }] }] };
const root = { key: 'power:101:7', need: 'power', valueHours: 100, object: { itemId: 101 },
    paths: [{ requirements: [{ key: product.key, amount: 5 }] }] };
let result = build([root, product, material], [root.key], id => id === 202 ? { owned: 4, incoming: 2 } : {});
let attempt = result.plans.get(root.key).requirements[0].plan;
assert.equal(attempt.batches, 3);
assert.equal(attempt.requirements[0].amount, 24, 'three whole batches minus owned four and incoming two');
assert.equal(result.queue[0].price, 48, 'basket pays only for the remaining material');
assert.equal(attempt.awaitingIncoming, true, 'incoming is planned supply, never physical craft readiness');
assert.equal(result.activity.itemId, 202);
assert.equal(result.activity.amount, 24);
assert.equal(result.activity.price, 48);
assert.equal(Intent.project({}, result, {}).find(row => row.itemId === 202).amount, 24,
    'advertisement reads the same remaining quantity without a second subtraction');
result = build([root, product, material], [root.key], id => id === 202 ? { owned: 30 } : {});
attempt = result.plans.get(root.key).requirements[0].plan;
assert.equal(attempt.requirements.length, 0);
assert.equal(result.activity.itemId, 101, 'physical complete materials make the craft executable');
assert.equal(result.activity.batches, 3);
const roots = [100, 20].map((valueHours, index) => ({ key: `power:${300 + index}:7`, need: 'power', valueHours,
    object: { itemId: 300 + index },
    paths: [{ requirements: [{ key: 'item:202', amount: 8 }] }] }));
result = build([...roots, material], roots.map(row => row.key), () => ({ owned: 5 }));
assert.equal(result.plans.get(roots[0].key).requirements[0].amount, 3);
assert.equal(result.plans.get(roots[1].key).requirements[0].amount, 8, 'lower priority root cannot reuse the first root stock');
assert.equal(Intent.project({}, result, {})[0].amount, 3, 'one advert binds the first useful root');
const alternatives = { key: 'item:101', price: 500, paths: [product.paths[0],
    { ...product.paths[0], recipeId: 8, grossRequirements: [{ key: 'item:202', amount: 12 }] }] };
result = build([root, alternatives, material], [root.key], id => id === 202 ? { owned: 4 } : {});
assert.equal(result.plans.get(root.key).requirements[0].plan.requirements[0].amount, 26,
    'alternative recipes start from the same owned-stock baseline');

// A ready craft with its own physical ingredients is the step; one short
// switches the same native build to the missing material, and an acquired
// output cuts the batches it still crafts.
const physical = (amount, incoming = 0, outputOwned = 0, outputIncoming = 0) => id => id === 202
    ? { owned: amount, incoming } : id === 101 ? { owned: outputOwned, incoming: outputIncoming } : {};
const ready = build([root, product, material], [root.key], physical(30));
assert.equal(ready.activity.kind, 'craft');
assert.equal(build([root, product, material], [root.key], physical(29)).activity.itemId, 202,
    'the same native build switches from ready craft to its missing material');
assert.equal(build([root, product, material], [root.key], physical(30, 0, 1)).activity.batches, 2,
    'one acquired output cuts three retained batches down to two');

// Other roots can consume the same item.
const other = { key: 'power:302:9', need: 'power', valueHours: 1000,
    paths: [{ requirements: [{ key: material.key, amount: 8 }] }] };
assert.equal(build([other, root, product, material], [other.key, root.key], physical(38)).activity.kind, 'craft');
assert.equal(build([other, root, product, material], [other.key, root.key], physical(30)).activity.itemId, 202,
    'another root can still consume stock above the craft\'s own batch');
const alternativeReady = { ...product, paths: [product.paths[0],
    { ...product.paths[0], recipeId: 8, costHours: 10, grossRequirements: [{ key: material.key, amount: 12 }] }] };

// Complete native reads precede pruning and include every alternative/root.
{
    const quantities = createQuantityInputs(), baseline = physical(38);
    const watched = (id, rootKey) => quantities.stock(id, rootKey, baseline(id, rootKey));
    const actual = build([other, root, alternativeReady, material], [other.key, root.key], watched);
    assert.deepEqual(actual, build([other, root, alternativeReady, material], [other.key, root.key], baseline),
        'capturing all native allocations preserves full decisions, plans and projections');
    const packed = quantities.finish(), rows = [];
    assert(packed instanceof Uint8Array && packed.byteLength <= QUANTITY_INPUT_BYTES);
    assert(eachQuantityRow(packed, row => { rows.push(row); }));
    assert(rows.some(row => row[0] === 'stock' && row[1] === root.key && row[2] === 101 && row[3] === 0),
        'zero output stock is an actual input too');
    assert(rows.some(row => row[0] === 'stock' && row[1] === other.key && row[2] === 202));
    assert.equal(quantityInputsHold(packed, { stockFor: baseline }), true);
    assert.equal(quantityInputsHold(packed, { stockFor: physical(30) }), false,
        'loss above the selected craft necessary floor still invalidates competing allocation');
    assert.equal(quantityInputsHold(packed, { stockFor: physical(37, 1) }), false,
        'equal owned+incoming totals cannot certify physical execution');
    assert.equal(quantityInputsHold(packed, { stockFor: (id, key) => key === other.key && id === 202
        ? { owned: 0 } : baseline(id, key) }), false, 'root-specific protected stock is read with the same root');

    const direct = createQuantityInputs();
    direct.present(202, 3); direct.free(203, 0); direct.physical(204, 2); direct.incoming(205, 1); direct.freePresent(206, 3);
    const directProof = direct.finish();
    const readers = { physical: id => id === 202 ? 4 : 2, free: id => id === 206 ? 4 : 0, incoming: () => 1 };
    assert.equal(quantityInputsHold(directProof, readers), true, 'a native positive-presence branch admits positive quantity drift');
    assert.equal(quantityInputsHold(directProof, { ...readers, physical: () => 0 }), false);
    assert.equal(quantityInputsHold(directProof, { ...readers, free: () => 1 }), false);
    assert.equal(quantityInputsHold(null, readers), false, 'missing and unsupported evidence never mean quiet');

    const overflow = createQuantityInputs();
    for (let id = 1; id <= QUANTITY_INPUT_LIMIT + 1; id++) overflow.physical(id, 0);
    assert.equal(overflow.finish(), null, 'overflow abstains instead of keeping a truncated proof');
    const tooLarge = createQuantityInputs();
    tooLarge.stock(1, 'x'.repeat(QUANTITY_INPUT_BYTES), {});  // the packed form exceeds its byte cap
    assert.equal(tooLarge.finish(), null, 'byte overflow also abstains');
    const unstable = createQuantityInputs(); unstable.physical(1, 0); unstable.physical(1, 1);
    assert.equal(unstable.finish(), null, 'inconsistent within-build owner answers cannot be certified');
}
console.log('Canonical wish quantities: whole batches, own/incoming stock, native readiness, basket cost and shared root allocation passed');
