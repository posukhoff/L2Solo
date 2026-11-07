const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const StaticMerchantPricing = invoke('GameServer/Bot/Economy/StaticMerchantPricing');
const MarketTelemetry = invoke('GameServer/Bot/Economy/MarketTelemetry');

// Fixed buy stores are an intentionally unlimited Adena source for the
// background economy. Only materials and drop resources they explicitly ask
// for go through this path; equipment still has a chance to reach players via
// a private store. The buyers and their prices are StaticMerchantPricing's
// one index (fixedBuyersOf); what the bag carries to them is its rule
// (carriedToBuyer), the same one that kept the item out of the NPC sale.

// Every carried sale candidate with its best buyer per town, in the index's
// (config) order: [{ item, offers: Map town -> best offer }].
function carried(state) {
    return ItemDisposition.saleCandidates(state, { unlimited: true }).flatMap((item) => {
        if (!StaticMerchantPricing.carriedToBuyer(state, item.selfId)) return [];
        const offers = new Map();
        for (const offer of StaticMerchantPricing.fixedBuyersOf(item.selfId))
            if (!(offers.get(offer.town)?.price >= offer.price)) offers.set(offer.town, offer);
        return [{ item, offers }];
    });
}

function inTown(rows, town) {
    return rows.flatMap(({ item, offers }) => {
        const offer = offers.get(town);
        const count = Math.min(Number(item.count || 0), Number(offer?.count || 0));
        return count > 0 ? [{ ...item, count, npcPrice: offer.price, buyerName: offer.buyerName, buyerTown: town }] : [];
    });
}

function candidatesFor(state, town) {
    return inTown(carried(state), town);
}

// The town whose fixed buyers pay the carried bag most (ties: the nearer
// buyer, then the index order): { town, candidates, value, distance } or null.
function bestTownFor(state) {
    const origin = state?.stats?.marketReturn?.loc || state?.loc || {};
    const hasOrigin = Number.isFinite(Number(origin.locX)) && Number.isFinite(Number(origin.locY))
        && (Number(origin.locX) !== 0 || Number(origin.locY) !== 0);
    const rows = carried(state);
    const distance = new Map();
    for (const { offers } of rows) for (const offer of offers.values()) distance.set(offer.town, Math.min(
        distance.get(offer.town) ?? Infinity,
        hasOrigin ? Math.hypot(Number(origin.locX) - offer.locX, Number(origin.locY) - offer.locY) : Infinity));
    return [...distance].map(([town, near], order) => {
        const candidates = inTown(rows, town);
        return { town, order, candidates, distance: near,
            value: candidates.reduce((sum, item) => sum + Number(item.count || 0) * Number(item.npcPrice || 0), 0) };
    }).filter((result) => result.value > 0)
        .sort((left, right) => right.value - left.value || left.distance - right.distance || left.order - right.order)[0] || null;
}

function sell(state, town) {
    const candidates = candidatesFor(state, town);
    if (!candidates.length) return Promise.resolve({ state, sold: false, candidates: [] });
    const itemCount = candidates.reduce((sum, item) => sum + Number(item.count || 0), 0);
    const adena = candidates.reduce((sum, item) => sum + Number(item.count || 0) * Number(item.npcPrice || 0), 0);
    return LifeState.applyNpcLiquidation(state, candidates, {
        source: 'static_buyer',
        town,
        buyers: [...new Set(candidates.map((item) => item.buyerName))]
    }).then((saved) => {
        if (saved) MarketTelemetry.staticBuyerSale(candidates, adena, {
            sellerCharacterId: state.characterId,
            sellerName: state.name,
            town
        });
        return { state: saved || state, sold: !!saved, candidates, itemCount, adena };
    });
}

module.exports = { bestTownFor, candidatesFor, sell };
