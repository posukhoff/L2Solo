const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../src/Global');
invoke('GameServer/DataCache').init();

// T97: a database job for a live body (an NPC sale, a warehouse deposit and
// withdrawal, a quest step) commits rows the body's bag takes in place
// (LiveBag). A shot used or Adena changed while the job waited on the
// database stays in memory and in the database, and so does the job's change.
const Database = invoke('Database');
const WriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');
const Backpack = invoke('GameServer/Actor/Backpack');
const World = invoke('GameServer/World/World');
const Response = invoke('GameServer/Network/Response');
const LiveBag = invoke('GameServer/Inventory/LiveBag');
const Sell = invoke('GameServer/Network/Request/Sell');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');
const Warehouse = invoke('GameServer/Warehouse/PersonalWarehouse');
const QuestService = invoke('GameServer/Quest/QuestService');
const QuestStep = invoke('GameServer/Quest/QuestStep');
const databasePath = path.join(process.cwd(), 'tmp', 'test-live-bag-job-merges.sqlite');
const SHOT = 1835, POTION = 1539, ADENA = 57;
const KEEPER = { objectId: 7097001, selfId: 7097 };

function clean() {
    for (const suffix of ['', '-wal', '-shm', '.orphan']) {
        fs.rmSync(databasePath + suffix, { force: true });
        fs.rmSync(databasePath.replace(/\.sqlite$/, '.history.sqlite') + suffix, { force: true });
    }
}

const amountOf = (rows, selfId) => rows.filter(row => Number(row.selfId) === selfId)
    .reduce((sum, row) => sum + Number(row.amount), 0);
const held = (actor, selfId) => amountOf(actor.backpack.fetchItems()
    .map(item => ({ selfId: item.fetchSelfId(), amount: item.fetchAmount() })), selfId);
const stack = (actor, selfId) => actor.backpack.fetchItemFromSelfId(selfId);

// A player with Adena, a shot stack and potions, live in the world.
async function player(name) {
    await Database.createAccount(name, 'pw');
    const id = Number((await Database.createCharacter(name, { name: `${name}C`, race: 0, classId: 0, maxHp: 100, maxMp: 100,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: 0, locY: 0, locZ: 0 })).insertId);
    await Database.setItem(id, { selfId: ADENA, name: 'Adena', amount: 1000 });
    await Database.setItem(id, { selfId: SHOT, name: 'Soulshot: No Grade', amount: 100 });
    await Database.setItem(id, { selfId: POTION, name: 'Greater Healing Potion', amount: 12 });
    const backpack = new Backpack({ paperdoll: {}, items: await Database.fetchItems(id) });
    const actor = { backpack, fetchId: () => id, isDead: () => false, fetchLocX: () => 0, fetchLocY: () => 0,
        fetchLevel: () => 20, fetchClassId: () => 0, fetchClanId: () => 0 };
    const session = { actor, accountId: name, packets: [], dataSendToMe(packet) { this.packets.push(packet); }, dataSendToOthers() {} };
    actor.session = session;
    World.user ||= {};
    World.user.sessions = [...(World.user.sessions || []), session];
    return { id, actor, session };
}

// Runs `job` and, after its own character flush and before its transaction
// reads the bag, the body's change `meanwhile` (the way a shot fires while
// the job waits on the database).
async function racing(characterId, job, meanwhile) {
    let opened, release;
    const window = new Promise(resolve => { opened = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    Database.registerCharacterWriteFlush(id => {
        const done = WriteQueue.flushCharacter(id);
        if (Number(id) !== characterId) return done;
        opened();
        return Promise.all([done, gate]);
    });
    const running = job();
    await Promise.race([window, running]);
    Database.registerCharacterWriteFlush(WriteQueue.flushCharacter);
    meanwhile();
    release();
    return running;
}

async function expectBoth(name, { id, actor }, expected) {
    for (const [selfId, amount] of Object.entries(expected)) {
        assert.strictEqual(held(actor, Number(selfId)), amount, `${name}: the bag holds ${selfId} x${amount}`);
    }
    await WriteQueue.flushAll();
    const rows = await Database.fetchItems(id);
    for (const [selfId, amount] of Object.entries(expected)) {
        assert.strictEqual(amountOf(rows, Number(selfId)), amount, `${name}: the database holds ${selfId} x${amount}`);
    }
    assert.strictEqual(new Set(actor.backpack.fetchItems().map(item => item.fetchId())).size,
        actor.backpack.fetchItems().length, `${name}: no item twice`);
}

function sellPacket(lines) {
    const buffer = Buffer.alloc(9 + 12 * lines.length);
    buffer.writeInt32LE(lines.length, 5);
    lines.forEach((line, index) => {
        buffer.writeInt32LE(line.objectId, 9 + index * 12);
        buffer.writeInt32LE(line.selfId, 13 + index * 12);
        buffer.writeInt32LE(line.amount, 17 + index * 12);
    });
    return buffer;
}

// An NPC sale pays into the Adena row a pickup credited while it committed.
async function npcSale() {
    const body = await player('t97_sale');
    const { actor, session } = body;
    session.activeNpcSellShop = { items: new Map(NpcSellRules.rows(actor).map(row =>
        [row.item.fetchId(), { selfId: row.item.fetchSelfId(), price: row.price }])) };
    const potions = stack(actor, POTION);
    const price = session.activeNpcSellShop.items.get(potions.fetchId()).price;
    await racing(body.id, () => Sell(session, sellPacket([{ objectId: potions.fetchId(), selfId: POTION, amount: 5 }])), () => {
        LiveBag.add(actor, stack(actor, ADENA), 40);
        LiveBag.add(actor, stack(actor, SHOT), -1);
    });
    assert.ok(price > 0, 'the shop pays for potions');
    await expectBoth('sale', body, { [ADENA]: 1000 + 5 * price + 40, [SHOT]: 99, [POTION]: 7 });
}

// A deposit and a withdrawal of the shot stack while the body fires shots.
async function warehouse() {
    const body = await player('t97_warehouse');
    const { actor, session } = body;
    World.npc ||= { spawns: [] };
    World.npc.spawns ||= [];
    World.npc.spawns.push({ fetchId: () => KEEPER.objectId, fetchSelfId: () => KEEPER.selfId,
        fetchTitle: () => 'Warehouse Keeper', fetchLocX: () => 0, fetchLocY: () => 0 });
    session.activeNpcTalk = { ...KEEPER, title: 'Warehouse Keeper' };
    const shots = stack(actor, SHOT);
    const stored = await racing(body.id, () => Warehouse.deposit(session, [{ objectId: shots.fetchId(), amount: 5 }]),
        () => LiveBag.add(actor, stack(actor, SHOT), -1));
    await expectBoth('deposit', body, { [SHOT]: 100 - 5 - 1, [ADENA]: 1000 });
    const kept = stored.find(item => item.fetchSelfId() === SHOT);
    assert.strictEqual(kept.fetchAmount(), 5, 'the warehouse holds the deposit');

    await racing(body.id, () => Warehouse.withdraw(session, [{ objectId: kept.fetchId(), amount: 5 }]),
        () => LiveBag.add(actor, stack(actor, SHOT), -1));
    await expectBoth('withdraw', body, { [SHOT]: 100 - 1 - 1, [ADENA]: 1000 });
}

// A quest step takes potions and pays Adena while the body pays a restock.
async function questStep() {
    const body = await player('t97_quest');
    const { actor, session } = body;
    await QuestService.ensureLoaded(session);
    const quest = QuestService.quests().find(entry => entry.id === 1);
    const state = QuestService.stateFor(session, quest);
    await racing(body.id, () => QuestStep.apply(state, { takes: [[POTION, 2]], gives: [[ADENA, 500]] }),
        () => LiveBag.add(actor, stack(actor, ADENA), -100));
    await expectBoth('quest step', body, { [ADENA]: 1000 + 500 - 100, [POTION]: 10, [SHOT]: 100 });
    assert.strictEqual(state.state, 'started', 'the step moved the quest');
}

(async () => {
    clean();
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();
    // The client packets a sale sends back read a full actor (the network edge).
    Response.userInfo = () => Buffer.from([4]);
    await npcSale();
    await warehouse();
    await questStep();
    console.log('live bag job merges ok');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    await Database.close?.();
    clean();
});
