const assert = require('assert/strict');
require('../src/Global');
const Intent = require('../src/GameServer/Bot/Economy/TradeIntent');
const { WishNetwork, rootMoneyPrice } = require('../src/GameServer/Bot/Economy/WishNetwork');

// T53 (user 10-27): money the bot holds is priced by its best other use;
// only the part of a price the wallet lacks is priced at the hunt rate.
// Gear values are T60's: a level-30 helmet into an empty slot adds ~0.046
// hunt hours per hour (0.69 h over a 15-h stage), a C weapon ~1.2 h/h.
const shop = (itemId, price) => ({ key: `item:${itemId}`, price, paths: [{ kind: 'buy', activity: 'shopping', price,
    itemId, executable: true, quoted: true, availableUnits: 1 }] });
// A piece no seller offers yet: the bot bids for it (TradeIntent.preparedProject).
const wanted = (itemId, price) => ({ key: `item:${itemId}`, price, paths: [{ kind: 'buy', activity: 'shopping', price,
    itemId, executable: false, quoted: false, availableUnits: 0 }] });
const gear = (itemId, valueHours, progressionPriority = 0) => ({ key: `power:${itemId}:6`, need: 'power',
    object: { itemId }, valueHours, progressionPriority, paths: [{ requirements: [{ key: `item:${itemId}`, amount: 1 }] }] });
const build = (wallet, hourAdena, nodes, extra = {}) => new WishNetwork().build({ actorKey: 'held', inputKey: `${wallet}`, nodes,
    roots: nodes.filter(node => node.need).map(node => node.key), wallet, hourAdena,
    persona: { traits: { commitment: 0 } }, remembered: false,
    moneyPaths: [{ activity: 'hunting', incomePerHour: hourAdena }], ...extra });
const row = (network, key) => network.queue.find(wish => wish.key === key);

// A level-30 bot with 1M buys a 34k helmet for its empty slot: the helmet
// costs it 1.7 hunt hours at 20k/h, but the held money has no better use.
const helmet = [gear(500, .69), shop(500, 34000)];
const rich = build(1e6, 20000, helmet);
assert.equal(row(rich, 'power:500:6').funded, true, 'held money buys the helmet');
assert.equal(rich.activity?.rootKey, 'power:500:6', 'the bot goes shopping for it');
assert(row(rich, 'power:500:6').effort < 34000 / 20000, 'held cash costs no hunt hours in its effort');
assert.equal(rich.moneyPrice, 1 / 20000, 'the next adena earned stays at the hunt rate');
// Without the money, earning it at the hunt rate is not worth the helmet.
const broke = build(10000, 20000, helmet);
assert.equal(row(broke, 'power:500:6').funded, false);
assert.equal(broke.gap, null, 'a wish below the hunt rate is no reason to hunt for money');

// A poor bot saving for a C weapon (its better use per adena, a gap worth
// earning) keeps the money for it and skips the helmet.
const saving = [...helmet, gear(600, 100), shop(600, 2e6)];
const poor = build(2e5, 20000, saving);
assert.equal(poor.gap?.key, 'power:600:6', 'the C weapon is the funding gap');
assert.equal(row(poor, 'power:500:6').funded, false, 'the helmet does not take the money saved for C');
assert.equal(poor.activity?.funding, true, 'the bot earns toward C');
// With the C weapon covered, the rest of the wallet still buys the helmet.
const both = build(3e6, 20000, saving);
assert.deepEqual(['power:600:6', 'power:500:6'].map(key => row(both, key).funded), [true, true]);

// A level-53 bot with 26M on a 1.5k/h field bids for a 5M C weapon no one
// sells yet: its bid may reach the price (24 h of benefit would be worth
// only 36k at the hunt rate).
const weapon = [gear(700, 24), wanted(700, 5e6)];
// A quantity build (stockFor), as the economy's: its intents are published.
const quantity = { stockFor: () => ({}) };
const wealthy = build(26e6, 1500, weapon, quantity);
const root = row(wealthy, 'power:700:6');
assert.equal(root.held, true, 'the wallet covers it at its queue place');
assert(root.valueHours / rootMoneyPrice(wealthy, root) >= 5e6 - 1e-6, 'its worth reaches its price');
const bid = Intent.project({}, wealthy, {}, 8).find(intent => intent.itemId === 700);
assert(bid && bid.worth >= 5e6 - 1e-6, 'the buy intent carries that worth');
// Poor, the same bot bids at the hunt rate, as before.
const poorBidder = build(1e5, 1500, weapon, quantity);
assert.equal(row(poorBidder, 'power:700:6').held, false);
assert(Intent.project({}, poorBidder, {}, 8).find(intent => intent.itemId === 700).worth < 5e6 / 100);

// A resale root (craft, crystals, farm for sale) turns money into money:
// its price stays at the hunt rate whatever the wallet holds.
const resale = { key: 'resale:800', need: 'power', object: { itemId: 800, amount: 1, kind: 'resale' }, valueHours: .5,
    paths: [{ requirements: [{ key: 'item:801', amount: 1 }] }] };
const trader = build(1e6, 1000, [resale, shop(801, 1000)]);
assert.equal(row(trader, 'resale:800')?.funded ?? false, false, 'a sale below the hunt rate takes no held money');
console.log('held money priced by its best other use (T53): PASS');
