'use strict';

// One immutable catalogue per reader thread. Dynamic quotes and route
// expansion are streamed; no owner holds a recipe/town graph or whole board.
const Data = invoke('GameServer/DataCache');
const ItemIndex = require('../../Item/ItemTemplateIndex');
const Routes = require('../Travel/TravelRoutes');
const Towns = require('../../World/TownRespawn');
const FixedShots = require('../Economy/FixedShotOffers');
const MarketDemand = require('../Economy/MarketDemand');
const { offerAdmission } = require('./PartyAdmission');
const Price = require('../Economy/PriceDecision');
const OfferQuery = require('../Economy/OfferQuery');
const ShotSalePolicy = require('../Economy/ShotSalePolicy');
const PriceBelief = require('../Economy/PriceBelief');
const CrystalCatalog = require('../../Knowledge/CrystalCatalog');
const MarketCounters = require('../Economy/MarketCounters');
const { QUOTE_DEPTH } = Price;
const EMPTY = Object.freeze([]);
let npcOfferView, mpRates, townByName, townOrdinal;
const npcOffersFor = id => npcOfferView?.offersFor(id) || EMPTY;

function initialise() {
    if (mpRates) return;
    mpRates = new Map();
    townByName = new Map(); townOrdinal = new Map();
    for (const town of Object.values(Towns.towns)) { townOrdinal.set(town.name, townOrdinal.size); townByName.set(town.name, town); }
    // Retain the original startup-time stock/rates, borrowing the shared shop
    // owner's snapshot instead of constructing a private item/town index.
    npcOfferView = require('../../Knowledge/GameDataCatalogue').native().npcTownOffers();
    // Warm the static item counters once, at the start (MarketCounters.counterOf).
    for (const item of Data.items || []) MarketCounters.counterOf(item.selfId);
    // Exact native seated recovery is static in class/level on this branch.
    const Rest = invoke('GameServer/Bot/Population/ColdRest');
    require('../../Knowledge/RecoveryCatalog').seatedMpRates(Data.classTemplates, Rest, mpRates);
}

function* reservations(state) {
    const reserved = invoke('GameServer/Bot/AI/PersonalGearProgression').preparedAmounts(state);
    const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
    const plan = Disposition.equipmentInputPlan(state);
    const planInputs = {};
    for (const [id, amount] of Object.entries(Disposition.retainedEquipmentAmounts(state))) {
        reserved[id] = Math.max(Number(reserved[id] || 0), amount); yield 'ingredient';
    }
    const role = Planner.roleFor(state), classId = Number(state.stats?.classId || state.classId || 0);
    const allowed = Disposition.gradeIndex(Planner.gradeForLevel(state.level));
    for (const row of Disposition.exchangeMaterials(plan)) planInputs[row.selfId] = Math.max(Number(planInputs[row.selfId] || 0), Number(row.amount));
    const equipped = new Map(), staged = new Map();
    for (const key in state.inventory || {}) {
        const item = state.inventory[key], template = ItemIndex.find(Data.items, Number(item.selfId));
        const slot = Number(template?.etc?.slot || 0), rank = Disposition.gradeIndex(template?.etc?.rank);
        if ([6, 9, 10, 11, 12, 15].includes(slot)) {
            const candidate = { selfId: Number(item.selfId), rank, score: Planner.itemScore(template, role, classId) };
            if (item.equipped || Number(item.equippedCount || 0) > 0) equipped.set(slot, candidate);
            else if (Number(item.amount) > 0 && rank <= allowed && Planner.suitable(template, state, role, template.etc.rank)) {
                const current = staged.get(slot);
                if (!current || rank > current.rank || rank === current.rank && candidate.score > current.score) staged.set(slot, candidate);
            }
        }
        yield 'stock';
    }
    for (const [slot, candidate] of staged) {
        let worn = equipped.get(slot) || ([10, 11].includes(slot) ? equipped.get(15) : null);
        if (slot === 15) for (const number of [10, 11]) {
            const other = equipped.get(number);
            if (other && (!worn || other.rank > worn.rank || other.rank === worn.rank && other.score > worn.score)) worn = other;
        }
        if (!worn || candidate.rank > worn.rank || candidate.rank === worn.rank && candidate.score > worn.score) reserved[candidate.selfId] = 1;
        yield 'owned';
    }
    if (plan?.combine && (Planner.planRunning(plan) || plan.status === 'blocked')) {
        for (const row of plan.combine.requirements || []) {
            planInputs[row.selfId] = Math.max(Number(planInputs[row.selfId] || 0), Number(row.amount || 0)); yield 'ingredient';
        }
    }
    if (Planner.planRunning(plan) && plan.strategy === 'craft') {
        // ARCH-NOTE: accepted clan/provider allocations belong to their existing
        // owner. Missing immutable allocation adapter makes this forecast unknown.
        if (plan.clanGoal?.clanId && plan.recipeId) return null;
        const Recipes = invoke('GameServer/Items/C4RecipeItems');
        const stack = [{ rows: plan.materials || [], at: 0, multiplier: 1, seen: new Set(), depth: 0 }];
        while (stack.length) {
            const node = stack[stack.length - 1];
            if (node.at >= node.rows.length) { stack.pop(); yield 'edge'; continue; }
            const row = node.rows[node.at++], id = Number(row.selfId), required = Number(row.amount) * node.multiplier;
            if (id && !node.seen.has(id)) {
                planInputs[id] = Number(planInputs[id] || 0) + required;
                const missing = Math.max(0, required - Number(state.inventory?.[id]?.amount ?? row.owned ?? 0));
                const recipe = missing > 0 ? Recipes.resolveByProductId(id) : null;
                if (recipe && node.depth < 5) stack.push({ rows: recipe.materials || [], at: 0,
                    multiplier: Math.ceil(missing / Math.max(1, Number(recipe.productCount))), seen: new Set([...node.seen, id]), depth: node.depth + 1 });
                else if (recipe && node.depth >= 5) return null;
            }
            yield 'edge';
        }
    }
    if (plan?.status === 'active') for (const row of plan.crystalPreparation?.materials || [])
        planInputs[row.selfId] = Math.max(Number(planInputs[row.selfId] || 0), Number(row.amount));
    for (const [id, amount] of Object.entries(Disposition.capDeferredInputs(state.stats?.equipmentPlan, planInputs)))
        reserved[id] = Math.max(Number(reserved[id] || 0), amount);
    const target = Number(plan?.target?.selfId || 0);
    if (target && Number(state.inventory?.[target]?.amount) > 0 && !state.inventory[target].equipped) reserved[target] = 1;
    return reserved;
}

function* feasibility(state, { board, read = () => {} }, reserved = null) {
    reserved ||= yield* reservations(state);
    if (!reserved || !board) return null;
    const Look = invoke('GameServer/Bot/Economy/BoardLook'), lines = board.ownerLines(state.characterId);
    if (lines.length > Look.MAX_OWNED_LINES) return null;
    let hash = 0x811c9dc5, blocked = 0, at = 0;
    for (const line of lines) {
        read(line.selfId); hash = Look.lineFingerprint(hash, line);
        if (line.storeType === 1 && Look.indexedFeasibility(state, line, reserved) === false) blocked |= 1 << at;
        at++; yield 'owned';
    }
    return [hash, blocked, lines.length];
}

const EconomicTrip = require('../Economy/EconomicTrip');
const { regionalTown, details: tripDetails } = EconomicTrip;
function recipeIndex(board, build = true) {
    initialise();
    return invoke('GameServer/Bot/Economy/RecipeProductionIndex').forBoard(board, {
        // A product the census buys now has customers (wearers, kit wishes;
        // a material's buyers are its trades and buy lines); how many is read
        // where the exit is priced (ShotSalePolicy), not in the index. A census move rechecks
        // the rows (ColdSimulationWorker table_page -> recheck).
        censusBuyer: recipe => MarketDemand.censusBuys(recipe.productId) }, build);
}

// Seated MP recovery per hour, one reader for the wish and the producer.
function mpPerHour(state) {
    initialise();
    return mpRates.get(Number(state.stats?.classId ?? state.classId))?.[Number(state.level)];
}

// The native craft executor's facts, one reader for the wish and the
// producer: a hot bot crafts one batch per command; a cold command is bound
// by the MP cap the executor's vitals carry (the combat profile only when
// none is stored); seated recovery prices the labour.
function craftLabour(state, timestamp = Date.now(), profile = null) {
    if (state.phase === 'hot') return { executor: 'hot', mpCapacity: Infinity, mpPerHour: mpPerHour(state) };
    const stored = Number(state.vitals?.maxMp);
    const mpCapacity = stored > 0 ? stored : Number((profile ? profile()
        : invoke('GameServer/Bot/Population/ColdCombatProfile').profileFor(state, timestamp))?.maxMp);
    return { executor: 'cold', mpCapacity, mpPerHour: mpPerHour(state) };
}

function* prepare(state, { board, timestamp, read = () => {}, stock = null, economy = null,
    routeRows = null, routeKey = null } = {}) {
    const packet = state.stats?.money;
    if (!board || !Array.isArray(packet) || packet.length < 4 || !(packet[0] > 0) || !(packet[1] > 0)) return null;
    const reserved = yield* reservations(state);
    if (!reserved) return null;
    const preparedFeasibility = yield* feasibility(state, { board, read }, reserved);
    const ownStock = new Map(), routes = [];
    const key = EconomicTrip.key(state);
    const directRows = routeKey === key && EconomicTrip.fullRows(routeRows) ? routeRows : null;
    const readyRows = directRows || (economy?.routeKey === key ? economy.routeRows : null);
    const readyTrip = EconomicTrip.fullRows(readyRows)
        ? EconomicTrip.preparedReader(readyRows, { hourAdena: Number(packet[0]) }) : null;
    const beliefReader = PriceBelief.reader({ state, board, timestamp, read });
    const context = { timestamp, state, insideContext: true, hourAdena: Number(packet[0]), moneyPrice: Number(packet[1]),
        survivalReserve: Number(packet[2]), ...craftLabour(state, timestamp),
        // A held unit is worth the bot's own price (user 2026-10-22): one
        // reader per prepare (persona: BotPersona.of, as the worker's plan);
        // soldPrice: its market price, the shot own-use ceiling (ShotCraftPolicy).
        price: beliefReader.price, soldPrice: beliefReader.soldPrice };
    const ensureTrip = function* (town) {
        const index = townOrdinal.get(town);
        if (index === undefined) return { known: false, hours: NaN, fees: NaN };
        if (!routes[index]) routes[index] = readyTrip ? readyTrip.details(town) : yield* tripDetails(state, town);
        return routes[index];
    };
    const trip = town => EconomicTrip.price(routes[townOrdinal.get(town)], context.hourAdena);
    trip.details = town => routes[townOrdinal.get(town)] || { known: false, hours: NaN, fees: NaN };
    // The cheapest trip to any town (PriceDecision.marketFor seenTo), the
    // whole-table read main's recheck of the same exit makes (CraftProfitPolicy
    // .tripFor = EconomicTrip.reader): the ready table's, else that reader,
    // read only on a crowded book.
    trip.least = () => (readyTrip || EconomicTrip.reader(state, { hourAdena: context.hourAdena })).least();
    context.trip = trip;
    for (const key in state.inventory || {}) {
        const id = Number(state.inventory[key].selfId || key);
        const value = context.price(id);
        let amount = invoke('GameServer/Bot/Economy/WealthCraftDecision').freeAmount(state, state.inventory[key], reserved);
        if (Number(stock?.itemId) === id) amount = Math.max(0, amount - Math.min(amount,
            Math.max(0, Number(stock.target || 0))));
        ownStock.set(id, { count: amount, unitValue: value }); yield 'stock';
    }
    // The units of a product already made (Price.heldUnits): free in the
    // bag past reservations and the personal stock, incoming and on the
    // bot's own plain sell lines; a new batch is valued beyond them.
    const existing = id => Price.heldUnits(ownStock.get(Number(id))?.count, state.acceptedIncoming?.[id],
        (board.ownerLines(state.characterId) || []).filter(line => line.selfId === Number(id) && Price.plainSale(line)));
    const prepareExits = function* (owner, recipe) {
        // lazy: cycle ReadyTradeChoice loads this module through BotImprovementService
        const Ready = require('../Economy/ReadyTradeChoice');
        const result = []; read(recipe.productId); let count = 0;
        for (const line of board?.list(recipe.productId, 3) || []) {
            if (count++ === QUOTE_DEPTH) break;
            if (!Ready.buyerExitOpen(line, owner)) { yield 'quote'; continue; }
            const details = yield* ensureTrip(line.town);
            result.push({ type: 'afk', conditional: line.custodyPolicy === 1, offer: line, price: Number(line.price), count: Number(line.count), town: line.town,
                trip: trip(line.town), tripDetails: details });
            yield 'quote';
        }
        // The units already made and the personal stock a batch fills first.
        const made = existing(recipe.productId), reserve = Number(stock?.itemId) === Number(recipe.productId)
            ? Math.max(0, Number(stock.target || 0) - Number(state.inventory?.[recipe.productId]?.amount || 0)
                - Number(state.acceptedIncoming?.[recipe.productId] || 0)) : 0;
        for (const exit of result) {
            const asks = board?.list(recipe.productId, 1) || [];
            const { cheaperUnits, limit } = Price.exitCompetition(asks,
                { ownerId: owner.characterId, price: exit.price, count: exit.count });
            exit.cheaperUnits = cheaperUnits;
            if (limit) exit.applicableUnits = NaN;
            yield 'quote';
            Object.assign(exit, Price.prospectiveExit(state, exit, { board, timestamp }));
            // A buyer's line takes the lots it takes from this crafter, no
            // more (Price.bidLots); the craft search sizes within them.
            exit.maxBatches = Price.bidLots(state, exit.offer, { board, timestamp, asks,
                oldUnits: made, reserve, perLot: Number(recipe.productCount || 1), producer: Number(state.characterId) });
            yield 'exit';
        }
        result.push(...yield* ShotSalePolicy.exits(state, recipe, { board, timestamp,
            trip, prepareTrip: ensureTrip, npcOffersFor, read,
            reserve, existing: made }));
        return result;
    };
    // One town table per item and NPC admission for this request: a craft
    // search prices the same input for batches 1..64 and across recipes.
    // A board change of a read item invalidates the request (planner
    // validation), so a table never outlives the board it was read from.
    // Every caller (a wealth craft, a shot craft's scroll, inputs and gear)
    // buys through an errand and passes no purpose: 'craft_input' stands for
    // them; OfferQuery.settledOnlyFor decides whether only lines that sell at
    // once count (a conditional line waits on its seller's meeting).
    const purchaseTables = new Map();
    const preparePurchase = function* (owner, id, amount, query = {}) {
        read(id);
        const npc = query.npc === true;
        const settledOnly = OfferQuery.settledOnlyFor(query.purpose ?? 'craft_input');
        const tableKey = `${Number(owner.characterId)}:${Number(id)}:${npc ? 1 : 0}:${settledOnly ? 1 : 0}`;
        let table = purchaseTables.get(tableKey);
        if (!table) {
            // Static NPC stock is the only unlimited ingredient source admitted here.
            const npcOffers = npc ? FixedShots.npcOffers(id, npcOffersFor) : EMPTY;
            const towns = new Set(npcOffers.map(offer => offer.town));
            for (const line of OfferQuery.inspectedLines(board?.list(id, 1), QUOTE_DEPTH, true)) towns.add(line.town);
            for (const town of towns) { if (townOrdinal.has(town)) yield* ensureTrip(town); yield 'quote'; }
            // sampleWhole (E303, diagnostics only): the whole-list rerun prices only towns whose trip is warmed above, so
            // in the worker `cap:quotes:lost` is a lower bound of the plans the cap drops. The party rule: the
            // owner's half read once for the table (its state is this request's, no session on the worker),
            // the seller's per line (cheapestIn holds its fills by the item's admission revision).
            const admitted = offerAdmission(owner);
            table = OfferQuery.townTable(board, id, { quoteDepth: QUOTE_DEPTH, excludeOwner: owner.characterId,
                accept: line => !Number(line.enchant || 0) && admitted(line),
                npcOffers, cost: trip, sampleWhole: true, settledOnly });
            purchaseTables.set(tableKey, table);
        }
        const best = OfferQuery.cheapestIn(table, amount);
        yield 'candidate';
        return best ? { ...best, tripDetails: trip.details(best.town), routeKey: best.town } : null;
    };
    const gearRowsFor = function* (rank) {
        // The buyer's half of the party rule once per call (this request's state).
        const admitted = offerAdmission(state);
        for (const { gear, crystals } of CrystalCatalog.byGrade(Data.items).get(rank) || []) {
            const selfId = Number(gear.selfId);
            // Null is one static adjacency edge. The consumer yields before
            // skipping it, including catalogue entries with no observed quote.
            yield null; read(selfId);
            for (const offer of npcOffersFor(selfId)) {
                const price = Number(offer.price);
                if (price > 0) yield { selfId, crystals, rank, source: 'npc', price, cash: price, count: 1,
                    town: offer.town, ownerId: 0 };
                else yield null;
            }
            for (const line of OfferQuery.inspectedLines(board?.list(selfId, 1), QUOTE_DEPTH, true)) {
                if (Number(line.ownerId) !== Number(state.characterId) && !Number(line.enchant || 0) && Number(line.price) > 0
                    && admitted(line)) {
                    yield { selfId, crystals, rank, source: 'afk', price: Number(line.price), cash: Number(line.price), count: Number(line.count),
                        town: line.town, ownerId: Number(line.ownerId), offer: line };
                } else yield null;
            }
        }
    };
    return { context, feasibility: preparedFeasibility, options: { reserved, ownStock, existing, prepareExits, preparePurchase, prepareTrip: ensureTrip, gearRowsFor,
        ownLines: board?.ownerLines(Number(state.characterId)) || [] } };
}

module.exports = { initialise, prepare, craftLabour, mpPerHour, reservations, feasibility, tripDetails, regionalTown, QUOTE_DEPTH, recipeIndex,
    hasNpcSellerInTown: town => { initialise(); return npcOfferView?.hasSellerInTown(town) || false; },
    npcOffersFor,
    catalogCounts: () => ({ npcItems: npcOfferView?.itemCount || 0,
        npcQuotes: npcOfferView?.quoteCount || 0,
        teleportEdges: Routes.teleportPoints().length, townPairs: townByName?.size || 0 }) };
