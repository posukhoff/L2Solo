const assert = require('assert');
const crypto = require('crypto');
require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const TradeService = invoke('GameServer/Bot/TradeService');
const Pricing = invoke('GameServer/Bot/Economy/StaticMerchantPricing');
const Configs = invoke('GameServer/Bot/MerchantStoreConfigs');
const Shops = invoke('GameServer/World/Generics/NpcShopBuyLists');
const MarketSnapshot = invoke('GameServer/Bot/Economy/MarketSnapshot');
const PurchaseItems = invoke('GameServer/World/Generics/PurchaseItems');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');
const NpcShopPriceScale = invoke('GameServer/World/Generics/NpcShopPriceScale');
const Fixed = invoke('GameServer/Bot/Economy/FixedShotOffers');
const Query = invoke('GameServer/Bot/Economy/OfferQuery');

DataCache.init();
const originals = {
    profile: ProgressionRates.profile,
    update: Database.updateItemAmount,
    delete: Database.deleteItem
};
const templates = new Map(DataCache.items.map((item) => [item.selfId, item]));
const normalize = (store) => TradeService.normalizeStoreItems(store, { staticStore: true });
const botLines = store => store.items.map(line => ({ selfId: line.selfId, count: line.count ?? 1,
    price: Pricing.botPriceFor(store, line) })).filter(line => line.price > 0);
// The 330 retained lines after removing permanent refined-material buyback:
// moving player prices must not change any retained bot payout or shot price.
// x10/x50 moved once when the payout cap read the one NPC table (town
// sellers): 4 jewelry payouts no longer sit under fallback lists no NPC sells.
// x10/x50 moved again when the gear reserve lines (left out here) joined the
// repeatable supply: 16 B/A gear payouts of the fixed buyers sit 10 % under
// the reserve price (a bot sells only materials there, TradeService).
const baselineBotPrices = {
    1: '650518d7b76a4b21e7dc71255cad60543aee1ca6e291dda45783cfad1cb4f794',
    10: 'fa985b85f72de9dd4b5d9168d82fcc3c8ddc0e0822ec548a1f8251cad6f86131',
    50: 'b41535a8fc187ba82e311ecfb7e6ed4ae0530958067f266238088ff1c9ea35f4'
};

function inventoryItem(selfId, amount) {
    return {
        fetchSelfId: () => selfId,
        fetchId: () => selfId,
        fetchAmount: () => amount,
        fetchStackable: () => templates.get(selfId)?.etc?.stackable === true,
        setAmount: (value) => { amount = value; },
        fetchEquipped: () => false
    };
}

async function run() {
    for (const rate of [1, 10, 50]) {
        ProgressionRates.profile = () => ({ adena: rate, multiplier: rate });
        const retainedPrices = Object.entries(Configs).flatMap(([name, store]) => (
            store.items.filter(line => line.reserve !== true).map(line => [name, line.selfId, Pricing.botPriceFor(store, line)])
        ));
        assert.strictEqual(crypto.createHash('sha256').update(JSON.stringify(retainedPrices)).digest('hex'),
            baselineBotPrices[rate], `every retained bot price matches the baseline at x${rate}`);
        const cheapest = new Map();
        const addOffer = (id, price) => cheapest.set(id, Math.min(cheapest.get(id) ?? Infinity, price));
        // Enumerate actual NPC lists independently of the policy's NPC price table.
        for (const id of Shops.npcIds()) {
            for (const line of Shops.fetchForNpc(id)) {
                addOffer(line.selfId, line.price ?? templates.get(line.selfId).template.price);
            }
        }
        for (const store of Object.values(Configs).filter((entry) => entry.storeType === 1)) {
            for (const line of normalize(store)) addOffer(line.selfId, line.price);
        }
        for (const offer of Pricing.sellersOf(1835)) {
            const line = Configs[offer.sourceName].items.find(item => item.selfId === 1835);
            assert.strictEqual(offer.price, TradeService.ratedPrice(1835, line.priceRate),
                `shot trip supply stays authored at x${rate}`);
        }
        const snapshot = MarketSnapshot.fixedStores();
        for (const [name, store] of Object.entries(Configs)) {
            const actual = normalize(store);
            const shown = snapshot.find((row) => row.ownerName === name).items;
            assert.deepStrictEqual(shown.map(({ selfId, price }) => ({ selfId, price })),
                actual.map(({ selfId, price }) => ({ selfId, price })), `${name}: observer/live parity at x${rate}`);
            if (store.storeType !== 3) continue;
            for (const line of botLines(store)) {
                const purchase = cheapest.get(line.selfId);
                assert(Number.isSafeInteger(line.price) && line.price > 0);
                if (purchase !== undefined) {
                    assert(line.price < purchase, `${name} item ${line.selfId} arbitrage at x${rate}: ${purchase} -> ${line.price}`);
                    assert(line.price <= Math.floor(purchase * 0.9), `${name}: missing buyback margin`);
                }
            }
            for (const line of actual) {
                assert.strictEqual(line.price, NpcSellRules.npcBuyPrice(templates.get(line.selfId).template.price),
                    `${name}: empty player board uses C4 buy-back at x${rate}`);
            }
        }
        assert.strictEqual(botLines(Configs['4manda']).find((line) => line.selfId === 1864).price,
            TradeService.ratedPrice(1864, 0.8), 'resource liquidity without a cheaper NPC source keeps its authored price');
        // The gear reserve: a bot pays 1.5x the NPC price scale of the template
        // price at Giran for a C weapon (Flamberge 71); a C armour piece a
        // limited player lot lists (Haldise) is bot-buyable only at its reserve line.
        const reserveC = NpcShopPriceScale.price(templates.get(71).template.price * 1.5, rate);
        assert.strictEqual(Pricing.cheapestPurchase(71, { forBot: true }), reserveC, `C weapon reserve price at x${rate}`);
        const flamberge = Fixed.offers(71);
        assert.deepStrictEqual(flamberge.map(row => [row.sourceName, row.town, row.price]), [['Squeesh', 'Giran', reserveC]]);
        const haldiseIds = Configs.Haldise.items.map(line => line.selfId).filter(id => templates.get(id)?.etc?.rank === 'c');
        assert(haldiseIds.length > 0);
        for (const id of haldiseIds) {
            const reserve = Configs.Squeesh.items.find(line => line.selfId === id && line.reserve === true);
            assert.deepStrictEqual(Fixed.offers(id).map(row => row.sourceName), reserve ? ['Squeesh'] : [],
                `Haldise's limited lot of ${id} is not a bot's reserve at x${rate}`);
            assert.strictEqual(Fixed.offers(id).every(row => Query.sourceAllowed(row)), true);
            assert.strictEqual(Query.sourceAllowed({ sourceType: 'configured_store', selfId: id, sourceName: 'Haldise' }), false,
                'a limited player lot is refused to bots');
        }
    }
    // The reserve stores list exactly the gear a bot's planner can target: each
    // C/B/A weapon or armour piece with a named template, a price and a source.
    const Sources = invoke('GameServer/Items/ItemAcquisitionCatalog');
    for (const [name, rank] of [['Squeesh', 'c'], ['M3tLa', 'b'], ['Lowfiles', 'a']]) {
        const expected = DataCache.items.filter(item => item.etc?.rank === rank && /^(Weapon|Armor)\./.test(String(item.template?.kind || ''))
            && item.template?.name && Number(item.template?.price) > 0 && Sources.hasSource(item.selfId)).map(item => item.selfId).sort((a, b) => a - b);
        const listed = Configs[name].items.filter(line => line.reserve === true).map(line => line.selfId).sort((a, b) => a - b);
        assert.deepStrictEqual(listed, expected, `${name} reserve ids follow the rule`);
    }
    // The player's window leaves the reserve lines out: he keeps C4's stores.
    ProgressionRates.profile = () => ({ adena: 1, multiplier: 1 });
    const squeesh = { storeType: 1, items: normalize(Configs.Squeesh) };
    assert.deepStrictEqual(TradeService.nativeStoreItems(squeesh).map(line => line.selfId), [1464, 2511, 3949],
        'the player sees only the C shots at Squeesh');
    // One switch: staticShotsDisabled removes the shot and the gear reserve.
    const Population = invoke('GameServer/Bot/Population/PopulationConfig');
    Population.staticShotsDisabled = true;
    try {
        assert.strictEqual(Pricing.cheapestPurchase(71, { forBot: true }), Infinity, 'the switch closes the gear reserve');
        assert.strictEqual(Pricing.cheapestPurchase(1464, { forBot: true }), Infinity, 'the switch closes the shot reserve');
        assert.strictEqual(Fixed.offers(71).length, 0);
    } finally {
        Population.staticShotsDisabled = false;
    }

    ProgressionRates.profile = () => ({ adena: 1, multiplier: 1 });
    // Explicit static prices and future inverted coefficients must also be capped.
    const inflated = { selfId: 2006, price: 99999999, count: 10 };
    const cap = Math.floor(normalize(Configs.TomRiddle).find((line) => line.selfId === 2006).price * 0.9);
    assert.strictEqual(Pricing.botPriceFor(Configs.Addicted, inflated), cap);
    assert.strictEqual(normalize({ storeType: 3, items: [inflated] })[0].price,
        NpcSellRules.npcBuyPrice(templates.get(inflated.selfId).template.price));
    assert.strictEqual(TradeService.normalizeStoreItems({ storeType: 3, items: [inflated] })[0].price,
        inflated.price, 'dynamic stores retain their negotiated prices');
    ProgressionRates.profile = () => ({ adena: 10, multiplier: 10 });
    assert.strictEqual(Pricing.botPriceFor(Configs.Veteranas, { selfId: 219, priceRate: 100 }), 483120,
        'at x10 use Graham at 536800, not an earlier NPC list at 585600');
    ProgressionRates.profile = () => ({ adena: 1, multiplier: 1 });

    // Reproduce purchase -> inventory delivery -> static buyback with real
    // trade functions and an isolated in-memory database boundary.
    Database.updateItemAmount = async () => {};
    Database.deleteItem = async () => {};
    const adena = inventoryItem(57, 1000000);
    const backpack = {
        items: [adena],
        fetchItems() { return this.items; },
        fetchItemFromSelfId(id) { return this.items.find((item) => item.fetchSelfId() === id); },
        fetchTotalAdena: () => adena.fetchAmount(),
        deleteItem(session, id, amount, done) { adena.setAmount(adena.fetchAmount() - amount); done(); }
    };
    const actor = { backpack, fetchId: () => 991 };
    const price = Shops.fetchForNpc(7084).find((line) => line.selfId === 219).price;
    await new Promise((resolve) => {
        PurchaseItems.call({ purchaseItem(session, id, amount) {
            backpack.items.push(inventoryItem(id, amount));
            resolve();
        } }, { actor }, [{ selfId: 219, amount: 1 }], { prices: new Map([[219, price]]) });
    });
    assert.strictEqual(adena.fetchAmount(), 731600);
    const store = { storeType: 3, items: normalize(Configs.Veteranas) };
    const sale = await TradeService.sellToStore(actor, store, 219, 1);
    const buyback = NpcSellRules.npcBuyPrice(templates.get(219).template.price);
    assert.strictEqual(sale.totalAdena, buyback);
    assert.strictEqual(adena.fetchAmount(), 731600 + buyback, 'the player round trip uses ordinary C4 buy-back');
    assert.strictEqual(backpack.fetchItemFromSelfId(219), undefined);
    assert.strictEqual(store.items.find((line) => line.selfId === 219).count, 999998);
    console.log('Static merchant pricing: bot ceilings, player C4/observer parity at x1/x10/x50 and Sword Breaker round trip passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    ProgressionRates.profile = originals.profile;
    Database.updateItemAmount = originals.update;
    Database.deleteItem = originals.delete;
});
