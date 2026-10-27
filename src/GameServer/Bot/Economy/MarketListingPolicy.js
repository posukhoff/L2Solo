const BeginnerShots = require('../../Items/C4BeginnerShots');
const LotPolicy = require('./MarketLotPolicy');
const BoardRules = require('../../AfkTrade/BoardRules');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const PriceDecision = require('./PriceDecision');
const MarketPricing = invoke('GameServer/Bot/Economy/MarketPricing');
const MarketTownPolicy = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
const ColdEconomyDecision = invoke('GameServer/Bot/Population/ColdEconomyDecision');
const KnowledgeLearning = invoke('GameServer/Bot/AI/KnowledgeLearning');
const PersonalGearProgression = invoke('GameServer/Bot/AI/PersonalGearProgression');
const { MAX_GEAR_COPIES_PER_TYPE } = require('./WarehouseRules');


function isGear(item = {}) {
    return String(item.kind || '').startsWith('Weapon.') || String(item.kind || '').startsWith('Armor.');
}

// The board slots go to the lines that gain most over the NPC (user
// 2026-10-23, R2): each listing's `gain`, its Adena over the NPC buy-back
// for its whole stock from the one sale owner (MarketPricing.disposition);
// what loses a slot takes its next-best answer there. Read from the listing
// alone, so the worker and a native town visit pick the same lines; stable
// ties keep that selection.
function prioritizeListings(listings = []) {
    return listings.slice().sort((left, right) => Number(right.gain || 0) - Number(left.gain || 0)
        || Number(right.price || 0) - Number(left.price || 0)
        || Number(right.enchant || 0) - Number(left.enchant || 0)
        || Number(isGear(right)) - Number(isGear(left))
        || Number(left.selfId) - Number(right.selfId));
}

// Physical and quest rules remain hard constraints. All other candidates
// go through the shared expected-value decision after ItemDisposition has
// reserved equipped items, personal stock and outstanding obligations.
function classify(state, item) {
    if (!item || Number(item.selfId || 0) <= 0 || Number(item.count || 0) <= 0) {
        return { action: 'ignore', reason: 'invalid_item' };
    }
    if (BeginnerShots.isRestricted(item.selfId)) return { action: 'ignore', reason: 'beginner_shot' };
    if (ItemDisposition.isQuestItem(item)) return { action: 'ignore', reason: 'quest_item' };
    if (!invoke('GameServer/Items/ItemAcquisitionCatalog').hasSource(item.selfId))
        return { action: 'ignore', reason: 'no_acquisition_source' };
    if (!LotPolicy.viable(item)) return { action: 'ignore', reason: 'invalid_item' };
    if (ItemDisposition.isNpcOnlyItem(item, undefined, state)) {
        return { action: 'npc', reason: 'npc_only_item' };
    }
    return { action: 'market', reason: 'market' };
}

// What the bot's thread knows for pricing on the main thread: its persona,
// the board index, the NPC shops and the spots for its trips. options may
// replace any (tests, offline digests).
function traderContext(state, options = {}) {
    return MarketPricing.traderContext(state, {
        timestamp: Number(options.now) || Date.now(),
        persona: options.persona ?? BotPersona.of(state),
        board: Object.hasOwn(options, 'board') ? options.board : invoke('GameServer/AfkTrade/AfkTradeService').boardIndex(),
        npcOffersFor: options.npcOffersFor
            || ((selfId) => invoke('GameServer/Bot/Economy/MarketOpportunity').npcOffersAll(selfId)),
        findSpot: options.findSpot || ((spotId) => invoke('GameServer/Bot/AI/SpotService').findById(spotId)),
        economy: options.economy,
        tripCost: options.tripCost,
        knowledgeEnabled: options.knowledgeEnabled,
        demandFor: options.demandFor,
        ownStock: options.ownStock,
        canSell: options.canSell
    });
}

// What main knows for pricing from the worker's accepted card, without a
// forecast: the persona, the money packet, the card's worths and buy intents; no hunt,
// stock or recipe build. A reader of economy.price (an enchanted line's
// belief, MarketPricing.beliefFor) takes traderContext. options as
// MarketPricing.traderContext's deps (board, npcOffersFor, canSell, ...).
function cardTraderContext(state, options = {}) {
    const persona = BotPersona.of(state), packet = state.stats?.money;
    // lazy: worker the coordinator's accepted decisions live on main only
    const prepared = invoke('GameServer/Bot/Population/ColdSimulationCoordinator').economyDecisions.decided?.(state);
    const worth = id => ColdEconomyDecision.preparedCardWorth(prepared,
        id, state, Number(packet?.[1]), persona?.understanding, KnowledgeLearning.knowledgeEnabled());
    return MarketPricing.traderContext(state, {
        npcOffersFor: selfId => invoke('GameServer/Bot/Economy/MarketOpportunity').npcOffersAll(selfId), // lazy: worker main-only NPC shops
        ...options,
        board: Object.hasOwn(options, 'board') ? options.board : invoke('GameServer/AfkTrade/AfkTradeService').boardIndex(), // lazy: worker main-only board
        persona, preparedWorth: worth, preparedBuffer: prepared?.data,
        // The card's buy intents: an intent BUY line prices at its intent's
        // worth (BoardLook.buyWorth) here as in the worker; a stale card has none,
        // as it has no worth.
        economy: { persona, hourAdena: Number(packet?.[0]), moneyPrice: Number(packet?.[1]), gapHorizonHours: NaN, worth,
            watchList: prepared?.stale ? [] : ColdEconomyDecision.watchList(prepared) } });
}

// Board slots of a bot (user, 2026-10-05): 3 shop lines + 5 sell ads.
const BOARD_SLOTS = BoardRules.BOT_SHOP_LINES + BoardRules.BOT_RECORDS.sell_ad;

// The bot's sale at a market visit or a review (group E): the author's hard
// rules first; every other item, a line the bot already has included, goes
// by the one sale owner (MarketPricing.disposition, user rule R2): the board
// when it pays more than the NPC, else the NPC, a buy ad answered in its
// town, or keeping it. A line the bot already has keeps its price (its own
// look reprices it, MarketPricing.look) and answers a bid only from
// unreserved conditional stock; when the owner takes it off the board the
// plan withdraws it and its goods are decided again as bag goods. The
// listings with the highest gain over the NPC take the bounded slots; the
// rest take their next-best answer. options: now (the decision point),
// slots (board slots), kept (selfId -> price of its lines), conditionalKept,
// stored (selfId -> units in the warehouse), plus traderContext's.
// Returns { candidates, decisions, listings, npc, warehouse, answers };
// selected listings carry their line pricing state and gain. Answers are the
// buy ads it chose to sell into ({ item, line, count }: the bot sells there
// when it is in the ad's town, the side that acts travels).
function evaluate(state, options = {}) {
    const ctx = traderContext(state, options);
    const candidates = ItemDisposition.saleCandidates(state, { ...options, unlimited: true });
    const decisionPoint = options.decisionPoint ?? (Number(options.now) || ctx.timestamp);
    const kept = options.kept || new Map((ctx.board?.ownerLines?.(Number(state.characterId)) || [])
        .filter(line => line.storeType === BoardRules.SELL)
        .map(line => [`${line.selfId}:${line.enchant || 0}`, line.price]));
    // An adventurer has no warehouse (ItemDisposition.warehouseCandidates):
    // it has no keep option, so what the market does not pay more for than
    // the NPC goes to the NPC (user 2026-10-24).
    const adventurer = PersonalGearProgression.adventurer(state);
    const room = item => adventurer ? 0 : roomFor(item, options.stored);
    // The owner's keep is the warehouse.
    const exit = row => ({ action: row.action === 'keep' ? 'warehouse' : row.action, answer: row.answer });
    const decisions = [];
    const next = new Map();
    for (const item of candidates) {
        const hard = classify(state, item);
        if (hard.action !== 'market') {
            decisions.push({ ...hard, item });
            continue;
        }
        const keptKey = `${item.selfId}:${item.enchant || 0}`;
        const held = kept.has(keptKey) || !item.enchant && kept.has(Number(item.selfId));
        const standingPrice = held ? kept.get(keptKey) ?? kept.get(Number(item.selfId)) : 0;
        const conditional = held && options.conditionalKept?.has(keptKey) === true;
        const chosen = MarketPricing.disposition(item, ctx, {
            town: conditional ? state.currentRegion : MarketTownPolicy.targetTownForItems(state, [item], options),
            room: room(item), standingPrice, answers: !held || conditional,
            rollKey: ['dispose', ctx.characterId, item.selfId, decisionPoint]
        });
        if (chosen.action === 'list') {
            const price = held ? standingPrice : chosen.priced.ask.price;
            // A listing of unknown demand waits on the market at the belief's ask.
            const reason = held ? 'kept_line' : chosen.priced.ask.known ? 'expected_value' : 'stock_quote';
            const decision = { action: 'list', reason, item: { ...item, price, marketReason: reason, gain: chosen.gain,
                ...(held ? {} : { pricing: MarketPricing.lineState(item.selfId, ctx,
                    { price, storeType: BoardRules.SELL, enchant: item.enchant || 0 }) }) },
            priced: chosen.priced };
            next.set(decision, held ? null : chosen.next);
            decisions.push(decision);
        } else if (held && chosen.action !== 'ad') decisions.push({ action: 'keep', reason: 'withdrawn', item });
        else decisions.push({ ...exit(chosen), reason: 'expected_value', item, priced: chosen.priced });
    }
    const slots = Math.max(0, Math.floor(Number(options.slots ?? BOARD_SLOTS)));
    const listed = new Set(prioritizeListings(decisions.filter(row => row.action === 'list').map(row => row.item)).slice(0, slots));
    for (const decision of decisions) {
        if (decision.action !== 'list' || listed.has(decision.item)) continue;
        // A held line without a slot is withdrawn (its goods decided again as bag goods).
        const other = next.get(decision);
        Object.assign(decision, other ? exit(other) : { action: 'keep', answer: null },
            { reason: 'no_board_slot' });
    }
    return {
        candidates,
        decisions,
        listings: decisions.filter((decision) => decision.action === 'list').map((decision) => decision.item),
        npc: decisions.filter((decision) => decision.action === 'npc').map((decision) => ({
            ...decision.item,
            npcPrice: PriceDecision.buyback(decision.item.selfId)
        })),
        warehouse: decisions.filter((decision) => decision.action === 'warehouse').map((decision) => decision.item),
        answers: decisions.filter((decision) => decision.action === 'ad')
            .map((decision) => ({ item: decision.item, line: decision.answer.line, count: decision.answer.count,
                receipts: decision.answer.receipts }))
    };
}

// Room to keep an item: gear keeps two copies in the warehouse
// (BotWarehouseService), anything else has room.
function roomFor(item, stored) {
    if (!isGear(item) || !stored) return 1;
    const kept = Number(stored.get?.(Number(item.selfId)) ?? stored[Number(item.selfId)] ?? 0);
    return Math.max(0, Math.min(1, (MAX_GEAR_COPIES_PER_TYPE - kept) / Math.max(1, Number(item.count) || 1)));
}

// A bot in the world seen by the cold rules: its saved life state with the
// live bag, level and class of the actor.
function actorState(session) {
    const actor = session.actor;
    const inventory = invoke('GameServer/Bot/Population/BotLifeState').inventorySummaryFromItems(actor.backpack.fetchItems());
    return {
        ...(session.coldLifeState || {}),
        characterId: Number(actor.fetchId()),
        level: Number(actor.fetchLevel?.() || session.coldLifeState?.level || 1),
        adena: Number(inventory['57']?.amount || 0),
        inventory,
        stats: { ...(session.coldLifeState?.stats || {}), classId: Number(actor.fetchClassId?.() || 0) }
    };
}

// What a bot in the world sells to the NPC, by selfId and count: the cold
// visit's NPC sale (evaluate().npc) on the actor's own bag. The hot town visit
// sells exactly this and keeps it out of the warehouse, as the cold visit sells
// before it stores.
function npcSaleForActor(session) {
    const sale = new Map();
    if (!session?.actor?.backpack?.fetchItems) return sale;
    const state = actorState(session);
    for (const line of evaluate(state, { unlimited: true, allowPreTradeCleanup: true }).npc) {
        sale.set(Number(line.selfId), Number(sale.get(Number(line.selfId)) || 0) + Number(line.count || 0));
    }
    return sale;
}

module.exports = {
    BOARD_SLOTS,
    classify,
    evaluate,
    isGear,
    prioritizeListings,
    traderContext,
    cardTraderContext,
    actorState,
    npcSaleForActor
};
