// Native shot decisions, shared by town reviews and the cold worker.
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const Basket = require('./WealthCraftPolicy');
const Profit = require('./CraftProfitPolicy');
const Price = require('./PriceDecision');
const Wealth = require('./WealthCraftDecision');
const PurchaseFunding = require('./PurchaseFunding');
const { canCraft } = require('./CraftEligibility');
const TradeIntent = require('./TradeIntent');
const Trip = require('./EconomicTrip');
const Crystals = require('./BotCrystallization');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const { CRYSTAL_IDS } = invoke('GameServer/Items/C4EnchantRules');
// The shot recipes: every recipe whose product is a D+ shop shot
// (ShotStock.gradedShopShot, the classifier MarketDemand reads), in recipe-id
// order. Recipe data is a restart input: built once, at the first read.
let shotRecipeIds = null;
function shotRecipes() {
    shotRecipeIds ||= Object.freeze(Object.values(Recipes.loadRecipeItems() || {})
        .filter(recipe => ShotStock.gradedShopShot(recipe.productId))
        .map(recipe => Number(recipe.recipeId)).sort((a, b) => a - b));
    return shotRecipeIds;
}
let townNames;
function townCode(town) {
    townNames ||= Object.values(require('../../World/TownRespawn').towns).map(row => row.name);
    return townNames.indexOf(town) + 1;
}
function townForCode(code) {
    townNames ||= Object.values(require('../../World/TownRespawn').towns).map(row => row.name);
    return townNames[Number(code) - 1] || null;
}
// The one packed identity of a craft's exit: a buyer line [record, line,
// price, revision] (the exit's board offer), own
// use [-1, units, unit hours, reserve] or a listing [-2, town code, price,
// forecast revision]. The producer root (WishProviders) and the step pack it.
function exitTuple(exit, ownReserve = 0) {
    const offer = exit?.offer;
    const tuple = offer ? [Number(offer.recordId), Number(offer.lineId), Number(exit.price),
        Number(offer.revision ?? offer.expectedRevision)] : exit?.type === 'use'
        ? [-1, Number(exit.ownUseUnits), Number(exit.ownUseUnitHours), ownReserve]
        : exit?.type === 'listing' ? [-2, townCode(exit.town), Number(exit.price),
            Number(exit.forecast?.authority?.revision)] : null;
    return tuple?.every(Number.isFinite) ? tuple : null;
}
function selectionFor(route) {
    if (!route) return null;
    const personal = route.context?.stock?.('shots') || route.personalStock;
    const ownReserve = Number(personal?.itemId) === Number(route.recipe.productId) ? Math.max(0, Number(personal.target || 0)) : 0;
    const exit = exitTuple(route.exit, ownReserve);
    const source = route.gear;
    let gear = null;
    if (source) {
        const quote = source.offer || source;
        const code = source.source === 'craft' ? Number(source.recipe?.recipeId) : source.source === 'owned' ? -1
            : source.source === 'npc' ? -2 : source.source === 'crystals' ? -3 : 0;
        gear = [Number(source.selfId), code, code === 0 ? Number(quote.recordId || 0) : townCode(source.town),
            code === 0 ? Number(quote.lineId || 0) : 0, Number(source.price || 0),
            code === 0 ? Number(quote.revision ?? quote.expectedRevision ?? 0) : 0];
    }
    return { recipeId: Number(route.recipe.recipeId), batches: Number(route.batches),
        ...(exit ? { exit } : {}), ...(gear ? { gear } : {}), ...(ownReserve > 0 ? { ownReserve } : {}) };
}
function availableMaterial(state, selfId) {
    const row = state.inventory?.[selfId];
    // The decision's shot craft takes what its split gave it: the focus part
    // only (the goals' claims guard sale and warehouse).
    return row ? Wealth.freeAmount(state, { ...row, selfId: Number(selfId) }, ItemDisposition.reservedEquipmentAmounts(state)) : 0;
}

function batchCount(state, candidate) {
    const ownCrystals = availableMaterial(state, candidate.crystalId);
    const potential = ownCrystals + Number(candidate.gear?.crystals || 0);
    const availableMp = Number(state.vitals?.mp || 0) - Number(candidate.gear?.recipe?.mpCost || 0);
    return Math.max(0, Math.min(Number(candidate.batches || 1),
        Math.floor(potential / candidate.requiredCrystals), Profit.mpBatches(availableMp, candidate.recipe)));
}

// The shot leaf: sizes one shot recipe's craft with the bounded basket
// iterator wealth uses, its crystals from crystals, held, bought or crafted
// gear (prepareCrystal) and its own use beside the sale. The producer root
// (WishProviders) picks the recipe and its exit; WealthCraftDecision.producerStep
// passes that exit (options.keepExit) and the root's money-queue ratio
// (options.r); main's recheck passes the step's exit alone. Source adapters
// provide one indexed quote/route per yield.
function* recipeShotSearch(state, recipe, context, options = {}) {
    const rank = ShotStock.SHOP_SHOT_RANK.get(Number(recipe.productId)), crystalId = CRYSTAL_IDS[String(rank).toUpperCase()];
    const output = options.itemTemplate?.(recipe.productId) || invoke('GameServer/Item/ItemTemplateIndex')
        .find(invoke('GameServer/DataCache').items, Number(recipe.productId));
    const required = new Map();
    for (const row of recipe.materials || []) {
        required.set(Number(row.selfId), Number(required.get(Number(row.selfId)) || 0) + Number(row.amount));
        yield 'ingredient';
    }
    const requiredCrystals = Number(required.get(crystalId) || 0);
    const oreRows = [];
    for (const entry of required) { if (entry[0] !== crystalId) oreRows.push(entry); yield 'ingredient'; }
    if (!output || !requiredCrystals || oreRows.length !== 1) return null;
    const [oreId, oreAmount] = oreRows[0], ore = { selfId: oreId, amount: oreAmount };
    const ownStock = options.ownStock || new Map();
    const ownFor = id => ownStock.get(Number(id)) || null;
    const trip = context.trip;
    // A producer step passes searchMemo: its shot rows and 1..64 batches
    // share the rank walks below, none of which depends on the missing
    // count. It lives as long as the step's iterator.
    const memo = options.searchMemo || null;
    // The first walk of a rank keeps the uncached walk's yields (one per row),
    // so no planner unit grows; later batches read the list without them.
    const perRank = function* (name, walk) {
        const key = `${name}:${rank}`;
        if (memo?.has(key)) return memo.get(key);
        const rows = yield* walk();
        memo?.set(key, rows);
        return rows;
    };
    const templateOf = id => options.itemTemplate?.(id) || invoke('GameServer/Item/ItemTemplateIndex')
        .find(invoke('GameServer/DataCache').items, Number(id));
    const gearKind = template => /^(Weapon|Armor)\./.test(String(template?.template?.kind || ''));
    // Null edges and own lines never pass consider; only the rest are held,
    // as the row and its score once a batch has scored it.
    const gearRows = function* () {
        const rows = [];
        for (const row of options.gearRowsFor?.(rank) || []) {
            yield 'edge';
            if (row && Number(row.ownerId) !== Number(state.characterId)) rows.push({ row, scored: undefined });
        }
        return rows;
    };
    const ownedRows = function* () {
        const rows = [];
        for (const [selfId, held] of ownStock) {
            yield 'stock';
            const template = templateOf(selfId);
            if (template?.etc?.rank === rank && gearKind(template)) rows.push([selfId, held, Number(template.etc.cristals)]);
        }
        return rows;
    };
    const scrapRows = function* () {
        const rows = [];
        for (const known of options.knownRecipes || []) {
            const scrap = Recipes.resolveByRecipeId(Number(known.recipeId ?? known));
            yield 'recipe';
            if (!canCraft(state, scrap, { sure: true }) || Number(scrap.productCount) !== 1
                || Profit.mpBatches(state.vitals?.mp, scrap) < 1) continue;
            const template = templateOf(scrap.productId);
            if (template?.etc?.rank === rank && gearKind(template)) rows.push({ scrap, template });
        }
        return rows;
    };
    // The batch-independent part of a crystal source: its trip and score.
    const scoreGear = function* (gear) {
        const details = ['owned', 'craft'].includes(gear.source) ? { known: true,
            hours: Number(gear.travelHours || 0), fees: 0 }
            : options.prepareTrip ? yield* options.prepareTrip(gear.town) : trip?.details?.(gear.town);
        yield 'trip';
        if (!details?.known) return null;
        const cash = Number(gear.cash ?? (gear.source === 'owned' ? 0 : gear.price));
        const ownedValue = Number(gear.ownedValue ?? Math.max(0, Number(gear.price) - cash));
        const mp = Number(gear.recipe?.mpCost || 0), processingHours = mp ? mp / Number(context.mpPerHour) : 0;
        if (!Number.isFinite(processingHours) || !Number.isFinite(cash) || cash < 0 || !Number.isFinite(ownedValue)) return null;
        const travel = Trip.price(details, Number(context.hourAdena));
        return { details, cash, ownedValue, mp, processingHours, travel,
            score: cash + ownedValue + travel + processingHours * Number(context.hourAdena) };
    };
    const prepareCrystal = function* (id, missing, allocation = {}) {
        const availableOwn = inputId => {
            const stock = ownFor(inputId);
            return stock ? { ...stock, count: Math.max(0, stock.count - Number(allocation.allocated?.get(inputId) || 0)) } : null;
        };
        let best = options.preparePurchase ? yield* options.preparePurchase(state, id, missing, { npc: false, cost: trip }) : null;
        if (best?.whole) best = { ...best, gear: { selfId: id, source: 'crystals', price: best.cost / missing,
            cash: best.cost, crystals: missing, town: best.town }, score: best.landed };
        else best = null;
        const take = (gear, scored) => {
            best = { town: gear.town, units: missing, whole: true,
                cost: scored.cash, ownedValue: scored.ownedValue, landed: scored.cash + scored.travel, tripDetails: scored.details,
                processingHours: scored.processingHours, extraMp: scored.mp, residualValue: 0, gear,
                score: scored.score, ownedInputs: gear.ownedInputs };
        };
        const consider = function* (gear) {
            if (!gear) return;
            if (Number(gear.ownerId) === Number(state.characterId) || Number(gear.crystals) < missing) return;
            const scored = yield* scoreGear(gear);
            if (scored && (!best || scored.score < best.score)) take(gear, scored);
        };
        // Gear (bought, held or crafted) turns into crystals only by the bot's
        // own Crystallize skill; without it only crystals themselves are bought.
        if (!Crystals.canSelf(state, rank)) return best;
        // Same order as the uncached walk: the strict score test keeps the first
        // best, and a row's trip is first read where that walk first read it.
        const gearSource = row => ({ ...row, cash: Number(row.price), ownedValue: 0 });
        const rows = yield* perRank('gear', gearRows);
        let scoredNow = false;
        for (const entry of rows) {
            if (Number(entry.row.crystals) < missing) continue;
            if (entry.scored === undefined) { entry.scored = yield* scoreGear(gearSource(entry.row)); scoredNow = true; }
            if (entry.scored && (!best || entry.scored.score < best.score)) take(gearSource(entry.row), entry.scored);
        }
        // A scored row can never be taken when it failed scoring, or when an
        // earlier scored row has at least its crystals and at most its score:
        // whenever it passes, that row passed first. Unscored rows stay.
        if (memo && scoredNow) {
            const kept = [], frontier = [];
            for (const entry of rows) {
                if (entry.scored === null) continue;
                if (entry.scored) {
                    const crystals = Number(entry.row.crystals), score = entry.scored.score;
                    if (frontier.some(other => Number(other.row.crystals) >= crystals && other.scored.score <= score)) continue;
                    frontier.push(entry);
                }
                kept.push(entry);
            }
            memo.set(`gear:${rank}`, kept);
        }
        for (const [selfId, held, crystals] of yield* perRank('owned', ownedRows)) {
            if (!(availableOwn(selfId)?.count > 0) || !(crystals >= missing)) continue;
            yield* consider({ selfId, source: 'owned', crystals, cash: 0,
                price: Number(held.unitValue), ownedValue: Number(held.unitValue), town: state.currentRegion,
                ownedInputs: [{ selfId, count: 1, unitValue: Number(held.unitValue) }] });
        }
        for (const { scrap, template } of yield* perRank('scraps', scrapRows)) {
            if (!(Number(template.etc.cristals) >= missing)) continue;
            const inputs = yield* Basket.ownCraftBasket(scrap, () => null, availableOwn, 1, {
                ...context, preparePurchase: (inputId, amount) => options.preparePurchase(state, inputId, amount, { npc: true, cost: trip }) });
            if (!inputs) continue;
            const materialInputs = [], materialAmounts = new Map(), inputQuotes = new Map();
            for (const purchase of inputs.purchases) { inputQuotes.set(purchase.selfId, purchase); yield 'quote'; }
            for (const row of scrap.materials || []) {
                materialAmounts.set(Number(row.selfId), Number(materialAmounts.get(Number(row.selfId)) || 0) + Number(row.amount));
                yield 'ingredient';
            }
            for (const [selfId, amount] of materialAmounts) {
                const purchase = inputQuotes.get(selfId);
                materialInputs.push({ selfId, amount, maxPrice: purchase ? purchase.cost / purchase.count : Infinity });
                yield 'ingredient';
            }
            yield* consider({ selfId: Number(scrap.productId), source: 'craft', recipe: scrap,
                crystals: Number(template.etc.cristals), cash: inputs.cash,
                price: inputs.cost, ownedValue: inputs.ownedValue, travelHours: inputs.travelHours,
                town: state.currentRegion, inputs: materialInputs, ownedInputs: inputs.owned,
                purchases: inputs.purchases });
        }
        return best;
    };
    const preparePurchase = (id, amount, allocation) => Number(id) === crystalId ? prepareCrystal(id, amount, allocation)
        : options.preparePurchase(state, id, amount, { npc: true, cost: trip });
    // Only the exit the caller keeps (the root's; any when none is given).
    const keep = options.keepExit || (() => true);
    const exits = (options.prepareExits ? yield* options.prepareExits(state, recipe, output, trip) : []).filter(keep);
    const personal = options.stock || context.stock?.('shots');
    const ownShots = Number(personal?.itemId) === Number(recipe.productId);
    const missing = ownShots ? Math.max(0, Number(personal.survivalMissing || 0) + Number(personal.missing || 0)) : 0;
    // One shot of own use: its share of the stock's benefit, at most buying
    // it at its market price (PriceBelief soldPrice through the context; 0
    // untraded: no ceiling), TradeIntent.inputValue, adena to hours.
    const hourAdena = Number(context.hourAdena);
    const ownUnitHours = ownShots ? TradeIntent.inputValue(Number(personal.benefitHours || 0)
        / Math.max(1, Number(personal.target || missing)), context.soldPrice(Number(recipe.productId)),
        hourAdena > 0 ? 1 / hourAdena : 0) : 0;
    const ownUse = missing && ownUnitHours > 0 ? { type: 'use', price: 0, count: 0, ownUseUnits: missing,
        ownUseUnitHours: ownUnitHours, residualUnitValue: 0 } : null;
    if (ownUse && keep(ownUse)) exits.push(ownUse);
    // The units of the product already made (Price.heldUnits): owned, incoming
    // unless the owned count holds them, and on the bot's own plain sell lines.
    const existingOutput = Price.heldUnits(ownFor(Number(recipe.productId))?.count,
        options.ownIncludesIncoming ? 0 : state.acceptedIncoming?.[recipe.productId],
        (options.ownLines || []).filter(line => line.selfId === Number(recipe.productId) && Price.plainSale(line)));
    const outputReserve = Number(personal?.itemId) === Number(recipe.productId)
        ? Math.max(0, Number(personal.target || 0) - Number(state.inventory?.[recipe.productId]?.amount || 0)
            - Number(state.acceptedIncoming?.[recipe.productId] || 0)) : 0;
    // A root's row spends at the root's money-queue ratio, the one rule of
    // every producer row (PurchaseFunding.goalTerms), in the worker and in
    // main's recheck of its step; without one, within the upper bound at the
    // step's own value ratio.
    const rooted = options.r !== undefined;
    const selected = yield* Basket.searchQuantity({ state: { ...state,
        adena: PurchaseFunding.spendable(state, 0, rooted ? { r: options.r } : { upperBound: true }) }, recipe, exits, ownedFor: ownFor,
        planFor: () => null, context: { ...context, existingOutput,
            outputReserve, reservedOutputUnitHours: ownUnitHours, preparePurchase } });
    if (!selected) return null;
    const cash = selected.basket.cashCost + selected.basket.actualCashFees;
    const r = rooted ? Number(options.r) : cash > 0 ? selected.valueHours / cash : Infinity;
    if (!rooted && cash > PurchaseFunding.spendable(state, 0, { r })) return null;
    const orePurchase = selected.basket.purchases.find(row => row.selfId === oreId);
    const crystalPurchase = selected.basket.purchases.find(row => row.selfId === crystalId);
    return { ...selected, output, rank, crystalId, requiredCrystals, ore,
        orePrice: orePurchase ? orePurchase.cost / orePurchase.count : Number(ownFor(oreId)?.unitValue || 0),
        gear: crystalPurchase?.source || null, salePrice: selected.exit.price,
        profit: selected.expectedProfit, cost: selected.basket.cost, demand: selected.exit.count,
        r, context, personalStock: personal };
}
// The command header reserves 59 B. Sparse tuples retain source identity in
// the remaining 69 B; exact public revisions let native rechecks recover the
// unchanged price/record from the same bounded indexed view.
function packStep(step) {
    const sparseExit = row => !row ? [] : row[0] === -2 ? [-Number(row[1]), Number(row[2]), Number(row[3])]
        : row[0] > 0 || row[0] == null ? [Number(row[1]), Number(row[3])]
        : [0, Number(row[1]), Number(row[2]), Number(row[3])];
    const sparseGear = row => !row ? [] : Number(row[1]) === 0 ? [Number(row[0]), 0, Number(row[3]), Number(row[5])]
        : Number(row[1]) === -2 ? [Number(row[0]), -2, Number(row[2]), Number(row[4])]
            : Number(row[1]) === -3 ? [Number(row[0]), -3, Number(row[2])] : [Number(row[0]), Number(row[1])];
    const tuple = action => {
        // r: the wealth step's value ratio, main funds its inputs at it.
        const r = Number.isFinite(Number(action.r)) && Number(action.r) > 0 ? Number(Number(action.r).toPrecision(6)) : 0;
        const row = [Number(action.recipeId), Number(action.batches)];
        if (action.exit || action.gear || action.ownReserve || r) row.push(sparseExit(action.exit));
        if (action.gear || action.ownReserve || r) row.push(sparseGear(action.gear));
        if (action.ownReserve) row.push(Number(action.ownReserve));
        if (action.scroll || r) {
            while (row.length < 5) row.push(null);
            row.push(action.scroll ? action.scroll.map(Number) : null);
        }
        if (r) row.push(r);
        return row;
    };
    if (step?.craft) return { craft: tuple(step.craft) };
    if (step?.recipeTarget && step.recipeRoute) return { recipeTarget: tuple(step.recipeRoute) };
    if (step?.wealth) return { wealth: tuple({ ...step.wealth, batches: step.wealth.batches || 1 }) };
    return step;
}
function unpackStep(step) {
    const action = row => {
        const result = { recipeId: Number(row[0]), batches: Number(row[1]) };
        if (Array.isArray(row[5])) result.scroll = row[5].map(Number);
        if (Array.isArray(row[2]) && row[6] > 0) result.r = Number(row[6]);
        if (Array.isArray(row[2])) {
            const exit = row[2], gear = row[3];
            if (exit.length === 2) result.exit = exit[0] > 0 ? [null, Number(exit[0]), null, Number(exit[1])]
                : [0, -Number(exit[0]), Number(exit[1]), 0];
            else if (exit.length === 3 && exit[0] < 0) result.exit = [-2, -Number(exit[0]), Number(exit[1]), Number(exit[2])];
            else if (exit.length === 4 && exit[0] === 0) result.exit = [-1, Number(exit[1]), Number(exit[2]), Number(exit[3])];
            if (Array.isArray(gear) && gear.length >= 2) result.gear = gear[1] === 0
                ? [Number(gear[0]), 0, null, Number(gear[2]), null, Number(gear[3])]
                : [Number(gear[0]), Number(gear[1]), Number(gear[2] || 0), 0, Number(gear[3] || 0), 0];
            if (row[4] > 0) result.ownReserve = Number(row[4]);
        } else {
            // Existing durable compact packets retain their former six fields.
            if (row.length >= 6 && !Array.isArray(row[5]) && (row[2] !== 0 || row[3] > 0)) result.exit = row.slice(2, 6).map(Number);
            if (row.length >= 12 && row[6] > 0) result.gear = row.slice(6, 12).map(Number);
            if (row.length === 13 && row[12] > 0) result.ownReserve = Number(row[12]);
        }
        return result;
    };
    if (Array.isArray(step?.craft)) return { craft: action(step.craft) };
    if (Array.isArray(step?.recipeTarget)) return { recipeTarget: Number(step.recipeTarget[0]), recipeRoute: action(step.recipeTarget) };
    if (Array.isArray(step?.wealth)) return { wealth: action(step.wealth) };
    if (typeof step?.wealth === 'number') return { wealth: { recipeId: step.wealth, batches: 1 } };
    return step;
}

module.exports = { get SHOT_RECIPE_IDS() { return shotRecipes(); },
    availableMaterial, batchCount, packStep, unpackStep,
    recipeShotSearch, exitTuple, selectionFor, townCode, townForCode };
