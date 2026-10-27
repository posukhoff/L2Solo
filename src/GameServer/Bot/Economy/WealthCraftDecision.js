'use strict';
// Pure worker decisions. Monetary/physical settlement remains on main.
const Policy = require('./WealthCraftPolicy');
const Valuation = require('./EconomicValuation');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const PurchaseFunding = require('./PurchaseFunding');
const { canCraft } = require('./CraftEligibility');
const Karma = require('../../Karma');
const CombinedErrands = require('../Population/CombinedErrandPolicy');
const { partyIdOf } = require('../Population/PartyId');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
function eligible(state, { now = Date.now() } = {}) {
    if (!state || state.phase !== 'cold' || !['hunting', 'resting', 'shopping'].includes(state.activity)
        || CombinedErrands.pending(state, now).length
        || partyIdOf(state) || Karma.closesTowns(state.stats?.karma)
        || state.stats?.craftStationId || /^bot_craft_\d+$/i.test(String(state.accountName || ''))) return false;
    if (!CraftShopService.isServiceCrafter(state) || CraftShopService.craftLevelFor(state) <= 0) return false;
    return !(state.stats?.equipmentPlan?.strategy === 'craft'
        && GearAcquisitionPlanner.planRunning(state.stats.equipmentPlan));
}
// The free units of a bag row: its amount past the equipped copies and its
// held units (ItemDisposition.rowReserve of the held map `reserved` and a
// sale's production `kit`).
function freeAmount(state, item, reserved = {}, kit = {}) {
    const held = ItemDisposition.rowReserve(state, item, reserved, kit);
    if (held === Infinity) return 0;
    const count = value => Math.max(0, Number(value) || 0);
    return Math.max(0, Math.floor(Number(item.amount ?? item.count ?? 0))
        - Math.max(count(item.equippedCount || (item.equipped ? item.amount ?? 1 : 0)), held));
}
// The one answer to "would the learner take this recipe's scroll"
// (ItemDisposition.recipeDisposition). An unknown recipe it refuses is no
// craft path (WishProviders craftPath), held or not. item: the held row
// (a hot bag's item for BotWarehouseService.learnActorRecipes).
function learnsRecipe(state, recipe, item = state?.inventory?.[recipe.recipeItemId]) {
    const selfId = Number(recipe.recipeItemId);
    return ItemDisposition.recipeDisposition(state, { ...item, selfId }, [])?.action === 'learn';
}
// A free held scroll of a recipe the learner takes ("may this held scroll be
// learned"): every learn point learns it unless the bot knows it already
// (LifeState.learnCraftableRecipes, BotWarehouseService.learnActorRecipes),
// and the craft of an unknown recipe learns it first. Read by recipePaths
// and ShotCraftPolicy.shotSearch (worker) and ColdWealthCraftService.recheck
// (main); the producer step reads WishProviders' scrollSource verdict instead.
// reserved: the executor's ItemDisposition.reservedEquipmentAmounts, or a
// function giving it, called only for a scroll the learner takes.
function heldScroll(state, recipe, item = state?.inventory?.[recipe.recipeItemId], reserved = {}) {
    return !!item && learnsRecipe(state, recipe, item)
        && freeAmount(state, item, typeof reserved === 'function' ? reserved() : reserved) > 0;
}
// The inputs a producer makes itself inside its craft's basket
// (WealthCraftPolicy.prepareBasket context.component): a known recipe it
// crafts itself with a sure result (canCraft sure: a failed roll would
// strand the parent's other inputs). Read by the worker's producerStep and
// main's ColdWealthCraftService.recheck.
function ownComponent(state, known) {
    return selfId => {
        for (const recipe of Recipes.resolveVariantsByProductId(Number(selfId)) || []) {
            if (known.has(Number(recipe.recipeId)) && canCraft(state, recipe, { sure: true })) return recipe;
        }
        return null;
    };
}
// The cold wealth step sizes the craft a WishProviders producer root chose
// (network.producers {key, amount, recipeId, exit, recipeReady, r}, WishNetwork.build: a kept
// `resale:` root with a chosen exit, priced (r = its money-queue ratio) or all
// inputs owned): the root alone picks the recipe and
// its one exit (ShotCraftPolicy.exitTuple); this step only finds
// the batches, up to the root's amount, the cash its ratio may spend and that
// exit's demand pay for. Only a row WishProviders' scrollSource found ready
// (recipeReady: a known recipe, or an unknown one whose free scroll the learner takes; the
// step carries it as `scroll`, main learns it before the craft); a scroll to
// find (SOURCE) is no craft yet: the root acts on the scroll alone
// (TradeIntent.scrollFirst), bought, farmed or bid for by its item node's path.
// prepared: ColdOccupationSources.prepare (context, options).
function* producerStep(state, producers, knownRecipes, { context, options }) {
    // lazy: cycle ShotCraftPolicy requires this module
    const { exitTuple } = invoke('GameServer/Bot/Economy/ShotCraftPolicy');
    const known = new Set((knownRecipes || []).map(row => Number(row.recipeId ?? row)));
    const preparePurchase = (id, missing) => options.preparePurchase(state, id, missing, { npc: true, cost: context.trip });
    const ownedFor = id => options.ownStock.get(Number(id)) || null;
    let best = null;
    for (const producer of producers || []) {
        const chosen = producer.exit;
        const recipe = Recipes.resolveByRecipeId(Number(producer.recipeId));
        if (!producer.recipeReady || !recipe || !CraftShopService.canCraft(state, recipe)) continue;
        const learn = !known.has(Number(producer.recipeId));
        const exits = (yield* options.prepareExits(state, recipe)).filter(exit => {
            const tuple = exitTuple(exit);
            return tuple?.[0] === chosen[0] && tuple[1] === chosen[1];
        });
        // Cash inputs spend at the root's money-queue ratio (one rule for
        // every reader, PurchaseFunding.goalTerms): the batches are sized
        // within what that ratio may spend (Policy's cash bound is state.adena).
        const r = producer.r;
        const candidate = exits.length ? yield* Policy.searchQuantity({
            state: { ...state, adena: PurchaseFunding.spendable(state, 0, { r }) }, recipe, exits, ownedFor,
            context: { ...context, preparePurchase, component: ownComponent(state, known), existingOutput: options.existing(recipe.productId),
                maxBatches: Math.floor(Number(producer.amount || 0) / Number(recipe.productCount || 1)) } }) : null;
        yield 'funding';
        if (!candidate) continue;
        // The step's own net value at today's quotes must still be positive.
        if (candidate.valueHours > 0 && (!best || candidate.valueHours > best.valueHours)) {
            best = { ...candidate, r, ...(learn ? { scroll: [Number(recipe.recipeItemId)] } : {}) };
        }
    }
    return best;
}
// The same finite route value also decides whether consuming/acquiring the
// physical scroll beats sale/holding/clan alternatives. No lifetime multiplier.
function recipePaths(state, recipe, { known = false, route = null, acquisition = null,
    sale = null, clan = null, commission = null, ownUse = null, context = {} } = {}) {
    const moneyPrice = Number(context.moneyPrice ?? (context.hourAdena > 0 ? 1 / context.hourAdena : NaN));
    const rows = [{ kind: 'hold', valueHours: 0, cashNow: 0, available: true }];
    const owned = Number(state.inventory?.[recipe.recipeItemId]?.amount || 0) > 0;
    // Only a free scroll the learner takes is learned (heldScroll); one held
    // for the clan or not learnable leaves the recipe to 'acquire'.
    const learnable = !known && owned && heldScroll(state, recipe);
    // A held scroll is worth the bot's own price (context.price, the one
    // reader); a buyer's bid is the separate 'sale' row, not its worth.
    const scrollWorth = owned ? Number(context.price?.(recipe.recipeItemId) || 0) : 0;
    const evaluate = (kind, outcome, extras = {}) => {
        const value = Valuation.opportunity({ ...context, moneyPrice }, [{ probability: 1, ...outcome }]);
        if (value.known) rows.push({ kind, valueHours: value.valueHours, cashNow: value.cashNow, available: true, ...extras });
    };
    // A learnable scroll is learned at every learn point (heldScroll), so it
    // has no sale or clan row: one learn-or-sell answer.
    if (owned && !learnable && sale?.available !== false && Number(sale?.price) > 0) evaluate('sale', {
        receipts: Number(sale.price), ownInputOpportunityValue: scrollWorth,
        foregoneBenefitHours: Number(sale.hours || 0), actualCashFees: Number(sale.fees || 0) });
    if (owned && !learnable && clan?.available === true && Number(clan.valueHours) > 0) evaluate('clan', {
        ownBenefitHours: Number(clan.valueHours), ownInputOpportunityValue: scrollWorth,
        foregoneBenefitHours: Number(clan.hours || 0) }, { target: clan.target });
    const value = Number(route?.valueHours ?? ownUse?.valueHours);
    if (Number.isFinite(value) && value > 0 && CraftShopService.canCraft(state, recipe)) {
        const acquireCash = known || learnable ? 0 : Number(acquisition?.cashNow ?? acquisition?.price);
        const acquisitionHours = known || learnable ? 0 : Number(acquisition?.hours || 0);
        const cash = Number(route?.basket?.cashCost || 0) + acquireCash;
        const scrollValue = learnable ? scrollWorth : 0;
        if ((known || learnable || acquisition?.available === true) && Number.isFinite(acquireCash) && acquireCash >= 0
            && cash <= PurchaseFunding.spendable(state, 0, { valueHours: value })) {
            evaluate(known ? 'use' : learnable ? 'learn' : 'acquire', { ownBenefitHours: value,
                cashNow: acquireCash, ownInputOpportunityValue: scrollValue,
                foregoneBenefitHours: acquisitionHours }, { recipeId: recipe.recipeId, route });
        }
    }
    if (commission?.available === true && commission.contract) evaluate('commission', commission.outcome || {}, { contract: commission.contract });
    let best = rows[0];
    for (const row of rows) if (row.valueHours > best.valueHours
        || row.kind === 'sale' && row.valueHours === best.valueHours) best = row;
    return { known: Number.isFinite(moneyPrice), rows, best, recipeId: Number(recipe.recipeId) };
}
module.exports = { eligible, producerStep, ownComponent, recipePaths, freeAmount, learnsRecipe, heldScroll };
