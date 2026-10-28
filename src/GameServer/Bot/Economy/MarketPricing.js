// One stateless board estimate and the unchanged expected-value decision
// for hot/cold trading. Only an author's open line keeps review cursors;
// own experience is counted by the actual trade transaction, not here.
const { SELL, BUY } = require('../../AfkTrade/BoardIndex');
const OfferOrder = require('./OfferOrder');
const PriceBelief = invoke('GameServer/Bot/Economy/PriceBelief');
const PriceDecision = invoke('GameServer/Bot/Economy/PriceDecision');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const MarketDemand = require('./MarketDemand');
const PriceLearning = invoke('GameServer/Bot/Economy/PriceLearning');
const Valuation = require('./EconomicValuation');
const Profit = require('./CraftProfitPolicy');
const BidPurchaseAlternative = require('./BidPurchaseAlternative');
const { npcOwnsPurchase } = require('./TradeIntent');
const { MAX_INSPECTED } = require('./ReadyTradeChoice');
const ColdEconomyDecision = require('../Population/ColdEconomyDecision');
const BoardLook = require('./BoardLook');
const Recipes = require('../../Items/C4RecipeItems');
const TwinCluster = require('./TwinCluster');
const Diagnostics = require('./EconomyDiagnostics');

// A bot as a trader: its persona's parameters, its hour and its money, its
// trips, and what its thread knows of the board. deps: { board, persona,
// npcOffersFor(selfId), findSpot(spotId), timestamp }.
function traderContext(state, deps = {}) {
    const timestamp = Number(deps.timestamp || Date.now());
    const economy = deps.economy || ColdEconomyDecision.economyFor(state, { ...deps, timestamp });
    const hour = economy.hourAdena;
    const adena = Math.max(0, Number(state?.adena ?? state?.inventory?.[57]?.amount ?? 0));
    const origin = deps.findSpot ? OfferOrder.farmingOrigin(state, deps.findSpot) : null;
    const economicTrip = deps.tripCost?.details ? deps.tripCost : economy.trip?.details ? economy.trip
        : Profit.tripFor(state, { ...economy, origin });
    const trip = economicTrip;
    const persona = deps.persona || economy.persona;
    const trader = PriceDecision.traderOf(persona, { hourAdena: hour, moneyPrice: economy.moneyPrice, gapHorizonHours: economy.gapHorizonHours });
    // The bot's own trip to a town: none to the town it is shopping in.
    const here = state?.activity === 'shopping' ? state.currentRegion || null : null;
    // The bot reading demand and price evidence: its own error on each.
    const board = deps.board || economy.board;
    const reader = { characterId: Number(state.characterId), understanding: trader.understanding,
        marketTrades: state.marketTrades || {} };
    // The census is read once per (context, item, town): a town choice asks
    // the same item at several prices. A holder sells goods in hand: no
    // rival plan's committed units are cut (no `producer`, MarketDemand.forecast).
    const forecasts = new Map();
    const forecastOf = (id, town) => {
        const key = `${id}:${town || ''}`;
        if (!forecasts.has(key)) forecasts.set(key, MarketDemand.forecast(id, town, timestamp, reader));
        return forecasts.get(key);
    };
    const demandFor = (id, enchant, town, askingPrice) => {
        const demand = !enchant ? forecastOf(id, town) : null;
        if (!demand || !(askingPrice > 0)) return demand;
        const belief = PriceBelief.prior(id, { board, timestamp, ...reader });
        if (!belief) return null;
        const market = PriceDecision.marketFor(id, { board, ownerId: state.characterId, town, timestamp,
            tripCost: trip, npcOffers: deps.npcOffersFor?.(id) || [], demand });
        return { ...demand, willingUnits: PriceDecision.willingUnitsAt(belief, trader,
            { price: askingPrice, applicableUnits: demand.applicableUnits,
                landed: askingPrice + market.ownTrip, npcLanded: market.npcLanded }) };
    };
    let saleAmounts = null;
    // Held for this context's life (one listing choice or review): the
    // twin's products.
    let products = null;
    const saleCount = line => {
        // Accepted custody keeps its advertised remainder until completion.
        if (line.storeType !== SELL || line.custodyPolicy !== 1 || state.stats?.tradeMeeting)
            return line.count;
        if (!saleAmounts) {
            const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
            const candidates = Disposition.saleCandidates(state, { unlimited: true,
                keptAmounts: {
                    ...invoke('GameServer/Inventory/ShotStock').keptAmounts(state, economy),
                    ...invoke('GameServer/Bot/AI/HealingPotionStock').keptAmounts(state, { targetAmount: economy.stock('potions').target }),
                    ...invoke('GameServer/Bot/Travel/ScrollStock').keptAmounts(state)
                } });
            saleAmounts = new Map(candidates.map(item => [`${item.selfId}:${item.enchant || 0}`, item.count]));
        }
        return Math.min(line.count, saleAmounts.get(`${line.selfId}:${line.enchant || 0}`) || 0);
    };
    return {
        state,
        characterId: Number(state?.characterId || 0),
        understanding: trader.understanding,
        persona,
        marketTrades: state?.marketTrades || {},
        knowledgeEnabled: deps.knowledgeEnabled ?? PriceLearning.knowledgeEnabled(),
        trader,
        economy,
        preparedWorth: deps.preparedWorth || ownWorth(economy),
        preparedBuffer: deps.preparedBuffer || null,
        preparedValue: economy.network?.demands && economy.projection?.values ? id => {
            const key = `item:${id}`;
            return economy.network.demands.has(key) ? economy.network.demands.get(key)
                : economy.projection.values.has(Number(id)) ? economy.projection.values.get(Number(id)) : NaN;
        } : null,
        moneyPrice: economy.moneyPrice,
        hour,
        adena,
        timestamp,
        board: deps.board || economy.board,
        npcOffersFor: deps.npcOffersFor || (() => []),
        purchaseNpcOffersFor: deps.purchaseNpcOffersFor || deps.npcOffersFor || (() => []),
        demandFor: deps.demandFor || economy.demandFor || demandFor,
        ownStock: deps.ownStock || economy.ownStock || null,
        canSell: line => invoke('GameServer/Items/ItemAcquisitionCatalog').hasSource(line.selfId)
            && !invoke('GameServer/Bot/Economy/ItemDisposition').isStarterEquipment(line)
            // Also withdraw legacy backed stock, which is no longer in the bag.
            && (state.stats?.tradeMeeting || !invoke('GameServer/Inventory/ShotStock').isPersonalShot(state, line.selfId))
            && deps.canSell?.(line) !== false,
        canBuy: line => invoke('GameServer/Items/ItemAcquisitionCatalog').hasSource(line.selfId)
            && (Number(line.enchant || 0) > 0 || !npcOwnsPurchase(economy, line.selfId)),
        ownProducts: () => products ??= ownProducts(state),
        saleCount: deps.saleCount || (typeof economy.stock === 'function' ? saleCount : null),
        tripCost: trip || null,
        travelDetails: (town) => town && town === here ? { known: true, hours: 0, fees: 0 }
            : economicTrip.details(town),
        travel: (town) => (town && town === here ? 0 : trip ? trip(town) : 0)
    };
}

// The best executable finite buy ad for this whole physical stock. The side
// that acts travels (E45); known economic inputs rank the same hours as the
// final action. `net` remains the legacy monetary trip comparison for callers.
function bestAnswer(selfId, ctx, { units = 1, enchant = 0, residualUnitValue = 0,
    reference = 0, caution = 0 } = {}) {
    let best = null;
    // Keep finite quantities among the observed candidates: a lower bid for
    // five units can beat the top bid for only one unit in the same town.
    // A bid, backed or conditional, is valued at its own price and count
    // (PriceDecision.prospectiveExit); the trade checks money.
    const lines = (ctx.board?.list(selfId, BUY) || []).slice(0, MAX_INSPECTED);
    const seller = { characterId: Number(ctx.characterId) };
    for (const line of lines) {
        if (line.ownerId === Number(ctx.characterId) || line.enchant !== Number(enchant || 0)) continue;
        const sale = PriceDecision.bidSale(seller, line, { board: ctx.board,
            timestamp: ctx.timestamp, units, residualUnitValue });
        const outcome = sale.after;
        if (sale.status !== 'ready' || !(outcome.sold > 0)) continue;
        const trip = ctx.travelDetails?.(line.town);
        const travel = ctx.travel ? ctx.travel(line.town) : 0;
        const net = outcome.receipts + outcome.residualValue - travel;
        if (trip && !trip.known || !Number.isFinite(net)) continue;
        const moneyPrice = Number(ctx.moneyPrice ?? ctx.economy?.moneyPrice);
        const valued = Valuation.opportunity({ moneyPrice }, [{ probability: 1,
            receipts: outcome.receipts, monetaryResidual: outcome.residualValue,
            actualCashFees: trip ? trip.fees : Math.max(0, travel),
            foregoneBenefitHours: trip ? trip.hours : 0, cycleHours: trip ? trip.hours : 0,
            riskHours: Math.max(0, reference - line.price) * outcome.sold * caution * moneyPrice }]);
        const score = valued.known ? valued.valueHours : net;
        if (!best || score > best.score) best = { line, count: Math.min(units, line.count), net, outcome, trip,
            valueHours: valued.valueHours, score };
    }
    return best;
}

function beliefFor(selfId, ctx, enchant = 0) {
    const belief = PriceBelief.prior(selfId, ctx);
    if (!belief || !(enchant > 0)) return belief;
    if (typeof ctx.economy?.price !== 'function') return null;
    const item = { selfId:Number(selfId), amount:1, enchant:Number(enchant) };
    const cost = invoke('GameServer/Bot/Economy/BotImprovementPolicy').enchantedPrice(item,enchant,ctx.economy);
    if (!(cost > 0) || !Number.isFinite(cost)) return null;
    // The full replacement/scroll chain prices this actual enchant; ordinary
    // NPC stock and +0 rivals are not interchangeable with it. A wished
    // piece's bid is its buyer's tool, no source (PriceBelief.mixtureOf, T84).
    const quotes = [ctx.board?.first(selfId,SELL,{excludeOwner:ctx.characterId,enchant}),
        MarketDemand.forecastOnly(selfId) ? null : ctx.board?.first(selfId,BUY,{excludeOwner:ctx.characterId,enchant})]
        .filter(row => row?.price > 0);
    return { ...belief, mu:(Math.log(cost) * belief.K + quotes.reduce((n,row) => n + Math.log(row.price),0))
        / (belief.K + quotes.length), K:belief.K + quotes.length };
}
// A fresh ask for this choice; nothing is read from saved item memory.
function priceForSale(selfId, ctx, { town = null, units = 1, enchant = 0, current = 0, rollKey }) {
    const belief = beliefFor(selfId, ctx, enchant);
    if (!belief) return null;
    const market = marketFor(selfId, ctx, { town, units, enchant });
    return { belief, market, ask: PriceDecision.chooseAsk(belief, market, ctx.trader, rollKey, current) };
}

function marketFor(selfId, ctx, { town = null, units = 1, enchant = 0 } = {}) {
    const stock = ctx.ownStock?.groups?.get(`${Number(selfId)}:${Number(enchant)}`);
    return PriceDecision.marketFor(selfId, {
        board: ctx.board, ownerId: ctx.characterId, town, units, enchant, tripCost: ctx.tripCost,
        npcOffers: ctx.npcOffersFor(selfId), timestamp: ctx.timestamp,
        demand: ctx.demandFor?.(Number(selfId), Number(enchant), town) || null,
        ownUnits: stock?.units ?? units,
        // Different accepted own asks have no declared common exposure. A
        // failed physical preparation cannot become a smaller profitable lot.
        jointKnown: ctx.ownStock?.known !== false && !(stock?.prices?.size > 1)
    });
}

// A bot's store line (shop SELL, sell ad) is only for a worthwhile item (user
// 2026-10-22, 2026-10-23): a recipe scroll or a gear piece of grade D and up
// (MarketCounters.counterOf), its own product (a recipe its workshop offers,
// TwinCluster.entriesOf), an item another owner's BUY line asks for (any
// enchant), or one with forecast demand anywhere (MarketDemand.forecast, town
// null: one answer for a listing choice, a kept line and a line's look, read
// through the context's demandFor memo). Whether a worthwhile item lists or
// goes to the NPC is the value check of disposition alone. Any other item goes
// to the NPC, into a buy ad, or stays. Read live at each listing choice and
// review: the board, the census and the twin are the thread's current ones (a
// traderContext holds the twin's products and its forecasts for its own
// life); the item's class is static.
function quotable(selfId, ctx) {
    const id = Number(selfId);
    const kind = MarketCounters.counterOf(id);
    const reason = kind.startsWith('recipe ') ? 'recipe'
        : kind.startsWith('gear ') && kind !== 'gear none' ? 'gear'
            : (ctx.ownProducts?.() ?? ownProducts(ctx.state)).has(id) ? 'own'
                : ctx.board?.first(id, BUY, { excludeOwner: ctx.characterId }) ? 'buy'
                    : ctx.demandFor?.(id, 0, null)?.applicableUnits > 0 ? 'forecast' : null;
    if (Diagnostics.active()) Diagnostics.count('worthwhile', reason ? 'pass' : 'refused', reason || 'none');
    return reason !== null;
}
function ownProducts(state) {
    const products = new Set();
    for (const entry of TwinCluster.entriesOf(state) || []) {
        const productId = Number(Recipes.resolveByRecipeId(entry.recipeId)?.productId);
        if (productId) products.add(productId);
    }
    return products;
}

// Publication and every completed review checkpoint exactly this line's
// state, even when its standing price remains among the near-best choices.
function lineState(selfId, ctx, { price, storeType = SELL, worth = 0, fills = 0, enchant = 0,
    count = 0, sigma = 0 }) {
    const counter = MarketCounters.counter(MarketCounters.counterOf(selfId), ctx.timestamp);
    const belief = sigma > 0 ? null : beliefFor(selfId, ctx, enchant);
    return {
        price: Math.round(price),
        seenCounter: counter.deals,
        seenAt: ctx.timestamp,
        seenItem: MarketCounters.itemDeals(selfId).deals,
        rival: ctx.board?.first(selfId, storeType, { excludeOwner: ctx.characterId, enchant })?.price || 0,
        worth: storeType === BUY ? Number(worth) || 0 : 0,
        seenFills: Math.max(0, Number(fills) || 0),
        seenCount: Math.max(0, Number(count) || 0),
        sigma: Number.isFinite(sigma) && sigma > 0 ? sigma : belief ? PriceBelief.sigma(belief) : 0
    };
}

// The one owner of what a bot does with an owned stock (user rule R2, one
// price rule for all bots, 2026-10-24): list it on the board when that pays
// more than selling to the NPC, else sell to the NPC; keeping it (room > 0,
// a warehouse) or answering a public bid compete in the same hours. The
// board's net is the ask's money per unit (PriceDecision.chooseAsk, known
// demand), for a worthwhile item only (quotable); the NPC's is the buy-back
// (PriceDecision.buyback). A sale below the bot's own value weighs that loss
// by caution, keeping has none. The best value wins, no roll: R2 is a hard
// rule. An ask of unknown demand over the buy-back has no receipts to weigh:
// it takes the place of the NPC or keeping when one of them wins (R2), never
// of a bid answer that wins, and its gain is 0, below every known listing's.
// Returns { action, priced, answer, gain, next }: gain = the listing's Adena
// over the NPC for the whole stock (the board slots rank by it,
// MarketListingPolicy.prioritizeListings), next = the best answer without the
// board (a listing that loses its slot). standingPrice: the bot's own line's
// ask; answers false: no bid answer (backed custody stays native).
function disposition(item, ctx, { town = null, room = 1, standingPrice = 0, answers = true, rollKey }) {
    const units = Math.max(1, Number(item.count) || 1);
    const priced = priceForSale(item.selfId, ctx, { town, units, enchant: item.enchant || 0,
        current: standingPrice, rollKey: [...rollKey, 'ask'] });
    // With no room to keep (room 0: an adventurer), what has no other
    // answer goes to the NPC.
    const fallback = { action: room > 0 ? 'keep' : 'npc', answer: null };
    if (!priced) {
        // No belief: a standing ask over the buy-back stands, as chooseAsk
        // keeps it with unknown demand (its own look moves it, look).
        const floor = PriceDecision.buyback(item.selfId);
        return PriceDecision.aboveBuyback(standingPrice, floor) && quotable(item.selfId, ctx)
            ? { action: 'list', answer: null, priced: null, gain: 0, next: fallback }
            : { ...fallback, priced: null, gain: 0, next: fallback };
    }
    const { ask, market, belief } = priced;
    const useful = ctx.economy?.worth?.(item.selfId);
    const reference = Math.exp(belief.mu);
    const moneyPrice = Number(ctx.moneyPrice ?? ctx.economy?.moneyPrice);
    const options = [];
    const add = (action, fields, answer = null) => {
        const result = Valuation.opportunity({ moneyPrice, discountRate: ctx.trader.wait }, [{ probability: 1, ...fields }]);
        if (result.known) options.push({ action, value: result.valueHours, answer });
    };
    const loss = (price, count) => Math.max(0, reference - price) * count * ctx.trader.caution * moneyPrice;
    // The exit is the buy-back, not the exit floor (BotCrystallization.exitFloor):
    // a held piece's crystal exit is the crystal root's question, whose claims
    // keep the spares it breaks (T89 1a: a floor here sent every Artisan's
    // gear to the NPC at the buy-back).
    add('npc', { receipts: market.buyback * units, riskHours: loss(market.buyback, units) });
    if (room > 0) add('keep', { monetaryResidual: units * (useful > 0 ? useful : market.buyback) });
    let gain = 0, quote = false;
    if (!ask.npc && quotable(item.selfId, ctx)) {
        if (ask.known) {
            // ask.money is per unit of the whole own stock (market.units).
            add('list', { receipts: ask.money * units,
                riskHours: loss(ask.price, Number(ask.sold || 0) * units / market.units) });
            gain = (ask.money - market.buyback) * units;
        } else quote = true;
    }
    if (answers) {
        const residualUnitValue = useful > 0 && room > 0 ? useful : market.buyback;
        const answer = bestAnswer(item.selfId, ctx, { units, enchant: item.enchant, residualUnitValue,
            reference, caution: ctx.trader.caution });
        if (answer && (Number.isFinite(answer.valueHours) ? answer.valueHours > 0 : answer.net > 0)) {
            const fields = { receipts: answer.outcome.receipts, monetaryResidual: answer.outcome.residualValue,
                riskHours: loss(answer.line.price, answer.outcome.sold) };
            if (answer.trip) Object.assign(fields, { actualCashFees: answer.trip.fees,
                foregoneBenefitHours: answer.trip.hours, cycleHours: answer.trip.hours });
            else fields.actualCashFees = Math.max(0, ctx.travel?.(answer.line.town) || 0);
            add('ad', fields, { line: answer.line, count: answer.count, receipts: answer.outcome.receipts });
        }
    }
    // The first of equal values wins: a listing that only matches the NPC does not pay more.
    let chosen = null, next = null;
    for (const option of options) {
        if (!chosen || option.value > chosen.value) chosen = option;
        if (option.action !== 'list' && (!next || option.value > next.value)) next = option;
    }
    const exit = (option) => option ? { action: option.action, answer: option.answer } : fallback;
    if (quote && exit(chosen).action !== 'ad') return { action: 'list', answer: null, priced, gain: 0, next: exit(next) };
    return { ...exit(chosen), priced, gain: chosen?.action === 'list' ? gain : 0, next: exit(next) };
}

// The economy's own worth of an item (its usefulness over the money price):
// NaN when the economy has no demand row or projected value for it, so a buy
// intent's input keeps the intent's worth instead of a usefulness of 0.
function ownWorth(economy) {
    if (economy?.network?.demands && economy.projection?.values) return id => economy.network.demands.has(`item:${id}`)
        || economy.projection.values.has(Number(id)) ? economy.worth(id) : NaN;
    return typeof economy?.worth === 'function' && !economy.price ? id => economy.worth(id) : null;
}

// A buy ad keeps authored worth with its line (BuyAdPolicy.bidFor decides
// it); the next ad starts fresh.
function bid(selfId, ctx, { units = 1, worth, cap, money = ctx.adena, town = null, rollKey }) {
    if (ctx.canBuy?.({ selfId, enchant: 0 }) === false) return null;
    const belief = PriceBelief.prior(selfId, ctx);
    if (!belief) return null;
    const meeting = ctx.travelDetails?.(town);
    if (town && !meeting?.known) return null;
    const spendable = Number.isFinite(money) ? Math.max(0, money - (meeting?.known ? meeting.fees : 0)) : money;
    cap = Math.min(cap, spendable);
    // A short wallet may reduce the order. Compare alternatives for that
    // actual quantity too; scarce cheap stock can cover the smaller order.
    for (let pass = 0; pass < 4; pass++) {
        const market = marketFor(selfId, ctx, { units, town });
        market.purchaseCap = BidPurchaseAlternative.cap(selfId, ctx, { units, town, money });
        const chosen = PriceDecision.chooseBid(belief, market, ctx.trader, { worth, cap }, rollKey);
        if (!chosen) return null;
        const count = Number.isFinite(spendable) ? Math.min(units, Math.floor(spendable / chosen.price)) : units;
        if (count === units) return { ...chosen, count, purchaseCap: market.purchaseCap, pricing: lineState(selfId, ctx, { price: chosen.price, storeType: BUY, worth,
            count, sigma: PriceBelief.sigma(belief) }) };
        if (!(count > 0)) return null;
        units = count;
    }
    return null;
}

// Only lines selected by the owner's shared attention roll reach this choice.
// Native writes retain revision + previousPricing fences; an unchanged price
// returns no update. Its observation stays in the worker's numeric lookSeen.
function look(state, lines, ctx) {
    const reprices = [];
    const withdrawals = [];
    for (const line of lines) {
        if (!(line.count > 0) || !line.pricing) continue;
        if (line.ownerId && Number(line.ownerId) !== Number(ctx.characterId)) continue;
        // Source admission is independent of price noise or a retained quote:
        // the native withdrawal owner returns only this line's held remainder.
        const move = { recordId: line.recordId, lineId: line.lineId, selfId: line.selfId,
            expectedRevision: line.revision, previousPricing: { ...line.pricing } };
        if (!invoke('GameServer/Items/ItemAcquisitionCatalog').hasSource(line.selfId)) {
            withdrawals.push(move); continue;
        }
        const count = ctx.saleCount?.(line);
        if (line.storeType === SELL && line.custodyPolicy === 1 && Number.isSafeInteger(count) && count < line.count) {
            if (!count) withdrawals.push(move);
            else reprices.push({ ...move, price: line.price, count,
                pricing: { ...line.pricing, seenCount: count } });
            continue;
        }
        const counter = MarketCounters.counter(MarketCounters.counterOf(line.selfId), ctx.timestamp);
        const reason = Number(ctx.reviewReasons?.get(line.lineId) || 0);
        const forced = Boolean(reason & 14);
        if (!forced && !(reason & 1) && counter.deals <= line.pricing.seenCounter) continue;
        // A store line holds only a worthwhile item (quotable), hot or cold;
        // checked like the price, at an event (a deal, a board change, a
        // forced reason), never on a look without one.
        if (line.storeType === SELL && !quotable(line.selfId, ctx)) { withdrawals.push(move); continue; }
        if (line.storeType === SELL && ctx.canSell?.(line) === false) { withdrawals.push(move); continue; }
        if (line.storeType === BUY && ctx.canBuy?.(line) === false) { withdrawals.push(move); continue; }
        const purchaseCap = line.storeType === BUY
            ? ctx.purchaseCaps?.get(line.lineId) ?? BidPurchaseAlternative.forLine(line, ctx) : undefined;
        const belief = beliefFor(line.selfId, ctx, line.enchant || 0);
        if (!belief) {
            // No price prior: no reprice, but the bid cap needs none; a bid
            // over its outside purchase or its cash still withdraws.
            if (line.storeType === BUY && BidPurchaseAlternative.lineLimit(line, ctx, purchaseCap) === 0)
                withdrawals.push(move);
            continue;
        }
        const learned = PriceBelief.learn(belief, PriceBelief.lineObservations(line, belief, ctx));
        const market = marketFor(line.selfId, ctx, { town: line.town, units: line.count, enchant: line.enchant || 0 });
        if (line.storeType === BUY) market.purchaseCap = purchaseCap;
        const acceptedSigma = line.pricing.sigma > 0 ? line.pricing.sigma : PriceBelief.sigma(belief);
        // Keep the accepted baseline through noise: new observations refresh
        // evidence, but never turn every small quote move into another roll.
        const rival = ctx.board?.first(line.selfId, line.storeType, { excludeOwner: ctx.characterId,
            enchant: line.enchant || 0 });
        const movement = rival?.price > 0 && line.pricing.rival > 0
            ? Math.abs(Math.log(rival.price / line.pricing.rival))
            : Math.abs(belief.mu - Math.log(line.pricing.price || line.price));
        if (!forced && reason & 1 && movement < acceptedSigma && !(line.price > market.purchaseCap)) continue;
        const rollKey = [line.storeType === BUY ? 'bid' : 'ask', ctx.characterId,
            line.lineId, line.selfId, counter.deals, line.fills || 0];
        let chosen;
        let worth = line.pricing.worth;
        if (line.storeType === BUY) {
            worth = BoardLook.buyWorth(ctx, line.selfId);
            if (!Number.isFinite(worth) || worth < 0) {
                // Unknown new usefulness cannot author additional spend. A
                // confirmed cheaper purchase/funding limit can still reduce
                // an old bid while its original authored worth is retained.
                const lowered = BidPurchaseAlternative.lineLimit(line, ctx, market.purchaseCap);
                if (lowered === null) continue;
                worth = line.pricing.worth;
                chosen = lowered ? { price: lowered } : null;
            } else {
                const cap = Math.floor(Math.min(worth, BidPurchaseAlternative.cashCap(line, ctx)));
                chosen = PriceDecision.chooseBid(belief, market, ctx.trader, { worth, cap }, rollKey, line.price);
            }
            if (!chosen) {
                withdrawals.push(move);
                continue;
            }
        }
        else {
            chosen = PriceDecision.chooseAsk(belief, market, ctx.trader, rollKey, line.price);
            if (!chosen.known) {
                // Only the line's own evidence (a visit pass, fills, passed deals)
                // moves an ask of unknown demand: the belief's new centre (the
                // learned belief, chooseAsk without the standing ask); a bare
                // prior would undo the last step. It is never withdrawn: when
                // the centre is not over the buy-back it holds, as the sale
                // owner holds it (disposition keeps a standing ask of unknown
                // demand), so no list-withdraw-list loop.
                if (!learned) continue;
                chosen = PriceDecision.chooseAsk(belief, market, ctx.trader, rollKey);
                if (chosen.npc) continue;
            }
            if (chosen.npc) { withdrawals.push(move); continue; }
        }
        const pricing = lineState(line.selfId, ctx, { price: chosen.price, storeType: line.storeType,
            worth, fills: line.fills, enchant: line.enchant || 0,
            count: line.count, sigma: PriceBelief.sigma(belief) });
        if (chosen.price !== line.price) reprices.push({ ...move, price: chosen.price, pricing });
    }
    return reprices.length || withdrawals.length ? { reprices, withdrawals } : null;
}

function lookOwn(state, lines, ctx, lookSeen) {
    return BoardLook.review(state, lines, ctx, lookSeen);
}

module.exports = { beliefFor, traderContext, ownWorth, priceForSale, lineState, bestAnswer, disposition, bid, look, lookOwn, quotable };
