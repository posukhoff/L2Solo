const assert = require('assert/strict');
require('../src/Global');
const Intent = require('../src/GameServer/Bot/Economy/TradeIntent');
const keys = ['power:101:7', 'stock:shots', 'stock:potions', 'stock:scrolls', 'book:123', 'enchant:123:4',
    'sa:123:555', 'henna:10', 'status:101', 'resale:101'];
for (const key of keys) {
    const row = { key, itemId: 202, amount: 6, price: 11, recipeId: 301, valueHours: 2, valueRate: .01 };
    assert.deepEqual(Intent.decode(Intent.encode(row)), row);
}
for (const key of ['unknown:1', 'stock:food', 'power:1', 'book:1:2', 'power:NaN:7']) assert.throws(() => Intent.rootTuple(key));
for (const bad of [NaN, Infinity, -1]) assert.throws(() => Intent.encode({ key: 'book:1', itemId: 1, amount: 1, price: 1, valueHours: bad, valueRate: 1 }));

const plannedPurchase = (sourceType, quoted, executable, count = 1) => ({ kind: 'buy', activity: 'shopping',
    sourceType, quoted, executable, missingAmount: count, availableUnits: executable ? count : 0, requirements: [] });
const preparedRoot = (key, itemId, child) => ({ key, object: { itemId }, valueHours: 1, ratio: .1,
    plan: { missingAmount: 1, requirements: [{ key: `item:${itemId}`, amount: child.missingAmount, plan: child }] } });
const nativeNpcPlan = plannedPurchase('npc', true, true);
const projectedQueue = [preparedRoot('power:101:7', 101, plannedPurchase(undefined, false, false)),
    preparedRoot('henna:501', 300, nativeNpcPlan), preparedRoot('henna:502', 301, nativeNpcPlan),
    { key: 'resale:501', object: { itemId: 501, kind: 'resale' }, valueHours: 1, ratio: .1,
        plan: { kind: 'craft', recipeId: 401, missingAmount: 1,
            requirements: [{ key: 'item:202', amount: 10, plan: plannedPurchase(undefined, false, false, 10) }] } },
    preparedRoot('stock:shots', 303, plannedPurchase('afk', true, true))];
const preparedNetwork = { quantityPrepared: true, queue: projectedQueue };
const beforeProjection = JSON.stringify(preparedNetwork);
assert.deepEqual(Intent.project({}, preparedNetwork, {}).map(row => row.itemId), [101, 202, 303],
    'two native NPC jobs leave existing three public slots for future/player supply and producer inputs');
assert.equal(JSON.stringify(preparedNetwork), beforeProjection, 'public projection does not change queue, funding or native action');
assert.equal(Intent.project({}, { quantityPrepared: true,
    queue: [preparedRoot('henna:501', 300, plannedPurchase('npc', false, false))] }, {})[0].itemId, 300,
    'unknown/unexecutable NPC annotation cannot hide an intended future acquisition');
// Batch rounding and the single stock pool are WishNetwork's (test_wish_quantity_allocation);
// a network without that stock reader has no remaining amounts and defers.
assert.equal(Intent.project({ inventory: { 202: { amount: 4 } } }, { queue: projectedQueue }, {}), null,
    'an unprepared network is never projected by a second stock subtraction');
assert.deepEqual(Intent.project({}, { quantityPrepared: true, queue: [preparedRoot('power:101:7', 101, nativeNpcPlan)] }, {}), [],
    'a chosen native NPC purchase bids nothing, neither the item nor an unchosen craft\'s inputs');
const sharedInput = (count) => plannedPurchase(undefined, false, false, count);
const repeated = Intent.project({}, { quantityPrepared: true, queue: [{ key: 'power:101:7', object: { itemId: 101 }, valueHours: 2, ratio: .01,
    plan: { missingAmount: 1, requirements: [{ key: 'item:101', amount: 1, plan: { kind: 'craft', recipeId: 301, missingAmount: 1,
        requirements: [{ key: 'item:202', amount: 6, plan: sharedInput(6) }, { key: 'item:203', amount: 1,
            plan: { kind: 'craft', recipeId: 302, missingAmount: 1, requirements: [{ key: 'item:202', amount: 6, plan: sharedInput(6) }] } }] } }] } }] },
    {}).find(row => row.itemId === 202);
assert.equal(repeated.amount, 12, 'repeated input quantities are summed before publication');
assert(repeated.valueHours <= 2);
// A crafted root splits its value by input price, not by unit count: the
// recipe scroll x1 keeps the share its price adds to the craft.
const priced = (count, basePrice) => ({ ...plannedPurchase(undefined, false, false, count), basePrice });
const craftRows = Intent.project({}, { quantityPrepared: true, queue: [{ key: 'resale:72', object: { itemId: 72, kind: 'resale' },
    valueHours: 100, ratio: .01, plan: { kind: 'craft', recipeId: 72, missingAmount: 1, requirements: [
        { key: 'item:2298', amount: 1, plan: priced(1, 20000) }, { key: 'item:1864', amount: 800, plan: priced(800, 8000) },
        { key: 'item:1865', amount: 200, plan: plannedPurchase(undefined, false, false, 200) }] } }] }, {}, 40);
const perUnit = id => { const row = craftRows.find(r => r.itemId === id); return row.valueHours / row.amount; };
assert(Math.abs(perUnit(2298) - 100 * 20000 / (28000 + 200 * 28000 / 801)) < 1e-9, 'the scroll keeps its price share of the root value');
assert(Math.abs(perUnit(2298) / perUnit(1864) - 2000) < 1e-9, 'per-unit value follows the input price');
assert(Math.abs(perUnit(1865) / perUnit(2298) - 28000 / 801 / 20000) < 1e-9, 'an unpriced input weighs the mean unit price of the priced ones');
// The same split feeds the economy's own worth (WishNetwork.flow demands)
// and the buy intent: through a built network the scroll x1 among 800 cheap
// units keeps its price share in both, not one unit's 1/801.
const { WishNetwork, moneyQueue } = require('../src/GameServer/Bot/Economy/WishNetwork');
const { compactNetwork } = require('../src/GameServer/Bot/Economy/EconomyContext');
const shop = (key, itemId, price) => ({ key, price, paths: [{ kind: 'buy', activity: 'shopping', price, itemId,
    executable: true, quoted: true, availableUnits: 1000 }] });
const crafted = { key: 'item:72', price: 30000, paths: [{ kind: 'craft', activity: 'crafting', costHours: .1, itemId: 72,
    productCount: 1, recipeId: 72, grossRequirements: [{ key: 'item:2298', amount: 1 }, { key: 'item:1864', amount: 800 }],
    requirements: [{ key: 'item:2298', amount: 1 }, { key: 'item:1864', amount: 800 }] }] };
const craftRoot = { key: 'power:72:7', need: 'power', valueHours: 100, object: { itemId: 72 },
    paths: [{ requirements: [{ key: crafted.key, amount: 1 }] }] };
const built = new WishNetwork().build({ actorKey: 'split', inputKey: 'fresh', nodes: [craftRoot, crafted,
    shop('item:2298', 2298, 20000), shop('item:1864', 1864, 10)], roots: [craftRoot.key], stockFor: () => ({}),
    wallet: 1e6, hourAdena: 100, persona: { traits: { commitment: 0 } }, remembered: false });
assert(Math.abs(built.demands.get('item:2298') / built.demands.get('item:1864') - 2000) < 1e-9,
    'the economy values the scroll at its price share, not one unit of 801');
const builtRow = Intent.project({}, built, {}, 40).find(row => row.itemId === 2298);
assert(Math.abs(builtRow.valueHours / builtRow.amount - built.demands.get('item:2298')) < 1e-9,
    'the buy intent and the economy split the root alike');
// Only the chosen path bids (user 2026-10-24), each at the root's whole
// worth: a bought War Axe bids the axe, an exchanged one the D crystals its
// exchange takes, never both.
const moneyPrice = 200 / 6.4e6;
const axeRoot = plan => ({ key: 'power:162:7', object: { itemId: 162 }, valueHours: 200, ratio: .01, funded: true,
    plan: { missingAmount: 1, requirements: [{ key: 'item:162', amount: 1, plan }] } });
const bought = Intent.project({}, { quantityPrepared: true, moneyPrice, queue: [axeRoot(priced(1, 6e6))] }, {}, 8);
assert.deepEqual(bought.map(row => [row.itemId, row.amount]), [[162, 1]], 'a chosen purchase bids the item alone');
assert(Math.abs(bought[0].worth - 6.4e6) < 1e-6, 'the bought item keeps the root worth');
const exchanged = Intent.project({}, { quantityPrepared: true, moneyPrice, queue: [axeRoot({ kind: 'exchange', missingAmount: 1,
    grossRequirements: [{ key: 'item:1458', amount: 5000 }],
    requirements: [{ key: 'item:1458', amount: 5000, plan: priced(5000, 1200) }] })] }, {}, 8);
assert.deepEqual(exchanged.map(row => [row.itemId, row.amount]), [[1458, 5000]], 'a chosen exchange bids its inputs, not its product');
assert(Math.abs(exchanged[0].worth * exchanged[0].amount - 6.4e6) < 1e-6, 'the inputs share the root worth whole');
// A kit C gear root (a progression root) on the luxury path stands in the
// money queue at least at its price in hours, but its inputs share only its
// own value: a 3x dearer 1459 lifts the root's place, never the 1459 bid to
// its own price (the loop price -> worth -> bid -> price). A root with no
// kit priority bids the same share of its value as before.
const hourAdena = 50000, ownHours = 10, gearCash = 400000;
const luxuryQueue = (crystalPrice, progressionPriority) => {
    const requirements = [{ key: 'item:1459', amount: 573, plan: priced(573, 573 * crystalPrice) },
        { key: 'item:2500', amount: 1, plan: priced(1, gearCash) }];
    return moneyQueue([{ key: 'power:2501:7', object: { itemId: 2501 }, valueHours: ownHours,
        price: 573 * crystalPrice + gearCash, progressionPriority,
        plan: { kind: 'luxury_exchange', missingAmount: 1, grossRequirements: requirements, requirements } }], 0, 0, 1 / hourAdena);
};
const crystalWorth = (crystalPrice, progressionPriority) => {
    const funding = luxuryQueue(crystalPrice, progressionPriority);
    const rows = Intent.project({}, { quantityPrepared: true, ...funding }, {}, 8);
    return { root: funding.queue[0], worth: rows.find(row => row.itemId === 1459).worth };
};
const ownShare = crystalPrice => ownHours * hourAdena * 573 * crystalPrice / (573 * crystalPrice + gearCash) / 573;
const kitRoot = crystalWorth(9000, 3);
assert(kitRoot.root.valueHours >= kitRoot.root.price / hourAdena - 1e-9, 'the kit root keeps its queue place at its price');
assert(kitRoot.worth <= ownShare(9000) + 1e-6, 'the 1459 worth stays within its share of the root own value');
assert(kitRoot.worth < 9000, 'the 1459 worth does not follow its raised price');
assert(Math.abs(crystalWorth(9000, 0).worth - ownShare(9000)) < 1e-6, 'a root without kit priority keeps its value share');
// A later view prices the funding again over the compact queue rows
// (EconomyContext.view over the kept plan): the root is floored again from
// its own value, so the 1459 worth is still its share, not the raised value.
const kept = compactNetwork(luxuryQueue(9000, 3)).queue;
const again = moneyQueue(kept, 0, 0, 1 / hourAdena);
const againWorth = Intent.project({}, { quantityPrepared: true, ...again }, {}, 8).find(row => row.itemId === 1459).worth;
assert(again.queue[0].valueHours >= again.queue[0].price / hourAdena - 1e-9, 'the repriced kit root keeps its queue place at its price');
assert(Math.abs(againWorth - ownShare(9000)) < 1e-6, 'a repriced kit root still bids 1459 at its own value share');
console.log('PASS public intention source ownership: selected NPC omitted, only the chosen path bids, future and player quotes retained, unchanged native queue and three-slot bound');

// A craft pays for its inputs at most its output at the item's market price
// less its own fee (the solve's inputCap): an orc without Create Item,
// missing Soulshots C traded at 140, crafts them at a known workshop
// (recipe 21: 476 shots from 1 C crystal + 15 Soul Ore, fee 500). When the
// crystal costs more than the 476 shots, the craft has no step: the bot bids
// the shots themselves (their unobserved buy) or waits.
const unobservedBuy = (itemId, price) => ({ kind: 'buy', activity: 'shopping', price, itemId, amount: 1,
    executable: false, availableUnits: 0, buyback: 1 });
const shotNodesFor = ({ ask = 120000, belief = 140, sold = belief } = {}) => [
    { key: 'item:1464', price: belief, ...(sold > 0 ? { soldPrice: sold } : {}), paths: [unobservedBuy(1464, belief),
        { kind: 'craft', activity: 'crafting', itemId: 1464, recipeId: 21,
            workshop: { characterId: 9, price: 500, townName: 'Giran' }, price: 500, executable: true, quoted: true,
            availableUnits: 476 * 10, costHours: 1 / 3600, productCount: 476,
            grossRequirements: [{ key: 'item:1785', amount: 15 }, { key: 'item:1459', amount: 1 }] }] },
    shop('item:1785', 1785, 135), shop('item:1459', 1459, ask)];
const networkOf = (root, nodes, oreHeld = 15) => new WishNetwork().build({ actorKey: 'orc', inputKey: 'shots',
    nodes: [root, ...nodes], roots: [root.key], stockFor: id => id === 1785 ? { owned: oreHeld } : {},
    wallet: 1e6, hourAdena: 1000, persona: { traits: { commitment: 0 } }, remembered: false });
const shotNetworkFor = ({ missing = 476, hoursPerShot = 1, ...prices } = {}) => networkOf({ key: 'stock:shots', need: 'power',
    valueHours: missing * hoursPerShot, price: missing * (prices.belief ?? 140),
    object: { itemId: 1464, amount: missing, kind: 'shots' },
    paths: [{ requirements: [{ key: 'item:1464', amount: missing }] }] }, shotNodesFor(prices));
const rowsOf = network => Intent.project({}, network, {}, 40);
const rootOf = (network, key) => network.queue.find(wish => wish.key === key);
const buysAt = (network, nodeKey, price) => network.activity?.activity === 'shopping'
    && network.activity.nodeKey === nodeKey && network.activity.price === price;
const dear = shotNetworkFor();
assert(rootOf(dear, 'stock:shots').funded !== true, 'a crystal dearer than the 476 shots it makes funds no craft');
assert(!rowsOf(dear).some(row => row.itemId === 1459) && !buysAt(dear, 'item:1459', 120000),
    'the bot neither bids nor shops the crystal above the shots it makes');
assert.equal(rowsOf(dear).find(row => row.itemId === 1464)?.amount, 476, 'it bids the shots themselves instead');
const cheap = shotNetworkFor({ ask: 40000 });
assert(buysAt(cheap, 'item:1459', 40000) && rootOf(cheap, 'stock:shots').funded,
    'a crystal cheaper than its 476 shots funds the craft and is bought at its ask');
assert(rowsOf(cheap).some(row => row.itemId === 1459) && !rowsOf(cheap).some(row => row.itemId === 1464),
    'the craft bids its crystal, not the shots');
// One ceiling for the step and its bids: a 50-shot top-up still crafts (the
// batch makes 476 shots) and bids the crystal up to 476 x 140 - 500 fee.
const topUp = shotNetworkFor({ ask: 40000, missing: 50, hoursPerShot: 1000 });
assert(buysAt(topUp, 'item:1459', 40000), 'a 50-shot top-up still crafts: the batch makes 476 shots');
const topUpCrystal = rowsOf(topUp).find(row => row.itemId === 1459);
assert(topUpCrystal && topUpCrystal.worth * topUpCrystal.amount <= 476 * 140 - 500 + 1e-6
    && topUpCrystal.worth * topUpCrystal.amount > 50 * 140, 'its crystal bid is the batch output less the fee');
assert(topUp.demands.get('item:1459') <= (476 * 140 - 500) * topUp.moneyPrice + 1e-9,
    'the economy values the crystal within the same ceiling');
// Only a traded price judges: shots priced 14 by their first price alone
// (no deals: sold price 0) keep the craft, as an unknown price does.
assert(buysAt(shotNetworkFor({ ask: 40000, belief: 14, sold: 0 }), 'item:1459', 40000), 'untraded shots keep the craft');
assert(buysAt(shotNetworkFor({ belief: 0 }), 'item:1459', 120000), 'an unknown shot price keeps the craft');
// The nearest traded product judges its whole chain: gear G traded at 1e6,
// made from 10 M (believed 100, never traded) made from R asked 300 each.
const chainFor = mSold => {
    const root = { key: 'power:9100:7', need: 'power', valueHours: 100, object: { itemId: 9100 },
        paths: [{ requirements: [{ key: 'item:9100', amount: 1 }] }] };
    const craftOf = (itemId, key, amount) => ({ kind: 'craft', activity: 'crafting', itemId, recipeId: itemId, productCount: 1,
        executable: true, quoted: true, availableUnits: 100, costHours: 1 / 3600, grossRequirements: [{ key, amount }] });
    const gear = { key: 'item:9100', price: 1e6, soldPrice: 1e6, paths: [unobservedBuy(9100, 1e6), craftOf(9100, 'item:9101', 10)] };
    const middle = { key: 'item:9101', price: 100, ...(mSold ? { soldPrice: mSold } : {}),
        paths: [unobservedBuy(9101, 100), craftOf(9101, 'item:9102', 1)] };
    return new WishNetwork().build({ actorKey: 'chain', inputKey: 'chain', nodes: [root, gear, middle, shop('item:9102', 9102, 300)],
        roots: [root.key], stockFor: () => ({}), wallet: 1e6, hourAdena: 1000, persona: { traits: { commitment: 0 } }, remembered: false });
};
const chain = chainFor(0);
const rawRow = rowsOf(chain).find(row => row.itemId === 9102);
assert(rootOf(chain, 'power:9100:7').funded && buysAt(chain, 'item:9102', 10 * 300), 'an untraded intermediate keeps the chain');
assert(rawRow && rawRow.worth * rawRow.amount > 10 * 100, 'the raw input is not capped at the intermediate\'s belief');
const tradedMiddle = chainFor(100);
assert(!rowsOf(tradedMiddle).some(row => row.itemId === 9102) && rowsOf(tradedMiddle).some(row => row.itemId === 9101),
    'a traded intermediate dearer to make than to buy is bid, not made');
// A buyer's line prices its inputs (src: a resale root with the craft on the
// root, WishProviders producer roots), not the market price of the shots it
// consumes: their crystal bids its share of the line.
const resale = networkOf({ key: 'resale:9200', need: 'power', valueHours: 1000, bidsInputs: 1e6,
    object: { itemId: 9200, amount: 1, kind: 'resale' },
    paths: [{ kind: 'craft', activity: 'crafting', itemId: 9200, recipeId: 9200, productCount: 1, executable: true, quoted: true,
        availableUnits: 10, costHours: 1 / 3600, grossRequirements: [{ key: 'item:1464', amount: 476 }] }] }, shotNodesFor({ ask: 40000 }));
const lineCrystal = rowsOf(resale).find(row => row.itemId === 1459);
assert(buysAt(resale, 'item:1459', 40000) && lineCrystal && lineCrystal.worth * lineCrystal.amount > 476 * 140,
    'under a buyer\'s line the crystal bids its share of the line');
console.log('PASS a craft pays for its inputs at most its output at the market price');

// Every funded root holds its first row in the limit (a craft root: its
// first input) before the focus root's many inputs fill the rest.
const manyInputs = { key: 'power:291:14', object: { itemId: 291 }, valueHours: 50, ratio: .1, funded: true,
    plan: { missingAmount: 1, requirements: [{ key: 'item:291', amount: 1, plan: { kind: 'craft', recipeId: 291, missingAmount: 1,
        requirements: Array.from({ length: 9 }, (_, at) => ({ key: `item:${1000 + at}`, amount: 1, plan: sharedInput(1) })) } }] } };
const resaleRoot = { key: 'resale:228', object: { itemId: 228, kind: 'resale' }, valueHours: 5, ratio: .05, funded: true,
    plan: { kind: 'craft', recipeId: 228, missingAmount: 1, requirements: [{ key: 'item:2357', amount: 1, plan: sharedInput(1) },
        { key: 'item:1864', amount: 10, plan: sharedInput(10) }] } };
const unfundedRoot = { ...preparedRoot('henna:503', 777, sharedInput(1)), funded: false };
const slots = Intent.project({}, { quantityPrepared: true, queue: [manyInputs, resaleRoot, unfundedRoot] }, {}, 8).map(row => row.itemId);
assert.deepEqual(slots, [1000, 2357, 1001, 1002, 1003, 1004, 1005, 1006],
    'the funded resale root bids its first input beside the focus root, which fills the remaining slots');
console.log('PASS every funded root keeps its first buy row within the limit');

// The gear the money waits for (the funding gap, unfunded) sorts first and
// keeps its first row beside the funded earning roots.
const gapGear = { ...preparedRoot('power:500:7', 500, sharedInput(1)), funded: false };
const cheapRoots = Array.from({ length: 8 }, (_, at) => ({ ...preparedRoot(`henna:${600 + at}`, 600 + at, sharedInput(1)), funded: true }));
const gapSlots = Intent.project({}, { quantityPrepared: true, gap: gapGear, queue: [gapGear, ...cheapRoots] }, {}, 8).map(row => row.itemId);
assert.deepEqual(gapSlots, [500, 600, 601, 602, 603, 604, 605, 606], 'the gap gear keeps its first row ahead of funded roots');
console.log('PASS the funding gap root keeps its first buy row within the limit');

// A supported scroll need must not defer unrelated gear intentions or bid review.
for (const [key, category] of [['stock:shots', 1], ['stock:potions', 2], ['stock:scrolls', 3]]) {
    assert.deepEqual(Intent.rootTuple(key), [2, category, 0]);
    assert.equal(Intent.rootKey(2, category, 0), key);
}
assert.throws(() => Intent.rootKey(2, 4, 0));
const scrollWish = preparedRoot('stock:scrolls', 736, plannedPurchase('afk', true, true));
const mixedPrepared = { quantityPrepared: true, queue: [
    preparedRoot('power:462:11', 462, plannedPurchase('afk', true, true)), scrollWish
] };
const mixedBefore = JSON.stringify(mixedPrepared);
const mixedRows = Intent.project({}, mixedPrepared, {}, 40);
assert.deepEqual(mixedRows.map(row => row.itemId), [462, 736]);
for (const row of mixedRows) assert.equal(Intent.decode(Intent.encode({ ...row, price: 100 })).key, row.key);
assert.equal(JSON.stringify(mixedPrepared), mixedBefore);
assert.deepEqual(Intent.project({}, { quantityPrepared: true, queue: [
    mixedPrepared.queue[0], preparedRoot('stock:scrolls', 736, nativeNpcPlan)
] }, {}, 40).map(row => row.itemId), [462], 'NPC scroll purchase does not block peer gear or duplicate the NPC job');
assert.equal(Intent.project({}, { quantityPrepared: true, queue: [
    mixedPrepared.queue[0], { ...scrollWish, key: 'stock:food' }
] }, {}, 40), null, 'unknown identities still defer instead of granting unsupported spending');
console.log('PASS scroll identity preserves existing codes, mixed gear projection and NPC ownership');

// The selected funded quote is executable consent for its own finite units,
// even when a mandatory kit upgrade exceeds the general willingness estimate.
const Funding = require('../src/GameServer/Bot/Economy/PurchaseFunding');
const requiredWish = { ...preparedRoot('power:101:7', 202,
    { ...plannedPurchase('afk', true, true, 10), unitPrice: 1459, town: 'Dion' }),
    funded: true, progressionPriority: 3, price: 14590, valueHours: 1,
    ratio: 1 / 90155 };
// One unit's share at this money price is worth 378 (row.worth).
const selectedNetwork = { quantityPrepared: true, moneyPrice: 1 / 3780, queue: [requiredWish], activity: {
    kind: 'buy', activity: 'shopping', sourceType: 'afk', quoted: true, executable: true,
    itemId: 202, amount: 2, availableUnits: 2, unitPrice: 1459, town: 'Dion', rootKey: requiredWish.key
} };
const standing = Intent.project({}, selectedNetwork, {}, 40);
const terms = { selfId: 202, count: 2, price: 1459, town: 'Dion', enchant: 0 };
assert.equal(standing[0].worth, 378, 'selected purchase does not inflate the standing bid for all missing units');
const agreed = Intent.meetingPurchase(selectedNetwork, standing, terms);
assert(agreed, 'a funded selected quote reaches meeting preparation at its decided price');
assert.equal(agreed.amount, 2, 'only the selected finite stock receives quote authority');
assert.equal(agreed.valueHours, standing[0].valueHours * 2 / 10);
const packet = Funding.packetFor({ ...selectedNetwork, moneyPrice: requiredWish.ratio }, 90155, 0);
assert.equal(Funding.spendable({ adena: 20000, stats: { money: packet } }, 0,
    { r: agreed.valueRate }), 20000, 'the certificate uses the native packet rounding at the funding floor');
for (const changed of [{ count: 3 }, { price: 1460 }, { town: 'Giran' }, { selfId: 203 }, { enchant: 1 }]) {
    assert.equal(Intent.meetingPurchase(selectedNetwork, standing, { ...terms, ...changed }), null,
        'selected consent cannot cover a changed item, price, town, enchant or excess amount');
}
for (const changed of [{ executable: false }, { quoted: false }, { sourceType: 'npc' }, { kind: 'farm' }, { rootKey: 'power:999:7' }]) {
    assert.equal(Intent.meetingPurchase({ ...selectedNetwork, activity: { ...selectedNetwork.activity, ...changed } }, standing, terms), null);
}
assert.equal(Intent.meetingPurchase({ ...selectedNetwork, queue: [{ ...requiredWish, funded: false }] }, standing, terms), null);
assert.equal(standing[0].amount, 10); assert.equal(standing[0].worth, 378);
const priorFunding = { stats: { wishFocus: [requiredWish.key], money: [100, .01, 0, 0, .01, 20000, 202] } };
assert.equal(Intent.meetingPurchase(selectedNetwork, standing, terms, priorFunding).valueRate, .01,
    'fresh valuation can spend the same goal at its already funded native priority');
assert.equal(Intent.meetingPurchase(selectedNetwork, [{ ...standing[0], worth: 2000 }], terms, priorFunding).valueRate, .01,
    'the selected ordinary quote uses that same native bucket after a changed hour estimate');
assert.equal(Intent.meetingPurchase(selectedNetwork, standing, terms,
    { stats: { ...priorFunding.stats, wishFocus: ['power:999:7'] } }).valueRate, standing[0].valueRate,
    'another goal cannot donate its native funding priority');
// Willingness is the row's value at the network's money price (purchaseWorth),
// not its stored worth: a row worth 2000 a unit covers the 1459 quote itself.
assert.equal(Intent.meetingPurchase(selectedNetwork, [{ ...standing[0], valueHours: standing[0].valueHours * 2000 / 378 }],
    terms).amount, 10, 'ordinary public willingness remains valid without selected-quote fallback');
// A partial cross (partialcross 2026-10-25): a crafter needs 2 Recipe: Arthro
// Nail (4189) and Orc Village asks 1 at 169k. The step the build chose buys
// that unit (network.activity, flow's leaf) and the bid holds only the unit
// the town lacks, at the same unit worth; a town that asks the whole lot, a
// buy that waits, or a short buy that is not the chosen step keeps the bid
// for all missing units.
const scrollBuy = (missing, available, executable = true) => ({ kind: 'buy', activity: 'shopping', sourceType: 'afk',
    quoted: true, executable, missingAmount: missing, availableUnits: available, unitPrice: 169000, town: 'Orc Village', requirements: [] });
const scrollNetwork = (child, activity = null) => ({ quantityPrepared: true, moneyPrice: 1 / 1000, activity, queue: [{
    key: 'resale:267', object: { itemId: 267, kind: 'resale' }, valueHours: 600, ratio: .01, funded: true,
    plan: { kind: 'craft', recipeId: 453, missingAmount: 1, executable: false,
        requirements: [{ key: 'item:4189', amount: child.missingAmount, plan: child }] } }] });
const scrollStep = { kind: 'buy', activity: 'shopping', rootKey: 'resale:267', nodeKey: 'item:4189', itemId: 4189, amount: 1 };
const scrollRow = (child, step = scrollStep) => Intent.project({}, scrollNetwork(child, step), {}, 40).find(row => row.itemId === 4189);
const partialBid = scrollRow(scrollBuy(2, 1)), wholeBid = scrollRow(scrollBuy(2, 2));
assert.equal(partialBid.amount, 1, 'the chosen step buys the smaller cheaper ask in its town; the bid holds only the units the town lacks');
assert.equal(partialBid.worth, wholeBid.worth, 'the rest of a partial cross keeps the unit worth of the whole bid');
assert.equal(wholeBid.amount, 2, 'a town that asks the whole lot keeps the bid for all units (whole-lot cross unchanged)');
assert.equal(scrollRow(scrollBuy(2, 1, false), null).amount, 2, 'a short buy that waits buys nothing now and bids every missing unit');
assert.equal(scrollRow(scrollBuy(2, 1), null).amount, 2, 'a short buy no step runs now bids every missing unit');
assert.equal(scrollRow(scrollBuy(2, 1), { ...scrollStep, rootKey: 'power:999:7' }).amount, 2,
    'another root\'s chosen step does not cut this root\'s bid');
console.log('PASS finite selected purchase consent, standing bid limits and native funding rounding');

const nativeWish = { ...requiredWish, plan: { ...requiredWish.plan,
    requirements: [{ key: 'item:202', amount: 2, plan: { ...plannedPurchase('npc', true, true, 2),
        unitPrice: 1459, town: 'Dion', availableUnits: Infinity } }] } };
const nativeNetwork = { ...selectedNetwork, queue: [nativeWish], activity: {
    ...selectedNetwork.activity, sourceType: 'npc', valueHours: .5 } };
assert.equal(Intent.project({}, nativeNetwork, {}, 40).length, 0,
    'a selected NPC purchase still publishes no duplicate player demand');
const peerInstead = Intent.meetingPurchase(nativeNetwork, [], { ...terms, price: 1200 });
assert(peerInstead, 'a cheaper peer quote may fulfill the exact funded NPC input');
assert.equal(peerInstead.amount, 2); assert.equal(peerInstead.valueHours, .5);
for (const changed of [{ count: 3 }, { price: 1460 }, { town: 'Giran' }, { enchant: 1 }, { selfId: 203 }])
    assert.equal(Intent.meetingPurchase(nativeNetwork, [], { ...terms, ...changed }), null);
assert.equal(Intent.meetingPurchase({ ...nativeNetwork, queue: [{ ...nativeWish, funded: false }] }, [], terms), null);

const materialIntent = { key: 'power:101:7', itemId: 202, amount: 10,
    worth: 100, valueHours: 1, valueRate: .01 };
const materialTerms = { selfId: 202, count: 2, price: 500, town: 'Dion' };
const materialNetwork = { quantityPrepared: true, moneyPrice: .0001, queue: [], activity: null };
assert.equal(Intent.purchaseWorth(materialIntent, materialNetwork.moneyPrice), 1000);
assert.equal(Intent.meetingPurchase(materialNetwork, [materialIntent], materialTerms), materialIntent,
    'an advertised craft input uses the same goal willingness at consent, even when another action is selected');
assert.equal(Intent.meetingPurchase(materialNetwork, [materialIntent], { ...materialTerms, price: 1001 }), null,
    'fresh goal value still bounds the purchase price');
assert.equal(Intent.meetingPurchase(materialNetwork, [materialIntent], { ...materialTerms, count: 11 }), null);
assert.equal(Intent.meetingPurchase(materialNetwork, [], materialTerms), null,
    'a retired goal does not gain consent from its old public bid');
assert.equal(Intent.meetingPurchase({ ...materialNetwork, quantityPrepared: false }, [materialIntent], materialTerms), null,
    'an unprepared network cannot authorize a purchase from a prior intention');
assert.equal(Intent.meetingPurchase({ ...materialNetwork, moneyPrice: .001 }, [materialIntent], materialTerms), null,
    'higher priority spending can lower the fresh willingness');
console.log('PASS public craft input and meeting consent share goal willingness');

const requiredInput = { ...materialIntent, quote: { price: 700, town: 'Dion', amount: 3 } };
const fundedKit = { ...materialNetwork, moneyPrice: .001, queue: [{ key: materialIntent.key, funded: true,
    valueHours: 1, ratio: .01, plan: { missingAmount: 1, requirements: [{ key: 'item:202', amount: 10,
        plan: { ...plannedPurchase('afk', true, true, 10), unitPrice: 700, availableUnits: 3, town: 'Dion' } }] } }] };
assert.equal(Intent.meetingPurchase(fundedKit, [requiredInput], materialTerms).worth, 700,
    'another prerequisite of the same funded kit retains its fresh executable quote authority');
for (const change of [{ price: 701 }, { count: 4 }, { town: 'Giran' }, { enchant: 1 }])
    assert.equal(Intent.meetingPurchase(fundedKit, [requiredInput], { ...materialTerms, ...change }), null);
assert.equal(Intent.meetingPurchase({ ...fundedKit, queue: [{ key: materialIntent.key, funded: false }] },
    [requiredInput], materialTerms), null, 'an unfunded kit cannot spend at a required input quote');
assert(Intent.meetingPurchase(fundedKit, [materialIntent], materialTerms),
    'a fresh funded input quote survives omission from the public projection');
const retiredKit = { ...fundedKit, queue: [{ ...fundedKit.queue[0], plan: { missingAmount: 0 } }] };
assert.equal(Intent.meetingPurchase(retiredKit, [requiredInput], materialTerms), null,
    'an old public quote cannot replace a retired actual input');

let deepInput = { missingAmount: 3, requirements: [] };
for (let depth = 0; depth < 6; depth++) deepInput = { missingAmount: 1,
    requirements: [{ key: depth === 0 ? 'item:202' : `craft:${depth}`, amount: 3, plan: deepInput }] };
assert(Intent.project({}, { quantityPrepared: true, queue: [{ key: 'power:101:7', object: { itemId: 101 },
    valueHours: 1, ratio: .01, plan: deepInput }] }, {}, 40).some(row => row.itemId === 202 && row.amount === 3),
    'nested craft inputs inside the native graph depth remain publicly purchasable');

const crystalPlan = amount => ({ ...plannedPurchase('afk', true, true, amount),
    unitPrice: 318, availableUnits: 575, town: 'Giran' });
const crystalRoot = (key, amount) => ({ ...preparedRoot(key, 1458, crystalPlan(amount)), funded: true });
const exchange = crystalRoot('power:854:2', 370);
const exchangeNetwork = { quantityPrepared: true, moneyPrice: 1, queue: [exchange] };
assert.deepEqual(Intent.project({}, exchangeNetwork, {}, 40).map(row => [row.itemId, row.amount]), [[1458, 370]],
    'the actual exchange survives publication');

const firstCrystal = crystalRoot('power:883:5', 117), nextCrystal = crystalRoot('power:915:3', 260);
const rootNetwork = { quantityPrepared: true, moneyPrice: 1, queue: [firstCrystal, nextCrystal],
    activity: { kind: 'buy', activity: 'shopping', sourceType: 'afk', quoted: true, executable: true,
        itemId: 1458, amount: 117, availableUnits: 575, unitPrice: 318, town: 'Giran', rootKey: firstCrystal.key } };
const rootRows = Intent.project({}, rootNetwork, {}, 1);
assert.equal(rootRows.length, 1); assert.equal(rootRows[0].amount, 117);
const crystalTerms = { selfId: 1458, count: 260, price: 318, town: 'Giran', enchant: 0 };
assert.equal(Intent.meetingPurchase(rootNetwork, rootRows, crystalTerms).key, nextCrystal.key,
    'a funded input omitted by item deduplication receives its own fresh certificate');
for (const change of [{ count: 261 }, { count: 377 }, { price: 319 }, { town: 'Dion' }, { enchant: 1 }])
    assert.equal(Intent.meetingPurchase(rootNetwork, rootRows, { ...crystalTerms, ...change }), null,
        'root quantities cannot be added or transferred to a different quote');
assert.equal(Intent.meetingPurchase({ ...rootNetwork, queue: [firstCrystal, { ...nextCrystal, funded: false }] },
    rootRows, crystalTerms), null, 'another root cannot lend its funding');
console.log('PASS exchange inputs survive publication and meetings retain each funded root quantity');
