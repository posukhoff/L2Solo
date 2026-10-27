const assert = require('assert/strict');
const fs = require('node:fs');
require('../src/Global');
const Intent = require('../src/GameServer/Bot/Economy/TradeIntent');
const Funding = require('../src/GameServer/Bot/Economy/PurchaseFunding');
const { WishNetwork, cashHours, cashFor } = require('../src/GameServer/Bot/Economy/WishNetwork');

// T53 (user 10-27, docs/game-decisions.md): money the bot holds is priced by
// its best other use among the wishes it sees (the next stage's too); only
// the part of a price the wallet lacks is priced at the hunt rate; a bid
// stops at the bot's price belief plus the time it saves. Checked on the
// executed spend (PurchaseFunding.spendable over the build's money packet)
// and the bid (BuyAdPolicy.bidFor over the build's intent), not on flags.
// Gear values are T60's: a level-30 helmet into an empty slot adds ~0.046
// hunt hours per hour (0.69 h over a 15-h stage), a C weapon ~1.2 h/h.
const shop = (itemId, price) => ({ key: `item:${itemId}`, price, paths: [{ kind: 'buy', activity: 'shopping', price,
    itemId, executable: true, quoted: true, availableUnits: 1 }] });
// A piece no seller offers yet: the bot bids for it (TradeIntent.preparedProject).
const wanted = (itemId, price) => ({ key: `item:${itemId}`, price, paths: [{ kind: 'buy', activity: 'shopping', price,
    itemId, executable: false, quoted: false, availableUnits: 0 }] });
const gear = (itemId, valueHours, extra = {}) => ({ key: `power:${itemId}:6`, need: 'power',
    object: { itemId }, valueHours, progressionPriority: 0, ...extra,
    paths: [{ requirements: [{ key: `item:${itemId}`, amount: 1 }] }] });
// A quantity build (stockFor), as the economy's: its intents are published.
const build = (wallet, hourAdena, nodes) => new WishNetwork().build({ actorKey: 'held', inputKey: `${wallet}`, nodes,
    roots: nodes.filter(node => node.need).map(node => node.key), wallet, hourAdena,
    persona: { traits: { commitment: 0 } }, remembered: false, stockFor: () => ({}),
    moneyPaths: [{ activity: 'hunting', incomePerHour: hourAdena }] });
const row = (network, key) => network.queue.find(wish => wish.key === key);
// The bot's state after the build: its wallet and the build's money packet.
const stateOf = (network, wallet, hourAdena) => ({ characterId: 7, adena: wallet,
    stats: { money: Funding.packetFor(network, hourAdena, 0) } });
const spend = (network, wallet, hourAdena, itemId) => Funding.spendable(stateOf(network, wallet, hourAdena), 0, { itemId });

// BuyAdPolicy with the real money rule; the market bids at the cap it is given.
const policyFile = require.resolve('../src/GameServer/Bot/Economy/BuyAdPolicy');
const loaded = { exports: {} };
const imports = {
    'GameServer/Items/ItemAcquisitionCatalog': { hasSource: () => true },
    'GameServer/DataCache': { items: [700, 900].map(selfId => ({ selfId, template: { price: 1000 }, etc: {} })) },
    'GameServer/Bot/Economy/PurchaseFunding': Funding,
    'GameServer/Bot/Economy/ItemDisposition': { isQuestItem: () => false },
    'GameServer/Bot/Economy/MarketListingPolicy': { traderContext: () => ({}) },
    'GameServer/Bot/Economy/MarketTownPolicy': { targetTownForItems: () => 'Giran' },
    'GameServer/Bot/Economy/MarketPricing': { bid: (selfId, ctx, { cap }) => ({ price: cap, count: 1 }) }
};
new Function('invoke', 'require', 'module', fs.readFileSync(policyFile, 'utf8'))(
    name => imports[name] || {}, require('node:module').createRequire(policyFile), loaded);
const BuyAds = loaded.exports;
const bid = (network, wallet, hourAdena, itemId) => {
    const intent = Intent.project({}, network, {}, 8).find(line => line.itemId === itemId);
    if (!intent) return null;
    return BuyAds.bidFor(stateOf(network, wallet, hourAdena), { type: 'buy_gear', target: { itemId }, intent,
        plan: { estimatedCost: intent.worth, purpose: intent.kind, valueRate: intent.valueRate } });
};

// The price of cash: the held part at the held price (never above the hunt
// rate: spent money can be earned again), the rest at the hunt rate.
assert.equal(cashHours(300, 100, .001, .01), 100 * .001 + 200 * .01);
assert.equal(cashHours(300, 100, .05, .01), 300 * .01, 'held money dearer than hunting costs the hunt rate');
assert.equal(cashHours(300, 0, .05, .01), cashHours(300, 0, 0, .01), 'a bot holding nothing pays the hunt rate (the author\'s)');
assert.equal(cashFor(cashHours(300, 100, .001, .01), 100, .001, .01), 300, 'cashFor inverts cashHours');

// A level-30 bot with 1M buys a 34k helmet for its empty slot: earning it
// would cost 1.7 hunt hours at 20k/h, but the held money has no better use.
const helmet = [gear(500, .69), shop(500, 34000)];
const rich = build(1e6, 20000, helmet);
assert.equal(rich.heldPrice, 0, 'a wallet that covers every wish holds free money');
assert.equal(rich.activity?.rootKey, 'power:500:6', 'the bot goes shopping for it');
assert(row(rich, 'power:500:6').effort < 34000 / 20000, 'held cash costs no hunt hours in its effort');
assert.equal(rich.moneyPrice, 1 / 20000, 'the next adena earned stays at the hunt rate');
assert(spend(rich, 1e6, 20000, 500) >= 34000, 'the purchase is funded');
// Its trip pays (ColdMarketService.worthwhileTravel: the cash and fees at
// PurchaseFunding.cashPrice, the held price for its root): 6 minutes away.
const Valuation = require('../src/GameServer/Bot/Economy/EconomicValuation');
const trip = (network, key) => Valuation.acquisition({ moneyPrice: Funding.cashPrice(Funding.packetFor(network, 20000, 0), key, network.moneyPrice),
    riskWeight: 1, itemUsefulness: () => Funding.significant(.69 / 34000) * 34000 }, { units: 1, selfId: 500, cost: 34000 },
    { known: true, hours: .1, fees: 500 }).valueHours;
assert(trip(rich, 'power:500:6') > 0, 'the rich bot travels for the helmet');
assert(trip(rich, 'resale:500') < 0, 'a resale root pays its trip at the money price');
// Without the money, earning it at the hunt rate is not worth the helmet.
const broke = build(10000, 20000, helmet);
assert.equal(spend(broke, 10000, 20000, 500), 0, 'no funding for the helmet');
assert.equal(broke.gap, null, 'a wish below the hunt rate is no reason to hunt for money');

// A poor bot saving for a coming C weapon (its better use per adena, a gap
// worth earning) keeps the money for it and skips the helmet.
const saving = [...helmet, gear(600, 100), shop(600, 2e6)];
const poor = build(2e5, 20000, saving);
assert.equal(poor.gap?.key, 'power:600:6', 'the C weapon is the funding gap');
assert.equal(poor.heldPrice, 1 / 20000, 'the held money is as dear as the C weapon makes it (at most the hunt rate)');
assert.equal(spend(poor, 2e5, 20000, 500), 0, 'the helmet does not take the money saved for C');
assert.equal(poor.activity?.funding, true, 'the bot earns toward C');
// A next-stage piece the bot cannot use yet still prices the money: the same
// weapon at level 40 in 5 h, valued later (WishProviders' early gear) and
// below the hunt rate (no gap to earn for): 1.5M held, 25 h to the rest.
const coming = build(1.5e6, 20000, [...helmet, gear(600, 100, { benefitPerHour: 2, horizonHours: 55, notBeforeHours: 5 }),
    shop(600, 2e6)]);
assert.equal(coming.gap, null);
assert(coming.heldPrice > .69 / 34000, 'the coming weapon is worth more per adena than the helmet');
assert.equal(spend(coming, 1.5e6, 20000, 500), 0, 'saving for the coming weapon skips the helmet');
// With the C weapon covered, the rest of the wallet still buys the helmet.
const both = build(3e6, 20000, saving);
assert(spend(both, 3e6, 20000, 600) >= 2e6 && spend(both, 3e6, 20000, 500) >= 34000, 'both purchases funded');
// Saving for a C weapon no seller offers yet: its cash is still held for it,
// so the helmet does not take it (no seller is no reason to spend the money).
const noSeller = build(2e5, 20000, [...helmet, gear(600, 100), wanted(600, 2e6)]);
assert(noSeller.heldPrice > .69 / 34000, 'the unsold weapon keeps the held money dear');
assert.equal(spend(noSeller, 2e5, 20000, 500), 0, 'the helmet does not take the money saved for the unsold weapon');
// The wallet covers the unsold weapon: its cash is saved (a packet row), so
// a cheaper piece below it neither takes it in the build nor on the main
// thread (its root key, below the saved row).
const covered = build(2.5e6, 20000, [gear(610, 9), shop(610, 6e5), gear(600, 100), wanted(600, 2e6)]);
assert.equal(row(covered, 'power:600:6').earmarked, true, 'the unsold weapon keeps its cash');
assert.equal(row(covered, 'power:610:6').funded, false, 'the piece does not take the saved cash');
assert(Funding.spendable(stateOf(covered, 2.5e6, 20000), 0, { r: Funding.significant(9 / 6e5), key: 'power:610:6' }) < 6e5,
    'main keeps the saved cash too');

// A level-53 bot with 26M on a 1.5k/h field bids for a 5M C weapon no one
// sells yet: 24 h of benefit would be worth only 36k at the hunt rate; its
// bid reaches the weapon's price belief and stops there.
const weapon = [gear(700, 24), wanted(700, 5e6)];
const wealthy = build(26e6, 1500, weapon);
assert.equal(bid(wealthy, 26e6, 1500, 700)?.price, 5e6, 'the bid is the price belief, not above it');
// Poor, the same bot saves its money for this weapon (its own value per
// adena prices it) and bids what it holds plus the rest of its value at the
// hunt rate; its bid stops at its wallet.
const poorNetwork = build(1e5, 1500, weapon);
const poorWorth = Intent.project({}, poorNetwork, {}, 8).find(line => line.itemId === 700).worth;
assert(Math.abs(poorWorth - (1e5 + (24 - 1e5 * 24 / 5e6) * 1500)) < 1e-6, 'held money, then the hunt rate');
assert.equal(bid(poorNetwork, 1e5, 1500, 700)?.price, 1e5, 'never above the wallet');
// A wish worth little, the wallet covering all: cheap money buys it, still
// no higher than its belief.
const trinket = bid(build(26e6, 1500, [gear(900, .001), wanted(900, 2e5)]), 26e6, 1500, 900);
assert.equal(trinket?.price, 2e5, 'free money bids no more than the belief');
// The time a bid saves: a piece that pays 1 h/h from now, its seller 4 h
// away (a unit wait), may bid its belief plus those 4 h at the money price.
const late = { key: 'item:700', price: 5e6, paths: [{ kind: 'buy', activity: 'shopping', price: 5e6, itemId: 700,
    executable: true, quoted: false, availableUnits: 1, waitHours: 4 }] };
const waiting = build(26e6, 1500, [gear(700, 24, { benefitPerHour: 1, horizonHours: 24 }), late]);
assert.equal(bid(waiting, 26e6, 1500, 700)?.price, 5e6 + 4 * 1500, 'the belief plus the wait at the money price');

// A resale root (craft, crystals, farm for sale) turns money into money:
// its price stays at the hunt rate whatever the wallet holds.
const resale = { key: 'resale:800', need: 'power', object: { itemId: 800, amount: 1, kind: 'resale' }, valueHours: .5,
    paths: [{ requirements: [{ key: 'item:801', amount: 1 }] }] };
const trader = build(1e6, 1000, [resale, shop(801, 1000)]);
assert.equal(row(trader, 'resale:800')?.funded ?? false, false, 'a sale below the hunt rate takes no held money');

// The executed path on the main thread: a bid's certificate (TradeIntent.encode,
// 9 fields) carries its root key, not a flag; the meeting's funding terms
// (TradeMeeting.fundingTerms, the worker's consent and the native accept)
// read it, and spendable admits held money for a root that is no resale.
const TradeMeeting = require('../src/GameServer/AfkTrade/TradeMeeting');
const meeting = (network, wallet, hourAdena, certificate) => {
    const request = { lines: [{ payer: 'A', count: 1, price: 1, certificate }],
        parties: { A: { route: { fee: 0 }, survivalCost: 0 } } };
    const terms = TradeMeeting.fundingTerms(request, 'A');
    delete terms.amount;
    return Funding.spendable(stateOf(network, wallet, hourAdena), 0, terms);
};
const wealthyIntent = Intent.project({}, wealthy, {}, 8).find(line => line.itemId === 700);
assert(wealthyIntent.valueRate < wealthy.moneyPrice, 'the weapon ranks below the hunt rate');
const certificate = Intent.encode({ ...wealthyIntent, price: 5e6 });
assert(meeting(wealthy, 26e6, 1500, certificate) >= 5e6, 'main funds the held bid from its certificate');
const resaleCertificate = Intent.encode({ ...wealthyIntent, key: 'resale:700', price: 5e6 });
assert.equal(meeting(wealthy, 26e6, 1500, resaleCertificate), 0, 'a resale root at that rate spends no held money');
// An old packet (no held price after its rows) spends at its money price.
assert.equal(Funding.heldPrice([1000, .001, 0, 0, .002, 500, 1]), .001);
assert.equal(Funding.heldPrice([1000, .001, 0, 0, .002, 500, 1, .0001]), .0001);
console.log('held money priced by its best other use (T53): PASS');
