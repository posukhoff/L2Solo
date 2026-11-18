'use strict';

// The configured city stores are a priced reserve alongside public crafters: a
// store line sells a bot its shots, and the gear lines it marks `reserve` (a
// limited lot of the same item stays the player's). The optional disable switch
// removes that whole reserve and NPC graded shots; ordinary NPC non-shot stock
// remains available. Purchases and prices read the same policy through
// OfferQuery.sourceAllowed, FixedShotOffers and TradeService.buyFromStore.
const NO_GRADE_SHOTS = new Set([1835, 2509, 3947]);
const GRADED_SHOTS = new Set([1463, 1464, 1465, 1466, 1467, 2510, 2511, 2512, 2513, 2514, 3948, 3949, 3950, 3951, 3952]);
const config = () => invoke('GameServer/Bot/Population/PopulationConfig');
function buyersDisabled() { return config().staticBuyersDisabled === true; }
function shotsDisabled() { return config().staticShotsDisabled === true; }
// A valve row (`valve`: its grade) sells a buyer VALVE_PIECES pieces of that grade
// over its life, counted in its stats.valveGear ({ C, B, A }); our rule, bounding
// the worst wait for a crafter's line without taking the crafters' trade.
const VALVE_PIECES = 1;
// The units of a line a buyer may still take: a valve row's remaining pieces, else
// Infinity (without a buyer: a quote, Infinity).
function valveAllowance(line, buyer = null) {
    if (!line?.valve || !buyer) return Infinity;
    return Math.max(0, VALVE_PIECES - Number(buyer.stats?.valveGear?.[line.valve] || 0));
}
// The stats patch a purchase of `units` from a line writes (null: none counted).
function valvePatch(line, buyer, units) {
    if (!line?.valve) return null;
    const counted = buyer?.stats?.valveGear || {};
    return { valveGear: { ...counted, [line.valve]: Number(counted[line.valve] || 0) + Number(units) } };
}
// line: a configured store line or an offer of one ({ selfId, reserve, buyerClasses, valve }).
// A line naming buyerClasses sells only to a buyer (a bot's state or actor) of one
// of those classes; without a buyer it is refused. A valve row refuses a buyer
// whose pieces of its grade are used up.
function allowsFixed(line, buyer = null) {
    const id = Number(line?.selfId);
    if (Array.isArray(line?.buyerClasses)
        && !line.buyerClasses.includes(Number(invoke('GameServer/Bot/AI/BotRoles').classIdOf(buyer)))) return false;
    if (!(valveAllowance(line, buyer) > 0)) return false;
    return !shotsDisabled() && (NO_GRADE_SHOTS.has(id) || GRADED_SHOTS.has(id) || line?.reserve === true);
}
function allowsNpcShot(id) { return !shotsDisabled() || !GRADED_SHOTS.has(Number(id)); }
module.exports = { buyersDisabled, shotsDisabled, allowsFixed, valveAllowance, valvePatch, allowsNpcShot, NO_GRADE_SHOTS, GRADED_SHOTS };
