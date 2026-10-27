const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const { isNativeSource } = require('./TradeIntent');
const Diagnostics = require('./EconomyDiagnostics');
const BoardRules = require('../../AfkTrade/BoardRules');
const PriceDecision = invoke('GameServer/Bot/Economy/PriceDecision');
const TwinCluster = require('./TwinCluster');
const BoardLook = require('./BoardLook');
const { isServiceCrafter } = require('./CraftEligibility');
const nativeGoal = goal => isNativeSource(goal?.plan?.sourceType);

function templateFor(selfId) {
    return ItemTemplateIndex.find(DataCache.items, selfId) || null;
}

// A survival item's tranche: its kit cost at the bot's own unit price
// (EconomyContext.kitCost; 0 for any other item and without an economy).
// Decided once with the bid: the plan carries it, executePlan and the native
// bid check reuse it, never a second price.
function survivalCost(economy, selfId) {
    return Math.max(0, Math.round(Number(economy?.kitCost?.(selfId)) || 0));
}
// The money a goal's bids may spend: its funding terms and its tranche.
function goalMoney(state, goal, escrow = 0, economy = null) {
    return PurchaseFunding.spendable(state, escrow,
        { ...PurchaseFunding.goalTerms(goal), survivalCost: survivalCost(economy, goal?.target?.itemId) });
}

// Quantity reviews retain the native line's price unless the prepared
// purchase cap requires a fenced reprice: the price the DB will hold
// (Database reconcileBotBuyAdsUnsafe keeps a held line's price).
function heldPrice(line, owned, town) {
    const previous = owned.find(row => row.kind === 'buy_ad' && row.town === town
        && Number(row.selfId) === Number(line.selfId) && Number(row.enchant || 0) === Number(line.enchant || 0));
    return previous && withinCap(previous, line.purchaseCap) ? Number(previous.price) : Number(line.price);
}
// The escrow store's allowance: what its whole escrow (with its kit
// tranche) may hold of `state.adena` (wallet + escrow), the money queue's
// upper bound; storeLines and retainedLines read it, the DB checks the same.
function storeAllowance(state, kit) {
    return PurchaseFunding.spendable(state, 0, { upperBound: true, survivalCost: kit });
}
// Size each bid at its held price, with the same root priority and survival
// tranche as native admission, in the DB's order (Database
// reconcileBotBuyAdsUnsafe): `state.adena` is the money (wallet + escrow);
// the escrow store (custodyPolicy 0, leading) spends it line by line, each
// line within its terms on the money the lines before it left and within
// the store's allowance less its reserve so far; a meeting bid holds no
// cash and fits its terms on the money the store left; a plain bid spends.
// A line that does not fit shrinks or drops; the rest still publish.
// `certify` (main, executePlan): a row whose own price and count do not fit
// its terms there is a stale plan (economy_plan_bid_unfunded).
function retainedLines(state, lines, owned, town, { certify = false } = {}) {
    let money = PurchaseFunding.budget(state), storeTotal = 0, kit = 0;
    const result = [];
    for (const line of lines) {
        const price = heldPrice(line, owned, town), store = line.custodyPolicy === 0;
        const lineKit = Math.max(0, Number(line.survivalCost) || 0);
        const spendable = PurchaseFunding.spendable({ ...state, adena: money }, 0,
            { ...(line.intent ? { r: line.intent.valueRate, key: line.intent.key } : { itemId: line.selfId }), survivalCost: line.survivalCost });
        if (certify && Number(line.count) * Number(line.price) > spendable) throw Error('economy_plan_bid_unfunded');
        const available = Math.min(money, spendable,
            store ? storeAllowance(state, kit + lineKit) - storeTotal : Infinity);
        const count = Math.min(Number(line.count), Math.floor(available / price));
        if (!(count > 0)) continue;
        if (store) { storeTotal += count * price; kit += lineKit; }
        if (!line.intent || store) money -= count * price;
        result.push({ ...line, price, count,
            ...(line.intent ? { intent: { ...line.intent, amount: count, price } } : {}) });
    }
    return result;
}

function bidFor(state, goal, { money = Infinity, ...options } = {}) {
    // The selected goal already has a native store executor. It cannot re-enter the
    // public projection through a caller's legacy goal fallback.
    if (nativeGoal(goal)) return null;
    const selfId = Number(goal?.target?.itemId || 0);
    const template = templateFor(selfId);
    const basePrice = Number(template?.template?.price || 0);
    const adena = Math.max(0, Number(state?.adena || 0));
    if (!selfId || !template || basePrice <= 0 || adena <= 0
        || !invoke('GameServer/Items/ItemAcquisitionCatalog').hasSource(selfId)) return null;
    // Saved goals/watch rows cannot override the loaded quest classification.
    if (invoke('GameServer/Bot/Economy/ItemDisposition').isQuestItem({ selfId }, template)) return null;
    if (goal.type === 'upgrade_gear' && Number(template.etc?.slot || 0) > 0
        && Number(state?.inventory?.[String(selfId)]?.amount || 0) > 0) return null;

    // `state.adena` already holds the order's escrow (callers add it).
    // A survival item may spend its kit cost from the survival reserve.
    const kit = survivalCost(options.economy, selfId);
    const spendable = Math.min(money, PurchaseFunding.spendable(state, 0,
        { ...PurchaseFunding.goalTerms(goal, selfId), survivalCost: kit }));
    const requestedCount = goal.type === 'buy_craft_material'
        ? Math.max(1, Math.floor(Number(goal.target.amount) || 1))
        : 1;
    // The bid (group E): the bot's belief of the item and the mirror of its
    // ask; a buy intent's item is worth the intent's own worth (its share of
    // the root, TradeIntent.preparedProject; without one, its own belief's
    // centre), any other item its buy worth (BoardLook.buyWorth, the worth
    // the look reprices from, hot and cold): 0 = no use and NaN = unknown use
    // author no new bid, as the look raises no line on an unknown worth;
    // never more than it can spend on one unit: a bot short of the whole
    // amount asks for fewer units. MarketPricing.bid keeps this worth.
    const MarketPricing = invoke('GameServer/Bot/Economy/MarketPricing');
    const PriceBelief = invoke('GameServer/Bot/Economy/PriceBelief');
    // Production preparation may pass only the towns used by its recipe.
    // WTB compares all purchases over the wish's completed route table.
    const ctx = invoke('GameServer/Bot/Economy/MarketListingPolicy').traderContext(state, {
        ...options, tripCost: options.economy?.trip || options.tripCost
    });
    let worth;
    if (goal.intent?.key) worth = Number(goal.intent.worth);
    else {
        worth = BoardLook.buyWorth(ctx, selfId);
        if (!(worth > 0)) return null;
    }
    if (!(worth > 0)) {
        const belief = PriceBelief.prior(selfId, ctx);
        if (!belief) return null;
        worth = Math.exp(belief.mu);
    }
    const cap = Math.floor(Math.min(worth, spendable));
    const town = options.town || invoke('GameServer/Bot/Economy/MarketTownPolicy').targetTownForItems(state, [{ selfId }]);
    const chosen = MarketPricing.bid(selfId, ctx, { units: requestedCount, worth, cap,
        money: spendable, town,
        rollKey: ['bid', Number(state.characterId || 0), selfId, Number(goal.createdAt || goal.id || 0)] });
    if (!chosen) return null;
    const price = Math.floor(chosen.price);
    const count = Math.min(requestedCount, chosen.count ?? requestedCount, Math.floor(spendable / price));
    if (count <= 0) return null;
    return {
        selfId,
        name: goal.target.itemName || template.template?.name || `Item ${selfId}`,
        kind: template.template?.kind || '',
        rank: template.etc?.rank || 'none',
        price,
        count,
        purchaseCap: Math.min(cap, chosen.purchaseCap ?? Infinity),
        survivalCost: kit,
        pricing: chosen.pricing
    };
}

function linesFor(state, goal, { money = Infinity, watchList, ...options } = {}) {
    const goals = (watchList || require('../Population/ColdEconomyDecision').economyFor(state).watchList).map(row => ({ type: 'buy_craft_material',
        target: { itemId: row.itemId, amount: row.amount },
        intent: row, plan: { estimatedCost: row.worth, purpose: row.kind, valueRate: row.valueRate } }));
    if (!nativeGoal(goal) && !watchList?.some(row => row.key) && goal?.target?.itemId
        && !goals.some(row => row.target.itemId === goal.target.itemId)) goals.unshift(goal);
    const wallet = Number(state.adena || 0);
    // E303: the buy ads cap (store lines + meeting buy ads) is cut here; the later slices (ColdEconomyPlan.buyBatch, BotAfkMarketService) see at most that.
    const limit = BoardRules.BOT_SHOP_LINES + BoardRules.BOT_RECORDS.buy_ad;
    if (Diagnostics.active()) {
        Diagnostics.count('cap', 'buy_ads', 'check');
        if (goals.length > limit) {
            Diagnostics.count('cap', 'buy_ads', 'cut');
            Diagnostics.count('cap', 'buy_ads', 'dropped', goals.length - limit);
        }
    }
    const owned = options.board?.ownerLines?.(Number(state.characterId)) || [];
    const candidates = goals.slice(0, limit);
    const townFor = options.townFor || (items => invoke('GameServer/Bot/Economy/MarketTownPolicy').targetTownForItems(state, items));
    let town = townFor(candidates.map(candidate => ({ selfId: Number(candidate.target.itemId) })));
    // Rejected lines can change the grade/town of a mixed order. Price the
    // final town too, before publication; this loop only removes candidates.
    for (let pass = 0; pass <= limit; pass++) {
        const lines = [];
        for (const candidate of candidates) {
            const bid = bidFor({ ...state, adena: wallet }, candidate, { money: candidate.intent?.key ? Infinity : money, ...options, town });
            if (!bid) continue;
            const item = ItemTemplateIndex.find(DataCache.items, bid.selfId);
            lines.push({ selfId: Number(bid.selfId), name: bid.name, count: Number(bid.count), price: Number(bid.price),
                enchant: 0, slot: Number(item?.etc?.slot || 0), stackable: item?.etc?.stackable === true, pricing: bid.pricing,
                purchaseCap: bid.purchaseCap,
                ...(bid.survivalCost ? { survivalCost: bid.survivalCost } : {}),
                ...(candidate.intent?.key ? { intent: { ...candidate.intent, price: bid.price, amount: bid.count } } : {}) });
            // Conditional alternatives hold no cash until a native agreement.
        }
        // The escrow store, split at the prices the DB will hold, leads the
        // running budget, as main applies the rows (executePlan): a meeting
        // bid fits the wallet the store's escrow leaves, never the escrow itself.
        const held = lines.map(line => ({ ...line, price: heldPrice(line, owned, town) }));
        const retained = retainedLines(state, storeLines(state, held), owned, town);
        if (!retained.length || townFor(retained) === town) return retained;
        const ids = new Set(retained.map(line => line.selfId));
        for (let at = candidates.length - 1; at >= 0; at--) if (!ids.has(Number(candidates[at].target.itemId))) candidates.splice(at, 1);
        town = townFor(retained);
    }
    return [];
}

// A producer's (workshop or service crafter) recipe inputs (intent.recipeId)
// go to its escrow buy store (buy_ad custody 0): at most BOT_SHOP_LINES, one
// per root, while the store's whole escrow fits the money queue with its kit
// tranche. The rest are meeting bids (custody 1, BOT_RECORDS.buy_ad). Returns
// the lines store-first, each tagged with its custodyPolicy (linesFor runs it
// before retainedLines' budget; buyBatch counts the store rows).
function storeLines(state, lines, escrow = 0) {
    const producer = TwinCluster.entriesOf(state)?.length || isServiceCrafter(state);
    const budgetState = { ...state, adena: PurchaseFunding.budget(state, escrow) };
    const store = [], meetings = [], roots = new Set();
    let total = 0, kit = 0;
    for (const line of lines) {
        const cost = Number(line.count) * Number(line.price), lineKit = Math.max(0, Number(line.survivalCost) || 0);
        if (producer && Number(line.intent?.recipeId) > 0 && store.length < BoardRules.BOT_SHOP_LINES
            && !roots.has(line.intent.key) && total + cost <= storeAllowance(budgetState, kit + lineKit)) {
            store.push({ ...line, custodyPolicy: 0 }); roots.add(line.intent.key); total += cost; kit += lineKit;
        } else if (meetings.length < BoardRules.BOT_RECORDS.buy_ad) meetings.push({ ...line, custodyPolicy: 1 });
    }
    return [...store, ...meetings];
}

// A held bid { selfId, price } stays while it can fill and is within the
// prepared purchase cap (no cap = any): PriceDecision.heldBid keeps it.
function withinCap(line, cap) {
    return PriceDecision.heldBid(line.selfId, Number(line.price), cap) === null;
}

// The one answer to "does a buy goal's item come through the bot's own buy
// ad, not a trip": the worker's batch (ColdEconomyPlan.prepare, plan.travel)
// and the ads that batch left on the board (BotAfkMarketService.canTradeRemotely)
// hold a line for it. A purchase planned at a native store or from a ready
// player ask (NeedsEvaluator priceSource 'offer') is made where it stands.
function remoteBuy(goal, lines) {
    if (nativeGoal(goal) || goal?.plan?.sourceType === 'afk' && goal.plan.priceSource === 'offer') return false;
    const selfId = Number(goal?.target?.itemId || 0);
    return selfId > 0 && lines.some(line => Number(line.selfId) === selfId && Number(line.count) > 0);
}

module.exports = { survivalCost, goalMoney, bidFor, linesFor, retainedLines, storeLines, withinCap, remoteBuy };
