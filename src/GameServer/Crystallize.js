const ItemTemplateIndex = require('./Item/ItemTemplateIndex');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LiveBag = require('./Inventory/LiveBag');
const ServerResponse = invoke('GameServer/Network/Response');
const CharacterWriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');
const GRADES = { d: { level: 1, crystalId: 1458 }, c: { level: 2, crystalId: 1459 }, b: { level: 3, crystalId: 1460 }, a: { level: 4, crystalId: 1461 }, s: { level: 5, crystalId: 1462 } };
async function crystallize(session, objectId, count) {
    const actor = session?.actor, item = actor?.backpack?.fetchItemRaw?.(objectId), skill = actor?.skillset?.fetchSkill?.(248);
    const grade = GRADES[String(item?.fetchRank?.() || '').toLowerCase()], amount = Number(item?.fetchCristals?.() || 0);
    if (!actor || actor.isDead?.() || Number(actor.fetchPrivateStoreType?.() || 0) !== 0 || Number(count) !== 1 || !item || item.fetchAmount() !== 1 || item.fetchEquipped() || !grade || amount <= 0 || Number(skill?.fetchLevel?.() || 0) < grade.level) { session?.dataSendToMe?.(ServerResponse.actionFailed()); return false; }
    const crystal = ItemTemplateIndex.find(DataCache.items, grade.crystalId); if (!crystal) return false;
    try {
        await CharacterWriteQueue.flushCharacter(actor.fetchId());
        const result = await Database.crystallizeInventoryItem(actor.fetchId(), { sourceId: item.fetchId(), sourceSelfId: item.fetchSelfId(), crystalId: grade.crystalId, crystalName: crystal.template?.name || '', crystalAmount: amount });
        LiveBag.applyAmounts(actor, result.rows);
        session.dataSendToMe(ServerResponse.itemsList(actor.backpack.fetchItems()));
        return true;
    } catch (error) { utils.infoWarn('Crystallize', 'rejected %s: %s', actor.fetchName(), error.message); session.dataSendToMe(ServerResponse.actionFailed()); return false; }
}
module.exports = { crystallize };
