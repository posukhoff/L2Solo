'use strict';
// Class kits by C4 masteries (user 10-30): a Rogue fights 20-39 with the
// weapon of its own future second class, a bow for a future Hawkeye, a
// dagger for a future Treasure Hunter, and reads that class's table line.
const assert = require('node:assert/strict');
require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Progression = invoke('GameServer/Bot/BotClassProgression');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const BotGear = invoke('GameServer/Bot/AI/BotGear');
const Compatibility = invoke('GameServer/Bot/AI/BotEquipmentCompatibility');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
const Index = require('../src/GameServer/Item/ItemTemplateIndex');

const ROGUE = 7, HAWKEYE = 9, TREASURE_HUNTER = 8, LEVEL = 30;
const DAGGER = 'Weapon.Knife'; // the datapack's dagger kind
const idWithFuture = (future) => {
    for (let id = 1; ; id++) if (Progression.futureClass(ROGUE, id) === future) return id;
};
const rogue = (characterId) => ({ characterId, level: LEVEL, stats: { classId: ROGUE } });
const hawkeye = rogue(idWithFuture(HAWKEYE)), hunter = rogue(idWithFuture(TREASURE_HUNTER));

assert.equal(Progression.futureClass(ROGUE, hawkeye.characterId),
    Progression.nextClass(ROGUE, 40, hawkeye.characterId), 'the future is the pick class progression makes at 40');
assert.equal(Progression.futureClass(HAWKEYE, 1), null, 'a second class has no future second class');

assert.equal(Roles.inferRole(hawkeye), 'archer', 'a future Hawkeye Rogue is an archer');
assert.equal(Roles.inferRole(hunter), 'dagger', 'a future Treasure Hunter Rogue is a dagger');
assert.equal(Roles.inferRole(ROGUE), 'dagger', 'a class-only Rogue keeps the dagger role');
const actor = session => ({ fetchId: () => hawkeye.characterId, fetchClassId: () => ROGUE, fetchLevel: () => LEVEL, session });
assert.equal(Roles.inferRole(actor({ botSession: true })), 'archer', 'a bot actor reads its own id');
assert.equal(Roles.inferRole(actor({})), 'dagger', 'a player picks its second class itself: its class role');
assert.equal(Roles.inferRole({ ...hawkeye, accountName: 'player1' }), 'dagger', 'a player row: its class role');
assert.equal(Roles.inferRole({ characterId: hawkeye.characterId, stats: { classId: 4 } }), 'tank', 'other classes keep their role');

const weaponKind = (state) => {
    const weapon = BotGear.planFor(state).items.find((item) => [7, 14].includes(Number(item.slot)));
    return Index.find(DataCache.items, weapon.selfId)?.template?.kind;
};
assert.equal(weaponKind(hawkeye), 'Weapon.Bow', 'a future Hawkeye gears a bow');
assert.equal(weaponKind(hunter), DAGGER, 'a future Treasure Hunter gears a dagger');
assert(Compatibility.profileFor(Roles.inferRole(hawkeye), ROGUE).weaponKinds.includes('Weapon.Bow'));
assert(!Compatibility.profileFor(Roles.inferRole(hunter), ROGUE).weaponKinds.includes('Weapon.Bow'));

assert.equal(Table.roleFor(hawkeye), String(HAWKEYE), 'a future Hawkeye reads the Hawkeye line');
assert.equal(Table.roleFor(hunter), String(TREASURE_HUNTER), 'a future Treasure Hunter reads its line');

// The table's reference bots: line 9 below 40 is a bow Rogue, line 8 a dagger one.
const referenceKind = (line) => {
    const state = HuntCycle.referenceState(ROGUE, LEVEL, { line });
    const weapon = Object.values(state.inventory).find((item) => [7, 14].includes(item.slot));
    return Index.find(DataCache.items, weapon.selfId)?.template?.kind;
};
assert.equal(referenceKind(HAWKEYE), 'Weapon.Bow');
assert.equal(referenceKind(TREASURE_HUNTER), DAGGER);
assert.equal(referenceKind(null), DAGGER, 'a class-only reference Rogue keeps its dagger');

console.log('test_future_class_kit: ok');
