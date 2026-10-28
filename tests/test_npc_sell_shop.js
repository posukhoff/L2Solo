const assert = require('assert');

require('../src/Global');

const SellShop = invoke('GameServer/World/Generics/NpcBypasses/SellShop');
const Sell = invoke('GameServer/Network/Request/Sell');
const Database = invoke('Database');
const ServerResponse = invoke('GameServer/Network/Response');

function item(id, selfId, amount, price, equipped = false) {
    return {
        fetchId: () => id,
        fetchSelfId: () => selfId,
        fetchAmount: () => amount,
        fetchPrice: () => price,
        fetchEquipped: () => equipped,
        fetchClass1: () => 4,
        fetchClass2: () => 5,
        isWearable: () => false
    };
}

const sellable = item(1001, 1539, 12, 40);
const equipped = item(1002, 17, 100, 10, true);
const adena = item(1003, 57, 500, 1);
const questItem = { ...item(1004, 1160, 13, 0), fetchKind: () => 'Other.Quest' };
const questClassItem = { ...item(1005, 7573, 1, 0), fetchClass2: () => 3 };
const petLocked = { ...item(1006, 2375, 1, 100), fetchPetLocked: () => true };
const packets = [];
const session = {
    activeNpcTalk: { selfId: 7004 },
    actor: {
        backpack: {
            fetchItems: () => [sellable, equipped, adena, questItem, questClassItem, petLocked],
            fetchTotalAdena: () => 500
        }
    },
    dataSendToMe(packet) {
        packets.push(packet);
    }
};

SellShop(session, ['sell-shop']);

assert.strictEqual(packets[0][0], 0x10, 'city merchant sale should open the native C4 SellList window');
assert.strictEqual(packets[1][0], 0x25, 'SellList should terminate the NPC interaction after opening');
assert.strictEqual(packets[0].readInt16LE(9), 1, 'SellList should only offer unequipped non-Adena items');
assert.strictEqual(packets[0].readInt32LE(17), 1539, 'SellList should identify the offered inventory item');
assert.strictEqual(packets[0].readInt32LE(39), 20, 'SellList should show the C4 half-reference sell price');
assert.strictEqual(session.activeNpcSellShop.items.get(1001).price, 20, 'server should retain the offered item and price for request validation');
for (const protectedItem of [questItem, questClassItem, petLocked]) {
    assert(!session.activeNpcSellShop.items.has(protectedItem.fetchId()), 'protected items must not enter the server offer snapshot');
}

// The sale itself commits in a real database: the live bag takes the
// committed rows (LiveBag), and a refused sale writes nothing.
const fixture = require('./helpers/liveBagRows')('npc-sell-shop');
const Backpack = invoke('GameServer/Actor/Backpack');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');
const characterId = 42;
const originalUserInfo = ServerResponse.userInfo;
const originalItemsList = ServerResponse.itemsList;
ServerResponse.userInfo = () => Buffer.from([0x04]);
ServerResponse.itemsList = () => Buffer.from([0x1b]);
const request = Buffer.alloc(21);

(async () => {
    invoke('GameServer/DataCache').init();
    fixture.open();
    await fixture.character(characterId, 'SellShopTester');
    for (const [selfId, amount] of [[1539, 12], [57, 500], [1160, 13], [7573, 1], [2375, 1]]) {
        await Database.setItem(characterId, { selfId, name: `Item ${selfId}`, amount });
    }
    const backpack = new Backpack({ paperdoll: {}, items: await Database.fetchItems(characterId) });
    const held = selfId => backpack.fetchItemFromSelfId(selfId);
    held(2375).petInUse = true;
    const sellPackets = [];
    const sellSession = {
        actor: { fetchId: () => characterId, backpack },
        dataSendToMe(packet) { sellPackets.push(packet); }
    };
    sellSession.activeNpcSellShop = { items: new Map(NpcSellRules.rows(sellSession.actor).map(row =>
        [row.item.fetchId(), { selfId: row.item.fetchSelfId(), price: row.price }])) };
    const price = sellSession.activeNpcSellShop.items.get(held(1539).fetchId()).price;
    assert.strictEqual(price, NpcSellRules.npcBuyPrice(held(1539).fetchPrice()), 'the offer is the C4 half-reference price');
    request.writeInt32LE(0, 1);
    request.writeInt32LE(1, 5);
    request.writeInt32LE(held(1539).fetchId(), 9);
    request.writeInt32LE(1539, 13);
    request.writeInt32LE(5, 17);

    await Sell(sellSession, request);
    assert.strictEqual(held(1539).fetchAmount(), 7, 'NPC sale should remove only the amount selected in the native window');
    assert.strictEqual(held(57).fetchAmount(), 500 + 5 * price, 'NPC sale should credit the advertised half-reference price');
    const rows = await Database.fetchItems(characterId);
    assert.strictEqual(rows.find(row => row.selfId === 1539).amount, 7, 'the database holds the potions left');
    assert.strictEqual(rows.find(row => row.selfId === 57).amount, 500 + 5 * price, 'the database holds the payout');
    assert.strictEqual(sellPackets[0][0], 0x04, 'NPC sale should refresh UserInfo after the transaction');
    assert.strictEqual(sellPackets[2][0], 0x10, 'NPC sale should keep the native SellList open with the remaining items');
    assert.strictEqual(sellPackets[2].readInt16LE(9), 1, 'refreshed offers must still exclude quest and pet-locked items');
    for (const protectedItem of [held(1160), held(7573), held(2375)]) {
        // Simulate an offer retained from before the fix, plus a forged packet.
        sellSession.activeNpcSellShop.items.set(protectedItem.fetchId(), { selfId: protectedItem.fetchSelfId(), price: 1 });
        const forged = Buffer.from(request);
        forged.writeInt32LE(protectedItem.fetchId(), 9);
        forged.writeInt32LE(protectedItem.fetchSelfId(), 13);
        forged.writeInt32LE(protectedItem.fetchAmount(), 17);
        await Sell(sellSession, forged);
        assert.deepStrictEqual(await Database.fetchItems(characterId), rows, 'rejected sales must not write items or Adena');
        assert(backpack.fetchItems().includes(protectedItem), 'rejected sales must retain the inventory item');
        assert.strictEqual(held(57).fetchAmount(), 500 + 5 * price, 'quest items must never pay the one-Adena minimum');
        assert(!sellSession.activeNpcSellShop.items.has(protectedItem.fetchId()), 'refresh must remove a stale protected offer');
    }
    console.log('NPC sell offers, normal payout and forged quest-item sale rejection passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    ServerResponse.userInfo = originalUserInfo;
    ServerResponse.itemsList = originalItemsList;
    await fixture.close();
});
