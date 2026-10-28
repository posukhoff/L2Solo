const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../src/Global');
invoke('GameServer/DataCache').init();

// T94: a live body's bag (a player or a hot bot) and a DB trade for it. The
// buyer uses a shot and pays a restock while its AFK purchase commits; after
// the trade's rows merge into the bag, memory and the database both hold the
// trade, the shot used and the restock (CharacterWriteQueue deltas, LiveBag).
const Database = invoke('Database');
const WriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');
const Backpack = invoke('GameServer/Actor/Backpack');
const World = invoke('GameServer/World/World');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const ConsumableRestock = invoke('GameServer/Inventory/ConsumableRestock');
const ManufactureShop = invoke('GameServer/Crafting/ManufactureShop');
const LiveBag = invoke('GameServer/Inventory/LiveBag');
const databasePath = path.join(process.cwd(), 'tmp', 'test-hot-bag-trade-race.sqlite');
const SHOT = 1835, POTION = 1060, ADENA = 57;

function clean() {
    for (const suffix of ['', '-wal', '-shm', '.orphan']) {
        fs.rmSync(databasePath + suffix, { force: true });
        fs.rmSync(databasePath.replace(/\.sqlite$/, '.history.sqlite') + suffix, { force: true });
    }
}

function character(name) {
    return { name, race: 0, classId: 0, maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: 83000, locY: 148000, locZ: -3400 };
}

const amountOf = (rows, selfId) => rows.filter(row => Number(row.selfId) === selfId)
    .reduce((sum, row) => sum + Number(row.amount), 0);
const held = (actor, selfId) => amountOf(actor.backpack.fetchItems()
    .map(item => ({ selfId: item.fetchSelfId(), amount: item.fetchAmount() })), selfId);

async function liveBody(characterId, accountId = 'bot_live_buyer') {
    const backpack = new Backpack({ paperdoll: {}, items: await Database.fetchItems(characterId) });
    const actor = { backpack, fetchId: () => characterId, isDead: () => false };
    const session = { actor, accountId, dataSendToMe() {}, dataSendToOthers() {} };
    actor.session = session;
    World.user ||= {};
    World.user.sessions = [...(World.user.sessions || []), session];
    return { actor, session };
}

async function shop(ownerId, stockId, count, price) {
    return Database.createAfkTradeShop(ownerId, { storeType: 1, title: 'Shots', town: 'Giran',
        locX: 83000, locY: 148000, locZ: -3400, appearance: { model: { name: 'Owner' } },
        lines: [{ objectId: stockId, selfId: SHOT, name: 'Soulshot', count, price, stackable: true }] });
}

// One purchase of 50 shots at 10 (500 Adena) with a shot use and a potion
// restock (5 x 20 = 100 Adena) between the commit's call and its merge.
async function race(name, { timerFlush }) {
    await Database.createAccount(`${name}_owner`, 'pw');
    await Database.createAccount(`${name}_buyer`, 'pw');
    const ownerId = Number((await Database.createCharacter(`${name}_owner`, character(`${name}O`))).insertId);
    const buyerId = Number((await Database.createCharacter(`${name}_buyer`, character(`${name}B`))).insertId);
    // The owner's Adena row is older than its stock: the sale pays into it.
    await Database.setItem(ownerId, { selfId: ADENA, name: 'Adena', amount: 1000 });
    const stockId = Number((await Database.setItem(ownerId, { selfId: SHOT, name: 'Soulshot', amount: 50 })).insertId);
    await Database.setItem(buyerId, { selfId: ADENA, name: 'Adena', amount: 10000 });
    const shotsId = Number((await Database.setItem(buyerId, { selfId: SHOT, name: 'Soulshot', amount: 100 })).insertId);
    await Database.setItem(buyerId, { selfId: POTION, name: 'Lesser Healing Potion', amount: 3 });
    // The owner is live too: its newest item (the stock, sold whole) leaves its bag.
    const owner = await liveBody(ownerId, 'bot_live_owner');
    const sale = await shop(ownerId, stockId, 50, 10);
    const { actor, session } = await liveBody(buyerId);
    const staleAdena = held(actor, ADENA);

    // The window: after the trade's own flush (Database withCharacterFlush),
    // before its transaction reads the bag.
    let flushed;
    const window = new Promise(resolve => { flushed = resolve; });
    Database.registerCharacterWriteFlush(id => {
        const done = WriteQueue.flushCharacter(id);
        if (id === buyerId) flushed();
        return done;
    });
    const trade = Database.buyFromAfkTradeShop(buyerId, { shopId: sale.shop.id, ownerId,
        lineId: sale.shop.lines[0].id, amount: 50, expectedPrice: 10, expectedRevision: 1 });
    await window;
    Database.registerCharacterWriteFlush(WriteQueue.flushCharacter);
    actor.backpack.deleteItem(session, shotsId, 1, () => {}, null);
    if (timerFlush) WriteQueue.flushAll();
    const restock = ConsumableRestock.buyForActor(actor, { selfId: POTION, name: 'Lesser Healing Potion',
        currentAmount: 3, amount: 5, unitPrice: 20, cost: 100, adena: staleAdena });
    const result = await trade;
    AfkTrade.syncOnlineInventory(buyerId, result.counterpartyInventory);
    AfkTrade.syncOnlineInventory(ownerId, result.ownerInventory);
    assert.strictEqual((await restock).ok, true, `${name}: the restock is paid`);
    assert.strictEqual(held(owner.actor, SHOT), 0, `${name}: the owner's sold stock left its bag`);
    assert.strictEqual(held(owner.actor, ADENA), amountOf(result.ownerInventory, ADENA), `${name}: the owner holds its sale`);
    assert.ok(held(owner.actor, ADENA) > 1000, `${name}: the sale paid the owner`);

    const expected = { [ADENA]: 10000 - 500 - 100, [SHOT]: 100 + 50 - 1, [POTION]: 3 + 5 };
    for (const [selfId, amount] of Object.entries(expected)) {
        assert.strictEqual(held(actor, Number(selfId)), amount, `${name}: the bag holds ${selfId} x${amount}`);
    }
    await WriteQueue.flushAll();
    const rows = await Database.fetchItems(buyerId);
    for (const [selfId, amount] of Object.entries(expected)) {
        assert.strictEqual(amountOf(rows, Number(selfId)), amount, `${name}: the database holds ${selfId} x${amount}`);
    }
    assert.strictEqual(new Set(actor.backpack.fetchItems().map(item => item.fetchId())).size,
        actor.backpack.fetchItems().length, `${name}: no item twice`);
    return { actor, session, buyerId };
}

(async () => {
    clean();
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();

    await race('plain', { timerFlush: false });
    // A timer flush between the shot use and the trade's read: the use is
    // in the trade's rows then, and is not counted twice.
    await race('flushed', { timerFlush: true });

    // A workshop fee row (Database.craftForCustomer's crafterAdena) read
    // before the body paid a restock keeps that payment.
    const { actor, buyerId } = await race('fee', { timerFlush: false });
    const adena = actor.backpack.fetchItemFromSelfId(ADENA);
    const row = WriteQueue.markRead(buyerId, { id: adena.fetchId(), amount: adena.fetchAmount() + 300 });
    const paid = await ConsumableRestock.buyForActor(actor, { selfId: POTION, name: 'Lesser Healing Potion',
        currentAmount: 8, amount: 1, unitPrice: 20, cost: 20, adena: adena.fetchAmount() });
    assert.strictEqual(paid.ok, true);
    ManufactureShop.applyAdena(actor, row);
    assert.strictEqual(held(actor, ADENA), 9400 + 300 - 20, 'the fee and the later payment both stay');

    await WriteQueue.flushAll();

    // A delta the row cannot take (spent meanwhile, or the row is gone)
    // neither fails nor jams the batch: another character's write in it lands.
    await Database.createAccount('fault_a', 'pw');
    await Database.createAccount('fault_b', 'pw');
    const faultA = Number((await Database.createCharacter('fault_a', character('FaultA'))).insertId);
    const faultB = Number((await Database.createCharacter('fault_b', character('FaultB'))).insertId);
    const thinId = Number((await Database.setItem(faultA, { selfId: ADENA, name: 'Adena', amount: 100 })).insertId);
    const otherId = Number((await Database.setItem(faultB, { selfId: ADENA, name: 'Adena', amount: 100 })).insertId);
    WriteQueue.itemDelta(faultA, thinId, -150);
    WriteQueue.itemDelta(faultA, 987654321, 5);
    WriteQueue.itemDelta(faultB, otherId, -40);
    await WriteQueue.flushAll();
    assert.strictEqual(WriteQueue.pendingCount(), 0, 'nothing waits for a retry');
    assert.strictEqual(amountOf(await Database.fetchItems(faultA), ADENA), 0, 'an overdrawn row goes to 0, as the bag holds it');
    assert.strictEqual(amountOf(await Database.fetchItems(faultB), ADENA), 60, 'the other character in the batch is written');

    // A quest step is written after the bag change it gave (QuestService).
    WriteQueue.itemDelta(faultB, otherId, 5);
    await Database.setCharacterQuest(faultB, 1, 'started', {});
    assert.strictEqual(WriteQueue.pendingCount(), 0, 'the quest step waited for the bag delta');
    assert.strictEqual(WriteQueue.unread(faultB).size, 0);

    // A mark taken on a settled entry keeps it through a prune: the merge
    // adds only the later change.
    const later = Date.now() + 11 * 60 * 1000;
    const mark = WriteQueue.markRead(faultB, [{ id: otherId, selfId: ADENA, amount: 65 }]);
    WriteQueue.pruneLedger(later - 60 * 1000);
    WriteQueue.itemDelta(faultB, otherId, -10);
    assert.strictEqual(WriteQueue.unread(faultB, mark).get(otherId), -10, 'a prune does not break a pending mark');
    await WriteQueue.flushAll();

    // Settled ledger entries leave after 10 minutes unchanged.
    assert.ok(WriteQueue.ledgerSize() > 0);
    WriteQueue.pruneLedger(Date.now() + 11 * 60 * 1000);
    assert.strictEqual(WriteQueue.ledgerSize(), 0, 'the ledger does not grow with uptime');

    // The newest row of the table listed whole: it leaves the live bag
    // (MAX(id) would drop below it; the read mark takes the table's sequence).
    await Database.createAccount('newest_owner', 'pw');
    const newestOwner = Number((await Database.createCharacter('newest_owner', character('NewestO'))).insertId);
    await Database.setItem(newestOwner, { selfId: ADENA, name: 'Adena', amount: 1000 });
    const newestStock = Number((await Database.setItem(newestOwner, { selfId: SHOT, name: 'Soulshot', amount: 50 })).insertId);
    const lister = await liveBody(newestOwner, 'bot_live_lister');
    const listed = await shop(newestOwner, newestStock, 50, 10);
    AfkTrade.syncOnlineInventory(newestOwner, listed.ownerInventory);
    assert.strictEqual(held(lister.actor, SHOT), 0, 'the newest stack, listed whole, left the bag');
    assert.strictEqual(held(lister.actor, ADENA), 1000);

    // A job's row at 0 is gone from the database: the bag drops the item even
    // with a gain queued meanwhile (that delta finds no row).
    const gone = lister.actor.backpack.fetchItemFromSelfId(ADENA);
    LiveBag.add(lister.actor, gone, 5);
    const goneRow = WriteQueue.markRead(newestOwner, { id: gone.fetchId(), amount: 0 });
    LiveBag.applyRow(lister.actor, goneRow);
    assert.strictEqual(held(lister.actor, ADENA), 0, 'a row the job removed leaves the bag');
    await WriteQueue.flushAll();
    console.log('hot bag trade race ok');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    await Database.close?.();
    clean();
});
