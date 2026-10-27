const ShotStock = invoke('GameServer/Inventory/ShotStock');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');

const WANTED_TTL_MS = 30 * 60 * 1000;

function timestampForWanted(wanted = {}) {
    const value = wanted || {};
    return Math.max(Number(value.lastMissingAt || 0), Number(value.lastTradeAdAt || 0));
}

// A shot user below its survival floor (EconomyContext.stockTargets: [potion,
// its target, shot, its target, shots held then, survival target, unit
// price]): the shots up to its target and their price, the most it spends;
// null at or above the floor. Held counts beginner shots too, as the stock does.
function shotsShort(state, selfId) {
    const row = state?.stats?.stockTargets;
    if (!Array.isArray(row) || row.length !== 7 || !(Number(row[2]) > 0) || Number(selfId) !== Number(row[2])) return null;
    const physical = Math.max(0, Number(state.inventory?.[row[2]]?.amount) || 0);
    if (physical >= Number(row[5])) return null;
    const held = physical + ShotStock.beginnerAmount(state);
    if (!(held < Number(row[5]))) return null;
    const amount = Math.max(1, Math.floor(Number(row[3]) || 0) - held);
    return { amount, maxSpend: amount * Math.max(0, Number(row[6]) || 0) };
}
function demandSignal(state, selfId, timestamp) {
    if (!state || Number(state.characterId || 0) <= 0) return null;
    const wanted = state.stats?.marketWanted;
    const recipeWanted = state.stats?.shotRecipeDemand;
    const plan = state.stats?.equipmentPlan;
    const wantedAt = timestampForWanted(wanted);
    const recentWanted = Number(wanted?.itemId || 0) === Number(selfId)
        && wantedAt > 0
        && wantedAt + WANTED_TTL_MS > timestamp;
    const recentRecipe = Number(recipeWanted?.itemId || 0) === Number(selfId)
        && Number(recipeWanted?.at || 0) + WANTED_TTL_MS > timestamp;
    const short = recentWanted || recentRecipe ? null : shotsShort(state, selfId);
    // Only 'active', not planRunning: a craft plan whose components are in hand
    // (component_ready, ready_to_craft) makes its target, it no longer buys it.
    const activeTarget = plan?.status === 'active'
        && Number(plan.target?.selfId || 0) === Number(selfId);
    const material = GearAcquisitionPlanner.planRunning(plan)
        ? (plan.materials || []).find((item) => Number(item.selfId) === Number(selfId) && Number(item.missing || 0) > 0)
        : null;

    if (!recentWanted && !recentRecipe && !short && !activeTarget && !material) return null;
    const ready = recentWanted || recentRecipe || !!short
        || (activeTarget && plan.strategy === 'market');
    const economicWanted = recentRecipe ? recipeWanted : short;
    return {
        characterId: Number(state.characterId),
        origin: 'own_need', scope: 'own', observedAt: timestamp,
        authority: { ownerId: Number(state.characterId), updatedAt: Number(state.updatedAt || 0) },
        selfId: Number(selfId), enchant: 0,
        needId: economicWanted?.needId || `own:${state.characterId}:${recentRecipe ? `recipe:${selfId}`
            : short ? 'charge' : material ? `material:${selfId}` : `item:${selfId}`}`,
        availability: { from: timestamp, until: recentRecipe ? Number(recipeWanted.at) + WANTED_TTL_MS
            : recentWanted ? wantedAt + WANTED_TTL_MS : timestamp },
        name: state.name || null,
        town: state.currentRegion || null,
        amount: Math.max(1, Number(economicWanted?.amount || (recentWanted ? wanted?.amount : material?.missing) || 1)),
        budget: Math.max(0, Math.min(Number(state.adena || 0), economicWanted?.maxSpend === undefined
            ? Infinity : Number(economicWanted.maxSpend))),
        ready,
        source: recentRecipe ? 'shot_recipe' : recentWanted ? 'wanted' : short ? 'shots'
            : material ? 'craft' : plan.strategy === 'market' ? 'market_plan' : 'progression_plan'
    };
}

// Private wants remain an own/group planning API. Seller projections never
// call it on foreign states or read their wallets. No allStates fallback.
function signalsOfState(state, timestamp = Date.now()) {
    const ids = new Set([Number(state?.stats?.marketWanted?.itemId || 0), Number(state?.stats?.shotRecipeDemand?.itemId || 0),
        Number(state?.stats?.stockTargets?.[2] || 0),
        Number(state?.stats?.equipmentPlan?.target?.selfId || 0)]);
    for (const row of state?.stats?.equipmentPlan?.materials || []) ids.add(Number(row.selfId));
    const entries = [];
    for (const selfId of ids) {
        if (!(selfId > 0)) continue;
        const signal = demandSignal(state, selfId, timestamp);
        if (signal) entries.push([selfId, signal]);
    }
    return entries;
}

module.exports = { WANTED_TTL_MS, demandSignal, signalsOfState, timestampForWanted };
