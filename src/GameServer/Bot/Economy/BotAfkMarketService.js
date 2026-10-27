const ClassProgression = invoke('GameServer/ClassProgression');
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const MarketTownPolicy = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const GoalService = invoke('GameServer/Bot/Goals/GoalService');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const TwinCluster = require('./TwinCluster');
const ShopPlaces = invoke('GameServer/Bot/Economy/ShopPlaces');
const MarketPricing = invoke('GameServer/Bot/Economy/MarketPricing');
const PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const LotPolicy = require('./MarketLotPolicy');
const Diagnostics = require('./EconomyDiagnostics');
const EconomyCommit = require('./EconomyCommit');
const { marketStoreTitle, marketBuyStoreTitle } = invoke('GameServer/Bot/Economy/MarketStoreTitle');

const BoardRules = require('../../AfkTrade/BoardRules');
const ColdEconomyDecision = require('../Population/ColdEconomyDecision');
const ReadyTradeChoice = require('./ReadyTradeChoice');
const ShotCraftPolicy = require('./ShotCraftPolicy');
const ColdShotEconomyService = require('./ColdShotEconomyService');
const TradeMeetingService = require('../../AfkTrade/TradeMeetingService');
const BuyAdPolicy = require('./BuyAdPolicy');
const { heldBid } = require('./PriceDecision');
const MAX_LINES = BoardRules.BOT_SHOP_LINES;

function desiredSide(goal) {
    if (goal?.status && goal.status !== 'active') return 0;
    if (goal?.type === 'sell_inventory' && goal.plan?.expectedBenefit === 'market_sale_inventory'
        && !goal.target?.cleanupReason && !goal.plan?.cleanupReason) return AfkTrade.SELL;
    if (goal?.type === 'upgrade_gear'
        && goal.plan?.expectedBenefit === 'market_search_for_gear') return AfkTrade.BUY;
    if (goal?.type === 'buy_craft_material'
        && goal.plan?.expectedBenefit === 'market_buy_craft_material') return AfkTrade.BUY;
    return 0;
}

// Adena reserved by the bot's escrow buy store (buy_ad custody 0) remains
// part of its budget when reviewing or replacing its bids.
function buyOrderEscrow(characterId) {
    return AfkTrade.ownerRecords(characterId).reduce((sum, record) => (
        Number(record.storeType) === AfkTrade.BUY ? sum + Math.max(0, Number(record.escrowAdena || 0)) : sum
    ), 0);
}

// The escrow store and the meeting bids are one kind (buy_ad) and follow the
// same need and withdrawal lifecycle.
function buyAds(characterId) {
    return AfkTrade.ownerRecords(characterId).filter((record) => record.kind === 'buy_ad');
}

// The held buy ads ask for the same items, counts and custody: their prices
// are the bot's own look's (MarketPricing.look), kept while within the
// prepared cap; a prepared cheaper price is a limit, not a reprice.
function sameBuyOrder(held, lines) {
    return held.length === lines.length && held.every(ad => lines.some(wanted => lineKey(wanted) === lineKey(ad.lines[0])
        && Number(ad.custodyPolicy) === Number(wanted.custodyPolicy) && Number(ad.lines[0].count) === Number(wanted.count)
        && BuyAdPolicy.withinCap(ad.lines[0], wanted.purchaseCap)));
}

function linesOf(records) {
    return records.flatMap((record) => (record.lines || []).filter((line) => Number(line.count) > 0));
}

// A far bot whose board records main may move on its behalf.
function remoteTrader(state) {
    return !!state && state.phase === 'cold'
        && (state.stats?.generatedCold === true || String(state.accountName || '').startsWith('bot_'));
}

function canTradeRemotely(state, goal) {
    const side = desiredSide(goal);
    if (!remoteTrader(state) || !side) return false;
    // The worker decided it: its batch bids for the goal item or the goal
    // travels (BuyAdPolicy.remoteBuy); the ads main published from that
    // batch carry the answer here, no bid is built on main.
    if (side === AfkTrade.BUY) return BuyAdPolicy.remoteBuy(goal, linesOf(buyAds(state.characterId)));
    // Opening a shop needs the seller in its town (user, 2026-10-05): only a
    // bot that has its shop sells from afar.
    return hasShop(state.characterId);
}

function hasShop(characterId) {
    return Number(AfkTrade.findOwnerProjection(characterId)?.shop?.storeType) === AfkTrade.SELL;
}

function appearance(row, items) {
    const classInfo = ClassProgression.firstClassRow(DataCache.classTemplates || [], row.classId);
    return {
        model: { ...row, ...utils.crushOb(classInfo || {}) },
        paperdoll: utils.tupleAlloc(16, {}),
        items: items.filter((item) => Number(item.equipped) === 1)
            .map((item) => ({ ...item, equipped: true }))
    };
}

function viableSellLine(line) {
    return LotPolicy.viable(line)
        && invoke('GameServer/Items/ItemAcquisitionCatalog').hasSource(line.selfId);
}

async function publishPrunedSellShop(shop, kept, town = shop.town, loc = shop) {
    if (!kept.length) return AfkTrade.stop(shop.ownerId);
    return AfkTrade.publishBot(shop.ownerId, {
        storeType: AfkTrade.SELL,
        title: marketStoreTitle(kept),
        town,
        locX: loc.locX, locY: loc.locY, locZ: loc.locZ,
        head: shop.head,
        appearance: shop.appearance,
        lines: kept.map((line) => ({
            ...line, objectId: line.sourceObjectId,
            stackable: Number(line.stackable) === 1
        }))
    });
}

async function pruneResourceLots(ownerId) {
    const shop = AfkTrade.findOwnerProjection(ownerId)?.shop;
    if (!shop || !String(shop.ownerAccount || '').startsWith('bot_')
        || Number(shop.storeType) !== AfkTrade.SELL) return { changed: false };
    const lines = (shop.lines || []).filter((line) => Number(line.count) > 0);
    const kept = lines.filter(viableSellLine);
    if (kept.length === lines.length) return { changed: false };
    await publishPrunedSellShop(shop, kept);
    return { changed: true, removed: lines.length - kept.length, closed: kept.length === 0 };
}

const lineKey = line => `${Number(line.selfId)}:${Number(line.enchant || 0)}`;
function stateWithEscrow(state, stock) {
    if (Number(stock?.storeType) !== AfkTrade.SELL) return state;
    const combined = { ...(state.inventory || {}) };
    for (const line of stock.lines || []) {
        const selfId = Number(line.selfId || 0);
        const count = Math.max(0, Number(line.count || 0));
        if (!selfId || !count) continue;
        const template = ItemTemplateIndex.find(DataCache.items, selfId);
        const previous = combined[String(selfId)] || {};
        combined[String(selfId)] = {
            ...previous, selfId, name: line.name || previous.name || template?.template?.name,
            kind: previous.kind || template?.template?.kind,
            rank: previous.rank || template?.etc?.rank,
            amount: Math.max(0, Number(previous.amount || 0)) + count,
            enchant: Math.max(Number(previous.enchant || 0), Number(line.enchant || 0)),
            instances: [...(previous.instances || []), {id:Number(line.sourceObjectId || line.objectId),amount:count,
                equipped:false,slot:line.slot,enchant:Number(line.enchant || 0)}]
        };
    }
    return { ...state, inventory: combined };
}

// The bot's shop lines and what it lists past them (sell ads), from the
// sale decision (MarketListingPolicy.evaluate) on its bag and its shop: a kept
// line keeps its price (the bot's own look reprices it, MarketPricing.look); a new
// one is listed at the bot's ask. The listings of the largest gain over the NPC fill
// the shop first; the rest become ads. Returns { lines, listed, listings }.
function sellLines(state, stock, inventory, evaluateOptions = {}) {
    const existing = stock?.storeType === AfkTrade.SELL
        ? stock.lines.filter((line) => Number(line.count) > 0).map((line) => ({
            objectId: Number(line.sourceObjectId || 0),
            selfId: Number(line.selfId),
            name: line.name,
            count: Number(line.count),
            price: Number(line.price),
            enchant: Number(line.enchant || 0),
            slot: Number(line.slot || 0),
            stackable: Number(line.stackable) === 1,
            petData: line.petData || null,
            fills: Number(line.fills || 0),
            pricing: line.pricing
        })) : [];
    const classified = evaluateOptions.decided || decide(state, stock, existing, evaluateOptions);
    const listings = classified.listings;
    const remaining = new Map(listings.map((item) => [lineKey(item), Number(item.count)]));
    const listed = new Map((classified.decisions || [])
        .filter((decision) => decision.action === 'list')
        .map((decision) => [lineKey(decision.item), decision]));
    const next = [];
    const keepExisting = (line) => {
        if (next.length >= MAX_LINES) return;
        const available = Math.max(0, Number(remaining.get(lineKey(line)) || 0));
        if (!available) return;
        const count = Math.min(line.count, available);
        next.push({ ...line, count });
        remaining.set(lineKey(line), available - count);
    };
    const appendListing = (listing) => {
        if (next.length >= MAX_LINES) return;
        const available = inventory.filter((row) => Number(row.selfId) === Number(listing.selfId)
            && !row.equipped && Number(row.amount) > 0 && Number(row.enchant || 0) === Number(listing.enchant || 0));
        for (const row of available) {
            const count = Math.min(Number(row.amount), Math.max(0, Number(remaining.get(lineKey(listing)) || 0)));
            if (count <= 0) continue;
            const stackable = ItemTemplateIndex.find(DataCache.items, row.selfId)?.etc?.stackable === true;
            const matching = stackable && next.find((line) => Number(line.selfId) === Number(row.selfId)
                && Number(line.enchant || 0) === Number(row.enchant || 0));
            if (matching) {
                matching.count += count;
                remaining.set(lineKey(listing), Number(remaining.get(lineKey(listing))) - count);
                break;
            }
            if (next.some((line) => Number(line.objectId) === Number(row.id))) continue;
            next.push({
                objectId: Number(row.id),
                selfId: Number(row.selfId),
                name: row.name || listing.name,
                count,
                price: Number(listing.price),
                enchant: Number(row.enchant || 0),
                slot: Number(row.slot || 0),
                stackable,
                petData: row.petData || null,
                pricing: listing.pricing
            });
            remaining.set(lineKey(listing), Number(remaining.get(lineKey(listing))) - count);
            break;
        }
    };
    // A worker plan's rows come ranked (ColdEconomyPlan ranks them by gain;
    // the plan carries no gain): their order stands.
    for (const listing of classified.ranked ? listings : ListingPolicy.prioritizeListings(listings)) {
        existing.filter(line => lineKey(line) === lineKey(listing)).forEach(keepExisting);
        appendListing(listing);
    }
    return { lines: next.filter(viableSellLine).slice(0, MAX_LINES), listed, listings };
}

// The sale decision (MarketListingPolicy.evaluate) over the bot's bag and its
// shop's stock: the shop's lines keep their slot and price, its sell ads
// take their slots.
function decide(state, stock, existing, options = {}) {
    const own = AfkTrade.boardIndex().ownerLines(Number(state.characterId)).filter(line => line.storeType === AfkTrade.SELL);
    return ListingPolicy.evaluate(stateWithEscrow(state, stock), {
        ...options, economy: options.economy || ColdEconomyDecision.economyFor(state),
        slots: ListingPolicy.BOARD_SLOTS,
        kept: new Map([...own, ...existing].map((line) => [lineKey(line), line.price])),
        conditionalKept: new Set(own.filter(line => line.custodyPolicy === 1).map(lineKey))
    });
}

// A market visit's one sale decision (one decision point, evaluated once):
// what goes into the buy ads of the town, to the NPC, onto the board
// (listOnBoard takes it as options.decided).
function saleDecision(state, options = {}) {
    const shop = AfkTrade.findOwnerProjection(state.characterId)?.shop;
    const stock = Number(shop?.storeType) === AfkTrade.SELL ? shop : null;
    const existing = stock ? stock.lines.filter((line) => Number(line.count) > 0)
        .map((line) => ({ selfId: Number(line.selfId), price: Number(line.price) })) : [];
    return decide(state, stock, existing, options);
}

// The shop offers the same items, counts and enchants; prices may differ.
function sameSellLines(stock, lines) {
    if (Number(stock?.storeType) !== AfkTrade.SELL) return false;
    const current = stock.lines.filter((line) => Number(line.count) > 0);
    return current.length === lines.length && current.every((line, index) =>
        Number(line.selfId) === Number(lines[index].selfId)
        && Number(line.count) === Number(lines[index].count)
        && Number(line.enchant || 0) === Number(lines[index].enchant || 0));
}

function sameSellOrder(stock, lines) {
    return sameSellLines(stock, lines) && stock.lines.filter((line) => Number(line.count) > 0)
        .every((line, index) => Number(line.price) === Number(lines[index].price));
}

// Source admission is fixed when an ad opens (BuyAdPolicy, the wish gates);
// only a saved ad from before that rule can lack a source. The board start
// closes such ads once through the native batch withdrawal/refund owner.
async function withdrawSourceInvalidBuyAds(ownerId) {
    ownerId = Number(ownerId);
    const withdrawals = [];
    let sourceChanged = false;
    for (const ad of buyAds(ownerId)) {
        const remaining = (ad.lines || []).filter(line => Number(line.count) > 0);
        const invalid = remaining.filter(line => !invoke('GameServer/Items/ItemAcquisitionCatalog').hasSource(line.selfId));
        if (!invalid.length) continue;
        if (invalid.every(line => line.pricing)) {
            for (const line of invalid) withdrawals.push({ recordId: ad.id, lineId: line.id,
                expectedRevision: ad.revision, previousPricing: { ...line.pricing } });
        } else if (invalid.length === remaining.length) {
            // Legacy lines without a pricing cursor can close only a wholly
            // impossible record; unrelated valid stock keeps its native owner.
            try {
                const result = await AfkTrade.closeBotRecord(ownerId, ad.id, { expectedRevision: ad.revision });
                sourceChanged = sourceChanged || result.closed;
            }
            catch (error) { if (!staleMove(error)) throw error; }
        }
    }
    if (withdrawals.length) {
        const result = await AfkTrade.repriceBotLines(ownerId, [], { withdrawals });
        sourceChanged = sourceChanged || Number(result.changed) > 0;
    }
    return sourceChanged;
}

// Retain authored prices, then publish the prepared lines in this town: the
// worker's store rows (custodyPolicy 0) and meeting bids (custodyPolicy 1).
async function publishBuyAds(ownerId, ads, lines, town, expectedAuthority = null) {
    // Reconciliation deliberately retains a continuing line's price. Apply
    // only violated prepared limits through the existing fenced price writer
    // before quantity reconciliation, including a native town review. A line
    // that cannot fill (at or below the buy-back, PriceDecision.heldBid 0) is
    // withdrawn, not raised with its old count: the publish below opens the
    // fresh line with its funding checked.
    const reprices = [], withdrawals = [];
    for (const ad of ads) if (ad.town === town) for (const line of ad.lines || []) {
        const wanted = lines.find(row => Number(row.selfId) === Number(line.selfId)
            && Number(row.enchant || 0) === Number(line.enchant || 0));
        if (!wanted || !line.pricing) continue;
        const held = heldBid(line.selfId, Number(line.price), wanted.purchaseCap);
        if (held === null) continue;
        const move = { recordId: ad.id, lineId: line.id, selfId: line.selfId, expectedRevision: ad.revision,
            previousPricing: { ...line.pricing } };
        if (!held) withdrawals.push(move);
        else reprices.push({ ...move, price: wanted.price, pricing: { ...line.pricing, price: wanted.price } });
    }
    if (reprices.length || withdrawals.length) {
        const result = await AfkTrade.repriceBotLines(ownerId, reprices, { withdrawals,
            ...(expectedAuthority?.phase === 'cold' ? { coldAuthority: expectedAuthority }
                : expectedAuthority?.phase === 'hot' ? { hotAuthority: expectedAuthority } : {})
        });
        if (result.skipped) throw shopChanged('buyReprice');
        // A reprice that moved escrow advanced the revision itself: the
        // replace below holds the revision this move left, not the one before.
        const own = result.coldLifeRows?.[ownerId];
        if (own && expectedAuthority) expectedAuthority = { ...expectedAuthority, revision: Number(own.simulationRevision) };
    }
    // Unchanged order and no legacy BUY shop standing: no write. The write
    // closes a legacy bot BUY shop with its escrow back (Database
    // reconcileBotBuyAdsUnsafe).
    const held = buyAds(ownerId);
    const legacyShop = Number(AfkTrade.findOwnerProjection(ownerId)?.shop?.storeType) === AfkTrade.BUY;
    if (!legacyShop && held.every(ad => ad.town === town) && sameBuyOrder(held, lines)) return { changed: false };
    const center = ListingService.townCenter(town) || { locX: 0, locY: 0, locZ: 0 };
    const result = await AfkTrade.replaceBotRecords(ownerId, 'buy_ad', lines.map(line => ({
        storeType: AfkTrade.BUY, title: marketBuyStoreTitle([line]), town, ...center,
        custodyPolicy: line.custodyPolicy, lines: [line]
    })), { expected: Object.fromEntries(held.map(ad => [ad.id, ad.revision])), expectedAuthority }).catch((error) => {
        if (staleMove(error)) error.site ||= 'buyReplace';
        throw error;
    });
    return { changed: !!(result.closed.length || result.changed?.length || result.opened.length) };
}

// Takes the bot's buy ads back (all, or those for one item): the escrow
// returns to its bag.
async function withdrawBuyAds(ownerId, selfId = null, state = null) {
    const ads = buyAds(ownerId).filter((ad) => selfId === null
        || (ad.lines || []).some((line) => Number(line.selfId) === Number(selfId)));
    let withdrawn = 0;
    for (const ad of ads) {
        try {
            const closed = await AfkTrade.closeBotRecord(ownerId, ad.id, { expectedRevision: ad.revision });
            if (closed.closed) withdrawn += 1;
        } catch (error) {
            if (!staleMove(error)) throw error;
        }
    }
    const current = LifeState.snapshot(ownerId) || state;
    return { state: current, changed: withdrawn > 0, withdrawn: withdrawn > 0 && withdrawn === ads.length };
}

// A deal or another move changed the record after the review read it: the
// move is refused (its idempotency key) and the next review starts afresh.
function staleMove(error) {
    return error?.message === 'afk_trade_shop_changed';
}

// The same refusal, tagged with the plan step that met it (buyReprice,
// buyReplace): the postcommit warn line names it.
function shopChanged(site) {
    return Object.assign(Error('afk_trade_shop_changed'), { site });
}

// Publishes the bot's shop with `lines` in `town` (replacing the shop it
// has): a place on the town's square, its look, its title. Returns { shop }
// or { reason }.
async function publishSellShop(ownerId, state, stock, lines, town, row, inventory) {
    const loc = stock?.town === town
        ? { locX: stock.locX, locY: stock.locY, locZ: stock.locZ }
        : ListingService.marketLocation({ name: town }, { state, owner: ShopPlaces.afkOwner(ownerId) });
    if (!loc) return { reason: ShopPlaces.fullReason(town) };
    try {
        return { shop: await AfkTrade.publishBot(ownerId, {
            storeType: AfkTrade.SELL,
            title: marketStoreTitle(lines),
            town,
            ...loc,
            head: Number(row.head || 0),
            appearance: appearance(row, inventory),
            lines,
            promoteAds: AfkTrade.ownerRecords(ownerId).filter(record => record.kind === 'sell_ad'
                && record.custodyPolicy === 1 && record.lines.some(line => lines.some(next => lineKey(line) === lineKey(next))))
                .map(record => ({ id: record.id, revision: record.revision })),
            ...(stock ? { expectedRevision: stock.revision } : {})
        }) };
    } catch (error) {
        AfkTrade.restorePlace(ownerId);
        if (staleMove(error)) return { reason: 'shop_changed' };
        throw error;
    }
}

// The record-backed equivalent of the author's market stall (step 3.3): a
// bot in a market town lists what the listing policy would put on a stall.
// Its shop takes up to MAX_LINES lines (kept lines first, as a review keeps
// them); each listing past the shop becomes a sell ad, up to the bot's cap;
// what fits nowhere stays in the bag. A shop stands where it was opened; a
// new one opens where its store stands (TwinCluster.storeTown: the plan's
// town, else its twin's): when that is another town, its lines wait in the bag
// and storeTown names the town to travel to. Returns { state, listed, reason,
// storeTown }.
async function listOnBoard(state, options = {}) {
    const ownerId = Number(state.characterId);
    const current = AfkTrade.findOwnerProjection(ownerId)?.shop;
    const stock = Number(current?.storeType) === AfkTrade.SELL ? current : null;
    const [characters, inventory] = await Promise.all([
        Database.execute(['SELECT * FROM characters WHERE id = ? LIMIT 1', [ownerId]], 'bot-afk:owner'),
        Database.fetchItems(ownerId, 'market_list_on_board')
    ]);
    const row = characters[0];
    if (!row) return { state, listed: 0, reason: 'owner_missing' };
    const sale = sellLines(state, stock, inventory, options);
    let listed = 0;
    let reason = null;
    let shop = stock;
    let storeTown = null;
    const visitTown = state.activity === 'shopping' && ShopPlaces.hasPlaza(state.currentRegion)
        && invoke('GameServer/Bot/Economy/BotImprovementService').inTown(state) ? state.currentRegion : null;
    const town = sale.lines.length ? TwinCluster.storeTown(state, stock, { planned: options.planTowns?.get(lineKey(sale.lines[0]))
        || options.planTowns?.get(Number(sale.lines[0].selfId)) })
        || visitTown || MarketTownPolicy.targetTownForItems(state, sale.lines) : null;
    if (town && !stock && town !== state.currentRegion) {
        // The shop opens in its own town: the bot goes there with its lines.
        storeTown = town;
        shop = { lines: sale.lines };
    } else if (town) {
        if (stock && sameSellOrder(stock, sale.lines)) {
            listed += sale.lines.length;
        } else {
            const published = await publishSellShop(ownerId, state, stock || current, sale.lines, town, row, inventory);
            if (published.shop) {
                shop = published.shop;
                listed += sale.lines.length;
            } else {
                reason = published.reason;
            }
        }
    }
    const advertisingInventory = shop && shop !== stock && !storeTown ? await Database.fetchItems(ownerId) : inventory;
    const ads = await listSellAds(ownerId, state, sale.listings, shop, advertisingInventory, options);
    listed += ads.listed;
    return { state: LifeState.snapshot(ownerId) || state, listed, reason: reason || ads.reason, storeTown };
}

// The owner's sell-ad room: the lines already up (its ads, the shop) and
// the free ad records.
function sellAdRoom(ownerId, shop) {
    const ads = AfkTrade.ownerRecords(ownerId).filter((record) => record.kind === 'sell_ad');
    return { advertised: new Set(linesOf(ads).map(lineKey)), inShop: new Set(linesOf(shop ? [shop] : []).map(lineKey)),
        free: Math.max(0, BoardRules.BOT_RECORDS.sell_ad - ads.length) };
}

// One sell ad per listing the shop has no line for, while the bot has ad
// slots left (BoardRules.BOT_RECORDS); an item it already advertises keeps
// its ad. All in one move from the bag. `inventory`: the bag the caller read
// for this review; a shop published since took only items of its own lines,
// which no ad takes (a row that changed meanwhile refuses the move).
// `inventory` may be a loader instead: it is read only when the board still
// has room for a listing not yet up (the room is read again after it).
async function listSellAds(ownerId, state, listings, shop, inventory, options = {}) {
    if (typeof inventory === 'function') {
        const room = sellAdRoom(ownerId, shop);
        if (!room.free) return { listed: 0, reason: 'board_cap_reached' };
        if (!(listings || []).some((listing) => !room.inShop.has(lineKey(listing))
            && !room.advertised.has(lineKey(listing)))) return { listed: 0 };
        inventory = await inventory();
    }
    const { advertised, inShop, free } = sellAdRoom(ownerId, shop);
    if (!free) return { listed: 0, reason: 'board_cap_reached' };
    const configs = [];
    for (const listing of listings || []) {
        if (configs.length >= free) break;
        const selfId = Number(listing.selfId);
        if (inShop.has(lineKey(listing)) || advertised.has(lineKey(listing))) continue;
        const row = inventory.find((item) => Number(item.selfId) === selfId && !Number(item.equipped)
            && Number(item.amount) > 0 && Number(item.enchant || 0) === Number(listing.enchant || 0));
        if (!row) continue;
        const stackable = ItemTemplateIndex.find(DataCache.items, selfId)?.etc?.stackable === true;
        const line = {
            objectId: Number(row.id), selfId, name: row.name || listing.name,
            count: Math.min(Number(row.amount), Math.max(1, Number(listing.count) || 1)),
            price: Number(listing.price), enchant: Number(row.enchant || 0), slot: Number(row.slot || 0),
            stackable, petData: row.petData || null, pricing: listing.pricing
        };
        if (!viableSellLine(line)) continue;
        const town = options.planTowns?.get(lineKey(line)) || options.planTowns?.get(selfId)
            || MarketTownPolicy.shopTown(state, [line]);
        const center = ListingService.townCenter(town) || { locX: 0, locY: 0, locZ: 0 };
        configs.push({ storeType: AfkTrade.SELL, title: marketStoreTitle([line]), town, ...center, lines: [line] });
        advertised.add(lineKey(listing));
    }
    if (!configs.length) return { listed: 0 };
    try {
        const result = await AfkTrade.openBotRecords(ownerId, 'sell_ad', configs);
        return { listed: result.opened.length };
    } catch (error) {
        if (['board_cap_reached', 'board_ad_exists', 'invalid_afk_trade_source', 'inventory_item_changed'].includes(error.message)) {
            return { listed: 0, reason: error.message };
        }
        throw error;
    }
}

// A lifecycle command's bid limits (ColdEconomyPlan.bidLimits), applied once:
// each row [lineId, recordId, revision, count, price, ceiling, crossed] is a certificate of
// the line the worker read, applied on its own. A row whose record or line
// is gone (withdrawn on a market trip) or moved (a fill, a reprice) is
// skipped, here or inside the writer's transaction: nothing is written for
// it, so no price rises, and the next look or plan decides it afresh; the
// other rows still apply. Ceiling 0 withdraws the line. A
// meeting preparation does not hold it: a preparation is a quote, checked
// by record revision at native acceptance, and cannot lock an overpriced ad.
// beforeWrite: the caller's source guard when it holds no mutation admission.
async function applyBidLimits(state, rows, { beforeWrite = null } = {}) {
    const ownerId = Number(state.characterId);
    if (state.stats?.tradeMeeting) return { pending: true };
    if (!Array.isArray(rows) || rows.length > MAX_LINES + BoardRules.BOT_RECORDS.buy_ad) throw Error('economy_plan_bid_cap');
    const reprices = [], withdrawals = [], seen = new Set(), ads = buyAds(ownerId);
    let moved = 0;
    for (const row of rows) {
        if (!Array.isArray(row) || row.length !== 7 || !row.every(Number.isSafeInteger)
            || row.slice(0, 5).some(value => value < 1) || row[5] < 0 || row[5] >= row[4]
            || row[6] !== 0 && row[6] !== 1 || seen.has(row[0]))
            throw Error('economy_plan_bid_cap');
        seen.add(row[0]);
        const [lineId, recordId, revision, count, price, ceiling, crossed] = row;
        const ad = ads.find(record => record.id === recordId);
        const line = ad?.lines.find(candidate => candidate.id === lineId);
        if (!line?.pricing || ad.revision !== revision || line.count !== count || line.price !== price) {
            moved += 1;
            continue;
        }
        const move = { lineId, recordId, selfId: line.selfId, expectedRevision: revision,
            previousPricing: { ...line.pricing } };
        if (!ceiling) withdrawals.push(crossed ? { ...move, crossed } : move);
        else reprices.push({ ...move, price: ceiling, pricing: { ...line.pricing, price: ceiling } });
    }
    if (!reprices.length && !withdrawals.length) return { changed: 0, skipped: moved };
    beforeWrite?.();
    const authority = EconomyCommit.authority(state);
    const result = await AfkTrade.repriceBotLines(ownerId, reprices, { withdrawals,
        ...(authority.phase === 'cold' ? { coldAuthority: authority } : { hotAuthority: authority }),
        ...(beforeWrite ? { canCommitReview: () => { beforeWrite(); return true; } } : {}) });
    return { ...result, skipped: moved + result.skipped };
}

// Executes only the worker's quoted lines. The native writers validate
// current item/record rows; a failed step is dropped by the coordinator's
// existing after-commit guard, and the next resolve can decide again.
async function executePlan(state, plan, { step = work => work(), beforeWrite = () => {}, preparedState = state, reviewGoal = true } = {}) {
    if (state.stats?.tradeMeeting || invoke('GameServer/AfkTrade/TradeMeetingService').hasPreparation(state.characterId)) return { state, pending: true };
    const ownerId = Number(state.characterId);
    const authority = EconomyCommit.authority(preparedState);
    const stillPrepared = () => EconomyCommit.sameAuthority(EconomyCommit.authority(LifeState.cachedState(ownerId) || state), authority);
    // site: the plan step a refusal names in the postcommit warn line.
    const run = async (site, work) => {
        const result = await step(async () => {
            try { return await Database.withMutationAdmission(beforeWrite, work); }
            catch (error) {
                if (error && typeof error === 'object' && !error.site) error.site = site;
                throw error;
            }
        });
        state = LifeState.cachedState(ownerId) || result?.state || state;
        return result;
    };
    // No native writer reads accepted incoming. Units that reached the bag or
    // an obligation accepted since the decision may already fill a purchase:
    // it waits for the worker's new card (buyPending) instead of buying twice.
    const card = preparedState.phase === 'cold' ? invoke('GameServer/Bot/Population/ColdSimulationCoordinator')
        .economyDecisions?.decided?.(preparedState)?.activity : null;
    const heldAtDecision = itemId => Number(card?.itemId) === Number(itemId) && Number.isFinite(Number(card.heldAtDecision))
        ? Number(card.heldAtDecision) : ColdEconomyDecision.heldFor(preparedState, itemId);
    const filledSince = itemId => ColdEconomyDecision.heldFor(LifeState.cachedState(ownerId) || state, itemId) > heldAtDecision(itemId);
    if (plan.take) {
        if (!stillPrepared()) return { state, tradeDeferred: true };
        const buying = plan.take[0] === AfkTrade.SELL;
        if (buying && filledSince(plan.take[1])) return { state, buyPending: true };
        const line = ReadyTradeChoice.resolve(plan.take, AfkTrade.boardIndex(), ownerId);
        // The tuple's item passed source admission where it was made: a wish
        // network item node (purchase) or the sale classification (answer).
        if (!line) return { state, tradeDeferred: true };
        const offer = AfkTrade.offerOf(line);
        if (!offer) return { state, tradeDeferred: true };
        const result = await run('take', async () => {
            if (!stillPrepared()) return { state, tradeDeferred: true };
            if (buying && filledSince(plan.take[1])) return { state, buyPending: true };
            try {
                const trade = buying ? AfkTrade.buyFromShop : AfkTrade.sellToShop;
                return await trade(ownerId, offer.store, line.selfId, plan.take[2], {
                    lineId: line.lineId, expectedRevision: line.revision, expectedPrice: line.price, coldState: state
                });
            } catch (error) {
                // A counterpart may change its need, wallet, stock or route
                // during bilateral preparation. Keep the old records; do not
                // turn rejection into new consent or an immediate retry loop.
                if (/^(trade_meeting_|economy_|afk_trade_|board_|not_enough_adena)/.test(error.message))
                    return { state, tradeDeferred: true, reason: error.message };
                throw error;
            }
        });
        return { ...result, state: LifeState.cachedState(ownerId) || state };
    }
    // A craft step runs under the prepared authority like a take: a stale
    // step waits for the worker's new card.
    const crafted = plan.shot ? await run('shot', async () => {
        if (!stillPrepared()) return { state, stale: true };
        const shot = ShotCraftPolicy.unpackStep(plan.shot);
        if (shot.wealth) {
            const Wealth = invoke('GameServer/Bot/Economy/ColdWealthCraftService');
            if (!Wealth.eligible(state)) return { state };
            const refusal = {};
            const opportunity = Wealth.recheck(state, shot.wealth, undefined, refusal);
            return opportunity ? Wealth.execute(state, opportunity, { stillPrepared })
                : { state: await Wealth.rejectAccepted(state, state, refusal) };
        }
        return { state: await ColdShotEconomyService.execute(state, shot) };
    }) : null;
    if (crafted?.stale) return { state, buyPending: true };
    if (TradeMeetingService.hasPreparation(ownerId)) return { state, pending: true };
    if (plan.withdraw?.length) await run('withdraw', async () => {
        const own = new Map(AfkTrade.boardIndex().ownerLines(ownerId).map(line => [line.lineId, line]));
        const withdrawals = [];
        let invalid = false;
        for (const lineId of new Set(plan.withdraw.slice(0, 8).map(Number))) {
            const line = own.get(lineId);
            // The earlier board review or a fill may already have removed it.
            // Its absence is the completed intent, not another stock return.
            if (!line) continue;
            if (line.storeType !== AfkTrade.SELL) { invalid = true; continue; }
            withdrawals.push({ lineId: line.lineId, recordId: line.recordId,
                expectedRevision: line.revision, previousPricing: line.pricing ? { ...line.pricing } : null });
        }
        // Use the same native batch writer as a board review: one transaction,
        // one inventory publication and one fence per original record snapshot.
        const result = withdrawals.length ? await AfkTrade.repriceBotLines(ownerId, [], { withdrawals,
            canCommitReview: () => { beforeWrite(); return true; } }) : { changed: 0, skipped: 0 };
        if (invalid || result.skipped) throw Error('economy_plan_line_changed');
        return result;
    });
    if (plan.sell?.length) await run('sell', async () => {
        // A line's pricing state (MarketPricing.lineState) reads the persona,
        // the board and the item beliefs, never the hunt/stock forecast: the
        // card context serves it. Only an enchanted line's belief reads
        // economy.price; that line takes the full context, built once.
        const ctx = ListingPolicy.cardTraderContext(state);
        let full = null;
        const lineContext = enchant => {
            if (!(enchant > 0)) return ctx;
            if (!full && Diagnostics.active()) Diagnostics.count('trader_context', 'full', 'enchanted_sale');
            return full ||= ListingPolicy.traderContext(state, { now: ctx.timestamp });
        };
        if (Diagnostics.active()) Diagnostics.count('trader_context', 'card', 'plan_sell');
        // Listings come from MarketListingPolicy.evaluate: sale candidates
        // and classify already admitted their sources.
        let ownSell = null; // read once: the map below writes nothing
        const listings = plan.sell.slice(0, 8).map(([selfId, count, price, , plannedEnchant]) => {
            const item = ItemTemplateIndex.find(DataCache.items, selfId);
            let enchant = plannedEnchant;
            if (enchant === undefined) {
                // Older prepared plans can only select a unique enchant.
                const bag = state.inventory?.[selfId], copies = (bag?.instances || []).filter(row => !row.equipped && row.amount > 0);
                const enchants = new Set([...copies.map(row => Number(row.enchant || 0)),
                    ...(ownSell ||= AfkTrade.boardIndex().ownerLines(ownerId).filter(line => line.storeType === AfkTrade.SELL))
                        .filter(line => line.selfId === Number(selfId))
                        .map(line => Number(line.enchant || 0))]);
                if (!enchants.size) enchants.add(Number(bag?.enchant || 0));
                if (enchants.size !== 1) throw Error('economy_plan_ambiguous_copies');
                enchant = [...enchants][0];
            }
            if (!Number.isSafeInteger(enchant) || enchant < 0) throw Error('economy_plan_invalid_enchant');
            return { selfId: Number(selfId), count: Number(count), price: Number(price), enchant,
                name: item?.template?.name || `Item ${selfId}`, kind: item?.template?.kind || '',
                pricing: MarketPricing.lineState(selfId, lineContext(enchant),
                    { price: Number(price), storeType: AfkTrade.SELL, enchant, count: Number(count) }) };
        });
        const planTowns = new Map(listings.map((line, at) => [lineKey(line), plan.sell[at][3]]));
        // The worker marks promotion at a real visit (or a standing shop's
        // refresh). Never manufacture a town visit from a field quote.
        const current = AfkTrade.findOwnerProjection(ownerId)?.shop;
        const shop = Number(current?.storeType) === AfkTrade.SELL ? current : null;
        if (plan.shop) {
            if (state.phase !== 'cold' || (current ? current.town !== plan.shop
                : state.activity !== 'shopping' || state.currentRegion !== plan.shop
                    || !invoke('GameServer/Bot/Economy/BotImprovementService').inTown(state)))
                return { state, reason: 'shop_visit_changed' };
            return listOnBoard(state, { decided: { listings, ranked: true }, planTowns });
        }
        return listSellAds(ownerId, state, listings, shop,
            () => Database.fetchItems(ownerId, 'market_execute_plan'), { planTowns });
    });
    // An empty desired list closes the old ads; it does not run another bid
    // decision on main. The plan's quote remains the quote the worker made.
    // An earlier native improvement/craft/sale may have filled the root or
    // changed its inputs. Publishing its old certificate at the new revision
    // would manufacture fresh authority from stale need. Keep it pending.
    const filledAd = () => (plan.buyAds || []).slice(0, MAX_LINES + BoardRules.BOT_RECORDS.buy_ad).some(row => filledSince(row[0]));
    if (Object.hasOwn(plan, 'buyAds') && (!stillPrepared() || filledAd())) return { state, buyPending: true };
    const published = Object.hasOwn(plan, 'buyAds') ? await run('buyAds', async () => {
        if (!stillPrepared()) throw Error('economy_plan_need_changed');
        if (filledAd()) return { state, buyPending: true };
        // One read of the owner's records: nothing below writes before publishBuyAds.
        const ads = buyAds(ownerId), escrow = buyOrderEscrow(ownerId);
        if (Object.hasOwn(plan, 'buyCaps') && (!Array.isArray(plan.buyCaps) || plan.buyCaps.length !== plan.buyAds.length
            || plan.buyCaps.some((cap, at) => cap !== null && (!Number.isSafeInteger(cap) || cap < 1 || plan.buyAds[at][2] > cap))))
            throw Error('economy_plan_bid_cap');
        // The worker's leading buyStore rows are the escrow store (custody 0).
        const store = plan.buyStore ?? 0;
        if (!Number.isSafeInteger(store) || store < 0 || store > Math.min(MAX_LINES, plan.buyAds.length)) throw Error('economy_plan_bid_cap');
        // The town the worker priced the bids for (ColdEconomyPlan buyBatch):
        // main publishes there and never chooses it.
        const town = plan.buyTown;
        if (typeof town !== 'string' || !MarketTownPolicy.marketTown(town)) throw Error('economy_plan_buy_town');
        // Unenchanted bids: their pricing state needs no forecast (see plan.sell).
        const ctx = ListingPolicy.cardTraderContext(state);
        if (Diagnostics.active()) Diagnostics.count('trader_context', 'card', 'plan_buy');
        // Planned bids come from BuyAdPolicy.linesFor: bidFor admitted each source.
        // A survival item's ad may spend its kit cost from the survival
        // reserve, as the meeting and the NPC restock do (each item once):
        // the tranche the worker decided the bid with (plan.buyKit). Each row's
        // own terms on the money the rows before it left must cover it (its
        // certificate, BuyAdPolicy.retainedLines' running budget below).
        let wanted = (plan.buyAds || []).slice(0, MAX_LINES + BoardRules.BOT_RECORDS.buy_ad).map((row, at) => {
            const [selfId, count, price] = row;
            const intent = row.length === 9 ? require('./TradeIntent').decode(row) : null;
            const survivalCost = Math.max(0, Math.round(Number(plan.buyKit?.[at]) || 0));
            if (!(selfId > 0 && count > 0 && price > 0)) throw Error('economy_plan_bid_unfunded');
            const item = ItemTemplateIndex.find(DataCache.items, selfId);
            return { selfId, count, price, intent, survivalCost, purchaseCap: plan.buyCaps?.[at] ?? Infinity,
                custodyPolicy: at < store ? 0 : 1,
                enchant: 0, name: item?.template?.name || `Item ${selfId}`,
                slot: Number(item?.etc?.slot || 0), stackable: item?.etc?.stackable === true,
                pricing: MarketPricing.lineState(selfId, ctx,
                    { price, storeType: AfkTrade.BUY, enchant: 0, count: Number(count) }) };
        });
        // A standing bid may have been repriced since worker preparation.
        // Bound its prepared quantity at the price reconciliation will keep;
        // this does not choose a new price or rebuild the worker's wishes.
        const budgetState = { ...state, adena: PurchaseFunding.budget(state, escrow) };
        const owned = AfkTrade.boardIndex().ownerLines(ownerId);
        wanted = BuyAdPolicy.retainedLines(budgetState, wanted, owned, town, { certify: true });
        if (!wanted.length) {
            if (ads.length) await publishBuyAds(ownerId, ads, [], ads[0].town, authority);
            return { state: LifeState.cachedState(ownerId) || state };
        }
        await publishBuyAds(ownerId, ads, wanted, town, authority);
        return { state: LifeState.cachedState(ownerId) || state };
    }) : null;
    if (published?.buyPending) return { state, buyPending: true };
    if (!reviewGoal) return { state };
    await run('goal', async () => {
        const snapshot = await GoalService.review(state, { saleTown: TwinCluster.storeTown(state, null, { planned: plan.sell?.[0]?.[3] }) });
        const goal = snapshot?.current;
        if (!plan.travel || goal?.plan?.wishKey !== plan.travel) return { state };
        const travel = GoalExecutor.beginMarketTravel(state, goal);
        return { state: travel ? await LifeState.upsertState(travel, 'worker_economy_market_travel') : state };
    });
    return { state };
}

// The bot takes its shop and its buy ads back.
async function withdraw(ownerId) {
    const id = Number(ownerId);
    const shop = AfkTrade.findOwnerProjection(id)?.shop;
    const bot = String(shop?.ownerAccount || '').startsWith('bot_');
    const result = bot ? await AfkTrade.stop(id) : { stopped: false };
    const ads = await withdrawBuyAds(id);
    return { ...result, stopped: !!result.stopped || ads.withdrawn };
}

// What the bot's own look decided (MarketPricing.look in the cold worker): new asks of
// its lines and new bids of its buy ads, lines whose best outcome is now the
// NPC (they leave the board; the NPC buys them at the next town visit) and
// buy ads no bid gains for (their escrow comes back). A line a deal or
// another move changed meanwhile waits for the next look.
async function applyReview(ownerId, review = {}, { coldAuthority = null, hotAuthority = null, canCommitReview = null } = {}) {
    // Prices and withdrawals share one fence, including lines of the same
    // record. Rows from an older worker have no revision and wait for a look
    // from a worker that has the current board format.
    const result = await AfkTrade.repriceBotLines(Number(ownerId), review.reprices || [], {
        withdrawals: review.withdrawals || [],
        updates: review.updates || [],
        coldAuthority,
        hotAuthority,
        canCommitReview
    });
    return { changed: result.changed, updated: result.updated || 0 };
}

module.exports = { executePlan, applyBidLimits, applyReview, buyOrderEscrow, withdrawSourceInvalidBuyAds, canTradeRemotely, desiredSide, listOnBoard,
    saleDecision,
    pruneResourceLots, viableSellLine, withdraw, withdrawBuyAds };
