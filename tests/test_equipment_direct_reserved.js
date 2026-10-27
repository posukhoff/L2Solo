const assert = require('assert');
require('../src/Global');

const BotManager = invoke('GameServer/Bot/BotManager');
const BotAgentTools = invoke('GameServer/Bot/AI/BotAgentTools');
const BotEquipmentUpgrade = invoke('GameServer/Bot/AI/BotEquipmentUpgrade');
const Item = invoke('GameServer/Item/Item');
const Data = invoke('GameServer/DataCache'); Data.init();

// A weapon reserved as a luxury-exchange material is hidden from automatic
// selection; the direct equip command (LLM tool) must refuse it the same way.

function wearable(id, data) {
    return new Item(id, {
        selfId: data.selfId || id,
        name: data.name || `item_${id}`,
        kind: data.kind,
        price: data.price ?? 100,
        rank: data.rank || 'none',
        pAtk: data.pAtk || 0,
        equipped: data.equipped || false,
        slot: data.slot
    });
}

const oldSword = wearable(901, { kind: 'Weapon.Sword', slot: 7, pAtk: 8, equipped: true });
// The material's template is a gradeless sword (Short Sword, selfId 1): it
// breaks into no crystals, so the plan holds it whatever the bot's skill.
const material = wearable(902, { selfId: 1, kind: 'Weapon.Sword', slot: 7, pAtk: 20 });
// A D sword (selfId 90) breaks into crystals: only a bot with the Crystallize
// skill keeps it for the exchange; at level 10 it is out of grade.
const dSword = wearable(903, { selfId: 90, kind: 'Weapon.Sword', slot: 7, pAtk: 30, rank: 'd' });
const items = [oldSword, material, dSword];
let equipCalls = 0;
let level = 10;
const backpack = {
    fetchItems: () => items,
    fetchEquippedWeapon: () => oldSword,
    fetchPaperdollId: (slot) => Number(slot) === 7 ? 901 : 0,
    fetchItemRaw: (id) => items.find((item) => item.fetchId() === id),
    equipGear: () => { equipCalls++; }
};
const leader = { accountId: 'player_reserved_leader', actor: { fetchId: () => 730, fetchName: () => 'Leader', fetchIsOnline: () => true } };
const bot = {
    accountId: 'bot_reserved_gear',
    plan: 'following',
    partyCompanion: true,
    followPlayerSession: leader,
    actor: {
        fetchId: () => 731,
        fetchName: () => 'ReservedCompanion',
        fetchLevel: () => level,
        fetchClassId: () => 0,
        isDead: () => false,
        state: { fetchHits: () => false, fetchCasts: () => false, fetchTowards: () => false },
        backpack
    }
};
BotManager.sessions = [bot];
const plan = (strategy, selfId = 1, skills) => ({ stats: { equipmentPlan: { strategy, status: 'active',
    materials: [{ selfId, amount: 1 }] }, ...(skills ? { coldCombat: { skills } } : {}) } });

function decision(turnId, itemId) {
    return { action: 'equip_candidate', confidence: 0.99, reply: '', targetPlayerName: '', spotId: '',
        buffType: '', reason: 'reserved test', turnId, itemId };
}
const ctx = (turnId) => ({ playerSession: leader, conversationTurn: { turnId } });

try {
    // control: no plan, the stronger sword is a normal upgrade and applies
    bot.coldLifeState = null;
    assert.strictEqual(BotEquipmentUpgrade.findBestUpgrades(bot).length, 1, 'control: sword is an upgrade without a plan');
    const control = BotEquipmentUpgrade.applyCandidate(bot, 902, { force: true });
    assert.strictEqual(control.applied, true, 'control: direct equip applies without a plan');
    assert.strictEqual(equipCalls, 1);
    equipCalls = 0;

    // reserved for a luxury exchange: auto-selection skips it, direct must refuse
    bot.coldLifeState = plan('luxury_exchange');
    assert.strictEqual(BotEquipmentUpgrade.findBestUpgrades(bot).length, 0, 'auto-selection skips the reserved material');
    assert.strictEqual(BotEquipmentUpgrade.listSafeLoadouts(bot).length, 0);
    const direct = BotEquipmentUpgrade.applyCandidate(bot, 902, { force: true });
    assert.deepStrictEqual(direct, { applied: false, reason: 'reserved_exchange_material' });
    assert.strictEqual(equipCalls, 0, 'reserved material must not be equipped');

    // through the LLM tool: the same refusal shape (clear the check cooldown the forced calls set)
    bot.lastEquipmentUpgradeCheckAt = 0;
    const tool = BotAgentTools.execute(bot, decision('res-1', 902), [], ctx('res-1'));
    assert.strictEqual(tool.applied, false);
    assert.strictEqual(tool.reason, 'reserved_exchange_material');
    assert.strictEqual(equipCalls, 0);

    // another strategy does not reserve it: same as auto-selection
    bot.coldLifeState = plan('craft');
    assert.strictEqual(BotEquipmentUpgrade.findBestUpgrades(bot).length, 1);
    assert.strictEqual(BotEquipmentUpgrade.applyCandidate(bot, 902, { force: true }).applied, true);

    // an old luxury plan of a bot without the Crystallize skill holds no D gear
    // (the disposition view frees it): the D sword is an upgrade again
    level = 20;
    bot.coldLifeState = plan('luxury_exchange', 90);
    assert(BotEquipmentUpgrade.findBestUpgrades(bot).some(({ item }) => item.fetchId() === 903), 'unskilled: D sword offered');
    assert.strictEqual(BotEquipmentUpgrade.applyCandidate(bot, 903, { force: true }).applied, true, 'unskilled: D sword equips');

    // the same plan of a bot with the skill still holds it for the exchange
    bot.coldLifeState = plan('luxury_exchange', 90, [{ selfId: 248, level: 1 }]);
    assert(!BotEquipmentUpgrade.findBestUpgrades(bot).some(({ item }) => item.fetchId() === 903), 'skilled: D sword hidden');
    assert.deepStrictEqual(BotEquipmentUpgrade.applyCandidate(bot, 903, { force: true }),
        { applied: false, reason: 'reserved_exchange_material' });
    console.log('Direct equip reserved material checks passed');
} finally {
    BotManager.sessions = [];
}
