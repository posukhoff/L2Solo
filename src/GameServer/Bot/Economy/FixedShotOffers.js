'use strict';
// Shared authored shot supply for main and cold workers. No live World or
// database dependency: selection and execution read the same configured rows.
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const Production = require('./ProductionPolicy');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const EMPTY_OFFERS = Object.freeze([]);
let fixedRate = null, fixedConfig = null, fixedRows = null, fixedByItem = new Map();
// Every configured shot merchant row (selfId null) or those of one item;
// EMPTY_OFFERS at once for an item that is no fixed-price shot
// (ProductionPolicy.allowsFixedShot), before the rate and store reads.
function offers(selfId = null) {
    if (selfId === null ? Production.shotsDisabled() : !Production.allowsFixedShot(selfId)) return EMPTY_OFFERS;
    const rate = invoke('GameServer/Bot/Economy/BotEconomyPricing').economyRate();
    const stores = invoke('GameServer/Bot/MerchantStoreConfigs');
    if (!fixedRows || fixedRate !== rate || fixedConfig !== stores) {
        fixedRate = rate; fixedConfig = stores;
        fixedByItem = new Map();
        const rows = [], Pricing = require('./StaticMerchantPricing');
        const items = invoke('GameServer/DataCache').items;
        for (const id of ShotStock.SHOP_SHOT_RANK.keys()) {
            const itemName = ItemTemplateIndex.find(items, id)?.template?.name || `Item ${id}`;
            const sources = Pricing.sellersOf(id).filter(row => Number(row.price) > 0).map(row => {
                const store = stores[row.sourceName];
                return Object.freeze({ ...row, sourceType: 'configured_store', sourceId: row.sourceName,
                    sellerKind: 'fixed', selfId: id, itemName, count: Infinity, available: true,
                    locX: Number(store?.locX || 0), locY: Number(store?.locY || 0), locZ: Number(store?.locZ || 0) });
            });
            fixedByItem.set(id, Object.freeze(sources));
            rows.push(...sources);
        }
        fixedRows = Object.freeze(rows);
    }
    return selfId === null ? fixedRows : fixedByItem.get(Number(selfId)) || EMPTY_OFFERS;
}
// The NPC part of what sells item `selfId` at a fixed price: the caller's
// thread's NPC shop list (npcOffersFor: ColdOccupationSources.npcOffersFor in
// the wish builds, the raid quote and the craft purchases (preparePurchase,
// ColdWealthCraftService and ColdShotEconomyService rechecks),
// MarketOpportunity.npcOffersAll in main's purchase); no graded shot is on
// any NPC list (NpcShopBuyLists.allowedEntry). The list as the reader hands it
// out (its frozen arrays stay the same object); EMPTY_OFFERS for none.
function npcOffers(selfId, npcOffersFor) {
    if (!npcOffersFor) return EMPTY_OFFERS;
    return npcOffersFor(Number(selfId)) || EMPTY_OFFERS;
}
// Everything that sells item `selfId` at a fixed price in each town: the NPC
// shops (npcOffers) and the configured shot merchants until 3.6 (offers);
// their stock never runs out for a bot. A new array the caller may keep.
// Read by the raid quote (RaidSupplyPolicy.shotQuote) and main's purchase
// (ColdMarketService.planPurchase, buyHere, finishTownErrands); the wish
// builds read the two parts apart (WishPurchaseEvidence.reader).
function staticOffers(selfId, npcOffersFor) {
    return [...npcOffers(selfId, npcOffersFor), ...offers(selfId)];
}
module.exports = { offers, npcOffers, staticOffers };
