const assert = require('assert');

require('../src/Global');

// "Sell unequipped junk" removes the sold items and pays their Adena as bag
// deltas (LiveBag -> CharacterWriteQueue, no write the handler waits on); only
// a missing Adena stack is a database write. Its failure must reach the
// handler's log, not reject unhandled (Node 22 ends the server on an unhandled
// rejection). What the player sees on success stays as it was; an existing
// Adena stack gets no second stack.
const SellJunk = invoke('GameServer/World/Generics/NpcBypasses/SellJunk');
const Database = invoke('Database');
const ServerResponse = invoke('GameServer/Network/Response');

// Counted only in this test: the server itself has no such listener.
const unhandled = [];
process.on('unhandledRejection', (error) => unhandled.push(error?.message || String(error)));

function item(id, selfId, amount, price, name) {
    return {
        fetchId: () => id,
        fetchSelfId: () => selfId,
        fetchAmount: () => amount.value,
        setAmount: (value) => { amount.value = value; },
        fetchPrice: () => price,
        fetchName: () => name,
        fetchEquipped: () => false,
        fetchStackable: () => true,
        fetchClass1: () => 4,
        fetchClass2: () => 5,
        fetchSlot: () => 0
    };
}

function fixture({ withAdena = true } = {}) {
    const cash = { value: 100 };
    const junk = item(1001, 1539, { value: 1 }, 100, 'Junk');
    const adena = item(1002, 57, cash, 1, 'Adena');
    const packets = [];
    const backpack = {
        items: withAdena ? [junk, adena] : [junk],
        stackableExists(selfId) {
            const found = this.items.find((entry) => entry.fetchSelfId() === selfId);
            return found ? Promise.resolve(found) : Promise.reject();
        },
        insertItem() {},
        fetchItems() { return this.items; }
    };
    const session = {
        accountId: 'human',
        actor: { fetchId: () => 42, fetchName: () => 'Fixture', backpack },
        dataSendToMe(packet) { packets.push(packet); }
    };
    return { session, cash, junk, packets, backpack };
}

const ticks = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)); };

async function scenario(name, writes, options) {
    const f = fixture(options);
    const warnings = [];
    const setItemCalls = [];
    const startUnhandled = unhandled.length;
    Database.setItem = (...args) => { setItemCalls.push(args); return writes.setItem ? writes.setItem(...args) : Promise.resolve({ insertId: 1003 }); };
    utils.infoWarn = (...args) => warnings.push(args);
    const done = SellJunk(f.session, ['sell-junk']);
    await done;
    await ticks();
    return {
        name,
        cash: f.cash.value,
        successMessages: f.packets.filter((packet) => packet === 'speak:Successfully').length,
        sellJunkWarnings: warnings.filter((args) => args[0] === 'SellJunk').length,
        warnings,
        unhandled: unhandled.slice(startUnhandled),
        setItemCalls: setItemCalls.length,
        junkInMemory: f.backpack.items.includes(f.junk)
    };
}

async function main() {
    const original = {
        setItem: Database.setItem,
        infoWarn: utils.infoWarn,
        speak: ServerResponse.speak,
        itemsList: ServerResponse.itemsList,
        userInfo: ServerResponse.userInfo
    };
    ServerResponse.speak = (_, payload) => (String(payload.text).startsWith('Successfully') ? 'speak:Successfully' : 'speak');
    ServerResponse.itemsList = () => 'items';
    ServerResponse.userInfo = () => 'user';
    try {
        const newStackFails = await scenario('new Adena stack fails', {
            setItem: () => Promise.reject(new Error('injected new stack failure'))
        }, { withAdena: false });
        assert.deepStrictEqual(newStackFails.unhandled, [], 'a failed new Adena stack must not reject unhandled');
        assert.strictEqual(newStackFails.setItemCalls, 1, 'without an Adena stack the payout creates one, as before');
        assert.strictEqual(newStackFails.sellJunkWarnings, 1, 'a failed new Adena stack is logged by the sale handler');

        const success = await scenario('all writes succeed', {});
        assert.deepStrictEqual(success.unhandled, []);
        assert.strictEqual(success.sellJunkWarnings, 0);
        assert.strictEqual(success.cash, 150);
        assert.strictEqual(success.successMessages, 1);
        assert.strictEqual(success.setItemCalls, 0);
        assert.strictEqual(success.junkInMemory, false);
        console.log('sell-junk write failure checks passed');
    } finally {
        Database.setItem = original.setItem;
        utils.infoWarn = original.infoWarn;
        ServerResponse.speak = original.speak;
        ServerResponse.itemsList = original.itemsList;
        ServerResponse.userInfo = original.userInfo;
    }
}

main().then(() => process.exit(process.exitCode || 0)).catch((error) => {
    console.error(error);
    process.exit(1);
});
