const assert = require('assert');

require('../src/Global');

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const Item = invoke('GameServer/Item/Item');
const Warehouse = invoke('GameServer/Warehouse/PersonalWarehouse');
const World = invoke('GameServer/World/World');
const ServerResponse = invoke('GameServer/Network/Response');
const GameOpcodes = invoke('GameServer/Network/Opcodes');
const GameRequest = invoke('GameServer/Network/Request');

DataCache.items = [{
    selfId: 1000, name: 'Warehouse Test Item', kind: 'Other', stackable: true,
    class1: 4, class2: 5, mass: 1, price: 100
}, {
    selfId: 627,
    template: { kind: 'Armor.Shield', name: 'Aspis', class1: 1, class2: 1, mass: 1350, price: 35000 },
    stats: { pDef: 114 },
    etc: { slot: 8, rank: 'd' }
}];

function item(id, amount) {
    return new Item(id, { ...DataCache.items[0], amount, equipped: false, slot: 0 });
}

const questItem = new Item(88, { selfId: 1252, kind: 'Other.Quest', name: 'Iron Heart',
    class1: 4, class2: 3, amount: 1, stackable: true });
const packetItem = item(77, 12);
for (const type of [1, 2]) {
    const filtered = ServerResponse.wareHouseDepositList([questItem, packetItem], 345, type);
    assert.equal(filtered.readInt16LE(7), 1, 'quest items are absent from deposit offers');
    assert.equal(filtered.readInt32LE(11), 77);
}
const depositList = ServerResponse.wareHouseDepositList([packetItem], 345);
const withdrawList = ServerResponse.wareHouseWithdrawalList([packetItem], 345);
assert.strictEqual(depositList[0], 0x41, 'C4 warehouse deposit list must use opcode 0x41');
assert.strictEqual(withdrawList[0], 0x42, 'C4 warehouse withdrawal list must use opcode 0x42');
assert.strictEqual(depositList.readInt16LE(1), 1, 'warehouse list must identify the private warehouse type');
assert.strictEqual(depositList.readInt32LE(3), 345, 'warehouse list must include current Adena');
assert.strictEqual(depositList.readInt32LE(11), 77, 'warehouse deposit rows must retain the inventory object id');
assert.strictEqual(GameOpcodes.table[0x31], GameRequest.warehouseDeposit, 'C4 warehouse deposit request must be wired');
assert.strictEqual(GameOpcodes.table[0x32], GameRequest.warehouseWithdraw, 'C4 warehouse withdrawal request must be wired');

const enchantedShield = new Item(78, {
    selfId: 627, name: 'Aspis', kind: 'Armor.Shield', class1: 1, class2: 1,
    amount: 1, enchant: 7, equipped: false, slot: 8
});
for (const type of [1, 2]) {
    for (const name of ['wareHouseDepositList', 'wareHouseWithdrawalList']) {
        const packet = ServerResponse[name]([enchantedShield, packetItem], 345, type);
        assert.strictEqual(packet.readUInt16LE(1), type, `${name} must preserve warehouse type`);
        assert.strictEqual(packet.readUInt16LE(7), 2, `${name} must preserve item count`);
        // C4 rows start at byte 9, span 32 bytes, and carry enchant at row offset 22.
        assert.strictEqual(packet.readUInt16LE(31), 7, `${name} type ${type} must display +7 gear`);
        assert.strictEqual(packet.readInt32LE(37), 78, `${name} must preserve the trailing object id`);
        assert.strictEqual(packet.readUInt16LE(63), 0, `${name} must keep ordinary items unenchanted`);
    }
}

// Deposits and withdrawals commit in a real database; the live bag takes the
// rows they committed (LiveBag).
const fixture = require('./helpers/liveBagRows')('personal-warehouse');
const source = item(10, 7);
assert.strictEqual(source.fetchPetData(), null, 'ordinary items must not synthesize an empty pet payload');
const session = {
    activeNpcTalk: { title: 'Warehouse Keeper', objectId: 7005001, selfId: 7005 },
    actor: {
        fetchId: () => 123,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        backpack: new (invoke('GameServer/Actor/Backpack'))({ paperdoll: {}, items: [] })
    }
};
session.actor.backpack.items = [source];
const stock = () => Database.fetchWarehouseItems(123);
const storeRow = (id, selfId, name) => Database.execute([`INSERT INTO warehouse_items (id, selfId, name, amount, enchant, characterId)
    VALUES (?, ?, ?, 1, 0, 123)`, [id, selfId, name]], 'test:warehouse-row');

World.npc = { spawns: [] };
World.npc.spawns.push({
    fetchId: () => 7005001,
    fetchSelfId: () => 7005,
    fetchTitle: () => 'Warehouse Keeper',
    fetchLocX: () => 0,
    fetchLocY: () => 0
});

(async () => {
    fixture.open();
    await fixture.character(123, 'WarehouseTester');
    await fixture.stored(123, source);
    session.actor.backpack.items.push(questItem);
    await assert.rejects(Warehouse.deposit(session, [
        { objectId: 10, amount: 1 }, { objectId: 88, amount: 1 }
    ]), /invalid warehouse deposit/);
    assert.deepStrictEqual(await stock(), [], 'mixed quest-item batches must not partially transfer');
    assert.equal(source.fetchAmount(), 7);
    session.actor.backpack.items.pop();
    await Warehouse.deposit(session, [{ objectId: 10, amount: 7 }]);

    assert.strictEqual(session.actor.backpack.items.length, 0, 'deposit should remove transferred inventory items after persistence');
    assert.strictEqual(await fixture.row(123, 10), undefined, 'the deposited row left the inventory');
    const [stored] = await stock();
    assert.strictEqual(stored.amount, 7, 'deposit must persist the warehouse amount immediately');
    assert.strictEqual(stored.petData, null, 'ordinary warehouse deposits must not persist empty pet metadata');

    await Warehouse.withdraw(session, [{ objectId: stored.id, amount: 7 }]);
    assert.deepStrictEqual(await stock(), [], 'withdraw must persist warehouse removal immediately');
    assert.strictEqual(session.actor.backpack.items[0].fetchAmount(), 7, 'withdraw should materialize the stored item in inventory');
    assert.strictEqual(Number((await fixture.row(123, session.actor.backpack.items[0].fetchId())).amount), 7,
        'the bag holds the inventory row the withdrawal wrote');

    await storeRow(501, 627, 'Aspis');
    const listedAspis = (await Warehouse.list(123)).find((entry) => entry.fetchSelfId() === 627);
    assert.strictEqual(listedAspis.fetchSlot(), 8, 'warehouse gear should use its canonical equipment slot in memory');
    await Warehouse.withdraw(session, [{ objectId: 501, amount: 1 }]);
    const restoredAspis = session.actor.backpack.items.find((entry) => entry.fetchSelfId() === 627);
    assert.strictEqual(restoredAspis.fetchSlot(), 8, 'warehouse withdrawal should materialize a shield in the shield slot');

    DataCache.items.push({ selfId: 1252, kind: 'Other.Quest', name: 'Iron Heart',
        class1: 4, class2: 3, mass: 0, stackable: true });
    await storeRow(502, 1252, 'Iron Heart');
    await Warehouse.withdraw(session, [{ objectId: 502, amount: 1 }]);
    assert(session.actor.backpack.items.some(item => item.fetchSelfId() === 1252),
        'quest items already stored by older versions remain withdrawable');

    session.activeNpcTalk.objectId = 999999;
    await assert.rejects(
        Warehouse.deposit(session, [{ objectId: 42, amount: 1 }]),
        /warehouse NPC/,
        'warehouse requests must remain bound to a warehouse NPC'
    );
    console.log('Personal warehouse checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => fixture.close());
