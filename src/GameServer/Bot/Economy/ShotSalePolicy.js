'use strict';
const History = require('./MarketDemand');
const Price = require('./PriceDecision');
const Belief = require('./PriceBelief');
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');

// The producer's read of an item's demand in a town (MarketDemand.forecast):
// its own error, less the units rivals' plans in flight commit to the
// listing there (a producer read: these exits size goods to make).
function demandOf(state, id, town, board, timestamp, persona = BotPersona.of(state)) {
    return persona ? History.forecast(id, town, timestamp, { characterId: Number(state.characterId),
        understanding: persona.understanding, marketTrades: state.marketTrades || {}, board,
        producer: Number(state.characterId) }) : null;
}
// Production and native rechecks share the seller's ordinary price decision
// and the bot's read of the item's demand. No accepted buyer is invented
// here. demand: the read exits() already made for this town (a quantity
// search reprices one read, it does not read the census again).
function exit(state, id, { board, town, timestamp = Date.now(), trip, npcOffers = [], units, lot = 1, reserve = 0,
    productionUnits = null, current = 0, demand: read = undefined } = {}) {
    const persona = BotPersona.of(state);
    if (!persona) return null;
    const reader = { characterId: Number(state.characterId), understanding: persona.understanding,
        marketTrades: state.marketTrades || {} };
    const demand = read === undefined ? demandOf(state, id, town, board, timestamp, persona) : read;
    if (!demand || !trip?.details?.(town)?.known) return null;
    const belief = Belief.prior(id, { board, timestamp, ...reader });
    if (!belief) return null;
    const trader = Price.traderOf(persona);
    const pricedUnits = productionUnits === null ? units
        : Math.max(0, units - lot) + Math.max(0, productionUnits - Math.max(0, Number(reserve) || 0));
    const market = Price.marketFor(id, { board, ownerId: state.characterId, town, tripCost: trip,
        npcOffers, timestamp, demand, units: pricedUnits });
    const ask = Price.chooseAsk(belief, market, trader, ['shot-production', state.characterId, id, demand.authority.revision], current);
    if (!ask.known || ask.npc || !(ask.sold > 0)) return null;
    const landed = ask.price + market.ownTrip;
    const cheaperUnits = market.rivals.reduce((sum, rival) => sum + (rival.landed < landed ? rival.units : 0), 0);
    const willingUnits = Price.willingUnitsAt(belief, trader, { price: ask.price,
        applicableUnits: demand.applicableUnits, landed, npcLanded: market.npcLanded });
    const remaining = Math.max(0, Math.min(demand.applicableUnits, willingUnits) - cheaperUnits - Math.max(0, units - lot));
    if (!(remaining > 0) || !Number.isSafeInteger(lot) || lot < 1) return null;
    return { type: 'listing', town, price: ask.price, count: demand.applicableUnits,
        applicableUnits: demand.applicableUnits, willingUnits, cheaperUnits,
        maxBatches: Math.ceil((remaining + Math.max(0, Number(reserve) || 0)) / lot),
        residualUnitValue: market.buyback, delayHours: demand.delayHours,
        forecast: demand, trip: trip(town), tripDetails: trip.details(town) };
}
function* exits(state, recipe, { board, timestamp, trip, prepareTrip, npcOffersFor, read = () => {}, existing = 0, reserve = 0 } = {}) {
    const id = Number(recipe.productId);
    read(id);
    const result = [];
    for (const town of History.towns(id, timestamp)) {
        if (prepareTrip) yield* prepareTrip(town);
        yield 'trip';
        const terms = { board, town, timestamp, trip,
            npcOffers: npcOffersFor?.(id) || [], lot: Number(recipe.productCount), reserve,
            units: Number(recipe.productCount) + Math.max(0, Number(existing) || 0),
            demand: demandOf(state, id, town, board, timestamp) };
        const value = exit(state, id, terms);
        if (value) {
            // A larger lot may need a lower ask to reach its observed buyers.
            // This local adapter never enters the worker command; only the
            // selected price, quantity and public forecast revision do.
            Object.defineProperty(value, 'forQuantity', { value: batches => exit(state, id,
                { ...terms, productionUnits: batches * Number(recipe.productCount) }) });
            result.push(value);
        }
        yield 'exit';
    }
    return result;
}
module.exports = { exit, exits };
