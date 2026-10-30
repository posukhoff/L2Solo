const { parentPort, workerData } = require('worker_threads');
const { partyIdOf } = require('./PartyId');
const epoch = String(workerData?.workerEpoch || 'cold-worker');
// Resolve the master before loading planning modules; inherited env cannot bypass Main's config.
process.env.BOT_DEVELOPER_DIAGNOSTICS = workerData?.developerDiagnostics === true ? 'true' : 'false';
const CharacterLocationRuntime = require('../../World/CharacterLocationRuntime');
const workerProjectorRole = CharacterLocationRuntime.beginWorkerProjectorRole(epoch);
const path = require('path');
const { performance, monitorEventLoopDelay } = require('perf_hooks');
const threadCpuMeter = require('../../ThreadCpuMeter');
let heapTelemetry = null;

const srcRoot = path.resolve(__dirname, '../../..');
require(path.join(srcRoot, 'Global'));
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
if (workerData?.sharedGeodata) GeodataEngine.attachShared(workerData.sharedGeodata);

const DataCache = invoke('GameServer/DataCache');
// Main checked these files against their schemas at startup; that check was ~3/4 of this boot (L71).
DataCache.init({ validate: false });

const originalInvoke = global.invoke;
const npcShopTables = originalInvoke('GameServer/World/Generics/NpcShopBuyLists');
const forbidden = /^(Database|GameServer\/World(?:\/|$)|GameServer\/Bot\/BotManager|GameServer\/Network(?:\/|$)|Server$)/;
const stubs = new Map([
    ['Database', new Proxy({ isReady: () => false }, {
        get(target, property) {
            if (property in target) return target[property];
            return () => Promise.reject(new Error(`cold worker database call forbidden: ${String(property)}`));
        }
    })],
    ['GameServer/Effects/EffectStore', {
        BUFF_LIMIT: 20,
        DEBUFF_RESERVED_SLOTS: 4,
        includedInBuffCount: (effect) => effect?.type !== 'debuff'
            && effect?.type !== 'item_passive'
            && effect?.toggle !== true
            && !['hp_recover', 'life_force_orc'].includes(effect?.stackFamily),
        list: () => []
    }],
    ['GameServer/Skills/ChargeLifecycle', { EXPIRY_MS: 600000 }],
    ['GameServer/Bot/AI/BotRaidSafety', {
        isRaidBoss: (target) => target?.raidBoss === true
            || target?.template?.raidBoss === true
            || String(target?.kind || '').toLowerCase() === 'boss'
            || String(target?.template?.kind || '').toLowerCase() === 'boss',
        isProtectedRaidEntity: (target) => target?.raidBoss === true
            || target?.template?.raidBoss === true
            || String(target?.kind || '').toLowerCase() === 'boss'
            || String(target?.template?.kind || '').toLowerCase() === 'boss'
            || Number(target?.minionBossObjectId || target?.minionBossTemplateId || 0) > 0
    }],
    // The board comes from the 'board' table (boardIndex below); NPC rows from
    // the planning catalog (ColdNpcPlanningCatalog).
    ['GameServer/Bot/Economy/MarketOpportunity', {
        TOWN_NPC_SELLERS: {},
        npcOffersAll: () => [],
        // The one buyer's offer search (OfferQuery.bestBuyerOffer) over the board, the buyer's row from the kernel.
        bestOffer: (selfId, options = {}) => {
            const buyerState = kernel?.states.get(Number(options.buyerCharacterId))?.state;
            // lazy: worker the stub table is built before the worker's invoke override; resolved at call time
            const OfferQuery = invoke('GameServer/Bot/Economy/OfferQuery');
            // lazy: worker as above
            const PartyAdmission = invoke('GameServer/Bot/Population/PartyAdmission');
            return OfferQuery.bestBuyerOffer(boardReady(), selfId, options, { buyerState,
                allowed: PartyAdmission.offerAdmission(buyerState) });
        }
    }],
    // Immutable map boundaries only; no live World, geodata or database access.
    ['GameServer/World/WorldAreaCatalog', { resolve: originalInvoke('GameServer/World/WorldAreaCatalog').resolve }],
    ['GameServer/World/TownRespawn', originalInvoke('GameServer/World/TownRespawn')],
    // Cold bots have no live summon (PartyBuffLoadout.build asks for one); SummonControl loads Network and World.
    ['GameServer/Npc/SummonControl', { activeSummon: () => null }],
    // The game clock is a pure function of the timestamp (cold night bonuses).
    ['GameServer/World/GameTime', originalInvoke('GameServer/World/GameTime')],
    ['GameServer/World/WorldConstants', originalInvoke('GameServer/World/WorldConstants')],
    ['GameServer/World/Generics/NpcShopBuyLists', { allEntries: () => [],
        townOffers: npcShopTables.townOffers }]
]);

// A name passes the boundary check once; hot paths call invoke() per decision.
const allowedModules = new Set();
global.invoke = (module) => {
    if (stubs.has(module)) return stubs.get(module);
    if (!allowedModules.has(module)) {
        if (forbidden.test(String(module || ''))) {
            throw new Error(`cold worker forbidden dependency: ${module}`);
        }
        if (typeof module === 'string') allowedModules.add(module);
    }
    return originalInvoke(module);
};

const BotMarketPricing = invoke('GameServer/Bot/Economy/BotMarketPricing');
BotMarketPricing.useNpcOfferSnapshot([]);
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const BackgroundPartyResolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Shots = invoke('GameServer/Bot/Economy/ShotCraftPolicy');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const GearPlanSelection = invoke('GameServer/Bot/AI/GearPlanSelection');
const PartyRequestPlanner = invoke('GameServer/Bot/Population/PartyRequestPlanner');
const LifeStateProjector = invoke('GameServer/Bot/Population/BotLifeState');
const PartyRequirementRefresh = invoke('GameServer/Bot/Population/PartyRequirementRefresh');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const PartySpotRiskPolicy = require('./PartySpotRiskPolicy');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const DecisionEvents = require('../AI/DecisionEvents');
const SavedStats = require('../SavedStats');
const { stateKey, usePlanningIndex } = require('./SpotOccupancyIndex');
const DecisionSections = invoke('GameServer/Bot/Economy/DecisionSections');
const PartyWaitFallback = invoke('GameServer/Bot/Population/PartyWaitFallback');
const Protocol = require('./ColdSimulationProtocol');
const ColdEconomyDecision = require('./ColdEconomyDecision');
const ColdEconomyPlan = require('./ColdEconomyPlan');
const RecomputeGeneration = require('./RecomputeGeneration');
const PersonalWarehouseIndex = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
const ClanSupplyPolicy = invoke('GameServer/Clan/ClanSupplyPolicy');
const ClanMembershipPolicy = require('../../Clan/ClanMembershipPolicy');
const { ColdOccupationPlanner } = require('./ColdOccupationPlanner');
const OccupationSources = require('./ColdOccupationSources');
const RecipeProduction = require('../Economy/RecipeProductionIndex');
const EconomicTrip = require('../Economy/EconomicTrip');
const RequiredPartyFormation = require('./RequiredPartyFormation');
const { ColdCompetitionMonitor } = require('./ColdCompetitionMonitor');
const ColdCompetitionCandidates = require('./ColdCompetitionCandidates');
const { ColdSimulationKernel } = require('./ColdSimulationKernel');
const PartyHuntingTarget = require('./PartyHuntingTarget');
const PartyGoalCalculation = require('./PartyGoalCalculation');
const { beginHuntingTrip } = require('./HuntingTravel');
const BotRoute = require('./BotRoute');
const ColdNpcPlanningCatalog = require('./ColdNpcPlanningCatalog');
const TableMirror = require('./TableMirror');
const { BoardIndex, recordOf, escrowOf } = require('../../AfkTrade/BoardIndex');
const PartyAdmission = require('./PartyAdmission');
const ColdPvpResolver = invoke('GameServer/Bot/Population/ColdPvpResolver');
const { MarketBuyerWaiters } = require('../Economy/MarketBuyerWaiters');
const SpotIndex = require('../AI/SpotIndex');
const SpotService = require('../AI/SpotService');
const SpotValueTable = require('../AI/SpotValueTable');
const DemandPrice = invoke('GameServer/Bot/Economy/DemandPrice');
const ColdCombatProfile = require('./ColdCombatProfile');
const EconomyContext = invoke('GameServer/Bot/Economy/EconomyContext');
const MarketDemand = invoke('GameServer/Bot/Economy/MarketDemand');
const CommittedExits = require('../Economy/CommittedExits');
const TradeIntent = invoke('GameServer/Bot/Economy/TradeIntent');
const BidPurchaseAlternative = invoke('GameServer/Bot/Economy/BidPurchaseAlternative');
const PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const TradeMeeting = invoke('GameServer/AfkTrade/TradeMeeting');
const CraftEligibility = require('../Economy/CraftEligibility');
const RecipeBookCodec = require('../Economy/RecipeBookCodec');
const EconomyCommit = require('../Economy/EconomyCommit');
const VisitNeed = require('../../ClanHall/VisitNeed');
const HallPolicy = require('../../ClanHall/Policy');
const forbiddenLoaded = Object.keys(require.cache).filter((filename) => (
    /[\\/]src[\\/]Database\.js$/i.test(filename)
    || /[\\/]GameServer[\\/]World[\\/]World\.js$/i.test(filename)
    || /[\\/]GameServer[\\/]Bot[\\/]BotManager\.js$/i.test(filename)
    || /[\\/]GameServer[\\/]Network[\\/]/i.test(filename)
));
if (forbiddenLoaded.length) throw new Error(`cold worker loaded forbidden modules: ${forbiddenLoaded.join(', ')}`);

let kernel = null;
// The scheduler wakes at kernel.nextWakeAt() (one timer on the nearest
// deadline). false restores the fixed loopIntervalMs poll.
const LOOP_ALARM = true;
// Longest idle sleep: the bound on a wake missed by a path that adds work
// without a re-arm (a resolve finishing between messages).
const LOOP_IDLE_CAP_MS = 250;
let loopTimer = null;
let loopIntervalMs = 20;
let loopArmedAt = 0;
let flushTimer = null;
let heartbeatTimer = null;
let shuttingDown = false;
let competition = null;
let competitionCandidates = null;
let competitionReady = false;
let safetyStateReady = false;
let safetyStateRepairs = 0;
let safetyOrphanRepairs = 0;
let previousElu = null;
let threadCpuMs = null;
let planningSpots = [];
invoke('GameServer/Bot/AI/SpotValueTable').useSpots(() => planningSpots);
let planningNpcOfferRows = [];
const tables = new TableMirror({ actorProjectorRole: workerProjectorRole });
// Planning producers import this same collector; its worker cap is64 rows.
const economyDiagnostics = require('../Economy/EconomyDiagnostics');
// The board's offers, built from the main thread's 'board' table as it changes.
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const TradeMeetingCodec = invoke('GameServer/AfkTrade/TradeMeetingCodec');
const boardIndex = new BoardIndex({ groupOf: MarketCounters.counterOf });
const buyerWaiters = new MarketBuyerWaiters({
    stateFor: id => kernel?.states.get(id)?.state,
    demandsFor: (state, timestamp) => invoke('GameServer/Bot/Economy/MarketDemandIndex').signalsOfState(state, timestamp),
    wake: (id, timestamp) => kernel?.wakeBuyer(id, timestamp) === true
});
const boardFollower = boardIndex.follower();
// A whole 'board' or 'market' table is being replaced: set by its reset, cleared
// by the table_page whose piece ends the full copy (TableMirror ready), which
// then rechecks the occupation slots against the whole new copy once. A gap
// during the copy asks for it again (table_resync); that copy's reset keeps
// the flag and its last piece ends the wait.
// censusMoved: a census row of the applied page moved what the census buys
// (MarketDemand.censusBuys): the recipe index rechecks once per page.
let boardReplacing = false, marketReplacing = false, censusMoved = false;
// A bot's own route preparation in flight (occupationFor mode wish), keyed by
// its id; the planner runs it in slot -id.
const routeRequests = new Map();
const publicWorkshopIndex = new (require('../Economy/PublicWorkshopIndex').PublicWorkshopIndex)();
// recipeId -> the mirrored workshops offering it, whatever their capacity now
// (the index drops a row below one batch): the worker's demand price holders
// (main: CraftWorkshopService's records).
const workshopHolders = new Map();
const countHolder = (recipeId, step) => {
    const count = (workshopHolders.get(recipeId) || 0) + step;
    if (count > 0) workshopHolders.set(recipeId, count); else workshopHolders.delete(recipeId);
};
DemandPrice.useHolders(recipeId => workshopHolders.get(Number(recipeId)) || 0);
const publicWorkshopKeys = new Map(), workshopRevisions = new Map(), workshopScopeDigests = new Map();
const digestToken = value => value ? `${value.xor}:${value.sum}:${value.count}` : '0:0:0';
// A known empty workshop in the one shape the context key and the decision
// packing read; a missing field would key a different planning input.
const noWorkshop = () => ({ known: true, recipeId: 0, productId: 0, incomePerHour: 0, cycleHours: 0 });
function workshopsFor(recipeId, state) { return publicWorkshopIndex.candidates(recipeId, Number(state?.characterId || 0)); }
function changeWorkshop(key, row) {
    const previous = publicWorkshopKeys.get(key);
    const recipeId = Number(row?.[1] || previous?.recipeId);
    if (!(recipeId > 0)) return;
    if (previous) { publicWorkshopKeys.delete(key); publicWorkshopIndex.remove(key); countHolder(previous.recipeId, -1); }
    if (row) {
        const value = { characterId: row[0], recipeId, price: row[2], entryPrice: row[2], townName: row[3],
            loc: { locX: row[4], locY: row[5], locZ: row[6] }, capacityBatches: row[7] };
        publicWorkshopKeys.set(key, value); publicWorkshopIndex.put(key, value); countHolder(recipeId, 1);
    }
    const productId = Number(C4RecipeItems.resolveByRecipeId(recipeId)?.productId || 0);
    if (productId) {
        const scalar = value => [value.characterId, value.recipeId, value.entryPrice, value.townName, value.loc.locX, value.loc.locY, value.loc.locZ, value.capacityBatches];
        const scope = MarketCounters.counterOf(productId), scoped = workshopScopeDigests.get(scope) || { xor: 0, sum: 0, count: 0 };
        const updateScope = (values, step) => { const hash = invoke('GameServer/Bot/Fnv1a').fnv1a32(JSON.stringify(values));
            scoped.xor = (scoped.xor ^ hash) >>> 0; scoped.sum = (scoped.sum + step * hash) >>> 0; scoped.count += step; };
        if (previous) updateScope(scalar(previous), -1); if (row) updateScope(row, 1);
        if (scoped.count) workshopScopeDigests.set(scope, scoped); else workshopScopeDigests.delete(scope);
        occupationPlanner.groupChanged(scope);
        workshopRevisions.set(productId, (workshopRevisions.get(productId) || 0) + 1); occupationPlanner.sourceChanged(productId); }
}
const EDGE_STEPS = 64;
const WORK_STAGES = Object.freeze(['stock', 'recipe', 'ingredient', 'owned', 'quote', 'trip', 'exit', 'without', 'success', 'utility', 'candidate', 'funding', 'edge']);
const occupationPlanner = new ColdOccupationPlanner({
    onPublishError: (error, characterId, input) => send('fault', {
        reason: 'occupation_publication_failed', characterId, mode: input.mode,
        stack: String(error?.stack || error).slice(0, 4096)
    }),
    sourceToken: (id, input) => input?.mode === 'meeting'
        ? TradeMeetingCodec.dependencyToken(boardIndex.groupFingerprint(MarketCounters.counterOf(id)),
            digestToken(workshopScopeDigests.get(MarketCounters.counterOf(id))))
        // Not the item's counter: the counter is a drifting market read. The
        // slot is bound to the state of the card it fed (a done slot is
        // re-pointed onto the next native state only while sameInput holds,
        // nativeSet; a stale echo goes out only while the owner's state is the
        // input's), and the next build reads the counter live (PriceBelief.prior
        // re-reads indexOf).
        : `${boardIndex.itemRevision(id)}:${tables.rows('market').get(`i:${id}`)?.[1] || 0}:${workshopRevisions.get(id) || 0}`,
    sourceScope: id => MarketCounters.counterOf(id),
    sourceScopeToken: scope => OccupationSources.recipeIndex(boardIndex).revision(scope),
    ownCurrent: (id, input) => !shuttingDown && (id >= 0 || routeRequests.get(-id) === input)
        && kernel?.states.get(Math.abs(id))?.state === input.sourceState,
    // In-flight de-duplication only, never a keep-or-recompute rule (the
    // workshop is kept with the held build, EconomyContext.heldWorkshop): one
    // native state (sourceState; the kernel replaces a state, never edits it),
    // the same asked state object (a step asks twice on different ones: the
    // card's craft refresh before its round, the action after it), and the
    // request's own inputs beside the state (the warehouse and clan supply
    // versions, whose table writes re-plan a near bot on its same state; a
    // party goal query passes main's escrow and recipe book).
    sameInput: (left, right) => left.mode === right.mode && left.sourceState === right.sourceState
        && left.routeKey === right.routeKey && (left.mode === 'wish' || left.state === right.state
        && left.assetsKey === right.assetsKey && left.recipeBook === right.recipeBook && left.stock === right.stock
        && left.sourceReady === right.sourceReady && left.buyOrderEscrow === right.buyOrderEscrow),
    capture: (id, input, read, readScope) => {
        const book = RecipeBookCodec.unpack(input.recipeBook);
        return { state: input.state, board: boardReady(), timestamp: input.timestamp, read, readScope,
            knownRecipes: book || [], recipesKnown: book !== null, book,
            buyOrderEscrow: input.buyOrderEscrow, stock: input.stock || null, economy: input.economy || null,
            routeRows: input.routeRows || null, routeKey: input.routeKey, mode: input.mode || 'occupation', meeting: input.meeting, pending: input.pending,
            // The ask's trigger for the rebuild table (a refresh or near build
            // and its moved-source shadow, publish).
            trigger: input.trigger || 'native_own_action' };
    },
    create: input => occupationWork(input, (function* () {
        if (input.mode === 'wish') return yield* EconomicTrip.prepare(input.state);
        if (input.mode === 'showcase') return { economyPlan:
            yield* invoke('GameServer/Bot/Population/ColdEconomyPlan').prepare(input.state, input.economy, {
                showcaseOnly: true, now: input.timestamp, board: input.board, tripCost: input.economy.trip,
                npcOffersFor: OccupationSources.npcOffersFor,
                findSpot: id => SpotIndex.spotById(planningSpots, id)
            }) };
        if (input.mode === 'meeting') {
            const request = input.meeting, ownId = Number(input.state.characterId);
            const side = request.actorA === ownId ? 0 : 1, own = request.parties[side];
            if (!EconomyCommit.sameAuthority(own, EconomyCommit.authority(input.state))) throw Error('trade_meeting_authority_changed');
            // A fill of the bot's own buy ad: every own line pays and carries the
            // ad's certificate (TradeMeetingService.prepareTrade). The bid was the
            // owner's consent at publish; the meeting checks it against the terms
            // and the wallet instead of rebuilding the network (held build is
            // checked, not rebuilt). A seller and a selected-quote buy build it.
            const trusted = request.lines.every(line => line.payer === side && line.certificate);
            let economy = null, intents = null, basics = null;
            // A trusted line's survival cost: the held build's kit, else the
            // bot's basics, built once for the meeting.
            const kitCost = line => EconomyContext.heldKitCost(input.state, line.selfId, line.price, line.intentRevision)
                ?? (basics ||= EconomyContext.basics(input.state, { board: input.board, timestamp: input.timestamp,
                    npcOffersFor: OccupationSources.npcOffersFor })).kitCost(line.selfId, line.price);
            if (!trusted) {
                // Public shot flow can admit another earning recipe before the
                // old graph reads its product. At most five category dependencies
                // cover the craftable grades, including currently absent demand.
                const craftLevel = CraftEligibility.craftLevelFor(input.state);
                for (const recipeId of Shots.SHOT_RECIPE_IDS) {
                    const recipe = C4RecipeItems.resolveByRecipeId(recipeId);
                    if (recipe && recipe.level <= craftLevel) input.read(Number(recipe.productId));
                }
                const routeRows = yield* EconomicTrip.prepare(input.state);
                // Fresh physical incoming is delivered in the native owner snapshot.
                // Reuse the bounded graph/seed; no price or private plan from another actor.
                economy = EconomyContext.forState(input.state, { board: input.board, routeRows, workshops: workshopsFor,
                    timestamp: input.timestamp, onSourceRead: input.read, onSourceScope: input.readScope, knownRecipes: input.knownRecipes, workshop: noWorkshop(),
                    buyOrderEscrow: input.buyOrderEscrow, npcOffersFor: OccupationSources.npcOffersFor,
                    // A meeting review (its own workshop input, maybe the meeting's incoming) never
                    // replaces the bot's held plan: its next request still finds it (L133).
                    rememberContext: false, caller: 'meeting_prepare', trigger: request.token });
                yield 'candidate';
                if (economy.intentPending) throw Error('trade_meeting_preparation_pending');
                intents = TradeIntent.project(input.state, economy.network, economy.projection, 40);
                if (!intents) throw Error('trade_meeting_preparation_pending');
            }
            const routePlan = invoke('GameServer/Bot/Population/ColdTrip').meetingTownPlan(input.state, request.point);
            if (!routePlan) throw Error('trade_meeting_route');
            const shared = /^meeting:([1-9][0-9]*)$/.exec(own.route.method);
            if (shared && Number(shared[1]) !== Number(input.state.stats?.tradeMeeting?.[0])) throw Error('trade_meeting_route_changed');
            own.route = shared ? { fee: 0, scroll: false, method: own.route.method, durationMs: 0 }
                : { fee: routePlan.route.fee, scroll: !!routePlan.scroll, method: routePlan.method, durationMs: routePlan.durationMs };
            let sellerDecision = null;
            const survival = new Map();
            const required = new Map(), sold = new Map();
            for (const line of request.lines) if (line.payer === side) required.set(line.selfId, (required.get(line.selfId) || 0) + line.count);
            else sold.set(line.selfId, (sold.get(line.selfId) || 0) + line.count);
            for (const line of request.lines) {
                if (!trusted) input.read(line.selfId);
                if (line.payer === side) {
                    let intent;
                    if (trusted) {
                        // The terms already match the certificate's item and
                        // price (TradeMeeting canonical); split stacks share its
                        // amount. A held build at least as new as the
                        // certificate is the owner's want now (read, not
                        // rebuilt): no longer listed or fewer units refuses, and
                        // its rate bounds the funding; an older one is ignored.
                        intent = TradeIntent.decode(line.certificate);
                        const want = EconomyContext.heldWatch(input.state, line.selfId, line.intentRevision);
                        if (intent.amount < required.get(line.selfId))
                            throw Error('trade_meeting_need_changed', { cause: 'certificate' });
                        if (want === null || want && want.amount < required.get(line.selfId))
                            throw Error('trade_meeting_need_changed', { cause: 'held_row' });
                        if (want) intent = { ...intent, valueRate: Math.min(intent.valueRate, Number(want.valueRate) || 0) };
                    } else {
                        intent = TradeIntent.meetingPurchase(economy.network, intents,
                            { selfId: line.selfId, count: required.get(line.selfId), price: line.price,
                                town: request.town, enchant: Number(line.enchant || 0) }, input.state);
                        if (!intent) throw Error('trade_meeting_need_changed');
                        if (economyDiagnostics.active() && !intents.some(row => row.itemId === line.selfId
                            && row.amount >= required.get(line.selfId) && Number(row.worth) >= line.price)) {
                            economyDiagnostics.count('meeting', 'purchase_consent', 'selected_quote');
                            if (economyDiagnostics.enabled(ownId)) economyDiagnostics.push({ owner: ownId,
                                trigger: request.token, phase: 'meeting_consent', reason: 'selected_quote',
                                wishKey: intent.key, item: line.selfId, requested: line.count, unitPrice: line.price,
                                quote: intents.find(row => row.itemId === line.selfId)?.worth || 0 });
                        }
                    }
                    line.certificate = TradeIntent.encode({ ...intent, amount: line.count, price: line.price, valueHours: intent.valueHours * line.count / intent.amount });
                    // Survival first (each item's kit cost once), the rest by the
                    // wish's rank, as every other restock (PurchaseFunding.stockAllowance).
                    survival.set(line.selfId, Math.round((trusted ? kitCost(line) : economy.kitCost?.(line.selfId, line.price)) || 0));
                } else {
                    // An old own SELL quote must not bypass personal stock
                    // protection when preparing a new meeting.
                    if (invoke('GameServer/Inventory/ShotStock').isPersonalShot(input.state, line.selfId))
                        throw Error('trade_meeting_protected_stock');
                    const item = input.state.inventory?.[line.selfId];
                    const free = invoke('GameServer/Bot/Economy/WealthCraftDecision').freeAmount(input.state, item || {});
                    if (free < sold.get(line.selfId)) throw Error('trade_meeting_protected_stock');
                    const quote = input.board?.records.get(line.adId)?.find(row => row.selfId === line.selfId);
                    if (Number(quote?.ownerId) !== ownId) {
                        sellerDecision ||= invoke('GameServer/Bot/Economy/MarketListingPolicy').evaluate(input.state, { economy, board: input.board,
                            npcOffersFor: OccupationSources.npcOffersFor,
                            findSpot: id => SpotIndex.spotById(planningSpots, id),
                            now: input.timestamp, decisionPoint: `meeting:${request.token}`, slots: 5 });
                        const answer = sellerDecision.answers.find(row => row.item.selfId === line.selfId
                            && Number(row.line.recordId) === line.adId && row.count >= line.count);
                        if (!answer) throw Error('trade_meeting_sale_changed');
                    }
                }
                yield 'funding';
            }
            // Funding: the native accept asks the same question with the same
            // terms (TradeMeeting.fundingTerms; the proof carries survivalCost).
            own.survivalCost = [...survival.values()].reduce((a, b) => a + b, 0);
            const { amount, ...terms } = TradeMeeting.fundingTerms(request, side);
            const spendable = PurchaseFunding.spendable(input.state, 0, terms);
            if (amount > spendable) throw Error('trade_meeting_funding');
            // A buy from a sell ad: no NPC or shop sells it cheaper now (the
            // rebuilt plan's routes and sources). An own buy-ad fill keeps its bid.
            if (!trusted) BidPurchaseAlternative.assertMeetingPurchase(request.lines, side, request.town, {
                state: input.state, characterId: ownId, adena: Number(input.state.adena || 0), hour: economy.hourAdena,
                economy, board: input.board, travelDetails: economy.trip.details,
                npcOffersFor: OccupationSources.npcOffersFor
            }, Math.min(spendable, Number(input.state.adena || 0)));
            // The certificate is the trusted fill's whole input: no source read to fence.
            // The proof is the build's own read tokens (sourceToken, meeting
            // mode): a token that moved mid-build made the slot dirty, so these
            // are the ones this request was decided on.
            request.dependencies = trusted ? [] : [...occupationPlanner.slots.get(ownId).reads.entries()];
            if (request.dependencies.length > 40) throw Error('trade_meeting_dependency_pressure');
            return request;
        }

        // A refresh (a far bot's economy plan) and a near bot's decision
        // (mode near) build the economy on the same inputs.
        if (input.mode === 'refresh' || input.mode === 'near') {
            const routeRows = input.routeRows = input.routeRows || (yield* EconomicTrip.prepare(input.state));
            input.economy = invoke('GameServer/Bot/Economy/EconomyContext').forState(input.state, {
                board: input.board, routeRows, workshops: workshopsFor,
                timestamp: input.timestamp, onSourceRead: input.read, onSourceScope: input.readScope, knownRecipes: input.knownRecipes, npcOffersFor: OccupationSources.npcOffersFor,
                buyOrderEscrow: input.buyOrderEscrow,
                // The book proposes the crafter's workshop offer (TwinCluster); none while unknown.
                recipeBook: input.book,
                // Both builds are held: the step after a refresh is served its
                // build while nothing was raised since (EconomyContext raisedSince),
                // a near post's clean repeat hits the verdict. A near build takes
                // the empty workshop, no ask: it records none (workshopAsked). A
                // refresh keeps the held workshop and its ask record (keptWorkshop).
                ...(input.mode === 'near' ? { workshop: noWorkshop(), workshopAsked: null } : {}),
                caller: `economy_${input.mode}`, trigger: input.trigger });
            // The shared money packet is derived from this same graph. Use it
            // in preparation only; the native writer owns physical funding.
            input.state = { ...input.state, stats: { ...input.state.stats, ...input.economy.statsPacket } };
            input.stock = input.economy.stock('shots');
            yield 'candidate';
        }
        // A workshop (mode occupation, near) is none: no product of a known
        // recipe has a repeatable exit since static buyers stopped buying
        // (C8). Only the owner's line feasibility mask rides with it.
        if (input.mode === 'occupation' || input.mode === 'near') {
            const mask = input.board?.ownerLines(input.state.characterId)?.length
                ? yield* OccupationSources.feasibility(input.state, input) : null;
            return { ...noWorkshop(), feasibility: mask };
        }
        const prepared = yield* OccupationSources.prepare(input.state, input);
        if (!prepared && input.mode === 'refresh') {
            const economyPlan = yield* invoke('GameServer/Bot/Population/ColdEconomyPlan').prepare(input.state, input.economy, {
                now: input.timestamp, board: input.board, persona: BotPersona.of(input.state), tripCost: input.economy.trip,
                preparedCraft: null, npcOffersFor: OccupationSources.npcOffersFor,
                buyOrderEscrow: input.buyOrderEscrow, findSpot: id => SpotIndex.spotById(planningSpots, id) });
            return { selected: null, economyPlan, economyDecision: ColdEconomyDecision.capture(input.economy, input.state) };
        }
        if (!prepared) return null;
        const Wealth = invoke('GameServer/Bot/Economy/WealthCraftDecision');
        const options = { ...prepared.options, stock: input.stock, buyOrderEscrow: input.buyOrderEscrow, now: input.timestamp };
        // The producer root's craft, sized by its leaf (WealthCraftDecision.producerStep,
        // the one answer to which craft the crafter takes); this step only executes it.
        // A held card's view has no producer rows: no craft until a build.
        const selected = Wealth.eligible(input.state, options) ? (yield* Wealth.producerStep(input.state,
            input.economy?.network?.producers, input.knownRecipes, { context: prepared.context, options }))?.step || null : null;
        const economyPlan = input.economy ? yield* invoke('GameServer/Bot/Population/ColdEconomyPlan').prepare(input.state, input.economy, {
            ...prepared.options, now: input.timestamp, board: input.board, persona: BotPersona.of(input.state),
            tripCost: prepared.context.trip, preparedCraft: selected,
            npcOffersFor: OccupationSources.npcOffersFor,
            ...(economyDiagnostics.enabled(input.state.characterId) ? { onTownDecision: decision => economyDiagnostics.push({
                owner: input.state.characterId, revision: Number(input.state.simulation?.revision), trigger: 'economy_plan',
                phase: 'town_choice', town: decision.town, reason: decision.reason, candidates: decision.candidates,
                tripHours: decision.tripHours, tripFees: decision.tripFees
            }) } : null),
            findSpot: id => SpotIndex.spotById(planningSpots, id),
            buyOrderEscrow: input.buyOrderEscrow
        }) : null;
        return { selected, economyPlan, ...(input.mode === 'refresh' ? { economyDecision:
            ColdEconomyDecision.capture({ ...input.economy, shot: economyPlan?.shot || null }, input.state) } : {}) };
    })()),
    // An edge (one polygon side, teleport point or material node) costs less
    // than the planner's per-unit checks: up to EDGE_STEPS of them run as one
    // unit. Other yields still end the unit, so the 4 ms slice check is unchanged.
    step: work => {
        let next = work.iterator.next(); work.units++;
        for (let edges = 1; next.value === 'edge' && edges < EDGE_STEPS; edges++) { next = work.iterator.next(); work.units++; }
        work.stage = typeof next.value === 'number' ? next.value
            : WORK_STAGES.indexOf(next.value) + 1;
        if (next.done) { work.done = true; work.value = next.value; work.iterator = null; }
        return work.done;
    },
    result: work => work.value,
    publish: (id, input, workshop, meta = {}) => {
        if (input.mode === 'meeting') {
            occupationPlanner.release(id); return;
        }
        if (input.mode === 'refresh') {
            const entry = kernel?.states.get(id);
            // The plan was already sent; a source change does not re-request
            // a refresh for the same native state (the next state does).
            if (meta.stale && entry?.state === input.sourceState && entry.economyPending) {
                occupationPlanner.release(id); return;
            }
            if (!shuttingDown && entry?.state === input.sourceState && !meta.stale && workshop?.economyPlan) {
                const hash = economyPlanHash(workshop.economyPlan);
                // A paging refresh that repeats the plan already sent (by the
                // commit or the last refresh) has nothing more to page.
                if (input.pending && hash === entry.economyPlanHash) { entry.economyPending = 0; input.economy = null; return; }
                entry.economyPlanHash = hash;
                entry.economyPending = workshop.economyPlan.d || 0;
                send('ready', { phase: 'economy_plan_ready', characterId: id,
                    authority: EconomyCommit.authority(input.state), economyPlan: workshop.economyPlan,
                    economyDecision: workshop.economyDecision });
            }
            input.economy = null; return;
        }

        if (input.mode === 'wish') {
            if (id < 0 && routeRequests.get(-id) === input) {
                routeRequests.delete(-id);
                occupationPlanner.release(id);
            }
            return;
        }
        // The action result is the existing compact native plan. Its derived
        // network is needed while preparing it, never by the completed cache.
        if (input.mode === 'action' || input.mode === 'showcase') input.economy = null;
        const owner = kernel?.states.get(id);
        if (shuttingDown || owner?.state !== input.sourceState) return;
        if (meta.stale) {
            // Main marks its copy stale (staleWorkshop). A near row's slot
            // recomputes on its next post; main's copy is current by nearSeq.
            if (input.state.phase !== 'hot') send('ready', { phase: 'economy_workshop_stale', characterId: id,
                updatedAt: Number(input.state.updatedAt || 0), echo: ColdEconomyDecision.stateEcho(input.state) });
        } else if (input.mode === 'near' && workshop?.decision) {
            // The near bot's decision on its post: the card, and beside it the
            // mind keys the body takes and the post and raise it answers.
            // The published packet moves the record's mind, as the far step's merge does,
            // so the next post's events compare against it and a raise is taken once.
            Object.assign(owner.state.stats ||= {}, workshop.statsPacket);
            owner.nearRoute = { key: input.routeKey, rows: workshop.routeRows };
            send('ready', { phase: 'economy_decided', characterId: id, economyDecision: workshop.decision,
                near: { statsPacket: workshop.statsPacket, shotRestock: workshop.shotRestock, personalCraft: workshop.personalCraft,
                    nearSeq: Number(input.state.nearSeq || 0), raiseSeq: Number(input.raiseSeq || 0),
                    ...(workshop.shots ? { shots: workshop.shots } : {}) } });
            // Sent once: the slot keeps the workshop.
            workshop.decision = null; workshop.statsPacket = null; workshop.personalCraft = null; workshop.routeRows = null; workshop.shots = null;
        }
    }
});
// The planner's work for one request. A near bot's decision (mode near) is the
// occupation's workshop with the card, the fields beside it
// (DecisionEvents.nearFields) and the route rows of the same build (publish
// sends them once).
function occupationWork(input, iterator) {
    return { iterator: input.mode === 'near' ? nearDecision(input, iterator) : iterator, done: false, value: null, stage: 0, units: 0 };
}
function* nearDecision(input, iterator) {
    const workshop = yield* iterator;
    return { workshop, decision: ColdEconomyDecision.capture({ ...input.economy, workshop }, input.state),
        ...DecisionEvents.nearFields(input.economy, input.state), routeRows: input.routeRows };
}
// options: { economy, stock, routeRows, routeKey } a step already holds, and
// a party goal query's own (main's) buyOrderEscrow.
function occupationFor(state, timestamp, options = {}, mode = 'occupation') {
    const id = Number(state.characterId), sourceState = kernel?.states.get(id)?.state;
    if (!sourceState || shuttingDown) return Promise.resolve(ColdEconomyDecision.unknownWorkshop());
    const routeKey = EconomicTrip.key(state), economy = options.economy || null;
    const directRows = options.routeKey === routeKey && Array.isArray(options.routeRows)
        && options.routeRows.length === EconomicTrip.towns.length ? options.routeRows : null;
    const routeRows = directRows || (economy?.routeKey === routeKey ? economy.routeRows
        : invoke('GameServer/Bot/Economy/EconomyContext').preparedRouteRows?.(state));
    if (mode === 'wish' && Array.isArray(routeRows) && routeRows.length === EconomicTrip.towns.length)
        return Promise.resolve(routeRows);
    if (mode === 'wish') {
        const previous = routeRequests.get(id);
        if (previous?.sourceState === sourceState && previous.routeKey === routeKey)
            return occupationPlanner.request(-id, previous);
        if (!previous && routeRequests.size >= 64) return Promise.resolve([]);
        cancelRoute(id);
        const input = { state: EconomicTrip.frame(state), sourceState, timestamp, mode: 'wish', routeKey };
        routeRequests.set(id, input);
        return occupationPlanner.request(-id, input);
    }
    const recipes = recipeKnowledgeOf(state);
    return occupationPlanner.request(id, { state, sourceState, timestamp, assetsKey: assetsKey(state),
        // The party goal query passes its own (main's) escrow; else the board's sum.
        buyOrderEscrow: options.buyOrderEscrow ?? escrowFor(state.characterId),
        recipeBook: recipes.recipeBook, stock: options.stock || null, economy,
        sourceReady: tables.ready('board') && tables.ready('market'), mode, routeKey, routeRows });
}
// A build's workshop (the crafter's best recipe and its income per hour,
// occupationFor mode occupation), counted by the caller that asks: only a
// build reads it, a held card asks none.
function askWorkshop(state, timestamp, routeRows, caller, options = {}) {
    economyDiagnostics.count('occupation', 'ask', caller);
    return occupationFor(state, timestamp, { ...options, routeRows, routeKey: EconomicTrip.key(state) });
}
// The step's action plan (occupationFor mode action: a crafter's prepared
// craft), asked only at the step's edges (ColdEconomyPlan.edges); its
// economyPlan.shot reaches main through the plan review
// (BotAfkMarketService.executePlan). A refresh asks it inside its own build
// (occupationOwnerChanged).
function askAction(state, timestamp, economy) {
    economyDiagnostics.count('occupation', 'ask', 'action:edge');
    return occupationFor(state, timestamp, { stock: economy.stock('shots'), economy }, 'action');
}
function cancelRoute(characterId) {
    const id = Number(characterId);
    routeRequests.delete(id);
    occupationPlanner.cancel(-id);
}
const refreshedStates = new WeakSet();
function assetsKey(state) {
    return `${PersonalWarehouseIndex.version(state)}:${ClanSupplyPolicy.version(state)}`;
}
const economyPlanHash = plan => require('../Fnv1a').fnv1a32(JSON.stringify(plan));
// A service crafter's packed recipe book, from main's 'recipes' table
// (CraftWorkshopService); none for any other bot.
const NO_RECIPES = Object.freeze({ recipeBook: undefined });
function recipeKnowledgeOf(state) {
    return state && CraftEligibility.isServiceCrafter(state)
        && tables.rows('recipes').get(Number(state.characterId)) || NO_RECIPES;
}
// The spot a bot stands at, in this worker's spot catalog.
const standingSpot = state => SpotService.standingSpot(state, planningSpots);
// A far bot's economy refresh, or a near bot's decision on its post (mode
// near): the raise it consumed (raiseSeq) and the route rows of its last
// decision while its route key holds. trigger: what asked (the rebuild
// table's entry, EconomyContext.rebuildStats): state_copy (a new native state
// not the step's own), own_commit/own_review (the step's own, near only),
// main_refresh/main_look (main's ask), warehouse, clan_supply (the entry
// names only these, EconomyContext REBUILD_TRIGGERS).
// The heartbeat's rebuild table at its largest (frameSizing): every row the
// bound allows, both names at their longest, every count at most.
function rebuildSizing(large) {
    const name = 'x'.repeat(EconomyContext.REBUILD_NAME_MAX);
    return Array.from({ length: EconomyContext.REBUILD_ROWS_MAX }, () => [name, name, large, large, large, large, 1]);
}
function occupationOwnerChanged(id, refresh = false, trigger = 'state_copy') {
    const entry = kernel?.states.get(Number(id));
    if (!entry || entry.state.phase !== 'hot' && !refresh) return;
    // One economy refresh per native state object.
    if (refresh && refreshedStates.has(entry.state)) return;
    if (refresh) { refreshedStates.add(entry.state); economyDiagnostics.count('occupation', 'ask', 'action:refresh'); }
    const routeKey = EconomicTrip.key(entry.state);
    occupationPlanner.request(id, { state: entry.state, sourceState: entry.state, assetsKey: assetsKey(entry.state),
        timestamp: Date.now(), mode: refresh ? 'refresh' : 'near', pending: entry.economyPending || 0, trigger,
        buyOrderEscrow: escrowFor(id),
        ...recipeKnowledgeOf(entry.state),
        routeKey, ...(refresh ? {} : { raiseSeq: Number(entry.raiseSeq || 0),
            routeRows: entry.nearRoute?.key === routeKey ? entry.nearRoute.rows : null }),
        sourceReady: tables.ready('board') && tables.ready('market') }, { awaitResult: false });
}
function changedItems(previous, next) {
    const ids = new Set();
    for (const row of previous || []) ids.add(Number(row.selfId));
    for (const row of next || []) ids.add(Number(row.selfId));
    for (const id of ids) {
        const admission = OccupationSources.recipeIndex(boardIndex);
        for (const scope of admission.update(id)) occupationPlanner.scopeChanged(scope);
        occupationPlanner.sourceChanged(id); occupationPlanner.groupChanged(MarketCounters.counterOf(id));
    }
}
boardIndex.setOwnerChangeObserver((previous, next, board) => {
    const owner = previous[0]?.ownerId, current = next[0]?.ownerId;
    for (const id of owner === current ? [owner] : [owner, current]) if (id) {
        invoke('GameServer/Bot/Economy/BoardLook').consumeOwnProjection(kernel?.lookSeen.get(id), previous, next, board, id);
    }
});
// A bot's buy-order escrow: the sum of its board records' escrow (row[9]),
// kept as the board rows apply (BotAfkMarketService.buyOrderEscrow on main).
const escrowByRecord = new Map(), escrowByOwner = new Map();
function setRecordEscrow(key, ownerId, amount) {
    const previous = escrowByRecord.get(key);
    if (previous) {
        const left = (escrowByOwner.get(previous[0]) || 0) - previous[1];
        if (left > 0) escrowByOwner.set(previous[0], left); else escrowByOwner.delete(previous[0]);
        escrowByRecord.delete(key);
    }
    if (ownerId > 0 && amount > 0) {
        escrowByRecord.set(key, [ownerId, amount]);
        escrowByOwner.set(ownerId, (escrowByOwner.get(ownerId) || 0) + amount);
    }
}
const escrowFor = characterId => escrowByOwner.get(Number(characterId)) || 0;
// The soft point's inputs (DecisionSections.softEvents: a far bot's step,
// BotLifeState.prepareResolve, and a near bot's post): the board mirror (null
// until ready) and the escrow.
const softInputFor = (characterId, timestamp) => ({ board: boardReady(), buyOrderEscrow: escrowFor(characterId), timestamp });
// A near bot's post (BotLifeState.notifyNearFacts) against the row before
// it, on the posted row before it is stored: the raise main named (once per
// raise), the hard facts (DecisionSections.events) and the soft point, in the
// far step's one bump. The decision is then taken on this row (mode near).
// applied: the last raise the record applied.
function nearEvents(id, previous, entry, applied) {
    const row = entry.state, stats = row.stats ||= {};
    // The worker owns the near mind: a post's mind keys are discarded and the
    // record's stand, so a late post cannot roll back a raise.
    for (const key of SavedStats.MIND_KEYS) stats[key] = previous.stats?.[key];
    entry.raiseSeq = DecisionEvents.takePostedRaise(stats, row.raise, applied);
    const hard = DecisionSections.events(previous, row, escrowFor(id));
    const soft = DecisionSections.softEvents(row, stats.wishSections, softInputFor(id, Date.now()));
    DecisionEvents.raiseSections(previous, row, hard, soft);
}
// A bot's goal revision (GoalState.revision on main, 0 = no goal) from the
// 'goals' table; undefined while the table loads (the decision skips the compare).
const goalRevision = characterId => tables.ready('goals')
    ? (tables.rows('goals').get(Number(characterId))?.revision ?? 0) : undefined;
tables.watch('board', {
    reset: () => { escrowByRecord.clear(); escrowByOwner.clear(); publicWorkshopIndex.clear(); publicWorkshopKeys.clear(); workshopHolders.clear(); workshopRevisions.clear(); workshopScopeDigests.clear(); boardReplacing = true; boardFollower.reset(); OccupationSources.recipeIndex(boardIndex).reset(); kernel?.lookSeen.clear(); },
    put: (key, row) => {
        if (String(key).startsWith('w:')) { changeWorkshop(key, row.length === 9 ? row.slice(1) : row); return; }
        const previous = boardIndex.records.get(Number(key)) || [];
        boardFollower.put(key, row);
        setRecordEscrow(Number(key), Number(recordOf(row).ownerId), escrowOf(row));
        changedItems(previous, boardIndex.records.get(Number(key)));
        pruneLookSeen(recordOf(row).ownerId);
        if (previous[0]?.ownerId !== recordOf(row).ownerId) pruneLookSeen(previous[0]?.ownerId);
        if (!boardReplacing && tables.ready('board')) buyerWaiters.recordChanged(recordOf(row), previous);
    },
    remove: (key) => {
        if (String(key).startsWith('w:')) { changeWorkshop(key, null); return; }
        const previous = boardIndex.records.get(Number(key)) || [];
        const ownerId = previous[0]?.ownerId;
        boardFollower.remove(key);
        setRecordEscrow(Number(key), 0, 0);
        changedItems(previous, []);
        if (ownerId) pruneLookSeen(ownerId);
    }
});
// Parties, memory and pressure are main's tables the kernel keeps
// (ColdSimulationKernel.partyPut, InteractionMemory.accept, pressureFor).
// A party's competition side is read through its leader: a row that changes
// leaders moves both the old and the new leader's candidate.
tables.watch('parties', {
    reset: () => { for (const leaderId of kernel?.partyReset() || []) competitionCandidates?.partyChanged(leaderId); },
    put: (key, row) => {
        const previous = kernel?.partyPut(key, row);
        competitionCandidates?.partyChanged(row.leaderId);
        if (previous && Number(previous.leaderId) !== Number(row.leaderId)) competitionCandidates?.partyChanged(previous.leaderId);
    },
    remove: key => {
        const previous = kernel?.partyRemove(key);
        if (previous) competitionCandidates?.partyChanged(previous.leaderId);
    }
});
// The memory rows are kept packed by the kernel's InteractionMemory, not a
// second plain copy in the mirror (retain: false); older revisions are refused.
// Main publishes no removed row: the set is bounded by the owners main
// accepted, and a full copy (reset) re-sends them, kept views refuse equals.
tables.watch('memory', {
    reset() {},
    put: (key, row) => { if (kernel?.interactionMemory.accept(row)) kernel.decisionEvents?.memoryChanged(Number(key)); },
    remove() {}
}, { retain: false });
tables.watch('pressure', {
    reset: () => { if (kernel) kernel.pressureRow = null; },
    put: (_key, row) => { if (kernel) kernel.pressureRow = row; },
    remove: () => { if (kernel) kernel.pressureRow = null; }
});
// The market counters come from the main thread's 'market' table.
MarketCounters.useTable(() => tables.rows('market'));
MarketCounters.useSpots(() => planningSpots);
// A row put or removed: an item row rechecks its readers, a counter row only
// drops the held counter moves (no meeting token reads the counter).
function marketRowChanged(key) {
    const text = String(key);
    if (text.startsWith('c:')) { MarketCounters.movesChanged(); OccupationSources.recipeIndex(boardIndex, false)?.counterMoved(text.slice(2)); }
    else if (text.startsWith('i:')) { OccupationSources.recipeIndex(boardIndex, false)?.priceMoved(Number(text.slice(2))); occupationPlanner.sourceChanged(Number(text.slice(2))); }
    // A census row moves its item's sums; its readers wake by the soft point.
    else if (text.startsWith('d:')) { MarketDemand.censusChanged(text); censusMoved = true; }
}
tables.watch('market', {
    reset: () => { marketReplacing = true; censusMoved = true; MarketCounters.movesChanged(); MarketDemand.censusChanged(); OccupationSources.recipeIndex(boardIndex, false)?.marketReset(); kernel?.lookSeen.clear(); },
    put: marketRowChanged,
    remove: marketRowChanged
});
// The player's meeting waits ('meetings'): the bots a player waits for. A
// row that comes or goes moves the bot's schedule (playerWaitingTransition).
const playerWaits = new Set();
tables.watch('meetings', {
    reset: () => {
        const previous = [...playerWaits];
        playerWaits.clear();
        for (const id of previous) kernel?.ensureScheduled(id);
    },
    put: key => { playerWaits.add(Number(key)); kernel?.ensureScheduled(Number(key)); },
    remove: key => { playerWaits.delete(Number(key)); kernel?.ensureScheduled(Number(key)); }
}, { retain: false });
// The clan halls ('clan_halls'), by owner clan: VisitNeed.needed reads the
// row with the hall's catalog definition (bounds, managers).
const hallById = new Map();
const hallByOwner = new Map();
tables.watch('clan_halls', {
    reset: () => { hallById.clear(); hallByOwner.clear(); },
    put: (key, row) => {
        const previous = hallById.get(Number(key));
        if (previous && hallByOwner.get(previous.ownerId) === previous) hallByOwner.delete(previous.ownerId);
        const hall = { ...HallPolicy.definition(row.id), ...row };
        hallById.set(Number(key), hall);
        if (hall.ownerId > 0) hallByOwner.set(hall.ownerId, hall);
    },
    remove: key => {
        const previous = hallById.get(Number(key));
        hallById.delete(Number(key));
        if (previous && hallByOwner.get(previous.ownerId) === previous) hallByOwner.delete(previous.ownerId);
    }
}, { retain: false });
// One hall verdict per state object and hall row until its next time
// crossing (VisitNeed.validUntil): lifecycleKind asks it several times per
// step, and a new state or hall row is a new key.
const hallVerdicts = new WeakMap();
function hallNeeded(state, timestamp) {
    const hall = hallByOwner.get(Number(state?.clanId ?? state?.stats?.clanId)) || null;
    if (!hall && !state?.stats?.clanHallVisit) return false;
    const known = hallVerdicts.get(state);
    if (known && known.hall === hall && timestamp >= known.at && timestamp < known.until) return known.value;
    const value = VisitNeed.needed(state, hall, hall?.managerPresent === true, timestamp);
    hallVerdicts.set(state, { hall, at: timestamp, until: VisitNeed.validUntil(state, hall, timestamp), value });
    return value;
}
tables.watch('personal_warehouse', {
    reset: () => {},
    put: (key, row) => { PersonalWarehouseIndex.prepareRow(row); occupationOwnerChanged(Number(key), false, 'warehouse'); },
    remove: key => occupationOwnerChanged(Number(key), false, 'warehouse')
});
tables.watch('clan_supplies', {
    reset: () => {},
    put: (key, row) => {
        ClanSupplyPolicy.prepareRow(row);
        // Only the bounded planner slots can carry an obsolete hot card.
        // Cold owners notice the version at their next natural resolve.
        for (const entry of occupationPlanner.slots.values()) {
            const state = entry.input.state;
            if (state.phase === 'hot' && Number(state.clanId ?? state.stats?.clanId) === Number(key))
                occupationOwnerChanged(entry.id, false, 'clan_supply');
        }
    },
    remove: key => {
        for (const entry of occupationPlanner.slots.values()) {
            const state = entry.input.state;
            if (state.phase === 'hot' && Number(state.clanId ?? state.stats?.clanId) === Number(key))
                occupationOwnerChanged(entry.id, false, 'clan_supply');
        }
    }
});
function boardReady() {
    return tables.ready('board') ? boardIndex : null;
}

function safetyTotals() {
    return { stateRepairs: safetyStateRepairs,
        coverageRepairs: 0, orphanRepairs: safetyOrphanRepairs };
}

function safetyPresence(checkpoint) {
    const id = checkpoint.characterId, entry = kernel?.states.get(id);
    const result = { characterId: id, checkpoint, observedCheckpoint: Protocol.safetyCheckpoint(entry?.state),
        workerVersion: kernel?.versions.get(id) || 0,
        normal: { status: 'deferred', reason: 'state_catalog_loading' } };
    const gate = (status, reason) => {
        result.normal = { status, reason };
        return result;
    };
    if (!kernel || !safetyStateReady) return result;
    if (shuttingDown || kernel.stopping) return gate('deferred', 'worker_shutdown');
    if (checkpoint.phase !== 'cold') return gate('ineligible', 'not_cold');
    // The committed row can be ahead of the cached state during ACK processing.
    if (kernel.busy(id)) return gate('deferred', 'worker_busy');
    const normalCovered = kernel.hasNormalCoverage(id);
    if (entry && !Protocol.sameSafetyCheckpoint(checkpoint, entry.state)) return gate('deferred', 'checkpoint_changed');
    result.normal = normalCovered ? { status: 'covered', reason: 'normal_schedule' }
        : kernel.paused ? { status: 'deferred', reason: 'worker_paused' }
            : !entry ? { status: 'uncovered', reason: 'missing_state' }
                : kernel.needsNormalSchedule(id) ? { status: 'uncovered', reason: 'local_coverage_missing' }
                    : { status: 'ineligible', reason: 'no_normal_schedule' };

    return result;
}

function safetyRepair(row) {
    const checkpoint = Protocol.safetyCheckpoint(row.checkpoint), id = checkpoint.characterId;
    let presence = safetyPresence(checkpoint);
    const receipt = (status, reason) => ({ edgeId: row.edgeId, characterId: id, kind: row.kind, status, reason,
        checkpoint, observedCheckpoint: presence.observedCheckpoint, workerVersion: presence.workerVersion });
    if (presence.workerVersion !== row.expectedWorkerVersion) return receipt('stale', 'worker_version_changed');
    if (!['state', 'orphan'].includes(row.kind)) return receipt('ineligible', 'unsupported_repair');
    const coverage = presence.normal;
    if (coverage.status !== 'uncovered') return receipt(coverage.status, coverage.reason);
    if (row.kind === 'orphan') {
        if (coverage.reason !== 'local_coverage_missing') return receipt('deferred', coverage.reason);
        if (!kernel.ensureScheduled(id)) return receipt('deferred', 'schedule_not_restored');
        safetyOrphanRepairs++;
        presence = safetyPresence(checkpoint);
        return receipt('accepted', 'orphan_schedule_restored');
    }
    if (row.kind === 'state') {
        if (coverage.reason !== 'missing_state') return receipt('deferred', 'local_safety_owns_schedule');
        const state = row.entry?.state;
        const object = value => value && typeof value === 'object' && !Array.isArray(value);
        if (!object(state)
            || !object(state.inventory) || !object(state.stats) || !object(state.timing) || !object(state.simulation)) {
            return receipt('deferred', 'projection_unavailable');
        }
        if (!Protocol.sameSafetyCheckpoint(checkpoint, state)) return receipt('stale', 'projection_checkpoint_changed');
        if (!kernel.upsert({ state })) return receipt('stale', 'projection_not_accepted');
        presence = safetyPresence(checkpoint);
        if (!Protocol.sameSafetyCheckpoint(presence.observedCheckpoint, checkpoint)) return receipt('stale', 'checkpoint_changed');
        safetyStateRepairs++;
        return receipt('accepted', 'state_delivery_restored');
    }

}
let planningNpcCatalog = ColdNpcPlanningCatalog.createLookup([], boardReady);
// Personas come from the main thread's 'personas' table (BotPersona.loadAll).
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
BotPersona.useRowSource((characterId) => tables.rows('personas').get(characterId));
ClanSupplyPolicy.useRowSource(id => tables.rows('clan_supplies').get(id), () => tables.ready('clan_supplies'));
PersonalWarehouseIndex.useRowSource(id => tables.rows('personal_warehouse').get(id), () => tables.ready('personal_warehouse'));
let eventLoopDelay = null;
const LAG_RESOLUTION_MS = 20;

// The owner notices moved counters only during its own natural resolve.
const MarketPricing = invoke('GameServer/Bot/Economy/MarketPricing');
// The prepared card's verdict (ColdEconomyDecision.refusal) joins the build's
// mask (EconomyContext.forState, deps.eventVerdict).
function withEventVerdict(deps, prepared) {
    return prepared.eventVerdict ? { ...deps, eventVerdict: prepared.eventVerdict } : deps;
}
// The card of the step's decision after its round carries the shot of the
// round's action plan: a prepared craft step joins it, an action plan that
// prepared none strips a stale one. No action plan keeps the card. No main
// crafter reads this far card's shot: crafts go to main as economyPlan.shot
// (BotAfkMarketService.executePlan).
function stepCard(card, actionPlan) {
    return actionPlan ? ColdEconomyDecision.cardWithShot(card, actionPlan.shot || null) || card : card;
}
// Two plan-like stats values hold the same data (undefined reads as null).
function samePlanJson(a, b) {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
// The existing native plan verdict. It grants no economy command or social
// interaction.
function nativePlanHolds(state, previousPlan, nativeReplan, timestamp, onFinalize = null) {
    const wishFocus = previousPlan?.status === 'deferred' && previousPlan.strategy === 'none'
        && previousPlan.next == null && previousPlan.reason === 'wish_focus';
    const wishHolds = (wishFocus || previousPlan?.source === 'wish_network')
        && !previousPlan.levelingRecovery
        && nativeReplan.recoveryTargets.length === (previousPlan.recoveryTargets || []).length;
    if (!previousPlan || DecisionSections.isEmptyWishPlan(previousPlan) || wishHolds) return true;
    if (previousPlan.status !== 'active' || !nativeReplan.routeCurrent
        || nativeReplan.failure || nativeReplan.invalidSource || nativeReplan.levelingRecovery) return false;
    onFinalize?.();
    return samePlanJson(GearAcquisitionPlanner.finalizePlan(state, previousPlan, previousPlan, nativeReplan, timestamp), previousPlan);
}
// L115: a publication the event proof refuses drops the advice, counted by
// its first failing check.
// owner: the bot's kernel record the step read; the card is a field of it.
function rememberWishAdvisory(owner, advisory, seen = null, deps = null) {
    const diagnostic = economyDiagnostics.active();
    if (!owner) {
        if (diagnostic && advisory) economyDiagnostics.count('card', 'drop', 'remember_no_record');
        return;
    }
    const current = kernel.states.get(Number(owner.state.characterId));
    if (current !== owner) {
        if (diagnostic && advisory) economyDiagnostics.count('card', 'drop', owner.wishAdvisory ? 'remember_stale_kept' : 'remember_stale');
        return;
    }
    if (advisory?.eventProof && seen
        && !ColdEconomyDecision.advisoryPublicationHolds(seen, advisory, current.wishAdvisory)) return;
    // Validate this publication against the original build's proof.
    const why = diagnostic ? [] : undefined;
    const Economy = advisory && seen && deps ? EconomyContext : null;
    const options = advisory && deps ? { baseline: advisory.baseline, activity: advisory.activity,
        leaf: advisory.card?.activity, mp: advisory.mp,
        timestamp: Number(deps.timestamp || Date.now()), why } : null;
    if (advisory && seen && (!Economy || !(advisory.eventProof && Economy.eventProofHolds(seen, advisory.eventProof, deps, options)))) {
        if (diagnostic) economyDiagnostics.count('card', 'drop', `remember:${deps ? why[0] || 'unknown' : 'no_deps'}`);
        advisory = null;
    }
    owner.wishAdvisory = advisory;
}

// A lifecycle command's bid limits (ColdEconomyPlan.bidLimits): the command
// has no look (MarketPricing.lookOwn runs on steps), so its plan carries them
// and main applies them once after the command (Coordinator
// executeLifecycleCommand). Read on the pre-round state; the next step's look
// corrects what the round moved.
function lifecycleBidLimits(state, economy, timestamp) {
    const board = boardReady();
    if (!board || state?.phase !== 'cold') return {};
    const rows = ColdEconomyPlan.bidLimits(state, economy, { now: timestamp, board, persona: BotPersona.of(state),
        tripCost: economy?.trip, npcOffersFor: OccupationSources.npcOffersFor,
        findSpot: id => SpotIndex.spotById(planningSpots, id) });
    return rows.length ? { bidLimits: rows } : {};
}

function reviewMarket(state, timestamp, economy) {
    const board = boardReady();
    if (!board || state?.phase !== 'cold') return null;
    const lines = board.ownerLines(state.characterId);
    if (!lines.length) { kernel.lookSeen.delete(Number(state.characterId)); return null; }
    const ctx = MarketPricing.traderContext(state, {
        timestamp, board, economy, persona: BotPersona.of(state),
        npcOffersFor: (selfId) => planningNpcCatalog.offersFor(selfId),
        purchaseNpcOffersFor: OccupationSources.npcOffersFor,
        findSpot: (spotId) => SpotIndex.spotById(planningSpots, spotId),
        canSell: invoke('GameServer/Bot/Economy/BoardLook').feasibilityPredicate(state, lines, economy?.workshop?.feasibility)
    });
    const id = Number(state.characterId);
    let seen = kernel.lookSeen.get(id);
    if (!seen) kernel.lookSeen.set(id, seen = new (invoke('GameServer/Bot/Economy/BoardLook').SeenLines)());
    const looked = MarketPricing.lookOwn(state, lines, ctx, seen);
    if (!looked) return null;
    return looked;
}

function pruneLookSeen(ownerId) {
    const seen = kernel?.lookSeen.get(Number(ownerId));
    if (!seen) return;
    const ids = new Set(boardIndex.ownerLines(ownerId).map(line => line.lineId));
    for (const id of [...seen.keys()]) if (!ids.has(id)) seen.delete(id);
    if (!seen.size) kernel.lookSeen.delete(Number(ownerId));
}

// The cheap check `room` at arrival: the bots that stand on the spot in the
// one "who stands here" index (kernel.occupancy), other than the arriving
// ones, plus the arriving ones, against the spot's capacity. A bot traveling
// there is indexed at its destination but does not stand there yet. Read once
// when a trip ends; no place is held for a bot on its way. A raid boss spot or
// a spot the catalog does not know has room.
const ROOM_SECTIONS = Object.freeze(['occupation', 'sources']);
function roomAtArrival(spotId, arriving, overflow = 0) {
    const room = SpotProfiles.spotRoom(planningSpots, spotId);
    if (room === Infinity) return true;
    const standing = kernel.occupancy.physicalCount(spotId, { excludeKeys: arriving, standingOnly: true });
    return standing + arriving.size <= room + overflow;
}

// The step's solo trip and the kept route's drop (BotRoute.trip / drop): the
// route lives in the bot's kernel record. The search skips a spot with no
// room for the bot (SpotProfiles.roomFilterFor over this worker's index).
// currentSpot: the spot the step's input state stands at.
function routeTrip(state, currentSpot, leaf, timestamp) {
    return BotRoute.trip(kernel.states.get(Number(state.characterId)), state, leaf,
        { spots: planningSpots, currentSpot, timestamp,
            hasRoom: SpotProfiles.roomFilterFor(kernel.occupancy, planningSpots, [state]) });
}
function dropRoute(characterId, why) {
    BotRoute.drop(kernel.states.get(Number(characterId)), why);
}

// A solo trip ends on a full spot: the bot stands there with a "was full"
// mark (counted from this step's counter before its +1) and the step raises
// occupation and sources with its other events, so the next step's decision
// point refuses the hunting leaf there and the spot search takes the next one.
// A safety evacuation may exceed a full spot by one bot. A party trip is
// checked once, at the party's arrival (partyArrival). Returns the marked
// result, or null when the step is no such arrival or the spot has room.
function soloArrival(state, result) {
    const travel = state?.activity === 'traveling' ? state.stats?.travel : null;
    if (!travel?.spotId || travel.reason === 'party_spot_replan' || result?.patch?.activity !== 'hunting'
        || String(result.patch.spotId) !== String(travel.spotId)) return null;
    const room = roomAtArrival(travel.spotId, new Set([stateKey(state)]),
        travel.reason === 'unsafe_ground_evacuation' ? 1 : 0);
    economyDiagnostics.count('roomAtArrival', 'solo', 'checked');
    if (room) return null;
    economyDiagnostics.count('roomAtArrival', 'solo', 'full');
    // Which trips still end on a full spot: the read names their reasons.
    economyDiagnostics.count('roomAtArrival', 'full', travel.reason || 'none');
    // The arrival patch carries the whole stats copy (resolveTravel); the mark
    // reads the same counter and marks from the state the step started on.
    const { capacityBackoffs, lastReason } = SpotRiskPolicy.withCapacityBackoff(state, travel.spotId).stats;
    return { ...result, patch: { ...result.patch, stats: { ...result.patch.stats, capacityBackoffs, lastReason } } };
}

// A party trip ends (the kernel's party round, finishPartyRouteTravelState):
// the spot's standing bots that are not of this party plus the whole party
// against the capacity, no overflow. Full -> the party's "was full" mark
// (PartySpotRiskPolicy, read by its next spot search) and occupation and
// sources raised on the leader; the members arrive and stand. The party's own
// objective spot (a clan goal, a material party) admits it: a pass read from
// the goal the party carries, not a place held for it, so a full roster does
// not bounce between its objective and a fallback spot. cause: the trip's
// (party.stats.travel.cause): competition_avoid (main's retreat),
// position_mismatch or death_pressure (the run's search); none: 'route', the
// run's search that picked a new spot.
function partyArrival({ party, members, spotId, cause = null }) {
    const arriving = new Set((party?.memberIds || []).map(String));
    if (!spotId || !arriving.size) return null;
    if (String(spotId) === String(party.stats?.objective?.spotId ?? '')) {
        economyDiagnostics.count('roomAtArrival', 'party', 'pass');
        return null;
    }
    const room = roomAtArrival(spotId, arriving);
    economyDiagnostics.count('roomAtArrival', 'party', 'checked');
    if (room) return null;
    economyDiagnostics.count('roomAtArrival', 'party', 'full');
    economyDiagnostics.count('roomAtArrival', 'party_full', cause || 'route');
    const leaderId = Number(party.leaderId || 0);
    return {
        party: PartySpotRiskPolicy.withCapacityBackoff(party, spotId),
        members: members.map(member => {
            if (Number(member.characterId) !== leaderId) return member;
            const raised = { ...member, stats: { ...(member.stats || {}) } };
            DecisionEvents.raiseSections(member, raised, ROOM_SECTIONS);
            return raised;
        })
    };
}

// payloadBytes: the payload's JSON size when the caller already counted it
// (the kernel's proposal batches); the 256 KB limit is checked against it.
let partyGoalJobs = 0;
let partyGoalTail = Promise.resolve();
const partyGoalPages = new Map();
const partyGoalSeen = new Map();
function partyMembersAvailable(members) {
    return members.every(member => {
        const held = occupationPlanner.slots.get(member.characterId) || occupationPlanner.waiting.get(member.characterId);
        return kernel.commandStartedAt.get(member.characterId)?.kind !== 'meeting'
            && (!held || held.done || !['meeting', 'refresh', 'action'].includes(held.input.mode));
    });
}

function admitPartyGoalPages(payload, msgId) {
    for (const [id, until] of partyGoalSeen) if (until <= Date.now()) partyGoalSeen.delete(id);
    let entry = partyGoalPages.get(msgId);
    const fail = reason => {
        if (entry) { clearTimeout(entry.timer); partyGoalPages.delete(msgId); partyGoalJobs--; }
        send('party_goal_result', { ok: false, reason }, msgId);
    };
    if (!entry) {
        if (partyGoalSeen.has(msgId)) return fail('party_goal_duplicate');
        if (payload.pageIndex !== 0) return fail('party_goal_page_order');
        if (partyGoalJobs >= 2) return fail('party_goal_busy');
        if (Date.now() >= payload.replyBy || shuttingDown) return fail('party_goal_expired');
        partyGoalJobs++;
        while (partyGoalSeen.size >= 16) partyGoalSeen.delete(partyGoalSeen.keys().next().value);
        partyGoalSeen.set(msgId, payload.replyBy);
        entry = { party: payload.party, members: [], escrows: [],
            timestamp: payload.timestamp, replyBy: payload.replyBy, pageCount: payload.pageCount, nextPage: 0 };
        partyGoalPages.set(msgId, entry);
        entry.timer = setTimeout(() => fail('party_goal_expired'), Math.max(1, entry.replyBy - Date.now()));
    }
    if (entry.nextPage !== payload.pageIndex || entry.pageCount !== payload.pageCount
        || entry.timestamp !== payload.timestamp || entry.replyBy !== payload.replyBy
        || payload.pageIndex > 0 && entry.party.partyId !== payload.partyId) return fail('party_goal_page_changed');
    entry.members.push(payload.members[0]); entry.escrows.push(payload.escrows[0]); entry.nextPage++;
    if (entry.nextPage !== entry.pageCount) return;
    clearTimeout(entry.timer); partyGoalPages.delete(msgId);
    if (!invoke('GameServer/Bot/Population/PartyGoalCalculation').validMembers(entry.party, entry.members)) {
        partyGoalJobs--; send('party_goal_result', { ok: false, reason: 'party_goal_roster_changed' }, msgId); return;
    }
    requestPartyGoals(entry, msgId, true);
}

function requestPartyGoals(payload, msgId, admitted = false) {
    if (!kernel || shuttingDown || kernel.stopping || !safetyStateReady || Date.now() >= payload.replyBy) {
        if (admitted) partyGoalJobs--;
        send('party_goal_result', { ok: false, reason: 'worker_not_ready' }, msgId);
        return;
    }
    // ARCH-NOTE: the 2-job cap stays; a busy answer keeps the party's current
    // objective on main (PopulationService.jointPartyGoals) and the next
    // party resolve asks again.
    if (!admitted && partyGoalJobs >= 2) {
        send('party_goal_result', { ok: false, reason: 'party_goal_busy' }, msgId);
        return;
    }
    if (!admitted) {
        for (const [id, until] of partyGoalSeen) if (until <= Date.now()) partyGoalSeen.delete(id);
        if (partyGoalSeen.has(msgId)) {
            send('party_goal_result', { ok: false, reason: 'party_goal_duplicate' }, msgId); return;
        }
        while (partyGoalSeen.size >= 16) partyGoalSeen.delete(partyGoalSeen.keys().next().value);
        partyGoalSeen.set(msgId, payload.replyBy);
        partyGoalJobs++;
    }
    let preparedMembers = [];
    partyGoalTail = partyGoalTail.then(async () => {
        if (shuttingDown || kernel.stopping || Date.now() >= payload.replyBy) return;
        const Calculation = invoke('GameServer/Bot/Population/PartyGoalCalculation');
        // Equal native snapshots keep their worker-owned identity and caches.
        // A freshly committed main snapshot is complete input, never merged
        // with an older worker wallet, inventory or equipment plan.
        const members = payload.members.map(member => {
            const native = kernel.states.get(member.characterId)?.state;
            return native && Calculation.sameSource(native, member) ? native : member;
        });
        preparedMembers = members;
        if (!partyMembersAvailable(members)) throw Error('party_goal_member_busy');
        const joint = await Calculation.calculate(payload.party, members, async (member, timestamp) => {
            const at = members.indexOf(member);
            // The build and its verdict read the worker's recipes mirror.
            const options = { buyOrderEscrow: payload.escrows[at] };
            const routeRows = await occupationFor(member, timestamp, options, 'wish');
            if (!partyMembersAvailable(members)) throw Error('party_goal_member_busy');
            // The held build's verdict on this state (main's escrow in it)
            // keeps its workshop, else the empty one: the goal reads no
            // workshop field (no income since C8b). A valid verdict serves the held build when its entry kept
            // the graph nodes (a party member's); a formation candidate's
            // entry kept none, so it is built (withNodes). Never remembered:
            // a query's own snapshot must not displace the bot's held build (L133).
            const deps = { timestamp, spots: planningSpots, board: boardReady(), routeRows,
                buyOrderEscrow: options.buyOrderEscrow, rememberContext: false, caller: 'workerPartyGoal' };
            const verdict = {};
            const workshop = EconomyContext.heldWorkshop(member, deps, verdict) || noWorkshop();
            return EconomyContext.forState(member, { ...deps, workshop, eventVerdict: verdict, withNodes: true });
        }, payload.timestamp, () => !shuttingDown && !kernel.stopping && Date.now() < payload.replyBy
            && partyMembersAvailable(members), { spots: planningSpots });
        if (!shuttingDown && !kernel.stopping && Date.now() < payload.replyBy)
            send('party_goal_result', { ok: true, joint, sources: Calculation.sources(members) }, msgId);
    }).catch(error => {
        send('party_goal_result', { ok: false, reason: error.message || 'party_goal_failed' }, msgId);
    }).finally(() => {
        // Advice on a not-yet-published main snapshot must not retain a second
        // complete actor state in the worker's per-actor context cache.
        const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
        for (const member of preparedMembers) if (kernel?.states.get(member.characterId)?.state !== member) {
            occupationPlanner.cancelState(member.characterId, member);
            Economy.forgetContext(member.characterId, 'party_query_release', member);
        }
        partyGoalJobs--;
    });
}

function send(type, payload = {}, msgId = null, payloadBytes = null) {
    const packed = invoke('GameServer/Bot/Population/ColdStateWire').packPayload(type, payload);
    if (packed !== payload) { payload = packed; payloadBytes = null; }
    const message = Protocol.envelope(type, epoch, payload, msgId);
    const bytes = Number.isFinite(payloadBytes) ? Protocol.envelopeBytes(message, payloadBytes) : null;
    let valid = Protocol.validateEnvelope(message, 'worker', { workerEpoch: epoch, bytes });
    if (!valid.ok && economyDiagnostics.omitAggregatesOnOverflow(message, valid.reason)) {
        valid = Protocol.validateEnvelope(message, 'worker', { workerEpoch: epoch });
    }
    if (!valid.ok && valid.reason === 'message_too_large' && Protocol.omitPlannedStates(message)) {
        valid = Protocol.validateEnvelope(message, 'worker', { workerEpoch: epoch });
    }
    if (!valid.ok) {
        if (type !== 'fault') {
            parentPort.postMessage(Protocol.envelope('fault', epoch, {
                reason: `out_${type}_${valid.reason}`,
                bytes: Number(valid.bytes || 0)
            }));
        }
        return false;
    }
    if (!['command_request', 'command_ack'].includes(type)
        || !(payload.requests || payload.results || []).some(row => row.kind === 'meeting')) message.bytes = valid.bytes;
    parentPort.postMessage(message);
    return true;
}

function stopTimers() {
    if (loopTimer) clearTimeout(loopTimer);
    if (flushTimer) clearInterval(flushTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    loopTimer = null;
    flushTimer = null;
    heartbeatTimer = null;
}

// When the scheduler should run next, counted from `from` (the start of the
// last tick, as setInterval did): due work keeps the loopIntervalMs cadence (a
// tick that could not take it, held by capacity or a pause, waits for an ack
// the same as before); otherwise 1 ms past the nearest deadline (a timer may
// fire up to 1 ms early), at most LOOP_IDLE_CAP_MS away.
function loopWakeAt(from, next = kernel.nextWakeAt()) {
    return next <= from ? from + loopIntervalMs : from + Math.min(next - from + 1, LOOP_IDLE_CAP_MS);
}

function armLoop(from = Date.now()) {
    const next = kernel.nextWakeAt();
    loopArmedAt = loopWakeAt(from, next);
    Config.developerDiagnostics && economyDiagnostics.count('worker_wake', 'armed',
        next <= from ? 'pending' : next - from >= LOOP_IDLE_CAP_MS ? 'cap' : 'due');
    loopTimer = setTimeout(runLoop, Math.max(0, loopArmedAt - Date.now()));
    loopTimer.unref?.();
}

function runLoop() {
    const startedAt = Date.now();
    try {
        kernel.tick();
    } finally {
        if (loopTimer && !shuttingDown) armLoop(startedAt);
    }
}

// Every path that can add earlier work (a message, the heartbeat's competition
// review arming a decision deadline) calls this: the timer moves only sooner.
function wakeLoopIfSooner() {
    if (!LOOP_ALARM || !loopTimer || shuttingDown || loopWakeAt(Date.now()) >= loopArmedAt) return;
    clearTimeout(loopTimer);
    Config.developerDiagnostics && economyDiagnostics.count('worker_wake', 'rearmed', 'sooner');
    armLoop();
}

function startKernel(config = {}) {
    if (kernel) return;
    if (typeof config.coldHonestTravel === 'boolean') Config.coldHonestTravel = config.coldHonestTravel;
    Config.developerDiagnostics = config.developerDiagnostics === true;
    Config.economyDiagnostics = Config.developerDiagnostics && config.economyDiagnostics === true;
    // Busy share and heap after GC are two of the goal's three numbers (read with diagnostics off): always on, one
    // major-GC observer, two clock reads and one thread CPU read per heartbeat.
    heapTelemetry = invoke('GameServer/Bot/Population/WorkerHeapTelemetry').observe();
    previousElu = performance.eventLoopUtilization();
    threadCpuMs = threadCpuMeter();
    // The longest loop delay per heartbeat is the health line's spike number (workerLag): always on,
    // a native histogram on a LAG_RESOLUTION_MS timer.
    eventLoopDelay = monitorEventLoopDelay({ resolution: LAG_RESOLUTION_MS });
    eventLoopDelay.enable();
    Config.economyDiagnosticsBotIds = Config.economyDiagnostics ? config.economyDiagnosticsBotIds || '' : '';
    if (Config.economyDiagnostics) economyDiagnostics.connect(batch => {
        if (shuttingDown) return false;
        const message = { type: 'economy_diagnostics', epoch, ...batch, dropped: economyDiagnostics.stats().dropped };
        const wireBytes = Buffer.byteLength(JSON.stringify(message));
        if (wireBytes > 16384) return false;
        parentPort.postMessage(message);
        return wireBytes;
    });
    // Use the main process's resolved setting, including programmatic overrides.
    Config.pvpAggression = invoke('GameServer/Social/PvpAggression').normalize(config.pvpAggression ?? Config.pvpAggression);
    kernel = new ColdSimulationKernel({
        stateSources: LifeStateProjector.passiveWorkerStateSources(workerProjectorRole),
        resolveSolo: (options) => BackgroundResolver.resolveSolo(options),
        resolveParty: (options) => BackgroundPartyResolver.resolve(options),
        partySession: {
            partySessionMaxMs: Config.partySessionMaxMs,
            partyReviewIntervalMs: Config.partyReviewIntervalMs,
            partySessionJitterMs: Config.partySessionJitterMs,
            partyMinSize: Config.partyMinSize
        },
        partyMinSize: Config.partyMinSize,
        buyOrderEscrow: escrowFor,
        hallNeeded,
        playerWaiting: id => playerWaits.has(id),
        raidRow: id => tables.rows('raids').get(id) || null,
        spotOf: standingSpot,
        equipmentBridgeReason: (state) => GearAcquisitionPlanner.equipmentBridgeReason(state, {
            ...planningNpcCatalog.plannerOptions,
            buyOrderEscrow: escrowFor(state.characterId)
        }),
        partyArrival,
        // The party's spot search skips a spot with no room for the whole
        // party (its own members not counted against it).
        partyRoute: ({ leader, party, members, spot, timestamp }) => BotRoute.route(leader, spot, party, members,
            { spots: planningSpots, timestamp, hasRoom: SpotProfiles.roomFilterFor(kernel.occupancy, planningSpots, members) }),
        // writtenAt: the row's write stamp, the real now (timestamp is the
        // round's time, the bot's due for a step started its lead early).
        projectResolve: async (state, result, timestamp, lifecyclePlan = null, writtenAt = timestamp) => {
            const owner = kernel.states.get(Number(state.characterId));
            // Room at arrival, before the projection: a full spot's mark rides
            // the patch, its sections join the step's one raise.
            const raidPreparing = require('./RaidSupplyPolicy').held(state, timestamp);
            const crowded = !raidPreparing && soloArrival(state, result);
            if (crowded) result = crowded;
            // The step's one decision, taken before the round (planLifecycle):
            // the round's consequences run on it, no second ask. A step
            // without one (a party member, karma) asks after
            // the round below: that is its one decision point.
            const stepEconomy = lifecyclePlan?.economy || null;
            let economy = stepEconomy, seenEcho = null, refreshed = null, observedDeps = null, economyEdges = null, raisedBits = 0;
            const ownEscrow = () => escrowFor(state.characterId);
            // The record as it stands when edges runs (a new state replaces
            // the record object across the awaits): it holds the edge basis.
            const edgeRecord = () => kernel.states.get(Number(state.characterId));
            const base = {
                persist: false,
                timestamp,
                writtenAt,
                projectClassProgression: true,
                ...(crowded ? { checkSections: ROOM_SECTIONS } : {}),
                moneyEscrowFor: ownEscrow,
                // The step's held leaf: the round's check reads its own trip and
                // arrival as no event (DecisionSections.events).
                leaf: stepEconomy?.network?.activity ?? null,
                // The soft point's inputs (BotLifeState.prepareResolve, every
                // step): the board mirror (null until ready), the escrow and
                // the bot's memory rows, read only when its bond is compared.
                softInputFor: (projected, at) => softInputFor(projected.characterId, at)
            };
            const resolved = await LifeStateProjector.prepareResolve(state, result, raidPreparing
                ? { ...base, statsPacket: {}, statsPacketBeforeResolve: true } : stepEconomy
                // Merged before the event check, whose dirty bits follow it.
                ? { ...base, statsPacket: lifecyclePlan.statsPacket, statsPacketBeforeResolve: true }
                : { ...base,
                    // The workshop is asked by economyFor, only for a build.
                    economyDepsFor: async projected => ({ spots: planningSpots, routeRows: await occupationFor(projected, timestamp, {}, 'wish'),
                        board: boardReady(), buyOrderEscrow: escrowFor(state.characterId), goalRevision: goalRevision(state.characterId) }),
                    economyFor: async (projected, deps) => {
                        observedDeps = deps;
                        // The bits raised before the build: its packet clears them
                        // on the state onEconomy reads (the route drop below).
                        raisedBits = Number(projected.stats?.wishDirty) || 0;
                        const prepared = {};
                        refreshed = !partyIdOf(projected)
                            ? ColdEconomyDecision.refreshAdvisory(projected, owner?.wishAdvisory, deps,
                                { afterResult: true, prepared, collect: true }) : null;
                        // Both native stock gates read one prepared foundation;
                        // the same edges also drive the action after projection.
                        // L116: a reuse's own basics, else built at the first
                        // gate read (edges skips resting, travelling and party
                        // bots, which read none).
                        let stock = refreshed?.economy || null;
                        economyEdges = ColdEconomyPlan.edges(state, projected, { buyOrderEscrow: ownEscrow(), record: edgeRecord(),
                            stockFor: (_state, kind) => (stock ||= EconomyContext.basics(projected, deps)).stock(kind) });
                        if (refreshed) { if (economyDiagnostics.active()) economyDiagnostics.count('advisory', 'reuse', 'result'); return refreshed.economy; }
                        // The lifecycle's order: the held build's verdict on the
                        // projected state keeps its workshop, else the planner is asked.
                        deps.workshop = EconomyContext.heldWorkshop(projected, deps, prepared.eventVerdict ||= {})
                            || await askWorkshop(projected, timestamp, deps.routeRows,
                                partyIdOf(projected) ? 'party' : 'karma');
                        return EconomyContext.forState(projected, withEventVerdict(deps, prepared));
                    },
                    onEconomy: (built, seen) => {
                        economy = built; seenEcho = ColdEconomyDecision.stateEcho(seen);
                        // This build clears wishDirty too (a party member, a karma step):
                        // every raised bit counts, also one a kept refresh build consumed.
                        if ((Number(built?.mask) | raisedBits) & DecisionSections.COMPUTED.route) {
                            dropRoute(state.characterId, 'sections');
                        }
                        const advice = refreshed?.advisory || ColdEconomyDecision.advisory(built, seen, undefined, observedDeps);
                        rememberWishAdvisory(owner, advice, refreshed ? null : seen, observedDeps);
                    }
                });
            // Membership is the row's: a plan, request or objective of another
            // clan leaves the proposal here (the same object when none, one
            // compare). The commit writes the proposal as it is, no merge.
            const projected = ClanMembershipPolicy.reconcileState(resolved);
            if (stepEconomy) {
                seenEcho = ColdEconomyDecision.stateEcho(projected);
                economyEdges = ColdEconomyPlan.edges(state, projected,
                    { buyOrderEscrow: ownEscrow(), record: edgeRecord(), stockFor: (_state, kind) => stepEconomy.stock(kind) });
            }
            const beforeLevel = Number(state.stats?.classProgressionLevel || 0);
            const beforeClassId = Number(state.stats?.classProgressionClassId ?? state.stats?.classId ?? 0);
            const afterClassId = Number(projected.stats?.classProgressionClassId ?? projected.stats?.classId ?? beforeClassId);
            const progressionChanged = beforeLevel < Number(projected.level || 1) || beforeClassId !== afterClassId;
            // The worker projects the class, but cannot grant tree ranks.
            // Accepted main-owned commits train against actual SP and books.
            const durable = {
                ...(progressionChanged ? { classId: afterClassId } : {}),
                ...(result.soulCrystals?.length ? { soulCrystals: result.soulCrystals } : {})
            };
            // Accepted custody owns the next physical transition. Resume the
            // original economic plan after the meeting releases the actor.
            const kitMoved = DecisionSections.kitMoved(state, projected);
            if (raidPreparing || state.stats?.tradeMeeting) return { state: projected,
                durable: Object.keys(durable).length ? durable : null, kitMoved };
            const preparedAction = economyEdges && economy ? await askAction(projected, timestamp, economy) : null;
            const economyPlan = preparedAction?.economyPlan || stepEconomy && lifecyclePlan.economyPlan || null;
            const record = kernel.states.get(Number(projected.characterId));
            // Every sent plan stamps what is still deferred: a complete plan
            // clears what an earlier one left, so no later state replans it.
            if (economyPlan && record) {
                record.economyPending = economyPlan.d || 0;
                if (economyPlan.d) record.economyPlanHash = economyPlanHash(economyPlan);
            }
            const market = reviewMarket(projected, timestamp, economy);
            // Main reads this instead of building the network again.
            const economyDecision = economy && projected ? stepEconomy || refreshed
                ? { ...stepCard(stepEconomy ? lifecyclePlan.economyDecision : refreshed.decision, preparedAction?.economyPlan),
                    updatedAt: Number(projected.updatedAt || 0), echo: seenEcho }
                : { ...ColdEconomyDecision.capture({ ...economy,
                    shot: economyPlan?.shot || null }, projected), echo: seenEcho } : null;
            return {
                state: projected,
                // A member's kit event, read by its party step (worker-local).
                kitMoved,
                economyEdges,
                ...(economyPlan ? { economyPlan } : {}),
                ...(market ? { market } : {}),
                durable: Object.keys(durable).length ? durable : null,
                // Worker-local (the kernel picks posted fields one by one): the
                // party requirement plan reads this build, not a second one.
                ...(economy ? { economy } : {}),
                buffOffer: invoke('GameServer/Bot/Economy/ColdBuffOffer').project(projected,
                    kernel.occupancy.members(projected.spotId, 'physical'), timestamp),
                ...(economyDecision ? { economyDecision } : {})
            };
        },
        // The member's own build of this step (projectResolve) while the
        // projection after it (class training, equipped upgrades) left its kit
        // (the build's baseline build fact); else one build on the same board
        // the step's build reads.
        planPartyRequirement: ({ state, timestamp, economy }) => PartyRequirementRefresh.plan(state, {
            spots: planningSpots, timestamp,
            preparedEconomy: economy?.statsPacket?.wishSections?.build === DecisionSections.kit(state) ? economy : null,
            planningOptions: { ...planningNpcCatalog.plannerOptions, buyOrderEscrow: escrowFor(state.characterId), board: boardReady() }
        }),
        reviewRecruits: ({ party, members, timestamp }) => PartyGoalCalculation.recruitCheck(party, members,
            { spots: planningSpots, timestamp }),
        // command: a lifecycle command's plan (Kernel resolveCommand), the only
        // one that carries bid limits; a step has prepareNative and the look.
        planLifecycle: async ({ state, timestamp, command = false }) => {
            if (state.stats?.tradeMeeting) return null;
            // The bot's record as the kernel handed the step over (its card).
            const record = kernel.states.get(Number(state.characterId));
            const karmaPlan = invoke('GameServer/Bot/Population/ColdKarmaPolicy').plan(state, planningSpots, timestamp);
            // A karma step carries no stats packet: it keeps the previous shot demand.
            if (karmaPlan) return karmaPlan;
            const previousPlan = state.stats?.equipmentPlan || null;
            // Failure counters and recovery deadlines are live native facts,
            // even when the expensive wish calculation still holds.
            const nativeReplan = GearAcquisitionPlanner.replanContextFor(state, previousPlan, timestamp);
            const spots = planningSpots;
            // GearPlanSelection uses EconomyContext's same prepared occupation
            // reader. No synchronous recipe scan can run through it.
            const routeRows = await occupationFor(state, timestamp, {}, 'wish');
            const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
            // deps.workshop: asked below, only for a build.
            const deps = { spots, timestamp, board: boardReady(), caller: 'economy_lifecycle',
                buyOrderEscrow: escrowFor(state.characterId), goalRevision: goalRevision(state.characterId), routeRows };
            const wishFocus = previousPlan?.status === 'deferred' && previousPlan.strategy === 'none'
                && previousPlan.next == null && previousPlan.reason === 'wish_focus';
            // A healer or buffer without solo ground plans its party request
            // below (PartyRequestPlanner, decision 10-30): no card reuse.
            const solo = !partyIdOf(state) && !state.stats?.partyRequest
                && !PartyRequestPlanner.supportWithoutGround(state, spots);
            const nativeHolds = !nativeReplan.failure && !nativeReplan.invalidSource && !nativeReplan.levelingRecovery;
            // An active current plan: before, finalizePlan re-finalized it on
            // every such step. Its steps count as plan_holds finalized (paid)
            // + skipped (saved).
            const routeHeld = previousPlan?.status === 'active' && nativeReplan.routeCurrent && nativeHolds;
            // Asked only by the card path of a solo bot whose native facts
            // hold (and by the diagnostics refusal name): finalizePlan is
            // pure, so the re-finalized plan and its JSON compare give the
            // same answer whenever they run. The new skip is a party bot (or
            // one with a pending party request) holding an active current
            // plan, and a plan the clauses before it already hold. A failed
            // route never paid: routeHeld excludes it and routeCurrent
            // implies no leveling recovery, so the diagnostics ask for a solo
            // bot whose native facts fail never reaches the finalize.
            let planHoldsAnswer, finalized = false;
            const planHolds = () => {
                if (planHoldsAnswer !== undefined) return planHoldsAnswer;
                // Native wish_focus retains inactive target/history fields,
                // not a current route/quote. A wish-network route
                // (WishProviders.personalCraftPlan) never passes finalizePlan,
                // so it has no grade/level/rate stamps. Neither is judged by
                // native stamps: the current advisory fence below is (its
                // build holds the level and worn kit). A wake/expiry still
                // goes through the native planner.
                return (planHoldsAnswer = nativePlanHolds(state, previousPlan, nativeReplan, timestamp, () => {
                    finalized = true;
                    if (economyDiagnostics.active()) economyDiagnostics.count('lifecycle', 'plan_holds', 'finalized');
                }));
            };
            // A proved ordinary solo round keeps its accepted native plan.
            // Party waiting, failed targets and excluded grounds still take
            // the existing planner; no new choice is made from a thin card.
            // A refused card's verdict serves the build below, which reads
            // this state, or a copy of it with a wish-focus plan deferred.
            const prepared = {};
            let refreshed = solo && nativeHolds && planHolds()
                ? ColdEconomyDecision.refreshAdvisory(state, record?.wishAdvisory, deps, { prepared, collect: !wishFocus }) : null;
            // Compact advice has no full money queue for clan acquisition.
            // A null intention takes its ordinary native selection there.
            if (refreshed?.economy.network.activity === null && GearAcquisitionPlanner.isClanOwnedPlan(previousPlan)) refreshed = null;
            const nullReuse = refreshed?.economy.network.activity === null;
            // Build the renewed proof against the native live history, so a
            // consumed wake/expiry does not invalidate it again on publication.
            const preparationState = wishFocus && !refreshed ? { ...state, stats: { ...state.stats,
                equipmentPlan: GearPlanSelection.deferredWishPlan(previousPlan, nativeReplan) } } : state;
            // Both reuses (the card's leaf, a null intention) read the card's
            // workshop. A build keeps the held one while its verdict, judged
            // here on the state the build reads and handed to it
            // (EconomyContext.heldWorkshop, prepared.eventVerdict), keeps it;
            // else it asks. The kernel replaces a state, never edits it: the
            // copy and its verdict stay the build's across the ask.
            if (!refreshed) deps.workshop = EconomyContext.heldWorkshop(preparationState, deps, prepared.eventVerdict ||= {})
                || await askWorkshop(state, timestamp, deps.routeRows, 'lifecycle');
            // No later ask reaches the finalize: a solo bot under routeHeld
            // has its native facts holding, so the card path asked above.
            if (economyDiagnostics.active() && routeHeld && !finalized) economyDiagnostics.count('lifecycle', 'plan_holds', 'skipped');
            // The card passed the verdict's cheap check (its spot not excluded).
            if (refreshed && !nullReuse) {
                if (economyDiagnostics.active()) economyDiagnostics.count('advisory', 'reuse', 'lifecycle');
                const leaf = refreshed.economy.network.activity;
                // The card holds the plan: the route is read on the input state.
                const route = routeTrip(state, standingSpot(state), leaf, timestamp);
                const routedState = beginHuntingTrip(state, route, timestamp) || state;
                rememberWishAdvisory(kernel.states.get(Number(state.characterId)), refreshed.advisory);
                // economy: worker-local, the step's one decision; the
                // projection after the round reads it (never posted).
                return { statsPacket: refreshed.economy.statsPacket, economy: refreshed.economy,
                    activityPick: { activity: leaf.activity, spotId: leaf.spotId, npcId: leaf.npcId },
                    economyDecision: refreshed.decision, previousPlan, acquisitionPlan: previousPlan,
                    partyRequest: null, reusablePartyRequest: false, replanFailure: null,
                    targetNpcId: PartyHuntingTarget.planTargetNpcId(previousPlan) || Number(leaf.npcId || 0), plannedState: routedState, route,
                    ...(command ? lifecycleBidLimits(state, refreshed.economy, timestamp) : {}) };
            }
            const preparedEconomy = nullReuse ? refreshed.economy
                : Economy.forState(preparationState, withEventVerdict(deps, prepared));
            const selectedAcquisition = nullReuse ? {
                acquisitionPlan: GearPlanSelection.deferredWishPlan(previousPlan, nativeReplan),
                replanContext: nativeReplan, reusablePartyRequest: false,
                excludedSpotIds: SpotRiskPolicy.excludedSpotIdsForStates([state], timestamp), economy: preparedEconomy
            } : GearPlanSelection
                .selectAcquisitionPlan(preparationState, previousPlan, {
                    spots, timestamp, preparedEconomy, preparedReplanContext: nativeReplan,
                    planningOptions: { ...planningNpcCatalog.plannerOptions, buyOrderEscrow: escrowFor(state.characterId) }
                });
            const { replanContext, reusablePartyRequest, excludedSpotIds, economy } = selectedAcquisition;
            const acquisitionPlan = invoke('GameServer/Bot/Economy/WishProviders').personalCraftPlan(state, preparedEconomy)
                || selectedAcquisition.acquisitionPlan;
            const partyRequest = PartyRequestPlanner.partyRequestForPlan(state, acquisitionPlan, timestamp,
                { spots, economy, memo: kernel.states.get(Number(state.characterId)) });
            // The step took its build result, which clears wishDirty: a moved
            // route section (the build's mask or a raised bit, also one a kept
            // refresh build consumed: its served view has no mask), or a new
            // plan destination the search reads (the gear branch, the party
            // wait), drops the kept route before the trip start, so the search
            // below runs on the planned state.
            const routeMask = (Number(economy.mask) | (Number(state.stats?.wishDirty) || 0)) & DecisionSections.COMPUTED.route;
            const routeDrop = BotRoute.dropReason(routeMask,
                { plan: previousPlan, request: state.stats?.partyRequest }, { plan: acquisitionPlan, request: partyRequest });
            if (routeDrop) dropRoute(state.characterId, routeDrop);
            const partyRouteWaiting = PartyWaitFallback.waiting(state, acquisitionPlan, partyRequest);
            const partyFallback = partyRouteWaiting
                ? PartyWaitFallback.spotFor(state, acquisitionPlan, spots,
                    { excludedSpotIds, timestamp,
                        hasRoom: SpotProfiles.roomFilterFor(kernel.occupancy, planningSpots, [state]) })
                : null;
            const fallbackSpot = partyFallback?.spot || null;
            const statsPacket = economy.statsPacket;
            const plannedStats = { ...(state.stats || {}), ...statsPacket, equipmentPlan: acquisitionPlan };
            if (partyRequest) plannedStats.partyRequest = partyRequest;
            else delete plannedStats.partyRequest;
            // A waiter that is resting finishes its rest first.
            const plannedState = {
                ...state,
                activity: fallbackSpot
                    && !['traveling', 'shopping', 'merchant', 'crafting', 'dead', 'resting'].includes(state.activity)
                    ? 'hunting'
                    : state.activity,
                spotId: fallbackSpot ? fallbackSpot.id : state.spotId,
                stats: plannedStats
            };
            const route = routeTrip(plannedState, standingSpot(state), economy.network.activity, timestamp);
            const routedState = beginHuntingTrip(plannedState, route, timestamp) || plannedState;
            const showcase = routedState.activity === 'shopping'
                ? await occupationFor(routedState, timestamp, { economy }, 'showcase') : null;
            const seen = { ...routedState, stats: { ...routedState.stats, ...statsPacket } };
            const heldDecision = nullReuse ? ColdEconomyDecision.compact({ data: refreshed.decision.data.slice(0),
                updatedAt: Number(seen.updatedAt || 0), echo: ColdEconomyDecision.stateEcho(seen), flags: 0 }) : null;
            const advice = nullReuse ? { ...refreshed.advisory, card: heldDecision }
                : ColdEconomyDecision.advisory(economy, seen, preparationState.activity, deps);
            rememberWishAdvisory(kernel.states.get(Number(state.characterId)), advice, seen, deps);
            if (nullReuse && economyDiagnostics.active()) economyDiagnostics.count('advisory', 'reuse', 'lifecycle');
            return {
                ...(showcase?.economyPlan ? { economyPlan: showcase.economyPlan } : {}),
                ...(command ? lifecycleBidLimits(state, economy, timestamp) : {}),
                statsPacket,
                economy,
                activityPick: economy.network.activity ? { activity: economy.network.activity.activity,
                    spotId: economy.network.activity.spotId, npcId: economy.network.activity.npcId } : null,
                economyDecision: heldDecision || ColdEconomyDecision.capture({ ...economy, workshop: deps.workshop }, routedState),
                previousPlan,
                acquisitionPlan,
                partyRequest,
                targetNpcId: partyRouteWaiting ? Number(partyFallback?.npcId || 0) : PartyHuntingTarget.planTargetNpcId(acquisitionPlan),
                reusablePartyRequest,
                replanFailure: replanContext.failure || null,
                plannedState: routedState,
                route
            };
        },
        emit: send,
        maxBatch: config.maxBatch,
        maxInFlight: config.maxInFlight,
        maxAtomicPartySize: config.maxAtomicPartySize,
        flushTargetMs: config.flushTargetMs,
        flushHardMs: config.flushHardMs
    });
    // SpotEconomics' crowd share reads this worker's occupancy.
    usePlanningIndex(kernel.occupancy);
    // Keep dependencies tied to the kernel's native lifetime. In-flight
    // scratch is cancelled on a newer canonical owner; it is never LRU-evicted.
    const nativeSet = kernel.states.set.bind(kernel.states), nativeDelete = kernel.states.delete.bind(kernel.states);
    // ownOutput (kernel upsert): the state is the step's own output echoed back
    // by main ('commit' or 'review'); the step already built its economy on it.
    const storeState = (id, entry, ownOutput) => {
        const previousEntry = kernel.states.get(Number(id)), previous = previousEntry?.state;
        // A new life starts from no record (activations fence the bot first),
        // so the raises applied are this life's.
        if (previous && previous !== entry.state && entry.state.phase === 'hot') nearEvents(id, previous, entry, Number(previousEntry.raiseSeq || 0));
        // The near bookkeeping ends with the body: a far record keeps no
        // route rows of a near decision, and the next activation's raises
        // count from its session's first.
        else if (entry.state.phase !== 'hot' && (entry.nearRoute || entry.raiseSeq)) { entry.nearRoute = null; entry.raiseSeq = 0; }
        const result = nativeSet(id, entry);
        if (previous !== entry.state) {
            const route = routeRequests.get(Number(id));
            if (route && route.sourceState !== entry.state) cancelRoute(id);
            const held = occupationPlanner.slots.get(Number(id));
            const routeKey = EconomicTrip.key(entry.state);
            const incoming = held ? { ...held.input, state: entry.state, sourceState: entry.state, routeKey,
                routeRows: held.input.routeKey === routeKey ? held.input.routeRows : null } : null;
            if (held?.done && (held.input.state === entry.state || occupationPlanner.sameInput(held.input, incoming))) {
                held.input = incoming;
            } else {
                occupationPlanner.cancel(id);
                // Own outputs are not inputs: no economy refresh for the own
                // commit or review; economyPending stays for main's next refresh.
                if (ownOutput && entry.economyPending) economyDiagnostics.count('occupation', 'refresh',
                    ownOutput === 'review' ? 'own_review_skipped' : 'own_commit_skipped');
                occupationOwnerChanged(id, !ownOutput && Boolean(entry.economyPending), ownOutput ? `own_${ownOutput}` : 'state_copy');
            }
        }
        return result;
    };
    kernel.states.set = (id, entry, ownOutput = null) => storeState(id, entry, ownOutput);
    kernel.states.delete = id => { occupationPlanner.cancel(id); cancelRoute(id); return nativeDelete(id); };
    // The states are the worker's party rule input (configureTradeAdmission
    // below; no session here): each write is the rule's flip event for its
    // bot (PartyAdmission.watchStates). No clear: nothing clears them.
    PartyAdmission.watchStates(kernel.states, boardIndex);
    PartyAdmission.configureTradeAdmission(id => kernel.states.get(Number(id))?.state || kernel.states.get(-Number(id))?.state);
    kernel.prepareMeeting = (id, meeting) => {
        const entry = kernel.states.get(id);
        const side = meeting.actorA === id ? 0 : 1;
        const state = meeting.incoming ? { ...entry.state, acceptedIncoming: meeting.incoming[side], incomingPending: false } : entry.state;
        return occupationPlanner.request(id, { state, sourceState: entry.state, timestamp: Date.now(), assetsKey: assetsKey(state),
            mode: 'meeting', meeting, recipeBook: recipeKnowledgeOf(entry.state).recipeBook, buyOrderEscrow: escrowFor(id),
            routeKey: EconomicTrip.key(entry.state), sourceReady: tables.ready('board') && tables.ready('market') }).then(result => {
                if (!result?.token) throw Error(result?.reason || 'trade_meeting_preparation_pending',
                    result?.cause ? { cause: result.cause } : undefined);
                return result;
            });
    };
    kernel.meetingResultPages = (result, id, token) => TradeMeetingCodec.commandPages(result,
        frame => Protocol.envelope('command_request', epoch, { requests: [{ kind: 'meeting', characterId: id, commandId: token, frame }] },
            `meeting-result:${id}:${token}:3`), result.dependencies);
    kernel.buyerEvents = buyerWaiters;
    EconomyContext.configure({
        board: boardReady,
        knownRecipes: id => RecipeBookCodec.unpack(recipeKnowledgeOf(kernel.states.get(Number(id))?.state).recipeBook) ?? undefined,
        workshops: workshopsFor,
        npcOffersFor: OccupationSources.npcOffersFor,
        buyOrderEscrow: escrowFor,
        spots: () => planningSpots,
        // The bot's memory rows for its relations fact, bond and threat (read
        // only), without the deep copy snapshot() makes; as main passes them.
        memory: characterId => kernel.interactionMemory.relationRows(Number(characterId)),
        memoryIdentity: characterId => kernel.interactionMemory.contentIdentity(characterId),
        sourceReady: () => tables.ready('board') && tables.ready('market'),
        nativeCraftContinuation: true
    });
    OccupationSources.initialise();
    loopIntervalMs = Math.max(5, Number(config.loopIntervalMs) || 20);
    if (LOOP_ALARM) armLoop();
    else loopTimer = setInterval(() => {
        kernel.tick();
    }, loopIntervalMs);
    if (Config.coldCompetitionObserveEnabled) {
        const allowed = new Set((DataCache.npcs || []).filter(npc => npc.template?.kind === 'Monster'
            && !invoke('GameServer/Bot/AI/BotRaidSafety').isProtectedRaidEntity(npc)).map(npc => Number(npc.selfId)));
        competition = new ColdCompetitionMonitor({
            capacityForSpot: invoke('GameServer/Bot/AI/LevelingRoutes').capacityForSpot,
            personaFor: state => BotPersona.of(state),
            knowledgeFor: (source, persona, key) => persona ? { source, persona, key } : null,
            isTargetAllowed: id => allowed.has(id),
            ownSide: ColdPvpResolver.ownSide,
            leaderParty: id => kernel.leaderParty(id),
            spotOf: standingSpot
        });
        competitionCandidates = new ColdCompetitionCandidates({
            records: id => kernel.states.locationIndex.getSource(id, 'state'),
            packets: id => kernel.states.get(id), memory: kernel.interactionMemory,
            monitor: competition, deadlines: kernel, leaderParty: id => kernel.leaderParty(id), spotOf: standingSpot,
            frameSizing: frame => {
                // ARCH-NOTE: these retained fields determine the existing byte admission.
                // Keep identical conservative capacity on/off; Candidates.snapshot hides
                // their optional publication. Removing this coupling needs a protocol task.
                const report = competition.snapshot();
                const large = Number.MAX_SAFE_INTEGER;
                const outcomes = Object.fromEntries(Object.keys(report.outcomes).map(key => [key, large]));
                const kernelReport = kernel.heartbeatSnapshot(true);
                const message = Protocol.envelope('heartbeat', epoch, {
                    ...kernelReport, safety: safetyTotals(), occupationInvalidations: large, censusCrossings: large,
                    rebuilds: rebuildSizing(large),
                    committedExits: { entries: large, takers: large, refused: large },
                    admissionFlips: { flips: large, items: large },
                    recipeFacts: { computes: large, reads: large },
                    demandPrices: { builds: large, moves: large, ms: large, capped: large, spotSums: large, spotRanks: large, shots: large },
                    // Forecast cooldowns can make a decision alarm the new
                    // head. Include both optional shapes before those effects.
                    queueHead: { ...kernelReport.queueHead, kind: 'normal', alarmKind: 'decision',
                        dueAt: large, overdue: false, current: false },
                    competition: { ...report, events: [],
                        recent: [], frame: { ...frame, events: [] }, at: frame.at, outcomes,
                        scans: large, evaluated: large, pvpIntents: large, activeHunters: large, lastSampleMs: large,
                        deliverySendFailures: large, lastScanEvents: 160, consumedSpotKeys: 32, consumedActorKeys: 128,
                        pendingSpotKeys: large, pendingActorKeys: large, deliveryMode: 'addressed',
                        revenge: { evaluated: large, intents: large, at: frame.at, active: 128, sampledActors: 128, overflow: false } },
                    tables: tables.summary(), heapUsed: large, rss: large, v8Heap: { used: large, total: large, external: large, limit: large, afterGc: large, afterGcMax: large, late: large },
                    eventLoopUtilization: 1, eluActiveMs: large, eluIdleMs: large, cpuMs: large, eventLoopLagP95Ms: large,
                    eventLoopLagMaxMs: large
                }, 'x'.repeat(160));
                return new (invoke('GameServer/Bot/Population/ColdCompetitionFrameSizer').ColdCompetitionFrameSizer)(message, report.recent);
            }
        });
        kernel.decisionEvents = competitionCandidates;
    }
    flushTimer = setInterval(() => kernel.flushDue(), Math.max(50, Math.min(250, Number(config.flushTargetMs) || 2000)));
    heartbeatTimer = setInterval(() => {
        // Read and reset first: the beat's own work (the review, the send) counts in the next beat; a
        // sample counts the whole timer interval, so the resolution comes off (0 = no delay).
        const lagMaxMs = Math.max(0, eventLoopDelay.max / 1e6 - LAG_RESOLUTION_MS) || 0;
        const lagP95Ms = Config.developerDiagnostics ? Number(eventLoopDelay.percentile(95) / 1e6) || 0 : 0;
        eventLoopDelay.reset();
        if (competitionCandidates && competitionReady && !kernel.paused && !shuttingDown) {
            const started = Config.developerDiagnostics ? performance.now() : 0;
            competitionCandidates.reviewBatch(Date.now());
            if (Config.developerDiagnostics) competition.report.lastSampleMs = performance.now() - started;
            wakeLoopIfSooner();
        }
        const elu = performance.eventLoopUtilization(previousElu);
        previousElu = performance.eventLoopUtilization();
        const heartbeat = {
            ...kernel.heartbeatSnapshot(),
            ...heapTelemetry.snapshot(),
            geodata: GeodataEngine.storageStats(),
            // The beat's busy share and its active / idle ms: main sums the ms into the health line's
            // busy share over its own window (a beat delayed by a long task lasts longer); cpuMs is this thread's
            // CPU in the beat, summed beside it (busy minus CPU share = time the system took).
            eventLoopUtilization: elu.utilization, eluActiveMs: elu.active, eluIdleMs: elu.idle, cpuMs: threadCpuMs(),
            eventLoopLagMaxMs: lagMaxMs,
            occupationInvalidations: occupationPlanner.stats.invalidations,
            censusCrossings: DecisionSections.censusCrossings(),
            rebuilds: EconomyContext.rebuildStats(),
            recipeFacts: { ...RecipeProduction.factStats },
            demandPrices: { ...DemandPrice.stats, spotSums: SpotValueTable.cacheStats().marketSums, spotRanks: SpotValueTable.cacheStats().marketRanks },
            committedExits: CommittedExits.stats(),
            admissionFlips: PartyAdmission.admissionEventCounts(),
            ...(Config.developerDiagnostics ? { occupationPlanning: occupationPlanner.snapshot() } : {}),
            safety: safetyTotals(),
            competition: competitionCandidates?.snapshot() || null,
            ...(Config.developerDiagnostics ? {
            tables: tables.summary(),
            developerDiagnostics: economyDiagnostics.delta(),
            caches: { spotValue: SpotValueTable.cacheStats(), kitProfiles: ColdCombatProfile.kitStoreSize() },
            heapUsed: process.memoryUsage().heapUsed,
            rss: process.memoryUsage().rss,
            eventLoopLagP95Ms: lagP95Ms
            } : {})
        };
        try {
            if (send('heartbeat', heartbeat)) {
                if (Config.developerDiagnostics) economyDiagnostics.deltaSent();
            } else if (competition) {
                if (Config.developerDiagnostics) competition.report.deliverySendFailures = (competition.report.deliverySendFailures || 0) + 1;
            }
        } catch {
            // Main has not admitted this frame. Its exact origin/content stay
            // owned here for the next existing heartbeat, including backpressure.
            if (Config.developerDiagnostics && competition) competition.report.deliverySendFailures = (competition.report.deliverySendFailures || 0) + 1;
        }
    }, Math.max(250, Number(config.heartbeatMs) || 1000));
    loopTimer.unref?.();
    flushTimer.unref?.();
    heartbeatTimer.unref?.();
}

async function handle(message) {
    const valid = Protocol.validateEnvelope(message, 'main', { workerEpoch: epoch, bytes: message?.bytes });
    if (!valid.ok) {
        send('fault', { reason: valid.reason, msgId: message?.msgId || null });
        return;
    }
    let payload;
    try { payload = invoke('GameServer/Bot/Population/ColdStateWire').unpackPayload(message.type, message.payload || {}); }
    catch (error) { send('fault', { reason: error.message, msgId: message.msgId }); return; }
    switch (message.type) {
    case 'catalog_page':
        if (payload.catalog === 'npc_offers') {
            planningNpcOfferRows.push(...(payload.rows || []));
            if (payload.done) {
                BotMarketPricing.useNpcOfferSnapshot(planningNpcOfferRows);
                planningNpcCatalog = ColdNpcPlanningCatalog.createLookup(planningNpcOfferRows, boardReady);
                planningNpcOfferRows = [];
            }
        } else {
            planningSpots.push(...(payload.rows || []));
        }
        break;
    case 'init':
        RecomputeGeneration.configure(payload.recomputeGeneration);
        startKernel(payload.config || {});
        send('ready', {
            phase: 'running',
            pvpAggression: Config.pvpAggression,
            protocolVersion: Protocol.PROTOCOL_VERSION,
            data: {
                items: DataCache.items?.length || 0,
                npcs: DataCache.npcs?.length || 0,
                rewards: DataCache.npcRewards?.length || 0,
                npcEquipmentItems: planningNpcCatalog.itemCount,
                npcEquipmentOffers: planningNpcCatalog.offerCount
            }
        }, message.msgId);
        // The census's table use, read once here so no census read pays a spot search.
        MarketDemand.warmUse();
        break;
    case 'table_page': {
        const resync = tables.apply(payload.tables.filter(table => table.name !== 'actors'));
        if (resync.length) send('table_resync', { names: resync });
        // A replaced table rechecks the slots that read it once its copy is
        // whole (both in one page: one recheck).
        let replaced = false;
        if (boardReplacing && tables.ready('board')) { boardReplacing = false; replaced = true; }
        // A census sum read between the pages of the copy saw no rows: read again.
        if (marketReplacing && tables.ready('market')) { marketReplacing = false; replaced = true; MarketDemand.censusChanged(); }
        // Before recheckSources: it compares the admission scopes' revisions.
        if (censusMoved && tables.ready('market')) {
            censusMoved = false;
            for (const scope of OccupationSources.recipeIndex(boardIndex).recheck()) occupationPlanner.scopeChanged(scope);
        }
        if (replaced) occupationPlanner.recheckSources();
        break;
    }
    case 'clan_social_page':
        if (!kernel) break;
        for (const snapshot of payload.rows || []) {
            if (kernel.interactionMemory.clanSocial.accept(snapshot)) competitionCandidates?.clanChanged(snapshot.clanId);
        }
        if (payload.memberships) {
            const social = kernel.interactionMemory.clanSocial, previous = social.memberships;
            const active = payload.activeClanIds ? new Set(payload.activeClanIds) : null;
            const removed = active ? [...social.clans.keys()].filter(id => !active.has(id)) : [];
            social.acceptMemberships(payload.memberships, payload.membershipVersion, payload.activeClanIds);
            if (social.memberships !== previous) competitionCandidates?.membershipsChanged(previous, social.memberships, removed);
        }
        break;
    case 'snapshot_page':
        if (!kernel) throw new Error('kernel_not_initialized');
        if (payload.economyOwnerId !== undefined) {
            if (Number.isSafeInteger(payload.economyOwnerId) && payload.economyOwnerId > 0
                && Array.isArray(payload.rows) && !payload.rows.length) occupationOwnerChanged(payload.economyOwnerId, payload.reconcile === true,
                payload.reconcile === true ? 'main_refresh' : 'main_look');
            break;
        }
        kernel.upsertMany(payload.rows || []);
        if (payload.initial === true && payload.done === true) safetyStateReady = true;
        if (payload.ack) {
            send('ready', {
                phase: 'state_loaded',
                characterId: Number(payload.rows?.[0]?.state?.characterId || 0),
                ...kernel.heartbeatSnapshot()
            }, message.msgId);
        } else if (payload.done) {
            competitionReady = true;
            send('ready', { phase: 'snapshots_loaded', ...kernel.heartbeatSnapshot() }, message.msgId);
        }
        break;
    case 'worker_presence_request':
        send('worker_presence_ack', { results: payload.rows.map(row => safetyPresence(Protocol.safetyCheckpoint(row))),
            safety: safetyTotals() }, message.msgId);
        break;
    case 'worker_repair_request':
        send('worker_repair_ack', { results: payload.rows.map(safetyRepair), safety: safetyTotals() }, message.msgId);
        break;
    case 'commit_ack':
        kernel?.onCommitAck(payload);
        break;
    case 'command_request':
        for (const request of payload.requests || []) if (!kernel?.receiveMeetingPage(request))
            send('command_ack', { results: [{ kind: 'meeting', characterId: request.characterId, commandId: request.commandId,
                pageIndex: -1, ok: false, reason: 'trade_meeting_worker_busy' }] });
        break;
    case 'command_ack':
        (payload.results || []).forEach(result => kernel?.completeCommand(result));
        break;
    case 'party_formation_request': {
        const states = kernel
            ? [...kernel.states.values()].map((entry) => entry?.state).filter(Boolean)
            : [];
        send('party_formation_proposal', RequiredPartyFormation.proposalFromStates(states, payload), message.msgId);
        break;
    }
    case 'party_goal_request':
        if (payload.pageIndex !== undefined) admitPartyGoalPages(payload, message.msgId);
        else requestPartyGoals(payload, message.msgId);
        break;
    case 'fence': {
        occupationPlanner.cancel(payload.characterId);
        cancelRoute(payload.characterId);
        send('fence_ack', kernel?.fence(payload.characterId) || { characterId: Number(payload.characterId), proposal: null },
            message.msgId);
        break;
    }
    case 'pause':
        kernel?.pause();
        break;
    case 'resume':
        kernel?.resume();
        break;
    case 'throttle':
        kernel?.setMaxInFlight(payload.maxInFlight);
        break;
    case 'diagnostics_resync':
        economyDiagnostics.requestFull();
        break;
    case 'competition_release':
        if (Object.hasOwn(payload, 'receipt') && !competitionCandidates?.receipt(payload.receipt)) break;
        competitionCandidates?.releaseForecasts(payload.events || []);
        break;
    case 'shutdown':
        buyerWaiters.clear();
        if (shuttingDown) break;
        shuttingDown = true;
        for (const entry of partyGoalPages.values()) { clearTimeout(entry.timer); partyGoalJobs--; }
        partyGoalPages.clear(); partyGoalSeen.clear();
        routeRequests.clear();
        if (Config.economyDiagnostics) economyDiagnostics.stop();
        occupationPlanner.stop();
        competitionCandidates?.stop();
        stopTimers();
        eventLoopDelay?.disable();
        heapTelemetry?.close();
        send('drained', await kernel?.shutdown() || {}, message.msgId);
        parentPort.close();
        break;
    default:
        send('fault', { reason: 'unhandled_message', type: message.type }, message.msgId);
        break;
    }
}

parentPort.on('message', (message) => {
    if (message?.type === 'economy_diagnostics_selection') {
        if (Config.developerDiagnostics && Config.economyDiagnostics && message.epoch === epoch)
            economyDiagnostics.useSelection(message.ownerIds);
        return;
    }
    if (message?.type === 'economy_diagnostics_ack' && Config.economyDiagnostics && message.epoch === epoch) {
        economyDiagnostics.ack(message.id, message.accepted); return;
    }
    Promise.resolve(handle(message)).catch((error) => {
        send('fault', { reason: error?.message || 'worker_message_error', stack: error?.stack || null, msgId: message?.msgId || null });
    }).finally(wakeLoopIfSooner);
    // A message that changed the schedule synchronously (an ack, a snapshot,
    // a buyer wake) moves the loop timer now; an awaited one at its finally.
    wakeLoopIfSooner();
});

send('ready', {
    phase: 'loaded',
    protocolVersion: Protocol.PROTOCOL_VERSION,
    forbiddenDependencies: forbiddenLoaded.length
});
