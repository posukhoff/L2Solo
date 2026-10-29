const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const Database = invoke('Database');

async function main() {
    const databasePath = path.join(process.cwd(), 'tmp', 'test-bot-trade.sqlite');
    fs.rmSync(databasePath, { force: true });
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();

    await Database.createAccount('trade_db_player', 'secret');
    await Database.createAccount('trade_db_bot', 'secret');
    await Database.createCharacter('trade_db_player', {
        name: 'TradeDbPlayer', race: 0, classId: 0, maxHp: 50, maxMp: 25,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: 0, locY: 0, locZ: 0
    });
    await Database.createCharacter('trade_db_bot', {
        name: 'TradeDbBot', race: 0, classId: 0, maxHp: 50, maxMp: 25,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: 0, locY: 0, locZ: 0
    });

    const playerId = Number((await Database.fetchCharacterName('TradeDbPlayer'))[0].id);
    const botId = Number((await Database.fetchCharacterName('TradeDbBot'))[0].id);
    const playerItemId = Number((await Database.setItem(playerId, {
        selfId: 7001, name: 'Player Token', amount: 2, enchant: 7, equipped: false, slot: 0
    })).insertId);
    const botItemId = Number((await Database.setItem(botId, {
        selfId: 7002, name: 'Bot Token', amount: 3, enchant: 5, equipped: false, slot: 0
    })).insertId);

    const moved = await Database.transferInventoryBetweenCharacters([
        { fromCharacterId: playerId, toCharacterId: botId, sourceItemId: playerItemId, selfId: 7001, amount: 1, stackable: true, name: 'Player Token' },
        { fromCharacterId: botId, toCharacterId: playerId, sourceItemId: botItemId, selfId: 7002, amount: 2, stackable: true, name: 'Bot Token' }
    ]);
    assert.strictEqual(moved.length, 2);
    assert.strictEqual((await Database.fetchItems(playerId)).find((item) => Number(item.selfId) === 7001).amount, 1);
    assert.strictEqual((await Database.fetchItems(playerId)).find((item) => Number(item.selfId) === 7002).amount, 2);
    assert.strictEqual((await Database.fetchItems(botId)).find((item) => Number(item.selfId) === 7001).amount, 1);
    assert.strictEqual((await Database.fetchItems(botId)).find((item) => Number(item.selfId) === 7002).amount, 1);
    assert.strictEqual((await Database.fetchItems(playerId)).find((item) => Number(item.selfId) === 7002).enchant, 5);
    assert.strictEqual((await Database.fetchItems(botId)).find((item) => Number(item.selfId) === 7001).enchant, 7);

    await assert.rejects(
        Database.transferInventoryBetweenCharacters([
            { fromCharacterId: playerId, toCharacterId: botId, sourceItemId: playerItemId, selfId: 7001, amount: 1, stackable: true },
            { fromCharacterId: botId, toCharacterId: playerId, sourceItemId: 999999, selfId: 7002, amount: 1, stackable: true }
        ]),
        /inventory item changed/
    );
    assert.strictEqual((await Database.fetchItems(playerId)).find((item) => Number(item.selfId) === 7001).amount, 1, 'failed transfer must roll back the first side');

    // A stack one entry credits and a later entry takes from is read at its
    // own write: the later entry sees the credit.
    const stock = async (characterId, selfId, amount, equipped = false) => Number((await Database.setItem(characterId, {
        selfId, name: `Token ${selfId}`, amount, equipped, slot: equipped ? 7 : 0 })).insertId);
    const rows = async (characterId, selfId) => (await Database.fetchItems(characterId))
        .filter((item) => Number(item.selfId) === selfId).map((item) => [Number(item.amount), Number(item.equipped)]);
    const playerStack = await stock(playerId, 7003, 5);
    const botStack = await stock(botId, 7003, 10);
    await Database.transferInventoryBetweenCharacters([
        { fromCharacterId: playerId, toCharacterId: botId, sourceItemId: playerStack, selfId: 7003, amount: 5, stackable: true },
        { fromCharacterId: botId, toCharacterId: playerId, sourceItemId: botStack, selfId: 7003, amount: 12, stackable: true }
    ]);
    assert.deepStrictEqual(await rows(botId, 7003), [[3, 0]], 'the later entry takes from the credited stack');
    assert.deepStrictEqual(await rows(playerId, 7003), [[12, 0]], 'the taker receives the whole later entry');

    // A worn stack takes the credit (one stack per stackable item, worn arrows too).
    await stock(botId, 7004, 10, true);
    const given = await stock(playerId, 7004, 4);
    await Database.transferInventoryBetweenCharacters([
        { fromCharacterId: playerId, toCharacterId: botId, sourceItemId: given, selfId: 7004, amount: 4, stackable: true }
    ]);
    assert.deepStrictEqual(await rows(botId, 7004), [[14, 1]], 'the worn stack takes the credit');
    console.log('Bot trade database checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
