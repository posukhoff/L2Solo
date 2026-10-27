const OfferOrder = require('../Economy/OfferOrder');
const OfferQuery = require('../Economy/OfferQuery');
const { offerAdmission } = require('./PartyAdmission');
const BotGear = invoke('GameServer/Bot/AI/BotGear');

const LOW_TIER_RANKS = new Set(['none', 'd']);
const EMPTY_OFFERS = Object.freeze([]);

function equipmentItemIds(items = []) {
    return new Set(BotGear.currentWearableRows(items)
        .filter((item) => LOW_TIER_RANKS.has(String(item?.etc?.rank || 'none').toLowerCase()))
        .map((item) => Number(item.selfId || 0))
        .filter(Boolean));
}

function buildRows(options = {}) {
    const allowedItems = equipmentItemIds(options.items || []);
    const fetchForNpc = typeof options.fetchForNpc === 'function'
        ? options.fetchForNpc
        : () => [];
    const offers = new Map();

    Object.entries(options.townNpcSellers || {}).forEach(([town, npcIds]) => {
        (npcIds || []).forEach((npcSelfId) => {
            (fetchForNpc(npcSelfId) || []).forEach((entry) => {
                const selfId = Number(entry?.selfId || 0);
                const price = Number(entry?.price || 0);
                if (!allowedItems.has(selfId) || price <= 0) return;
                const key = `${town}:${selfId}`;
                const existing = offers.get(key);
                if (existing && (existing.price < price
                    || existing.price === price && existing.sourceId <= Number(npcSelfId))) return;
                offers.set(key, {
                    sourceType: 'npc',
                    sourceId: Number(npcSelfId),
                    town: String(town),
                    selfId,
                    price,
                    available: true
                });
            });
        });
    });

    return Object.freeze([...offers.values()]
        .sort((left, right) => Number(left.selfId) - Number(right.selfId)
            || Number(left.price) - Number(right.price)
            || String(left.town).localeCompare(String(right.town))
            || Number(left.sourceId) - Number(right.sourceId))
        .map((offer) => Object.freeze(offer)));
}

// The cold planner's offers: the NPC rows (none and D-grade gear, buildRows)
// and the board, read from `board()` (the worker's BoardIndex, null while its
// table is not whole). Both in the one order of OfferOrder with the bot's trip.
function createLookup(rows = [], board = () => null) {
    const offersByItem = new Map();
    (rows || []).forEach((row) => {
        const selfId = Number(row?.selfId || 0);
        const price = Number(row?.price || 0);
        if (!selfId || price <= 0 || row?.sourceType !== 'npc' || !row?.town) return;
        const offer = Object.freeze({
            sourceType: 'npc',
            sourceId: Number(row.sourceId || 0),
            town: String(row.town),
            selfId,
            price,
            available: true
        });
        if (!offersByItem.has(selfId)) offersByItem.set(selfId, []);
        offersByItem.get(selfId).push(offer);
    });
    offersByItem.forEach((offers, selfId) => {
        offersByItem.set(selfId, Object.freeze(offers.sort((left, right) => (
            Number(left.price) - Number(right.price)
            || String(left.town).localeCompare(String(right.town))
            || Number(left.sourceId) - Number(right.sourceId)
        ))));
    });

    const offersFor = (target) => offersByItem.get(Number(target?.selfId ?? target)) || EMPTY_OFFERS;
    const bestOffer = (target, state, origin) => OfferQuery.bestSellOffer(null, Number(target?.selfId ?? target),
        { cost: OfferOrder.tripCost(state, { origin }), others: offersFor(target) });
    // The worker gear planner's offer search: the one buyer's search
    // (OfferQuery.bestBuyerOffer) over the board and the NPC offers in every
    // town, admitted as the worker's MarketOpportunity (party rule) and never
    // a line whose meeting this bot was refused. A board line at price 0 is
    // no purchase (GearAcquisitionPlanner: usable).
    const findMarketOffer = (target, state, origin) => OfferQuery.bestBuyerOffer(board(), Number(target?.selfId ?? target), {
        buyerCharacterId: state?.characterId,
        cost: OfferOrder.tripCost(state, { origin }),
        accept: (offer) => Number(offer.price) > 0
    }, { buyerState: state, allowed: offerAdmission(state), others: () => offersFor(target) });
    const plannerOptions = Object.freeze({
        findNpcOffer: bestOffer,
        findMarketOffer
    });

    return Object.freeze({
        itemCount: offersByItem.size,
        offerCount: [...offersByItem.values()].reduce((sum, offers) => sum + offers.length, 0),
        offersFor,
        bestOffer,
        findMarketOffer,
        plannerOptions
    });
}

module.exports = { buildRows, createLookup };
