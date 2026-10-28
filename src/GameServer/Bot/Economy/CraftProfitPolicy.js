'use strict';
const RecipeCatalog = require('../../Knowledge/RecipeCatalog');

function successProbability(recipe) {
    const rate = Number(recipe?.successRate);
    return Number.isFinite(rate) && rate >= 0 && rate <= 100 ? rate / 100 : NaN;
}
// MP hours of any batch count (the 64-batch bound is per command: craftFacts perCommand).
function mpHours(recipe, batches = 1, { mpPerHour } = {}) {
    const mp = Number(recipe?.mpCost ?? 0);
    if (!Number.isFinite(mp) || mp < 0 || !Number.isSafeInteger(batches) || batches < 0) return null;
    if (!mp || !batches) return 0;
    return Number.isFinite(mpPerHour) && mpPerHour > 0 ? mp * batches / mpPerHour : null;
}
// The batches an MP pool pays for, at most one command's 64 (a recipe with no
// MP cost: 64). The one MP bound of a craft: the craft facts (perCommand), a
// basket's quantity search (WealthCraftPolicy), a workshop's published
// capacity (CraftWorkshopService) and a plan's own or workshop craft
// (ColdCraftingService).
function mpBatches(mp, recipe) {
    const cost = Number(recipe?.mpCost || 0);
    return cost > 0 ? Math.min(64, Math.floor(Math.max(0, Number(mp) || 0) / cost)) : 64;
}
// The labour of one craft: its MP hours at the crafter's seated recovery and
// their worth at the crafter's hour (null: MP rate unknown). A workshop's fee
// (TwinCluster) is this labour.
function labour(recipe, { hourAdena, mpPerHour } = {}) {
    const hours = mpHours(recipe, 1, { mpPerHour });
    return hours === null ? null : { hours, adena: hours * Number(hourAdena || 0) };
}

// A scroll to find, bought at `price` for one lot that nets `lotNet` over its
// inputs: the learned recipe keeps for later crafts its shared worth
// (DemandPrice.recipeWorth: its share of the world's unmet crafts) past this
// lot, the bot's own value of no recipe (decisions 10-28); the lot carries
// the part of the price that worth does not cover, so a scroll dearer than
// its worth nets below the lot alone. O(1).
function learning(price, worth, lotNet) {
    const paid = Math.max(0, Number(price) || 0);
    const kept = Math.max(0, (Number(worth) || 0) - Math.max(0, Number(lotNet) || 0));
    return { kept, carried: Math.max(0, paid - kept) };
}
function contextFor(state, timestamp = Date.now()) {
    const context = require('../Population/ColdEconomyDecision').economyFor(state, { timestamp });
    return { ...context, ...invoke('GameServer/Bot/Population/ColdOccupationSources').craftLabour(state, timestamp) };
}
function tripFor(state, options = {}) { return invoke('GameServer/Bot/Economy/EconomicTrip').reader(state, options); }
function requirements(recipe, batches = 1) {
    if (!Number.isSafeInteger(batches) || batches < 1 || batches > 64) return null;
    const prepared = RecipeCatalog.inputsFor(recipe);
    if (prepared) {
        const required = new Map();
        let safe = true;
        for (const input of prepared.ingredients) {
            const amount = input.quantity * batches;
            if (!Number.isSafeInteger(amount)) { safe = false; break; }
            required.set(input.selfId, amount);
        }
        if (safe) return required;
    }
    const required = new Map();
    for (const input of recipe?.materials || []) {
        const id = Number(input.selfId), amount = Number(input.amount) * batches;
        if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(amount) || amount < 1) return null;
        const total = Number(required.get(id) || 0) + amount;
        if (!Number.isSafeInteger(total)) return null;
        required.set(id, total);
    }
    return required;
}
function batchesFor(recipe, output) {
    const count = Number(recipe?.productCount || 1);
    if (!Number.isSafeInteger(output) || output < 0 || !Number.isSafeInteger(count) || count <= 0) return null;
    const batches = Math.ceil(output / count);
    return Number.isSafeInteger(batches) ? batches : null;
}
// Native finite facts of one recipe for `output` units or `batches`, read by
// the wish network and by the producer alike. Gross requirements only: the
// Core quantity reader subtracts stock, incoming and commitments once.
// A cold own craft makes one draw per command of up to 64 batches bounded by
// MP (Database.craftInventoryItems); a hot bot crafts one batch per command
// (HotWealthCraftService); a workshop command is bounded by its capacity
// (Database.craftForCustomer). A failed draw consumes every input of its command.
// A recipe scroll learned for this decision is consumed once, never per batch.
function* prepareCraftFacts(recipe, { output, batches, executor = 'cold', mpCapacity = Infinity, capacityBatches,
    mpPerHour, recipeInput = 0, fee = 0 } = {}) {
    const probability = successProbability(recipe);
    if (!recipe || !Number.isFinite(probability)) return { status: 'unknown', reason: 'recipe' };
    const productCount = Number(recipe.productCount || 1);
    const count = batches ?? batchesFor(recipe, output);
    if (!Number.isSafeInteger(count) || count < 0) return { status: 'unknown', reason: 'quantity' };
    const mpCost = Math.max(0, Number(recipe.mpCost || 0));
    const bound = executor === 'hot' ? 1 : executor === 'workshop' ? Number(capacityBatches)
        : mpBatches(mpCapacity, recipe);
    const perCommand = Math.min(64, bound);
    if (!(perCommand >= 1)) return { status: 'unknown', reason: executor === 'workshop' ? 'capacity' : 'mp_capacity' };
    const gross = new Map(), once = new Set();
    const entry = Number(recipeInput || 0);
    if (entry > 0) { gross.set(entry, 1); once.add(entry); }
    const prepared = RecipeCatalog.preparedInputsFor(recipe);
    let rows = 0;
    for (const input of recipe.materials || []) {
        // Keep the native row order, yields and overflow reason. A mutation
        // between generator steps also falls back to the current raw input.
        const normalized = prepared?.entries[rows];
        const same = normalized && input === normalized.input && input.selfId === normalized.selfId && input.amount === normalized.amount;
        const id = same ? normalized.selfId : Number(input.selfId);
        const amount = (same ? normalized.amount : Number(input.amount)) * count;
        if (!Number.isSafeInteger(id) || id < 1 || !(same ? normalized.amount > 0 : Number(input.amount) > 0) || !Number.isSafeInteger(amount))
            return { status: 'unknown', reason: 'recipe' };
        const total = Number(gross.get(id) || 0) + amount;
        if (!Number.isSafeInteger(total)) return { status: 'unknown', reason: 'quantity' };
        gross.set(id, total); rows++;
        yield 'ingredient';
    }
    const mp = mpCost * count;
    // Own MP is labour; a workshop crafter spends his own MP for the fee.
    const labourHours = executor === 'workshop' ? 0 : mpHours(recipe, count, { mpPerHour }) ?? NaN;
    const cash = Math.max(0, Number(fee) || 0) * count;
    // Unknown labour keeps the quantities for readers that need no hours.
    return { ...(Number.isFinite(labourHours) ? { status: 'ready' } : { status: 'unknown', reason: 'mp_regen' }), recipeId: Number(recipe.recipeId), productCount, batches: count, output: count * productCount,
        perCommand, draws: Math.ceil(count / perCommand), successProbability: probability, gross, once, mp, labourHours,
        fee: cash, feeOnFailure: cash > 0, rows };
}
function craftFacts(recipe, options) {
    const steps = prepareCraftFacts(recipe, options);
    let step;
    do { step = steps.next(); } while (!step.done);
    return step.value;
}
function craftableBatches(items, recipe, requested = 1) {
    const required = requirements(recipe), amounts = new Map(), seen = new Set();
    if (!required || !Number.isSafeInteger(requested) || requested < 1) return 0;
    for (const item of items || []) {
        const identity = Number.isSafeInteger(Number(item.id)) && Number(item.id) > 0 ? Number(item.id) : item;
        if (item.equipped || item.protected || !required.has(Number(item.selfId)) || seen.has(identity)) continue;
        seen.add(identity);
        amounts.set(Number(item.selfId), (amounts.get(Number(item.selfId)) || 0) + Number(item.amount || 0));
    }
    let count = requested;
    for (const [id, amount] of required) count = Math.min(count, Math.floor((amounts.get(id) || 0) / amount));
    return count;
}
function materials(items, recipe, batches = 1) {
    const required = requirements(recipe, batches);
    if (!required) return null;
    const byItem = new Map(), physical = new Set();
    for (const item of items || []) {
        const id = Number(item.id), selfId = Number(item.selfId), amount = Number(item.amount);
        if (item.equipped || item.protected || !required.has(selfId)) continue;
        if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(amount) || amount < 0) return null;
        if (physical.has(id)) continue;
        physical.add(id);
        if (!byItem.has(selfId)) byItem.set(selfId, []);
        byItem.get(selfId).push(item);
    }
    const result = [];
    for (const [selfId, amount] of required) {
        let missing = amount;
        for (const item of byItem.get(selfId) || []) {
            if (missing <= 0) break;
            const taken = Math.min(missing, Number(item.amount || 0));
            if (taken > 0) result.push({ id: Number(item.id), selfId, amount: taken });
            missing -= taken;
        }
        if (missing > 0) return null;
    }
    return result;
}

function succeeds(recipe, random = Math.random) {
    return Number(recipe.successRate) >= 100 || Number(random()) * 100 < Number(recipe.successRate);
}
module.exports = { prepareCraftFacts, craftFacts, requirements, batchesFor, craftableBatches, labour, learning, contextFor, tripFor, materials, succeeds,
    mpHours, mpBatches };
