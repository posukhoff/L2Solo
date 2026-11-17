'use strict';
// The configured reserve a bot buys from, shared by main and cold workers: the
// city stores' shot lines and their gear lines marked `reserve`
// (ProductionPolicy.allowsFixed). No live World or database dependency:
// selection and execution read the same configured rows.
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const Production = require('./ProductionPolicy');
const SHOT_IDS = [...Production.NO_GRADE_SHOTS, ...Production.GRADED_SHOTS];
const EMPTY_OFFERS = Object.freeze([]);
let fixedRate = null, fixedMultiplier = null, fixedConfig = null, fixedRows = null, fixedByItem = new Map(), fixedLowest = new Map();
// Builds the table once per config, Adena rate and progression multiplier; false
// while the switch removes the reserve.
function built() {
    if (Production.shotsDisabled()) return false;
    const rate = invoke('GameServer/Bot/Economy/BotEconomyPricing').economyRate();
    const multiplier = invoke('GameServer/ProgressionRates').profile().multiplier;
    const stores = invoke('GameServer/Bot/MerchantStoreConfigs');
    if (!fixedRows || fixedRate !== rate || fixedMultiplier !== multiplier || fixedConfig !== stores) {
        fixedRate = rate; fixedMultiplier = multiplier; fixedConfig = stores;
        fixedByItem = new Map();
        fixedLowest = new Map();
        const rows = [], Pricing = require('./StaticMerchantPricing');
        const items = invoke('GameServer/DataCache').items;
        const reserveIds = Object.values(stores).flatMap(store => (store.items || [])
            .filter(line => line.reserve === true).map(line => Number(line.selfId)));
        for (const id of new Set([...SHOT_IDS, ...reserveIds])) {
            const itemName = ItemTemplateIndex.find(items, id)?.template?.name || `Item ${id}`;
            const sources = Pricing.sellersOf(id)
                .filter(row => Number(row.price) > 0 && Production.allowsFixed({ selfId: id, reserve: row.reserve }))
                .map(row => {
                    const store = stores[row.sourceName];
                    return Object.freeze({ ...row, sourceType: 'configured_store', sourceId: row.sourceName,
                        sellerKind: 'fixed', selfId: id, itemName, count: Infinity, available: true,
                        locX: Number(store?.locX || 0), locY: Number(store?.locY || 0), locZ: Number(store?.locZ || 0) });
                });
            fixedByItem.set(id, Object.freeze(sources));
            if (sources.length) fixedLowest.set(id, Math.min(...sources.map(row => Number(row.price))));
            rows.push(...sources);
        }
        fixedRows = Object.freeze(rows);
    }
    return true;
}
function offers(selfId = null) {
    if (!built()) return EMPTY_OFFERS;
    return selfId === null ? fixedRows : fixedByItem.get(Number(selfId)) || EMPTY_OFFERS;
}
// The lowest price a bot pays for an item at the configured stores (Infinity: none).
function lowestPrice(selfId) {
    return built() ? fixedLowest.get(Number(selfId)) ?? Infinity : Infinity;
}
module.exports = { offers, lowestPrice };
