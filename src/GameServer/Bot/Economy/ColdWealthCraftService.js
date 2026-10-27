const Policy = require('./WealthCraftPolicy');
const { partyIdOf } = require('../Population/PartyId');
const Shots = require('./ShotCraftPolicy');
const WealthDecision = require('./WealthCraftDecision');
const Profit = require('./CraftProfitPolicy');
const Workshops = require('./CraftWorkshopService');
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const Karma = require('../../Karma');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const ColdCrafting = invoke('GameServer/Bot/Economy/ColdCraftingService');
const PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const { personalOfferAllowed, offerAdmission } = require('../Population/PartyAdmission');
const Price = require('./PriceDecision');
const PriceBelief = require('./PriceBelief');
const OfferQuery = require('./OfferQuery');
const DecisionEvents = require('../AI/DecisionEvents');
const FixedShots = require('./FixedShotOffers');
const ColdOccupationSources = require('../Population/ColdOccupationSources');
const Ready = require('./ReadyTradeChoice');
const Sources = () => { ColdOccupationSources.initialise(); return ColdOccupationSources; };

const inFlight = new Set();

// The component a basket purchase row crafts (WealthCraftPolicy componentPlan):
// its recipe, batches and template, else null.
function componentOf(purchase) {
    const source = purchase?.source?.source === 'craft' ? purchase.source : null;
    const recipe = source && Recipes.resolveByRecipeId(Number(source.recipe));
    return recipe ? { source, recipe, batches: Number(source.batches),
        template: ItemTemplateIndex.find(DataCache.items, Number(recipe.productId)) } : null;
}

// Spending rechecks a single worker-selected native batch/exit. It uses the
// current scalar purse and at most five indexed input quotes; it never builds
// wishes, a catalogue scan, or a new quantity optimisation on main.
// extraMp: the basket's own processing (a component it crafts first).
const mpChanged = (state, recipe, batches, extraMp = 0) =>
    Profit.mpBatches(Number(state.vitals?.mp || 0) - Number(extraMp || 0), recipe) < batches;
function recheck(state, step = {}, knownRecipes = Workshops.cachedRecipes(state.characterId), refusal = null) {
    const recipe = Recipes.resolveByRecipeId(Number(step.recipeId)), batches = Number(step.batches || 1);
    const packet = state.stats?.money;
    if (!recipe || !CraftShopService.canCraft(state, recipe) || !Number.isSafeInteger(batches)
        || batches < 1 || batches > 64 || !Array.isArray(packet) || !(packet[0] > 0) || !(packet[1] > 0)) return null;
    if (mpChanged(state, recipe, batches)) {
        if (refusal) refusal.reason = 'mp_changed';
        return null;
    }
    const template = ItemTemplateIndex.find(DataCache.items, Number(recipe.productId));
    if (!template) return null;
    const board = AfkTrade.boardIndex();
    // Held units are worth the bot's own price, the worker's reader rule.
    const context = { hourAdena: Number(packet[0]), moneyPrice: Number(packet[1]),
        ...Sources().craftLabour(state), fixedBatches: batches,
        component: WealthDecision.ownComponent(state, new Set((knownRecipes || []).map(row => Number(row.recipeId ?? row)))),
        price: PriceBelief.reader({ state, board, timestamp: Date.now() }).price };
    const trip = Profit.tripFor(state, context); context.trip = trip;
    // An unknown recipe passes only for a step that carries its scroll
    // (step.scroll: the worker's producerStep, or the hot craft leaf of
    // HotWealthCraftService.review) with that scroll still held and
    // learnable (WealthCraftDecision.heldScroll). The executor learns it
    // before the craft (`learn`), so the basket is the batch alone.
    const learning = !(knownRecipes || []).some(row => Number(row.recipeId ?? row) === Number(recipe.recipeId));
    if (learning && (!Array.isArray(step.scroll) || !WealthDecision.heldScroll(state, recipe))) return null;
    let exit = null;
    if (Array.isArray(step.exit) && Number(step.exit[0]) === -2) {
        // A listing exit [-2, town code, price, forecast revision]: the
        // worker priced its demand; main rechecks only rows and the purse.
        const town = Shots.townForCode(step.exit[1]), price = Number(step.exit[2]);
        if (!town || !(price > 0)) return null;
        exit = { type: 'listing', town, price };
    } else if (Array.isArray(step.exit) && step.exit.length === 4) {
        const compact = step.exit[0] == null && step.exit[2] == null;
        // A saved static-buyer exit [0, id, price, 0] has no buyer now (C8).
        if (!(Number(step.exit[0]) > 0 || compact)) return null;
        exit = Ready.savedExit(board, recipe.productId, step.exit, state);
    }
    if (!exit) return null;
    const ownedFor = id => {
        const row = state.inventory?.[id];
        if (!row) return null;
        // The row's own hold is freeAmount's (ItemDisposition.rowHeldAmount).
        const count = WealthDecision.freeAmount(state, { ...row, selfId: Number(id) });
        return { count: Number(id) === Number(recipe.productId) ? Math.max(0, count - Number(step.ownReserve || 0)) : count,
            unitValue: context.price(id) };
    };
    // The buyer's half of the party rule once for this synchronous recheck.
    const admitted = offerAdmission(state);
    const planFor = (id, amount) => {
        const best = OfferQuery.cheapestTown(board, id, { amount, cost: trip, excludeOwner: state.characterId,
            quoteDepth: Price.QUOTE_DEPTH, sampleWhole: true, settledOnly: OfferQuery.settledOnlyFor('wealth_craft'),
            accept: line => !Number(line.enchant || 0) && admitted(line),
            npcOffers: FixedShots.npcOffers(id, Sources().npcOffersFor) });
        return best?.whole ? { ...best, tripDetails: trip.details?.(best.town), quoteDepth: Price.QUOTE_DEPTH } : null;
    };
    let candidate;
    if (exit.type === 'listing') {
        // Inputs at today's quotes.
        const basket = Policy.basketFor(recipe, planFor, ownedFor, batches, context);
        if (!basket) return null;
        candidate = { recipe, batches, basket, exit };
    } else {
        exit = { ...exit, trip: trip(exit.town), tripDetails: trip.details?.(exit.town) };
        // Raw indexed depth is the same view the worker receives. A competitive
        // tail can change F(q), so the selected forecast remains unsupported.
        const { cheaperUnits, limit } = Price.exitCompetition(board.list(recipe.productId, AfkTrade.SELL),
            { ownerId: state.characterId, price: exit.price, count: exit.count });
        if (limit) return null;
        exit.cheaperUnits = cheaperUnits;
        exit = Price.prospectiveExit(state, exit, { board, timestamp: Date.now() });
        const ownOutput = board.ownerLines(state.characterId)
            .filter(line => line.selfId === Number(recipe.productId) && Price.plainSale(line));
        if (ownOutput.some(line => line.price !== Number(exit.price))) return null;
        context.existingOutput = Price.heldUnits(ownedFor(Number(recipe.productId))?.count,
            state.acceptedIncoming?.[recipe.productId], ownOutput);
        candidate = Policy.evaluateBasket({ state, recipe, batches, planFor, exit, ownedFor, context });
        if (!candidate || !(candidate.valueHours > 0)) return null;
    }
    // Cash inputs are funded at the worker's root ratio (step.r); a step
    // without one that must spend cash goes back to the worker.
    const cash = candidate.basket.cashCost + candidate.basket.actualCashFees, r = Number(step.r);
    if (cash > 0 && !(r > 0 && cash <= PurchaseFunding.spendable(state, 0, { r }))) return null;
    return { ...candidate, template, r, learn: learning };
}

function eligible(state) {
    if (!state || state.phase !== 'cold' || !['hunting', 'resting', 'shopping'].includes(state.activity)
        || invoke('GameServer/Bot/Economy/ColdMarketService').pendingErrand(state)
        || partyIdOf(state) || Karma.closesTowns(state.stats?.karma)
        || state.stats?.craftStationId || /^bot_craft_\d+$/i.test(String(state.accountName || ''))) return false;
    if (!CraftShopService.isServiceCrafter(state)) return false;
    if (CraftShopService.craftLevelFor(state) <= 0) return false;
    return !(state.stats?.equipmentPlan?.strategy === 'craft'
        && GearAcquisitionPlanner.planRunning(state.stats.equipmentPlan));
}

async function refreshCraftedInventory(state, recipe) {
    const inventory = { ...(state.inventory || {}) };
    for (const material of recipe.materials || []) delete inventory[String(material.selfId)];
    delete inventory[String(recipe.productId)];
    return LifeState.refreshInventory({ ...state, inventory });
}

function materialRows(items, recipe, batches = 1) { return Profit.materials(items, recipe, batches); }

function withOutcome(state, opportunity, outcome, extras = {}) {
    return {
        ...state,
        stats: {
            ...(state.stats || {}),
            ...(outcome === 'buying' && (state.stats?.wealthCraft?.outcome !== 'buying'
                || Number(state.stats.wealthCraft.recipeId) !== Number(opportunity.recipe.recipeId)
                || Number(state.stats.wealthCraft.batches) !== Number(opportunity.batches || 1))
                ? DecisionEvents.applyRaise({ ...(state.stats || {}) },
                    require('./DecisionSections').sectionMask(['sources', 'benefits', 'money'])) : {}),
            ...(['sold', 'waiting_for_buyer', 'for_sale'].includes(outcome) ? { production: {
                ...(state.stats?.production || {}),
                crafts: Number(state.stats?.production?.crafts || 0) + 1,
                profit: Number(state.stats?.production?.profit || 0) + (outcome === 'sold' ? Number(extras.profit || 0) : 0)
            } } : {}),
            wealthCraft: {
                recipeId: Number(opportunity.recipe.recipeId),
                productId: Number(opportunity.recipe.productId),
                batches: Number(opportunity.batches || 1),
                inputCost: Number(opportunity.basket.cost),
                ...(Number.isFinite(opportunity.expectedProfit) ? { expectedProfit: opportunity.expectedProfit } : {}),
                outcome,
                at: Date.now(),
                ...extras
            }
        }
    };
}

// Retire only the accepted work that actually failed. A purchase
// await may have published another native row; never save its older caller.
function rejectedWork(current, accepted) {
    if (current.phase !== 'cold') return current;
    return DecisionEvents.rejectedState(current, accepted);
}
async function rejectAccepted(state, accepted = state, refusal = null) {
    const current = LifeState.cachedState(state.characterId) || state;
    if (refusal?.reason === 'mp_changed') return current;
    const next = rejectedWork(current, accepted);
    return next === current ? current : await LifeState.upsertState(next, 'wealth_craft_source_rejected') || current;
}

// options.stillPrepared: the economy plan's authority check. The first write
// below advances the revision; it runs only while the decision still holds.
async function execute(state, opportunity, options = {}) {
    // A buyer exit is rechecked against its line; a listing exit keeps the
    // product in the bag for the bot's own listing (for_sale).
    const buyer = opportunity.exit?.offer || null;
    if (buyer && !personalOfferAllowed(buyer, state)) {
        return { state: await rejectAccepted(state), crafted: false, reason: 'buyer_changed' };
    }
    const recipe = opportunity.recipe;
    const batches = Math.min(64, Math.max(1, Number(opportunity.batches || 1)));
    if (!Number.isSafeInteger(batches) || mpChanged(state, recipe, batches, opportunity.basket.extraMp)) {
        return { state, crafted: false, reason: 'mp_changed' };
    }
    if (opportunity.basket.owned.length) {
        const physical = await Database.fetchItems(state.characterId, 'wealth_craft_physical');
        if (opportunity.basket.owned.some((stock) => physical
            .filter((item) => Number(item.selfId) === Number(stock.selfId) && !item.equipped)
            .reduce((count, item) => count + Number(item.amount || 0), 0) < Number(stock.count))) {
            return { state: await rejectAccepted(state), crafted: false, reason: 'owned_materials_changed' };
        }
    }
    if (options.stillPrepared && !options.stillPrepared()) return { state, crafted: false, reason: 'decision_changed', stale: true };
    let current = await LifeState.upsertState(withOutcome(state, opportunity, 'buying'), 'wealth_craft_started');
    if (!current) return { state, crafted: false, reason: 'state_write_rejected' };
    // The held scroll the step carries (recheck `learn`) is learnt by the one
    // learner, its own admission, before any input is bought: a scroll the
    // learner refuses buys nothing.
    if (opportunity.learn) {
        current = await LifeState.learnCraftableRecipes(current) || current;
        const book = await Workshops.knownFor(current.characterId);
        if (!book.includes(Number(recipe.recipeId))) {
            const failed = withOutcome(rejectedWork(LifeState.cachedState(current.characterId) || current, state), opportunity, 'recipe_not_learned', { spent: 0 });
            return { state: await LifeState.upsertState(failed, 'wealth_craft_recipe_not_learned') || failed,
                crafted: false, reason: 'recipe_not_learned' };
        }
    }
    let spent = 0;
    try {
        // Each input is bought in its town (the one purchase path): here, or
        // the bot goes there and the craft waits for the next look.
        const ColdMarket = invoke('GameServer/Bot/Economy/ColdMarketService');
        // A component the basket crafts (componentPlan) buys its own inputs
        // (none of them the parent's) instead of itself.
        const required = Profit.requirements(recipe, batches) || new Map(), sources = new Map();
        for (const purchase of opportunity.basket.purchases) {
            const made = componentOf(purchase);
            if (!made) { sources.set(Number(purchase.selfId), purchase); continue; }
            for (const [id, amount] of Profit.requirements(made.recipe, made.batches) || [])
                required.set(id, Number(required.get(id) || 0) + amount);
            for (const row of made.source.purchases) sources.set(Number(row.selfId), row);
        }
        const inputs = [...sources].map(([selfId, purchase]) => ({ selfId, amount: Number(required.get(selfId) || 0),
            options: { towns: [purchase.town], npc: Number(purchase.npc || 0) > 0, purpose: 'wealth_craft',
                r: opportunity.r, money: PurchaseFunding.spendable(current, 0, { r: opportunity.r }),
                quoteDepth: 5, sourcePlan: purchase } }));
        const bought = await ColdMarket.acquireMaterials(current, inputs);
        current = bought.state || current; spent += Number(bought.spent || 0);
        if (bought.pending) return { state: current, crafted: false, pending: true, spent };
        if (bought.hot) return { state: current, crafted: false, reason: 'bot_went_hot', spent };
        if (!bought.ready && (bought.traveling || current.stats?.marketErrand)) {
            return { state: current, crafted: false, reason: 'buying_trip', spent };
        }
        if (!bought.ready) throw Error('purchase_unavailable');
    } catch (error) {
        const failed = withOutcome(error?.message === 'purchase_unavailable'
            ? rejectedWork(LifeState.cachedState(current.characterId) || current, state) : current, opportunity, 'purchase_failed',
            { spent, error: String(error?.message || error) });
        return { state: await LifeState.upsertState(failed, 'wealth_craft_purchase_failed') || failed,
            crafted: false, reason: 'purchase_failed' };
    }

    for (const purchase of opportunity.basket.purchases) {
        const made = componentOf(purchase);
        if (!made) continue;
        const rows = materialRows(await Database.fetchItems(current.characterId, 'wealth_craft_component'), made.recipe, made.batches);
        let own = null, error = rows ? null : 'materials_changed';
        try {
            own = rows && await ColdCrafting.craftOwn(current, made.recipe, made.batches, rows);
        } catch (failure) {
            error = String(failure?.message || failure);
        }
        if (own) {
            current = await refreshCraftedInventory(own.state, made.recipe);
            if (own.result?.success === true) await LifeEvents.record(current.characterId, 'component_craft',
                `${current.name} crafted ${made.batches > 1 ? `${made.batches}x ` : ''}${made.template?.template?.name || `item ${made.recipe.productId}`} for ${opportunity.template.template?.name || `item ${recipe.productId}`}`,
                { recipeId: made.recipe.recipeId, productId: made.recipe.productId, stationId: 'producer' }, 1);
        }
        if (own?.result?.success !== true) {
            const failed = withOutcome(rejectedWork(LifeState.cachedState(current.characterId) || current, state), opportunity, 'component_failed',
                { spent, error: error || 'craft_roll_failed' });
            return { state: await LifeState.upsertState(failed, 'wealth_craft_component_failed') || failed,
                crafted: false, reason: 'component_failed' };
        }
    }
    const items = await Database.fetchItems(current.characterId, 'wealth_craft_items');
    const materials = materialRows(items, recipe, batches);
    if (!materials) {
        const failed = withOutcome(rejectedWork(LifeState.cachedState(current.characterId) || current, state), opportunity, 'materials_changed', { spent });
        return { state: await LifeState.upsertState(failed, 'wealth_craft_materials_changed') || failed,
            crafted: false, reason: 'materials_changed' };
    }

    if (buyer && (!personalOfferAllowed(buyer, current)
        || current.currentRegion === buyer.town && !AfkTrade.offers(recipe.productId, AfkTrade.BUY,
        { characterId: current.characterId }).some((offer) => (
        Number(offer.recordId) === Number(buyer.recordId)
            && Number(offer.lineId) === Number(buyer.lineId)
            && Number(offer.expectedRevision) === Number(buyer.expectedRevision)
            && Number(offer.price) === Number(opportunity.exit.price)
            && Number(offer.count) > 0
    )))) {
        const changed = withOutcome(rejectedWork(LifeState.cachedState(current.characterId) || current, state), opportunity, 'buyer_changed', { spent });
        return { state: await LifeState.upsertState(changed, 'wealth_craft_buyer_changed') || changed,
            crafted: false, reason: 'buyer_changed' };
    }

    const productName = opportunity.template.template?.name || '';
    let success = false, units = 0;
    let remainingMp = Number(current.vitals?.mp || 0);
    try {
        const own = await ColdCrafting.craftOwn(current, recipe, batches, materials);
        current = own.state;
        success = own.result?.success === true;
        units = Number(own.result?.units || 0);
        remainingMp = Number(current.vitals?.mp);
    } catch (error) {
        const semantic = ['craft_recipe_changed', 'craft_recipe_materials_changed', 'craft_product_changed',
            'craft_product_template_changed', 'craft_material_identity_changed', 'craft material changed'].includes(error?.message);
        const failed = withOutcome(semantic ? rejectedWork(LifeState.cachedState(current.characterId) || current, state) : current, opportunity, 'craft_rejected',
            { spent, error: String(error?.message || error) });
        return { state: await LifeState.upsertState(failed, 'wealth_craft_rejected') || failed,
            crafted: false, reason: 'craft_rejected' };
    }

    current = await refreshCraftedInventory({ ...current, vitals: {
        ...(current.vitals || {}), mp: remainingMp
    } }, recipe);
    // A listing craft is settled here (for_sale); a buyer craft below.
    current = await LifeState.upsertState(withOutcome(current, opportunity, !success ? 'failed_roll' : buyer ? 'crafted' : 'for_sale',
        { spent }), 'wealth_craft_resolved') || current;
    if (!success) {
        await LifeEvents.record(current.characterId, 'wealth_craft_failed',
            `${current.name} failed to craft ${opportunity.template.template?.name || `item ${recipe.productId}`}`, {
                recipeId: recipe.recipeId, productId: recipe.productId,
                spent, inputValue: opportunity.basket.cost
            }, 1);
        return { state: current, crafted: false, reason: 'failed_roll' };
    }

    let sold = false;
    let revenue = 0;
    const exit = opportunity.exit;
    if (buyer && current.activity === 'shopping' && current.currentRegion === buyer.town) {
        // A buy ad is answered in its town (E45); elsewhere the product waits
        // for the bot's sale, which goes there when it pays (MarketPricing.disposition),
        // as it does when this bot's meeting on the ad was refused (meetingRefused).
        const offer = AfkTrade.offers(recipe.productId, AfkTrade.BUY, { characterId: current.characterId })
            .find((entry) => !Ready.meetingRefused(entry, current) && Number(entry.recordId) === Number(buyer.recordId)
                && Number(entry.lineId) === Number(buyer.lineId)
                && Number(entry.expectedRevision) === Number(buyer.expectedRevision)
                && Number(entry.price) === Number(exit.price)
                && Number(entry.count) > 0);
        const saleCount = Math.min(units, Number(offer?.count || 0));
        const productRow = (await Database.fetchItems(current.characterId, 'wealth_craft_product'))
            .find((item) => Number(item.selfId) === Number(recipe.productId)
                && Number(item.amount) >= saleCount && !item.equipped);
        if (offer && productRow) {
            try {
                const trade = await AfkTrade.sellToShop(current.characterId, offer.store, recipe.productId,
                    saleCount, { objectId: Number(productRow.id), lineId: offer.lineId,
                        expectedPrice: Number(offer.price), expectedRevision: offer.expectedRevision, coldState: current });
                if (trade.pending) return { state: LifeState.cachedState(current.characterId) || current, crafted: true, sold: false, pending: true, spent, revenue: 0 };
                const done = AfkTrade.committedTrade(trade, current.characterId);
                if (done.committed) {
                    const actualUnits = Number(trade.amount ?? trade.units ?? 0);
                    revenue = Number(trade.totalPrice ?? trade.received ?? 0);
                    sold = actualUnits >= units;
                    current = done.state || current;
                    if (done.hot) return { state: current, crafted: true, sold, spent, revenue, reason: 'bot_went_hot' };
                }
            } catch (_) {
                // The output remains in inventory for the normal sale policy.
            }
        }
    }
    const outcome = !buyer ? 'for_sale' : sold ? 'sold' : 'waiting_for_buyer';
    if (buyer) {
        const settled = withOutcome(current, opportunity, outcome,
            { spent, revenue, profit: sold ? revenue - Number(opportunity.basket.cost) : null,
                cashGain: sold ? revenue - spent : null });
        current = await LifeState.upsertState(settled, `wealth_craft_${outcome}`) || settled;
    }
    await LifeEvents.record(current.characterId, 'wealth_craft', `${current.name} crafted ${productName}${sold ? ` for ${revenue - Number(opportunity.basket.cost)} Adena profit` : ''}`, {
        recipeId: recipe.recipeId, productId: recipe.productId, spent, inputValue: opportunity.basket.cost, revenue,
        outcome, exit: exit.type
    }, sold ? 2 : 1);
    return { state: current, crafted: true, sold, spent, revenue, reason: outcome };
}

async function tryCraft(state) {
    if (!eligible(state)) return { state, crafted: false, reason: 'ineligible' };
    const characterId = Number(state.characterId);
    if (inFlight.has(characterId)) return { state, crafted: false, reason: 'in_flight' };
    inFlight.add(characterId);
    try {
        const decision = invoke('GameServer/Bot/Population/ColdSimulationCoordinator').economyDecisions.decided(state);
        const step = Shots.unpackStep(decision?.shot);
        if (!step?.wealth) return { state, crafted: false, reason: 'no_profit' };
        const book = await Workshops.knownFor(characterId);
        const refusal = {};
        const opportunity = recheck(state, step.wealth, book, refusal);
        if (!opportunity) return { state: await rejectAccepted(state, state, refusal), crafted: false, reason: 'no_profit' };
        return await execute(state, opportunity);
    } catch (error) {
        utils.infoWarn('BotWealth', 'wealth craft failed for %s: %s', state.name, error?.message || String(error));
        return { state: LifeState.snapshot(characterId) || state, crafted: false, reason: 'error' };
    } finally {
        inFlight.delete(characterId);
    }
}

module.exports = { eligible, tryCraft, execute, recheck, rejectAccepted };
