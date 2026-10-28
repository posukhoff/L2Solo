const assert = require('assert');
require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const CharacterWriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');
const TradeService = invoke('GameServer/Bot/TradeService');
const Item = invoke('GameServer/Item/Item');

const RING = 881;

const ARROW = 17;

function item(id, selfId, amount, equipped, name) {
    return new Item(id, {
        selfId,
        name,
        kind: selfId === 57 ? 'Other.Currency' : selfId === ARROW ? 'Other.Arrow' : 'Armor.Jewel',
        amount,
        stackable: selfId === 57 || selfId === ARROW,
        equipped,
        slot: selfId === 57 ? 0 : 4
    });
}

function seller(items, id = 9001) {
    return {
        fetchId: () => id,
        backpack: {
            items,
            insertItem(objectId, selfId, { amount }) { this.items.push(item(objectId, selfId, amount, false, 'Elven Ring')); },
            fetchItems() { return this.items; },
            fetchItemFromSelfId(selfId) { return this.items.find((entry) => Number(entry.fetchSelfId()) === Number(selfId)); },
            stackableExists(selfId) {
                const found = this.items.find((entry) => Number(entry.fetchSelfId()) === Number(selfId) && entry.fetchStackable());
                return found ? Promise.resolve(found) : Promise.reject(new Error('missing_stack'));
            },
            updateAmount(id, amount) {
                this.items.find((entry) => Number(entry.fetchId()) === Number(id))?.setAmount(amount);
            }
        }
    };
}

async function main() {
    const originalItems = DataCache.items;
    const originals = { setItem: Database.setItem };
    // A sold copy leaves the live bag as a queued delta (LiveBag -> CharacterWriteQueue).
    const taken = (characterId, id) => CharacterWriteQueue.unread(characterId).get(id);
    // The seller has no Adena stack: its payout is a new row, whose write fails.
    const failSellerPayout = (insertId) => async (characterId, row) => {
        if (Number(characterId) === 9001 && Number(row?.selfId) === 57) throw new Error('seller_adena_write_failed');
        return { insertId: insertId() };
    };
    try {
        DataCache.items = [
            { selfId: RING, template: { name: 'Elven Ring' }, etc: { stackable: false } },
            { selfId: 57, template: { name: 'Adena' }, etc: { stackable: true } },
            { selfId: ARROW, template: { name: 'Wooden Arrow' }, etc: { stackable: true } }
        ];

        // Two worn rings (older rows first, as the backpack loads them) and a spare.
        const hotBot = seller([
            item(101, RING, 1, true, 'Elven Ring'),
            item(102, RING, 1, true, 'Elven Ring'),
            item(103, RING, 1, false, 'Elven Ring'),
            item(104, 57, 5000, false, 'Adena')
        ]);
        const store = { storeType: 3, items: [{ selfId: RING, price: 116501, count: 1 }] };
        const preview = TradeService.previewSaleToStore(hotBot, store);
        assert.deepStrictEqual(preview.lines.map((line) => line.objectId), [103], 'the preview offers only the spare');
        const sale = await TradeService.sellInventoryToStore(hotBot, store);
        assert.strictEqual(sale.itemsSold, 1);
        assert.strictEqual(taken(9001, 103), -1, 'the sold row is the spare, not a worn ring');
        assert(!CharacterWriteQueue.unread(9001).has(101) && !CharacterWriteQueue.unread(9001).has(102), 'no worn ring is written');
        assert.deepStrictEqual(hotBot.backpack.items.filter((entry) => entry.fetchSelfId() === RING)
            .map((entry) => [entry.fetchId(), entry.fetchEquipped()]), [[101, true], [102, true]]);
        assert.strictEqual(hotBot.backpack.fetchItemFromSelfId(57).fetchAmount(), 5000 + 116501);

        // The player's sale names the exact copy it offers.
        const player = seller([
            item(201, RING, 1, false, 'Elven Ring'),
            item(202, RING, 1, false, 'Elven Ring'),
            item(203, 57, 10, false, 'Adena')
        ]);
        await TradeService.sellToStore(player, { storeType: 3, items: [{ selfId: RING, price: 100, count: 1 }] },
            RING, 1, { objectId: 202 });
        assert.strictEqual(taken(9001, 202), -1, 'the chosen copy is sold');
        assert(!CharacterWriteQueue.unread(9001).has(201), 'not the first one');

        // Only worn copies left: nothing to sell.
        const wornOnly = seller([item(301, RING, 1, true, 'Elven Ring'), item(302, 57, 10, false, 'Adena')]);
        await assert.rejects(TradeService.sellToStore(wornOnly,
            { storeType: 3, items: [{ selfId: RING, price: 100, count: 1 }] }, RING, 1), /No items to sell/);
        assert.strictEqual(wornOnly.backpack.items.length, 2);

        // A budget-backed sale that fails after the buyer got the item takes
        // back that copy, not the ring the buyer wears.
        const buyer = seller([item(401, RING, 1, true, 'Elven Ring'), item(403, RING, 1, false, 'Elven Ring'),
            item(402, 57, 5000, false, 'Adena')], 9002);
        const failing = seller([item(501, RING, 1, false, 'Elven Ring')]);
        const setItem = Database.setItem;
        let nextInsertId = 450;
        Database.setItem = failSellerPayout(() => nextInsertId++);
        // The given amount went onto a stack the buyer wears (arrows): it comes back from that stack.
        const archer = seller([item(601, ARROW, 10, true, 'Wooden Arrow'), item(602, 57, 5000, false, 'Adena')], 9002);
        const fletcher = seller([item(701, ARROW, 5, false, 'Wooden Arrow')]);
        try {
            await assert.rejects(TradeService.sellToStore(failing,
                { storeType: 3, budgetBacked: true, items: [{ selfId: RING, price: 100, count: 1 }] }, RING, 1,
                { buyerActor: buyer }), /seller_adena_write_failed/);
            await assert.rejects(TradeService.sellToStore(fletcher,
                { storeType: 3, budgetBacked: true, items: [{ selfId: ARROW, price: 100, count: 5 }] }, ARROW, 5,
                { buyerActor: archer }), /seller_adena_write_failed/);
        } finally {
            Database.setItem = setItem;
        }
        assert.deepStrictEqual(buyer.backpack.items.filter((entry) => entry.fetchSelfId() === RING)
            .map((entry) => [entry.fetchId(), entry.fetchEquipped()]), [[401, true], [403, false]],
            'the buyer keeps the ring it wears and the spare it held; only the given copy goes back');
        assert.strictEqual(buyer.backpack.fetchItemFromSelfId(57).fetchAmount(), 5000, 'and gets its Adena back');
        assert.strictEqual(failing.backpack.items.filter((entry) => entry.fetchSelfId() === RING).length, 1, 'the seller gets its ring back');
        assert.strictEqual(archer.backpack.fetchItemFromSelfId(ARROW).fetchAmount(), 10, 'the worn stack is back at its amount');
        assert.strictEqual(archer.backpack.fetchItemFromSelfId(57).fetchAmount(), 5000, 'and the buyer is refunded');
        assert.strictEqual(fletcher.backpack.items.filter((entry) => entry.fetchSelfId() === ARROW)
            .reduce((sum, entry) => sum + entry.fetchAmount(), 0), 5, 'the seller gets its arrows back');

        // The backpack did not take the new row: the rollback deletes exactly that
        // row (no duplicate), never the ring the buyer wears.
        const blind = seller([item(801, RING, 1, true, 'Elven Ring'), item(802, 57, 5000, false, 'Adena')], 9002);
        blind.backpack.insertItem = () => {};
        const failingAgain = seller([item(901, RING, 1, false, 'Elven Ring')]);
        Database.setItem = failSellerPayout(() => 999);
        try {
            await assert.rejects(TradeService.sellToStore(failingAgain,
                { storeType: 3, budgetBacked: true, items: [{ selfId: RING, price: 100, count: 1 }] }, RING, 1,
                { buyerActor: blind }), /seller_adena_write_failed/);
        } finally {
            Database.setItem = setItem;
        }
        assert.strictEqual(taken(9002, 999), -1, 'the row given to the buyer is taken back');
        assert.deepStrictEqual(blind.backpack.items.filter((entry) => entry.fetchSelfId() === RING)
            .map((entry) => [entry.fetchId(), entry.fetchEquipped()]), [[801, true]], 'the worn ring is never taken back in its place');
        assert.strictEqual(blind.backpack.fetchItemFromSelfId(57).fetchAmount(), 5000, 'the buyer is refunded');
    } finally {
        DataCache.items = originalItems;
        Object.assign(Database, originals);
    }
    console.log('Trade store sale copy tests passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
