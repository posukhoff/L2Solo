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
// buyer (a bot's state or actor): only the rows it may buy (ProductionPolicy.allowsFixed:
// a row naming buyerClasses); none: every row (quotes and prices).
function offers(selfId = null, buyer = undefined) {
    if (!built()) return EMPTY_OFFERS;
    const rows = selfId === null ? fixedRows : fixedByItem.get(Number(selfId)) || EMPTY_OFFERS;
    return buyer === undefined || !rows.some(row => row.buyerClasses) ? rows
        : rows.filter(row => Production.allowsFixed(row, buyer));
}
// A row's server stock (hourlyStock): the units it sells a game hour, refilled each
// full hour and held at most STOCK_HOURS hours' worth; in memory on the thread that
// executes the purchase (main), from one hour's worth at start. take(selfId, amount)
// grants what the stock holds (an item without hourlyStock: all of it) and counts
// a refusal; restore gives back a grant whose purchase failed. Our rule.
const HOUR_MS = 3600000, STOCK_HOURS = 2;
const stocks = new Map();
function stockOf(selfId, now) {
    const cap = Number(offers(selfId).find(row => row.hourlyStock > 0)?.hourlyStock || 0);
    if (!cap) return null;
    let stock = stocks.get(selfId);
    if (!stock) stocks.set(selfId, stock = { units: cap, at: now, refused: 0 });
    const hours = Math.floor((now - stock.at) / HOUR_MS);
    if (hours > 0) {
        stock.units = Math.min(cap * STOCK_HOURS, stock.units + hours * cap);
        stock.at += hours * HOUR_MS;
    }
    return stock;
}
function take(selfId, amount, now = Date.now()) {
    const id = Number(selfId), wanted = Math.max(0, Math.floor(Number(amount) || 0));
    const stock = stockOf(id, now);
    if (!stock) return wanted;
    const granted = Math.min(wanted, stock.units);
    stock.units -= granted;
    if (granted < wanted) {
        stock.refused += wanted - granted;
        const Diagnostics = require('./EconomyDiagnostics');
        if (Diagnostics.active()) Diagnostics.count('fixed_stock', 'refused', String(id));
    }
    return granted;
}
function restore(selfId, amount, now = Date.now()) {
    const stock = stockOf(Number(selfId), now);
    if (stock) stock.units += Math.max(0, Math.floor(Number(amount) || 0));
}
// The units refused so far for lack of stock (diagnostics, tests).
function refused(selfId) {
    return Number(stocks.get(Number(selfId))?.refused || 0);
}
// The lowest price a bot pays for an item at the configured stores (Infinity: none).
function lowestPrice(selfId) {
    return built() ? fixedLowest.get(Number(selfId)) ?? Infinity : Infinity;
}
module.exports = { offers, lowestPrice, take, restore, refused };
