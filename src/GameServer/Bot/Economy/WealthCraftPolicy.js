'use strict';
const Profit = require('./CraftProfitPolicy');
const { remainingQuantity } = require('./WishNetwork');
const Valuation = require('./EconomicValuation');
const Price = require('./PriceDecision');
const Trip = require('./EconomicTrip');
const MAX_BATCHES = 64;
const count = value => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : NaN;

function* prepareBasket(recipe, planFor, ownedFor = () => null, batches = 1, context = {}) {
    // A known recipe only: a scroll to learn is the producer root's input
    // (WishProviders craftPath), never this basket's.
    const facts = yield* Profit.prepareCraftFacts(recipe, { batches,
        executor: context.executor, mpCapacity: context.mpCapacity, mpPerHour: context.mpPerHour });
    if (facts.status !== 'ready' && facts.reason !== 'mp_regen') return null;
    const required = facts.gross;
    const purchases = [], owned = [], trips = new Map(), allocated = new Map();
    // Input ids this basket already prices (its own, then each component's):
    // set on its first component (componentPlan).
    let claimed = null;
    let cashCost = 0, ownedValue = 0, actualCashFees = 0, travelHours = 0, processingHours = 0,
        extraMp = 0, residualValue = 0;
    for (const [selfId, needed] of required) {
        let missing = needed;
        const stock = ownedFor(selfId) || {};
        const available = count(Math.max(0, Number(stock.count ?? 0) - Number(allocated.get(selfId) || 0)));
        if (!Number.isFinite(available)) return null;
        // The Core quantity reader subtracts held units once, as for a wish.
        const ownCount = needed - remainingQuantity({ required: needed, freePhysical: available }).toOrder;
        if (ownCount) {
            const unitValue = Number(stock.unitValue);
            if (!Number.isFinite(unitValue) || unitValue < 0) return null;
            owned.push({ selfId, count: ownCount, unitValue });
            allocated.set(selfId, Number(allocated.get(selfId) || 0) + ownCount);
            ownedValue += ownCount * unitValue;
            missing -= ownCount;
        }
        yield 'owned';
        if (!missing) continue;
        const quote = context.preparePurchase ? yield* context.preparePurchase(selfId, missing, { allocated })
            : planFor(selfId, missing);
        if (!context.preparePurchase) yield 'quote';
        // An input nobody sells whole that the crafter makes itself
        // (context.component: WealthCraftDecision.ownComponent) comes from
        // its own basket, crafted first (ColdWealthCraftService.execute).
        const component = !quote?.whole && context.component?.(selfId);
        if (component && !claimed) claimed = new Set(required.keys());
        const plan = component ? yield* componentPlan(component, claimed, selfId, missing, planFor, ownedFor, allocated, context) : quote;
        if (!plan?.whole || Number(plan.units ?? missing) < missing || !Number.isFinite(Number(plan.cost))
            || Number(plan.cost) < 0 || !Number.isFinite(Number(plan.landed))) return null;
        for (const input of plan.ownedInputs || []) {
            const inputId = Number(input.selfId), used = Number(input.count), stock = ownedFor(inputId);
            const total = Number(allocated.get(inputId) || 0) + used;
            if (!Number.isSafeInteger(used) || used <= 0 || total > Number(stock?.count || 0)) return null;
            allocated.set(inputId, total); owned.push({ selfId: inputId, count: used, unitValue: Number(input.unitValue) });
            yield 'owned';
        }
        purchases.push({ selfId, count: missing, town: plan.town, cost: Number(plan.cost),
            landed: Number(plan.landed), lines: plan.lines, npc: plan.npc, npcPrice: plan.npcPrice, source: plan.gear });
        cashCost += Number(plan.cost);
        ownedValue += Number(plan.ownedValue || 0);
        processingHours += Number(plan.processingHours || 0);
        extraMp += Number(plan.extraMp || 0);
        residualValue += Number(plan.residualValue || 0);
        // A component's own trips (componentPlan) join the basket's: one
        // visit per town for both.
        for (const [key, { trip, details }] of plan.tripTowns || [[plan.routeKey ?? plan.town ?? `input:${selfId}`,
            { trip: Math.max(0, Number(plan.landed) - Number(plan.cost)), details: plan.tripDetails || context.trip?.details?.(plan.town) }]]) {
            if (!trips.has(key) || trip > trips.get(key).trip) trips.set(key, { trip, details });
        }
        if (trips.size > 8) return null;
    }
    let tripEquivalent = 0;
    for (const { trip, details } of trips.values()) {
        if (details?.known) {
            actualCashFees += details.fees; travelHours += details.hours;
            tripEquivalent += Trip.price(details, Number(context.hourAdena || 0));
        } else if (!trip) { /* same town */ }
        else if (Number(context.hourAdena) > 0) {
            travelHours += trip / Number(context.hourAdena); tripEquivalent += trip;
        } else return null;
        yield 'trip';
    }
    const cost = cashCost + ownedValue + tripEquivalent;
    return Number.isFinite(cost) ? { purchases, owned, cashCost, ownedValue, actualCashFees, travelHours,
        processingHours, extraMp, residualValue, tripTowns: trips, cost: Math.ceil(cost), batches, facts } : null;
}
// A component made inside a basket, one level deep (its own inputs are bought
// whole or owned): the batches for the missing units, its inputs' cash, its
// trips merged into the parent's (tripTowns), its MP and labour as the
// parent's processing. Shaped as a purchase
// row of prepareBasket (source = { source: 'craft', recipe, batches,
// purchases }); surplus units count for nothing. A component that takes an
// input its parent or a sibling component already prices (claimed) is none:
// both would price the same asks. Its inputs join claimed.
function* componentPlan(recipe, claimed, selfId, missing, planFor, ownedFor, allocated, context) {
    const batches = Math.ceil(missing / Math.max(1, Number(recipe.productCount || 1)));
    if (!Number.isSafeInteger(batches) || batches > MAX_BATCHES) return null;
    if ((recipe.materials || []).some(row => claimed.has(Number(row.selfId)))) return null;
    for (const row of recipe.materials || []) claimed.add(Number(row.selfId));
    const free = id => {
        const stock = ownedFor(id);
        return stock ? { ...stock, count: Math.max(0, Number(stock.count || 0) - Number(allocated.get(Number(id)) || 0)) } : null;
    };
    const inner = yield* ownCraftBasket(recipe, planFor, free, batches, context);
    if (!inner) return null;
    return { whole: true, units: missing, cost: inner.cashCost, landed: inner.cashCost, tripTowns: inner.tripTowns,
        ownedValue: inner.ownedValue, ownedInputs: inner.owned,
        processingHours: Number(inner.facts.labourHours || 0) + inner.processingHours,
        extraMp: Number(inner.facts.mp || 0) + inner.extraMp, residualValue: 0,
        gear: { source: 'craft', recipe: Number(recipe.recipeId), batches, purchases: inner.purchases } };
}
// The basket of a craft its crafter makes itself inside another's basket (a
// component, componentPlan; a shot scrap, ShotCraftPolicy prepareCrystal):
// one level deep, cash = its bought inputs plus their fees.
function* ownCraftBasket(recipe, planFor, ownedFor, batches, context) {
    const inner = yield* prepareBasket(recipe, planFor, ownedFor, batches, { ...context, component: null });
    return inner && { ...inner, cash: inner.cashCost + inner.actualCashFees };
}
function drain(iterator) { let step; do { step = iterator.next(); } while (!step.done); return step.value; }
function basketFor(recipe, planFor, ownedFor = () => null, batches = 1, context = {}) {
    if (!Number.isSafeInteger(batches) || batches < 0 || batches > MAX_BATCHES) return null;
    return drain(prepareBasket(recipe, planFor, ownedFor, batches, context));
}
function saleInput(exit, units, context) {
    const conditional = exit.conditional || exit.offer?.conditional;
    const snapshot = exit.prospective, authority = snapshot?.authority, offer = exit.offer;
    const prospective = conditional && exit.trial === true
        && snapshot?.known === true && snapshot.origin === 'public_bid'
        && authority?.recordId === Number(offer?.recordId) && authority?.lineId === Number(offer?.lineId)
        && authority?.revision === (offer?.revision ?? offer?.expectedRevision)
        && snapshot.applicableUnits === Number(exit.count) && Number(offer?.count) === Number(exit.count)
        && Number(offer?.price) === Number(exit.price)
        && Number.isFinite(snapshot.willingUnits) && snapshot.willingUnits >= 0
        && snapshot.willingUnits <= snapshot.applicableUnits;
    return { units, applicableUnits: conditional ? prospective ? Number(exit.applicableUnits ?? snapshot.applicableUnits) : 0
        : Number(exit.applicableUnits ?? exit.count),
        willingUnits: prospective ? snapshot.willingUnits : Number(exit.willingUnits ?? exit.count), cheaperUnits: Number(exit.cheaperUnits || 0),
        price: Number(exit.price), residualUnitValue: Number(exit.residualUnitValue ?? context.residualUnitValue ?? 0) };
}
function* evaluatePrepared({ state, recipe, batches = 1, basket, exit, ownedFor = () => null, context = {} }) {
    // Chance, MP and labour of the basket's own craft facts, the reader the
    // wish network prices the same craft by.
    const facts = basket?.facts?.batches === batches ? basket.facts
        : Profit.craftFacts(recipe, { batches, executor: context.executor, mpCapacity: context.mpCapacity, mpPerHour: context.mpPerHour });
    const successRate = facts.successProbability;
    const productCount = Number(recipe?.productCount) * batches;
    const mp = Number(facts.mp);
    if (!recipe || !Number.isSafeInteger(batches) || batches < 1 || batches > MAX_BATCHES
        || batches > Number(exit.maxBatches ?? MAX_BATCHES)
        || !Number.isSafeInteger(productCount) || productCount <= 0 || !(successRate > 0 && successRate <= 1)
        || !Number.isFinite(mp) || mp < 0 || !basket || mp + Number(basket.extraMp || 0) > Number(state?.vitals?.mp || 0)
        || basket.cashCost + basket.actualCashFees > Number(state?.adena || 0)
        || productCount > Number(context.destinationCapacity ?? Infinity)
        || productCount > Number(context.assignedCapacity ?? Infinity)) return null;
    const hourAdena = Number(context.hourAdena ?? context.hunt?.perHour);
    const moneyPrice = Number(context.moneyPrice ?? (hourAdena > 0 ? 1 / hourAdena : NaN));
    if (!Number.isFinite(moneyPrice) || moneyPrice <= 0) return null;
    const mpHours = Number(facts.labourHours);
    if (!Number.isFinite(mpHours) || mpHours < 0) return null;
    const activeHours = Number(context.activeCraftHours || 0) * batches + Number(basket.processingHours || 0);
    const shopHours = Number(exit.shopHours || 0), exitDetails = exit.tripDetails || context.trip?.details?.(exit.town);
    const exitTrip = Number(exit.trip || 0);
    const sameVisit = !!exit.town && basket.tripTowns?.has(exit.town);
    const exitHours = sameVisit ? 0 : exitDetails ? Number(exitDetails.hours) : exitTrip ? exitTrip / hourAdena : 0;
    const exitFees = sameVisit ? 0 : exitDetails ? Number(exitDetails.fees) : 0;
    const cycleHours = mpHours + activeHours + basket.travelHours + exitHours + shopHours;
    if (!Number.isFinite(cycleHours) || cycleHours < 0 || !Number.isFinite(exitFees) || exitFees < 0) return null;
    const oldCount = count(context.existingOutput ?? ownedFor(Number(recipe.productId))?.count ?? 0);
    if (!Number.isFinite(oldCount) || !Number.isSafeInteger(oldCount + productCount)) return null;
    // A commercial batch first fills the crafter's missing personal stock.
    // Those units give their own use benefit, never external sale receipts.
    const reservedOutput = exit.type === 'use' ? 0 : Math.min(productCount, count(context.outputReserve ?? 0));
    if (!Number.isFinite(reservedOutput)) return null;
    // The batch's units past the old ones: a listing sells them over the
    // forecast's time (Price.listingSale, the producer root's reading; the
    // root cut its lot to the units sold within its horizon and the exit's
    // maxBatches bounds a shot lot by one window), any other exit what one
    // sale takes beyond the old units.
    const newUnits = productCount - reservedOutput;
    let sale;
    if (exit.type === 'listing') {
        sale = Price.listingSale({ ...saleInput(exit, oldCount, context), units: newUnits, oldUnits: oldCount,
            delayHours: Number(exit.delayHours) });
        yield 'success';
        if (!sale.known) return null;
    } else {
        const without = Price.saleOutcome(saleInput(exit, oldCount, context));
        yield 'without';
        if (!without.known) return null;
        const full = Price.saleOutcome(saleInput(exit, oldCount + newUnits, context));
        yield 'success';
        if (!full.known) return null;
        if (exit.trial === true && !(full.sold > without.sold)) return null;
        sale = { receipts: full.receipts - without.receipts, residualValue: full.residualValue - without.residualValue,
            residual: full.residual - without.residual, sold: full.sold - without.sold, delayHours: Number(exit.delayHours || 0) };
    }
    // One native command draws once, including a multi-batch command. Cap each
    // physical outcome before mixing, so 100 output at 60% against 10 sells 6.
    const receipts = sale.receipts;
    const residual = sale.residualValue;
    const ownUse = Math.min(Math.max(0, sale.residual), Math.max(0, Number(exit.ownUseUnits || 0)));
    const ownBenefit = ownUse * Number(exit.ownUseUnitHours || 0)
        + reservedOutput * Number(context.reservedOutputUnitHours || 0);
    const base = { cashNow: basket.cashCost, ownInputOpportunityValue: basket.ownedValue,
        actualCashFees: basket.actualCashFees + exitFees,
        foregoneBenefitHours: mpHours + activeHours + basket.travelHours + exitHours
            + (exit.concurrentAlternative === true ? 0 : shopHours),
        riskHours: Number(context.riskHours || 0), delayHours: sale.delayHours, cycleHours };
    const monetaryResidual = residual - ownUse * Number(exit.residualUnitValue ?? context.residualUnitValue ?? 0)
        + Number(basket.residualValue || 0);
    const outcomes = [{ ...base, probability: successRate, receipts, monetaryResidual,
        ownBenefitHours: ownBenefit }];
    if (successRate < 1) outcomes.push({ ...base, probability: 1 - successRate, receipts: 0,
        monetaryResidual: Number(basket.residualValue || 0), ownBenefitHours: 0 });
    const accumulator = Valuation.createOpportunity({ ...context, moneyPrice });
    for (const outcome of outcomes) {
        Valuation.addOutcome(accumulator, outcome);
        yield 'utility';
    }
    const value = Valuation.finishOpportunity(accumulator);
    if (!value.known) return null;
    const rawProfit = value.valueHours / moneyPrice;
    const expectedProfit = Math.abs(rawProfit - Math.round(rawProfit)) < 1e-7 ? Math.round(rawProfit) : rawProfit;
    const expectedRevenue = successRate * receipts;
    const labour = (mpHours + activeHours + basket.travelHours + exitHours + shopHours) / moneyPrice;
    return { recipe, basket, exit, batches, revenue: Number(exit.price) * productCount,
        expectedProfit, successRate, hours: cycleHours, valueHours: value.valueHours, valuation: value,
        expectedSold: successRate * sale.sold,
        margin: { expectedRevenue, inputs: basket.cost, labour, hours: cycleHours, profit: expectedProfit, cycleHours } };
}
function evaluateBasket(args, recipe, planFor, exit, ownedFor, context, batches = 1) {
    const input = arguments.length === 1 ? args : { state: args, recipe, planFor, exit, ownedFor, context, batches };
    const basket = input.basket || basketFor(input.recipe, input.planFor, input.ownedFor, input.batches ?? 1, input.context);
    return drain(evaluatePrepared({ ...input, basket }));
}
// The batches one search may try (searchQuantity): what the MP pays for
// (Profit.mpBatches), and the context's cap within MAX_BATCHES.
function contextBatches(context = {}) {
    return Math.min(MAX_BATCHES, Math.max(0, Math.floor(Number(context.maxBatches ?? MAX_BATCHES))));
}
function* searchQuantity({ state, recipe, planFor, exits = [], ownedFor = () => null, context = {} }) {
    let best = null;
    // Complete bounded search also handles discontinuous quote/fee breakpoints.
    // Zero is the without-case; never force production when every value is <=0.
    const limit = Math.min(Profit.mpBatches(state?.vitals?.mp, recipe), contextBatches(context));
    const first = context.fixedBatches === undefined ? 1 : Number(context.fixedBatches);
    const end = context.fixedBatches === undefined ? limit : Math.min(limit, first);
    if (!Number.isSafeInteger(first) || first < 1 || first > MAX_BATCHES) return null;
    for (let batches = first; batches <= end; batches++) {
        const basket = yield* prepareBasket(recipe, planFor, ownedFor, batches, context);
        if (!basket) continue;
        for (const exit of exits) {
            yield 'exit';
            const pricedExit = typeof exit.forQuantity === 'function' ? exit.forQuantity(batches) : exit;
            if (!pricedExit) continue;
            const candidate = yield* evaluatePrepared({ state, recipe, batches, basket, exit: pricedExit, ownedFor, context });
            if (candidate?.valueHours > 0 && (!best || candidate.valueHours > best.valueHours)) best = candidate;
        }
        yield 'candidate';
    }
    return best;
}
function chooseQuantity(input) { return drain(searchQuantity(input)); }
module.exports = { MAX_BATCHES, basketFor, evaluateBasket, chooseQuantity,
    prepareBasket, ownCraftBasket, evaluatePrepared, searchQuantity, drain };
