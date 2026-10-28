'use strict';
// A real database under a test's live bags: the job's transaction reads and
// writes rows that mirror the test's Items, and the bag takes back the rows
// it committed (LiveBag). Characters keep the test's fixed ids.
const fs = require('node:fs');
const path = require('node:path');
const Native = require('./nativeMarketFixture');

module.exports = function liveBagRows(name) {
    const Database = invoke('Database');
    const file = path.join(process.cwd(), 'tmp', `test-${name}-${process.pid}.sqlite`);
    const clean = () => {
        for (const suffix of ['', '-wal', '-shm']) {
            fs.rmSync(file + suffix, { force: true });
            fs.rmSync(file.replace(/\.sqlite$/, '.history.sqlite') + suffix, { force: true });
        }
    };
    return {
        open() {
            clean();
            options.default.Database.path = path.relative(process.cwd(), file);
            Database.init();
        },
        character: (id, characterName) => Native.character(Database, id, characterName, `${characterName.toLowerCase()}_account`),
        // The Items' rows (same ids, amounts, enchant, equip) for the character.
        async stored(characterId, ...items) {
            for (const item of items) {
                await Database.execute([`INSERT INTO items (id, selfId, name, amount, enchant, equipped, slot, characterId)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [item.fetchId(), item.fetchSelfId(), item.fetchName?.() || '',
                    item.fetchAmount(), item.fetchEnchantLevel?.() || 0, item.fetchEquipped?.() ? 1 : 0,
                    item.fetchSlot?.() || 0, characterId]], 'test:live-bag-row');
            }
        },
        async row(characterId, id) {
            return (await Database.fetchItems(characterId)).find(entry => Number(entry.id) === Number(id));
        },
        async close() {
            await Database.close?.();
            clean();
        }
    };
};
