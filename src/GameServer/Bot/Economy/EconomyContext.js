'use strict';
const ClassProgression = invoke('GameServer/ClassProgression');
const DataCache = invoke('GameServer/DataCache');
const Roles = require('../AI/BotRoles');
const Knowledge = require('../AI/KnowledgeLearning');
const Crystallization = require('./BotCrystallization');
const Floor = require('../Population/SurvivalFloor');
const { partyIdOf } = require('../Population/PartyId');

const GearThreat = require('./GearThreat');

const ItemIndex = require('../../Item/ItemTemplateIndex');
const Valuation = require('./EconomicValuation');
const Providers = require('./WishProviders');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const WealthDecision = invoke('GameServer/Bot/Economy/WealthCraftDecision');
const ClanCrystalSupply = require('./ClanCrystalSupply');
const Sections = require('./DecisionSections');
const Funding = require('./PurchaseFunding');
const SpotRiskPolicy = require('../Population/SpotRiskPolicy');
const ColdEconomyDecision = require('../Population/ColdEconomyDecision');
const Network = require('./WishNetwork');
const PurchaseEvidence = require('./WishPurchaseEvidence');
const { buyback } = require('./PriceDecision');
const OccupationSources = invoke('GameServer/Bot/Population/ColdOccupationSources');
const { WishNetwork, remember, admitRoots, remainingQuantity, moneyQueue, cashCharge,
    createQuantityInputs, quantityInputsHold, eachQuantityRow } = Network;
const { isMainThread } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const RecomputeGeneration = require('../Population/RecomputeGeneration');
const Warehouse = require('./PersonalWarehouseIndex');
const ClanSupply = require('../../Clan/ClanSupplyPolicy');
const Recipes = require('../../Items/C4RecipeItems');
const CraftInputReservations = require('./CraftInputReservations');
const Bytes = require('./CompactBytes');
const { SELL, BUY } = require('../../AfkTrade/BoardIndex');
const BoardRules = require('../../AfkTrade/BoardRules');
const Diagnostics = require('./EconomyDiagnostics');
const PriceBelief = require('./PriceBelief');
const MarketDemand = require('./MarketDemand');
const TwinCluster = require('./TwinCluster');
const CraftEligibility = invoke('GameServer/Bot/Economy/CraftEligibility');
const HealingPotionStock = invoke('GameServer/Bot/AI/HealingPotionStock');
const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
const CombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const { fnv1a32 } = require('../Fnv1a');
const engine = new WishNetwork();
const Trip = require('./EconomicTrip');
const IncomeRoute = require('./EquipmentIncomeRoute');
const SpotEconomics = require('./SpotEconomics');
const SpotIndex = invoke('GameServer/Bot/AI/SpotIndex');
const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const WalkBack = invoke('GameServer/Bot/Economy/WalkBack');
const ColdTrip = invoke('GameServer/Bot/Population/ColdTrip');
const TravelRoutes = invoke('GameServer/Bot/Travel/TravelRoutes');
const GearProgression = invoke('GameServer/Bot/AI/PersonalGearProgression');
const TradeIntent = require('./TradeIntent');
// The bound of an event proof's packed and wire forms.
const PROOF_RAW_BYTES = 65536;
// The cold worker holds one plan per bot (~1,700), apart from the planner's in-flight builds: a
// 64-slot cache shrunk by them dropped a plan within ~2.5 s under a long cold queue, so every
// same-key rebuild found nothing held (L133). A worker entry is the plan only (perf C1), a party
// member's with its graph nodes; the main thread keeps the graph nodes too and stays at 64.
const RETAIN_LIMIT = isMainThread ? 64 : 2048;
let routeAnchors = new WeakMap();
// The rebuild table, always on (rebuildStats; the worker's heartbeat, summary
// line rebuilds=): per entry (the build's caller and trigger) and per reason a
// held build was not served, the builds, their ms and, of those with a held
// build, how many chose what it had chosen (sameDecision); 'served' counts the
// held builds served. Since start; bounded by REBUILD_ROWS_MAX whatever the
// callers pass: an entry names a trigger only from REBUILD_TRIGGERS (a per-ask
// token never names a row), at most REBUILD_ENTRIES_MAX entries (the rest share
// 'other'), REBUILD_REASONS_MAX reasons per entry and REBUILD_NAMED_MAX
// named rows (the rest join their entry's 'other'); names are cut to
// REBUILD_NAME_MAX on the heartbeat (the worker's frameSizing reserves the max).
// Only with diagnostics on a held refusal names its cause (refused:<reason>:<cause>, forState
// refusalCause: unproved, wish_dirty, sections): an entry's
// first REBUILD_CAUSES_MAX causes of one reason get a row, the rest share
// its refused:<reason>:other, so a reason takes at most 4 of the entry's
// reasons (the caps carry those +3 per caused reason beside the plain row
// they replace: 4 reasons, +12 per entry; NAMED_MAX +6 per caused reason).
const REBUILD_TRIGGERS = new Set(['state_copy', 'own_commit', 'own_review', 'main_refresh', 'main_look',
    'warehouse', 'clan_supply', 'native_own_action', 'ask']);
const REBUILD_ENTRIES_MAX = 32, REBUILD_REASONS_MAX = 21, REBUILD_NAMED_MAX = 114, REBUILD_NAME_MAX = 48;
const REBUILD_REFUSED = 'refused:', REBUILD_CAUSES_MAX = 3;
// A cause naming sections or facts lists at most 3 (the longest fits
// REBUILD_NAME_MAX with its row prefix), more read 'many'.
function causeNames(names) {
    return names.length > 3 ? 'many' : names.join('+') || 'none';
}
// A row's kind on the heartbeat (rebuildStats): 0 a build, 1 a served held
// build. The summary line's builds/s counts kind 0 (PopulationStatus.rebuildText).
const REBUILD_KINDS = new Map([['served', 1]]);
const REBUILD_ROWS_MAX = REBUILD_NAMED_MAX + REBUILD_ENTRIES_MAX + 1;
const rebuildRows = new Map();
// entry -> its named reason rows; rebuildNamed: all named rows.
const rebuildEntries = new Map();
let rebuildNamed = 0;
// entry|refused:<reason> -> its named causes (REBUILD_CAUSES_MAX).
const rebuildCauses = new Map();
function rebuildEntry(caller, trigger) {
    const entry = caller || 'economy_context';
    return REBUILD_TRIGGERS.has(trigger) ? `${entry}<${trigger}` : entry;
}
function countRebuild(entry, reason, ms = 0, same = null) {
    let name = `${entry}|${reason}`, row = rebuildRows.get(name);
    if (!row) {
        let reasons = rebuildEntries.get(entry);
        if (reasons === undefined && rebuildEntries.size < REBUILD_ENTRIES_MAX) rebuildEntries.set(entry, reasons = 0);
        const at = reasons !== undefined && reason.startsWith(REBUILD_REFUSED) ? reason.indexOf(':', REBUILD_REFUSED.length) : -1;
        if (at > 0) {
            const base = `${entry}|${reason.slice(0, at)}`, causes = rebuildCauses.get(base) || 0;
            if (causes < REBUILD_CAUSES_MAX) rebuildCauses.set(base, causes + 1);
            else row = rebuildRows.get(name = `${base}:other`);
        }
        if (!row) {
            if (reasons === undefined) name = 'other|other';
            else if (reasons >= REBUILD_REASONS_MAX || rebuildNamed >= REBUILD_NAMED_MAX) name = `${entry}|other`;
            else { rebuildEntries.set(entry, reasons + 1); rebuildNamed++; }
            row = rebuildRows.get(name);
            if (!row) rebuildRows.set(name, row = { n: 0, ms: 0, same: 0, compared: 0 });
        }
    }
    row.n++; row.ms += ms;
    if (same !== null) { row.compared++; if (same) row.same++; }
}
// A build chose what the held build had chosen: the focus, the leaf and the
// first wishes of the queue in order (the decision's outputs, no projection).
function sameDecision(held, fresh) {
    if (!held || !fresh || held.focus?.[0] !== fresh.focus?.[0] || held.activity?.key !== fresh.activity?.key) return false;
    const a = held.queue || [], b = fresh.queue || [];
    for (let i = 0; i < 4; i++) if (a[i]?.key !== b[i]?.key) return false;
    return true;
}
// [entry, reason, builds, ms, same, compared, kind] rows since start.
function rebuildStats() {
    return [...rebuildRows].map(([name, row]) => {
        const at = name.lastIndexOf('|');
        const reason = name.slice(at + 1);
        return [name.slice(0, Math.min(at, REBUILD_NAME_MAX)), reason.slice(0, REBUILD_NAME_MAX), row.n, Math.round(row.ms), row.same, row.compared, REBUILD_KINDS.get(reason) || 0];
    });
}
let runtime = {};
function configure(providers = {}) { runtime = providers; reset(); }
// The market board a reader looks at: the given one (a board or its
// getter), else the configured runtime's, else main's live board; null in
// a worker not configured yet. The one board resolution of every reader.
// Main's live board gets its recipe index at the first resolution (the one
// builder, ColdOccupationSources.recipeIndex), so main's recipe market
// facts (scroll value in spot income and scroll demand) are held and
// follow its board and deals (RecipeProductionIndex.forBoard), as the worker's.
let indexedBoard = null;
function marketBoard(board = runtime.board) {
    if (typeof board === 'function') board = board();
    if (board || !isMainThread) return board || null;
    // lazy: worker the board's owner lives on main; the worker passes its board.
    const live = invoke('GameServer/AfkTrade/AfkTradeService').boardIndex();
    if (live && live !== indexedBoard) {
        OccupationSources.recipeIndex(live);
        indexedBoard = live;
    }
    return live;
}
// The recipes a bot knows, as its thread holds them: the worker's book
// (the configured runtime's knownRecipes: the book main sent), main's
// workshop cache once loaded (CraftWorkshopService); undefined while the
// thread holds no book. The one source of every reader of known recipes
// (resolved, ItemDisposition.knownRecipeIds).
function knownRecipesOf(state) {
    const id = Number(state?.characterId);
    if (typeof runtime.knownRecipes === 'function') return runtime.knownRecipes(id) ?? undefined;
    if (!isMainThread) return undefined;
    // lazy: worker the workshop cache lives on main only.
    const Workshops = invoke('GameServer/Bot/Economy/CraftWorkshopService');
    return Workshops.bookFor(id) !== null ? Workshops.cachedRecipes(id) : undefined;
}
// actorKey -> { key, readIds, plan, stateRef, gearThreat } of bots: bounded
// (WishNetwork.remember). The plan is data (planOf); a reader gets view().
const cache = new Map();
// Groups apart, so a party composition that weighs many candidate groups
// never evicts the bots' own reviews: `group:<partyId>` -> { key, ids,
// context }, removed when the party ends (forgetGroup) and bounded besides;
// a proposed composition (`proposal:` party id) is built and not kept.
const groups = new Map();
const GROUP_LIMIT = 256;
const positive = value => Math.max(0, Number(value) || 0);

function stateForActor(actor, session = actor?.session) {
    // lazy: cycle hot decision publication calls this native actor capture.
    const decisionStats = require('../AI/DecisionEvents').decisionStatsFor(session);
    const stored = session?.coldLifeState || {};
    const current = invoke('GameServer/Bot/Population/BotLifeState').cachedState?.(actor.fetchId?.());
    const physicalInventory = actor.backpack?.fetchItems?.() || [];
    const inventory = itemRows(physicalInventory);
    const hotKit = invoke('GameServer/Bot/Population/ColdCombatProfile').capture(actor);
    const state = { ...stored, characterId: actor.fetchId?.(), level: actor.fetchLevel?.(), inventory, physicalInventory,
        clanId: Number(actor.fetchClanId?.() ?? stored.clanId ?? stored.stats?.clanId ?? 0),
        craftLevel: actor.backpack?.fetchDwarvenCraftLevel?.(actor) ?? stored.craftLevel,
        acceptedIncoming: current?.acceptedIncoming || stored.acceptedIncoming || {},
        incomingPending: current ? current.incomingPending === true : stored.incomingPending === true,
        adena: actor.backpack?.fetchItemFromSelfId?.(57)?.fetchAmount?.() || 0,
        sp: actor.fetchSp?.() ?? stored.sp,
        spotId: session?.currentSpot?.id || stored.spotId,
        stats: { ...decisionStats, coldCombat: hotKit, hennas: [...(session?.hennas || stored.stats?.hennas || [])], soulCrystalQuest: session?.questStates?.get(350)?.isStarted() === true || stored.stats?.soulCrystalQuest, classId: actor.fetchClassId?.(), exp: actor.fetchExp?.(), karma: actor.fetchKarma?.(), pk: actor.fetchPk?.() },
        party: session?.hotBackgroundPartyId ? { partyId: session.hotBackgroundPartyId, role: stored.party?.role } : null,
        activity: session?.plan || 'hunting' };
    const loc = { locX: Number(actor.fetchLocX?.()), locY: Number(actor.fetchLocY?.()), locZ: Number(actor.fetchLocZ?.()) };
    if (!Object.values(loc).every(Number.isFinite)) Object.assign(loc, stored.loc || {});
    state.loc = loc;
    return routeState(state, session);
}
// The live items of a backpack as a state's inventory rows, one per item id
// (stateForActor).
function itemRows(items) {
    const inventory = {};
    for (const item of items) {
        const id = Number(item.fetchSelfId?.());
        if (!id) continue;
        const amount = positive(item.fetchAmount?.());
        const equipped = !!item.fetchEquipped?.();
        const stackable = item.fetchStackable?.();
        const previous = inventory[id];
        inventory[id] = { selfId: id, amount: amount + positive(previous?.amount),
            equipped: equipped || previous?.equipped, equippedCount: Number(equipped) + positive(previous?.equippedCount),
            slot: equipped ? Number(item.fetchSlot?.()) : previous?.slot || 0,
            enchant: item.fetchEnchantLevel?.() ?? item.fetchEnchant?.() ?? 0, stackable,
            ...(stackable === true ? {} : { instances: [...(previous?.instances || []), { id: item.fetchId?.(), selfId: id, amount, equipped,
                slot: Number(item.fetchSlot?.() || 0), enchant: item.fetchEnchantLevel?.() ?? item.fetchEnchant?.() ?? 0 }] }) };
    }
    return inventory;
}
function routeState(state, session) {
    if (!session || typeof session !== 'object') return state;
    const frame = Trip.frame(state); frame.loc = null;
    const event = JSON.stringify([state.spotId, state.stats?.decisionSeq, frame]);
    const held = routeAnchors.get(session);
    const anchor = held?.event === event ? held : { event, loc: state.loc };
    routeAnchors.set(session, anchor);
    return { ...state, loc: anchor.loc };
}
const proofDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function activityIdentity(leaf) {
    if (!leaf) return null;
    const value = new ColdEconomyDecision.CompactActivity(leaf);
    // These are the card's derived execution/funding annotations, not a
    // different selected activity. Every native command field stays bound.
    delete value.heldAtDecision; delete value.r; delete value.craftReservations;
    return proofDigest(value);
}
// L70: the bot's own hunting/resting/travelling is not an economic event.
// Only this kind is equalised. One trip is the plan itself: leaving for the
// held leaf's own hunting spot or its own town (Sections.occupationPlanned);
// its trip record is dropped. The arrival is the occupation fact, read by
// the verdict's sections against the held leaf.
const FIELD_ACTIVITIES = new Set(['hunting', 'resting', 'traveling']);
function fieldActivity(state, activity, leaf = null) {
    if (!activity || activity === state.activity || !FIELD_ACTIVITIES.has(activity) || !FIELD_ACTIVITIES.has(state.activity)) return state;
    return state.activity === 'traveling' && Sections.occupationPlanned(state, leaf)
        ? { ...state, activity, stats: { ...state.stats, travel: null } } : { ...state, activity };
}
// The decided facts of a request over resolved deps: the recipe book the
// build reads (main: the database book; worker: the
// book main sent), so a build and its verdict read the same sources.
function requestFacts(state, deps) {
    return Sections.semanticFacts(state, ItemDisposition.knownRecipeIds(state, deps.knownRecipes));
}
// The build's input name (the weighing memo, the card's inputHash, the group
// key): its facts without the occupation, which the verdict reads against
// the held leaf, so a trip the leaf ordered does not rename the inputs; and
// the gear-threat mask the decision weighs and keeps, so the rebuild after a
// threat refusal never reuses the weighing made under the other mask.
const inputName = (facts, threat) => String(Sections.hash({ ...facts, occupation: null, threat }));
// The held leaf's own purchase item stays exact: its order counts only the
// rise since the decision (remainingToOrder), so use inside a band would buy short.
function bandsHold(state, bands = [], leaf = null) {
    if (!Array.isArray(bands) || bands.length > 128) return false;
    const bought = leaf?.activity === 'shopping' ? Number(leaf.itemId) || 0 : 0;
    for (const band of bands) {
        if (!Array.isArray(band) || band.length !== 4) return false;
        const [id, low, high, original] = band;
        if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(low) || low < 0
            || high !== null && (!Number.isFinite(high) || high < low)
            || !Number.isFinite(original) || original < low || high !== null && original > high) return false;
        const amount = Number(state.inventory?.[id]?.amount);
        if (bought && Number(id) === bought ? amount !== original
            : !(amount >= low) || high !== null && !(amount <= high)) return false;
    }
    return true;
}
// The event part of the one verdict "the held plan is still valid" (L70),
// read by the verdict (heldBuildVerdict), which checks a raised event
// (wishDirty) itself before. Only hard checks: a crafter's MP and hard money
// (below the lower bound or a moved funding mark). Soft money, income and
// the market are the soft point's (DecisionSections.softEvents, the end of
// the step), never here.
// held: { baseline, mp, nativeCraftContinuation, money } of the last actual
// decision; money: the packet it priced with (heldMoney), the state's without.
// Every failing check names itself in `why` (an array or null), in order.
const miss = (why, reason) => { why?.push(reason); return false; };
function heldEventsQuiet(state, held, deps = {}, why = null) {
    const stats = state.stats || {};
    let quiet = true;
    if (!held.nativeCraftContinuation && Number(state.craftLevel ?? stats.dwarvenCraftLevel) > 0
        && Number(state.vitals?.mp) !== Number(held.mp)) quiet = miss(why, 'crafter_mp');
    if (Sections.moneyChanged(state, held.baseline, deps.buyOrderEscrow, false, held.money ?? state.stats?.money)) quiet = miss(why, 'money');
    return quiet;
}
// A quantity proof row (WishNetwork createQuantityInputs layout) of the
// leaf's own progress: a stock row of its own root on its item, or a
// scalar row of its item (WishNetwork finish keeps that stock row apart).
// Other roots' stock row on that item (shared, root '') is their input (a
// wished material reaching its count).
const ownQuantityRow = (row, rootKey, own) => row[0] === 'stock' || row[0] === 'stockPhysical'
    ? row[1] === rootKey && row[2] === own : row[1] === own;
// The first input a completed build lacks for an event proof, '' if none.
function eventProofMissing(state, deps, plan) {
    if (!plan || plan.pending) return 'pending';
    if (!plan.quantityInputs) return 'quantity_inputs';
    if (!plan.liquidationInputs) return 'liquidation_inputs';
    if (deps.nodes?.length) return 'nodes';
    if (state.incomingPending) return 'incoming_pending';
    if (!plan.statsPacket?.wishSections) return 'sections';
    if (!Warehouse.contentIdentity(state)) return 'warehouse';
    if (!ClanSupply.contentIdentity(state)) return 'clan_supply';
    if (!RecomputeGeneration.current()) return 'generation';
    const baseline = plan.statsPacket.wishSections, leaf = plan.network?.activity;
    if (leaf === null ? plan.pending !== false || plan.intentPending !== false || plan.statsPacket.activityLeaf !== 0
        : !leaf?.activity) return 'leaf';
    if (!Number.isFinite(baseline.at) || !Sections.observationBaselineValid(baseline)) return 'baseline';
    return '';
}
// This proof is produced by the completed native build, shared by its cache
// entry and compact execution card. It is never reconstructed from a later
// publication.
function captureEventProof(state, deps = {}, options = {}) {
    const plan = options.plan, missing = eventProofMissing(state, deps, plan);
    // Diagnostics: per retained build, captured or the first missing input.
    if (Diagnostics.active()) Diagnostics.count('context', 'proof', missing || 'captured');
    if (missing) return null;
    const baseline = plan.statsPacket.wishSections, leaf = plan.network?.activity;
    return Object.freeze({ version: 2, owner: Number(state.characterId), at: baseline.at,
        generation: RecomputeGeneration.current(),
        decision: Object.freeze([Number(plan.statsPacket.decisionSeq || 0),
            Number(plan.statsPacket.activityLeaf || 0), plan.network.focus?.[0] ?? null]),
        activity: activityIdentity(leaf),
        quantities: plan.quantityInputs, liquidation: plan.liquidationInputs,
        stockRoots: Object.freeze([...plan.stockRoots]),
        thresholds: plan.quantityThresholds || Network.NO_THRESHOLDS, bands: plan.quantityBands || [], hourAdena: plan.hourAdena,
        // A restored prefix currently excludes process-local owner versions.
        // Unsupported owners abstain; an empty numeric revision is not proof.
        restartable: !!RecomputeGeneration.current() && typeof deps.memoryIdentity === 'string'
            && deps.sourceReady === true });
}

// A row kept exact whatever its drift: incoming, presence and a physical
// stock row (no threshold is noted on it).
const EXACT_QUANTITY_ROWS = new Set(['incoming', 'present', 'freePresent', 'stockPhysical']);
// The quantity bands of a held build (open item 'hold:economy decision_seq
// and quantity'), the tolerate walker of quantityInputsHold for one verdict:
// a moved count row holds while it stays on the same side of every
// threshold the build compared it with (proof.thresholds, WishNetwork
// createQuantityInputs) and the drift of the rows so held (|delta| x
// buyback, an item's largest drift once) stays within the verdict's one drift budget (charge, shared
// with the old bands: heldBuildVerdict). A row kept exact or never noted
// (untracked), a stock row whose incoming moved, a crossing or a drift past
// the budget refuses, and so does a malformed list.
function quantityBand(proof, charge) {
    const list = proof.thresholds;
    let cursor = 0;
    return (row, index, value, incoming) => {
        // Rows come in ascending index: the cursor only moves on.
        let count = thresholdCount(list, cursor);
        while (count >= 0 && list[cursor] < index) count = thresholdCount(list, cursor += 2 + count);
        if (count < 0 || list[cursor] !== index || EXACT_QUANTITY_ROWS.has(row[0])
            || row[0] === 'stock' && incoming !== row[4]) return false;
        const original = row[0] === 'stock' ? row[3] : row[2];
        for (let at = cursor + 2; at < cursor + 2 + count; at++) {
            const side = list[at];
            if (!(side > 0) || (value >= side) !== (original >= side)) return false;
        }
        return charge(row[0] === 'stock' ? row[2] : row[1], value - original);
    };
}
// The threshold count of the entry at `at` of a proof's flat thresholds
// list (WishNetwork createQuantityInputs: row index, count, thresholds),
// -1 past the end or when malformed.
function thresholdCount(list, at) {
    const count = list[at + 1];
    return Number.isSafeInteger(count) && count >= 0 && at + 2 + count <= list.length ? count : -1;
}

// The state's decision (sequence, leaf, focus) against the held build's
// (design-rules Recompute: own outputs are not inputs): '' while the state
// carries the build's output (decision: the proof's, its packet applied) or
// still the decision the build read (input: the held entry's, forState; its
// packet not yet written back: a refresh, a near post sent before it came
// back). Else the refusal against the input when the sequence is still the
// input's, against the output otherwise. The input seen again means it did
// not move: a raise bumps the sequence (DecisionEvents applyRaise,
// raiseSections) and a packet is a build's output over the state it read;
// every other fact the build read has its own check below. anySeq: the
// sequence moved with a raise its bits name, only leaf and focus compared.
function decisionMove(state, decision, input, anySeq) {
    const seq = Number(state.stats?.decisionSeq || 0);
    const output = Sections.decisionRefusal(state, anySeq ? seq : decision[0], decision[1], decision[2]);
    if (!output || !input) return output;
    const own = Sections.decisionRefusal(state, anySeq ? seq : input[0], input[1], input[2]);
    return !own ? '' : !anySeq && seq === input[0] ? own : output;
}
// options.collect (the decision point, forState): a refusal that names
// sections ORs them into touchedSections and the checks go on; one that
// names none stops with every section. Otherwise (every other caller) the
// first refusal answers. The first refusal stays the reason either way.
// refuse always returns `out`; a sections refusal stops only outside
// collect mode: `if (cond && refuse(...) && !collect) return out`.
function heldBuildVerdict(state, proof, deps = {}, options = {}) {
    // Diagnostics: verdicts computed (every caller), against the ones a build
    // served from the card's verdict of its step (forState, handedVerdict).
    const diagnostic = Diagnostics.active();
    if (diagnostic) Diagnostics.count('context', 'held_verdict', 'computed');
    const collect = options.collect === true;
    // touchedSections: the pieces to rebuild; movedSections: only the
    // sections refusals named (a refusal naming none adds nothing to it);
    // firstSections: the sections the first refusal named, what a run that
    // stops there answers (eventProofHolds); leaf: the identity of the leaf
    // it judged, unset when it stopped before; cause: the cause of the first
    // refusal, read by the rebuild table (forState refusalCause): unproved
    // (missing: no proof, malformed, leaf_shape, decode), sections (the moved
    // facts, diagnostics on).
    const out = { valid: false, reason: '', touchedSections: 0, movedSections: 0, firstSections: 0, leaf: undefined, cause: '' };
    const refuse = (reason, names) => {
        const first = !out.reason;
        out.reason ||= reason;
        if (!names) {
            if (collect) out.touchedSections = Sections.COMPUTED.weighing;
            return out;
        }
        const bits = typeof names === 'number' ? names : Sections.sectionMask(names);
        out.touchedSections |= bits; out.movedSections |= bits;
        if (first) out.firstSections = bits;
        return out;
    };
    const unproved = cause => {
        if (!out.reason) out.cause = cause;
        return refuse('unproved');
    };
    if (!proof) return unproved('missing');
    if (proof.version !== 2 || proof.owner !== Number(state.characterId)
        || !Array.isArray(proof.decision) || proof.decision.length !== 3
        || !proof.decision.slice(0, 2).every(value => Number.isSafeInteger(value) && value >= 0)
        || proof.decision[2] !== null && typeof proof.decision[2] !== 'string'
        || !Array.isArray(proof.stockRoots) || proof.stockRoots.length > 40
        || !proof.stockRoots.every(row => Array.isArray(row) && row.length === 2
            && typeof row[0] === 'string' && Number.isSafeInteger(row[1]) && row[1] > 0)
        || !Array.isArray(proof.bands) || !Array.isArray(proof.thresholds) || !Array.isArray(proof.liquidation?.rows)
        || proof.liquidation.rows.length > 8 || !proof.liquidation.rows.every(row => Array.isArray(row)
            && row.length === 2 && Number.isSafeInteger(row[0]) && row[0] > 0 && Number.isFinite(row[1]) && row[1] > 0)
        || !Number.isFinite(proof.hourAdena) || proof.hourAdena < 0) return unproved('malformed');
    // The judged leaf has the proof's shape: none for a leafless proof.
    if (!(proof.activity === null ? options.leaf === null && proof.decision[1] === 0
        : typeof proof.activity === 'string' && !!options.leaf?.activity)) return unproved('leaf_shape');
    const baseline = options.baseline;
    if (!Sections.observationBaselineValid(baseline) || !Number.isFinite(proof.at)) return refuse('baseline');
    // The baseline belongs to this proof (identity of `at`, not an order of
    // two times: a request's own clock is no decision input).
    if (proof.at !== baseline.at) return refuse('baseline_at');
    const generation = RecomputeGeneration.current();
    if ((!generation || proof.generation !== generation) && refuse('generation', ['build', 'sources']) && !collect) return out;
    out.leaf = activityIdentity(options.leaf);
    if (out.leaf !== proof.activity && refuse('activity', ['sources']) && !collect) return out;
    // A raised event (reconcile bumps the sequence with it) is named by its
    // sections before the echo: the held build's own verdict reads the bits
    // raised since that build (options.dirty, raisedSince), a card all of them.
    const dirty = options.dirty ?? (Number(state.stats?.wishDirty) || 0);
    if (dirty && refuse('wish_dirty', dirty) && !collect) return out;
    const echo = decisionMove(state, proof.decision, options.input, false);
    // Collecting past raised bits: every raise (DecisionEvents markSections,
    // raiseSections) bumps decisionSeq with its bits, so a moved sequence is
    // that raise, already named by its bits; read as sources it would rebuild
    // the source walk on every event. The leaf and the focus are still
    // compared: a moved one lights sources, as the echo does.
    if (echo && collect && dirty) {
        const leafOrFocus = decisionMove(state, proof.decision, options.input, true);
        if (leafOrFocus) refuse(leafOrFocus, ['sources']);
    } else if (echo && refuse(echo, ['sources']) && !collect) return out;
    deps = resolved(state, deps);
    if (!Warehouse.contentIdentity(state) || !ClanSupply.contentIdentity(state)) return refuse('unready');
    const current = fieldActivity(state, options.activity, options.leaf);
    // An occupation move the held leaf ordered (its trip, its arrival) is its own output.
    // A first refusal here names the moved facts (diagnostics only).
    const movedFacts = diagnostic && !out.reason ? [] : null;
    const changed = Sections.factEvents(name => baseline[name], options.facts || requestFacts(current, deps), false, movedFacts,
        Sections.occupationPlanned(state, options.leaf));
    if (changed.length && movedFacts) out.cause = causeNames(movedFacts);
    if (changed.length && refuse('sections', changed) && !collect) return out;
    // The gear-threat mask the decision weighed: only its flip between
    // "physical only" and "both" changes a decision. A baseline kept before
    // the mask was recorded has none to compare.
    if (baseline.threat !== undefined && baseline.threat !== (deps.gearThreatMask ?? GearThreat.maskFor(current, deps))
        && refuse('observation', ['occupation', 'benefits', 'sources']) && !collect) return out;
    const why = [];
    if (!heldEventsQuiet(state, { baseline, mp: options.mp, nativeCraftContinuation: deps.nativeCraftContinuation === true,
        money: options.money }, deps, why))
        for (const name of why) if (refuse(name, name === 'money' ? ['money'] : ['sources']) && !collect) return out;
    if (!bandsHold(state, proof.bands, options.leaf) && refuse('bands', ['supply']) && !collect) return out;
    const roots = new Map(proof.stockRoots);
    const leaf = options.leaf;
    // A held build passes its entry's fields; a card carries them on its leaf.
    const heldUnits = options.heldUnits ?? leaf?.heldAtDecision;
    const craftReservations = options.craftReservations ?? leaf?.craftReservations;
    // A held craft's reserved inputs may only grow before it runs: a stock
    // row holds while its owned+incoming does not fall (its own delivery
    // moves incoming into the bag), a physical row while its count does not.
    // Every root needing the input carries the same physical row: unlike the
    // own item, the tolerance is not scoped to the leaf's root.
    // A loss below what the decision reserved stays a quantity event.
    const reserved = leaf?.activity === 'crafting' && Array.isArray(craftReservations) ? craftReservations : null;
    const isReserved = id => reserved?.some(row => row[0] === id) === true;
    // The verdict's one drift budget, the bot's error on an hour's income:
    // every count a finite band (shots, unused loot) or a quantity band
    // keeps charges its drift (|delta| x buyback) to it, so together they
    // never tolerate more. A band without an upper bound (stock at or above
    // its target) is sale capacity, not noise: it charges nothing.
    // An item charges its largest drift once per verdict: its stock,
    // physical and sale rows read one bag count (one drift, one charge),
    // a free row reads the bag minus its reserves and may move further.
    const budget = positive(proof.hourAdena) * positive(baseline.incomeError);
    let spent = 0, charged = null;
    const charge = (id, delta) => {
        const units = Math.abs(delta || 0), prior = charged?.get(id) || 0;
        if (units > prior) {
            (charged ||= new Map()).set(id, units);
            spent += (units - prior) * positive(buyback(id));
        }
        return spent <= budget;
    };
    const stockAmount = (kind, key, id, currentOwned, originalOwned) => {
        if (kind === 'stockPhysical' && isReserved(id) && currentOwned >= originalOwned) return originalOwned;
        if (roots.get(key) !== id) return currentOwned;
        const band = proof.bands?.find(row => row[0] === id);
        return band && originalOwned === band[3] && currentOwned >= band[1]
            && (band[2] === null || currentOwned <= band[2] && charge(id, currentOwned - originalOwned)) ? originalOwned : currentOwned;
    };
    // Own outputs are not inputs: the leaf's own item moves with its progress.
    // It holds while the bot keeps what it held at the decision; the order's
    // completion is the activity check below, a loss is a quantity event.
    const own = ColdEconomyDecision.ownItem(leaf) !== null && Number.isFinite(heldUnits) ? leaf.itemId : null;
    if (own !== null && ColdEconomyDecision.heldFor(state, own) < heldUnits && refuse('quantity', ['money']) && !collect) return out;
    // The proof is held packed and read as a stream: no rows array.
    const ownRow = own === null ? null : row => ownQuantityRow(row, leaf.rootKey, own);
    const stock = stockReader(state, key => roots.get(key));
    // A reserved input's stock row holds while its owned+incoming does not fall.
    const stockFor = !reserved ? stock : (id, rootKey, row) => {
        const current = stock(id, rootKey);
        if (!isReserved(id) || current.owned + current.incoming < row[3] + row[4]) return current;
        return { owned: row[3], incoming: row[4] };
    };
    // A moved count row inside its thresholds and the drift budget holds (quantityBand).
    const moved = [];
    if (!quantityInputsHold(proof.quantities, { ...Providers.quantityReaders(state), stockFor }, stockAmount, ownRow, moved,
        quantityBand(proof, charge))
        && (moved.length ? refuse('quantity', ['money']) && !collect : unproved('decode'))) return out;
    const liquidation = Providers.liquidationInputs(state, proof.liquidation?.basis);
    // The leaf's own item and a craft's reserved inputs are not sales: their
    // count moves with the leaf's progress, held above by the quantity check.
    const sale = own === null && !reserved ? null : row => row[0] !== own && !isReserved(row[0]);
    const originalSales = sale ? proof.liquidation.rows.filter(sale) : proof.liquidation.rows;
    const currentSales = liquidation.proof && (sale ? liquidation.proof.rows.filter(sale) : liquidation.proof.rows);
    let changedLoot = false;
    const sameSales = currentSales && currentSales.length === originalSales.length
        && currentSales.every(([id, count], at) => {
            const original = originalSales[at];
            if (id !== original?.[0]) return false;
            if (count === original[1]) return true;
            changedLoot = true;
            const band = proof.bands?.find(row => row[0] === id);
            const item = ItemIndex.find(DataCache.items, id);
            // Only the existing finite unused-loot error band. Unlimited
            // surplus stock is sale capacity, not economic noise.
            return band && band[2] !== null && /^Other\.(Material|Arrow)/.test(String(item?.template?.kind || ''))
                && count - original[1] === positive(state.inventory?.[id]?.amount) - band[3] && charge(id, count - original[1]);
        });
    if ((!sameSales || changedLoot && !choiceBagValueHolds(state, proof.bands, baseline, proof.hourAdena))
        && refuse('liquidation', ['money']) && !collect) return out;
    // The leaf's own check (LEAF_CHECKS): a check:<name> refusal names its sections.
    const failed = leafCheck(state, leaf, deps, { heldUnits, current: null, prepared: { liquidation: liquidation.candidates } });
    if (failed && refuse(failed.reason, failed.sections) && !collect) return out;
    out.valid = !out.reason;
    return out;
}
// options.verdict receives what a run stopping at the first refusal answers,
// in either mode (touched = moved = the first refusal's sections): the card's
// verdict that joins the build's mask (forState, deps.eventVerdict). A
// refusal in collect mode (a card refused right before a build of the same
// step on the same state) also hands the whole verdict on with what it
// judged (`collected`, handedVerdict). A held card hands nothing: it is
// executed. The step's own verdict on the held build (heldWorkshop) hands
// itself, valid or not, to the build of its step, across the workshop ask.
// The hand-off of a verdict (`collected`): only what handedVerdict compares,
// no deps or options. leaf: the leaf the verdict judged (the card's compact
// one, or the held leaf itself, heldWorkshop); reads: the held build's reads
// it was judged with (heldReadsOf), handed by the step's own verdict only.
function collectedOf(verdict, state, proof, options, deps, reads = null) {
    return { verdict, state, proof, baseline: options.baseline, activity: options.activity, mp: options.mp,
        units: options.heldUnits ?? options.leaf?.heldAtDecision ?? null,
        reservations: options.craftReservations ?? options.leaf?.craftReservations,
        routeRows: deps.routeRows, tripCost: deps.tripCost, leaf: options.leaf, reads };
}
function eventProofHolds(state, proof, deps = {}, options = {}) {
    const verdict = heldBuildVerdict(state, proof, deps, options);
    if (options.verdict) {
        const first = verdict.firstSections;
        Object.assign(options.verdict, { valid: verdict.valid, reason: verdict.reason, touchedSections: first, movedSections: first });
        if (options.collect === true && !verdict.valid) options.verdict.collected = collectedOf(verdict, state, proof, options, deps);
    }
    if (!verdict.valid) options.why?.push(verdict.reason);
    return verdict.valid;
}
// The card's verdict of this step (eventProofHolds `collected`) or the
// step's own pre-verdict (heldWorkshop), served as
// the build's held verdict when it judged the same held entry on the same
// inputs: the same state object and proof, the proof's own baseline and
// activity, a leaf of the same identity, the same own units, reserved inputs
// (a craft leaf), crafter MP and trip rows. The deps it read beside these are
// the build's own: the caller spreads the card's deps into the build's
// (ColdSimulationWorker withEventVerdict), and the gear-threat mask
// is GearThreat's answer for the same state and deps. Else null: computed.
// The verdict lives with the step's deps, nothing keeps it.
const reservedRows = rows => rows?.length ? JSON.stringify(rows) : '';
// The card judged its leaf's compact form (ColdEconomyDecision.CompactActivity),
// of the same identity as the held leaf; the held leaf reads as it only where
// the compact form keeps what the verdict reads: the item (the compact one
// falls back to the wish object's), the sale rows (cut to 8) and the funding
// mark (made true). A verdict that judged the held leaf itself reads it.
function readsAsCompact(leaf) {
    if (!leaf) return true;
    const object = typeof leaf.object === 'number' ? leaf.object : leaf.object?.itemId;
    return (leaf.itemId ?? 0) === Number(leaf.itemId || object || 0) && !(leaf.items?.length > 8)
        && (!leaf.funding || leaf.funding === true);
}
function handedVerdict(handed, state, held, deps) {
    if (!handed || !held || handed.state !== state || handed.proof !== held.plan.eventProof) return null;
    const leaf = held.plan.network?.activity;
    if (handed.baseline !== held.plan.statsPacket.wishSections || handed.activity !== held.activity
        || !Object.is(handed.mp, held.mp) || handed.routeRows !== deps.routeRows || handed.tripCost !== deps.tripCost
        || handed.units !== (held.heldUnits ?? leaf?.heldAtDecision ?? null)
        || leaf?.activity === 'crafting' && reservedRows(handed.reservations)
            !== reservedRows(held.craftReservations ?? leaf.craftReservations)
        || !(handed.leaf === leaf || readsAsCompact(leaf))) return null;
    // The held leaf's identity is its proof's (captureEventProof, the same plan).
    return handed.verdict.leaf !== undefined && handed.verdict.leaf === handed.proof.activity ? handed.verdict : null;
}
function restartEventProof(proof, accepted) {
    if (proof?.version !== 2 || proof.restartable !== true || !accepted?.card
        || Object.keys(proof).some(key => !['version', 'owner', 'at', 'generation', 'decision', 'activity',
            'quantities', 'liquidation', 'stockRoots', 'thresholds', 'bands', 'hourAdena', 'restartable'].includes(key))
        || !RecomputeGeneration.current() || proof.generation !== RecomputeGeneration.current()
        || !/^[a-f0-9]{64}$/.test(proof.generation)
        || proof.owner !== accepted.characterId || proof.at !== accepted.baseline?.at
        || !Array.isArray(proof.decision) || proof.decision.length !== 3
        || proof.decision[0] !== accepted.decisionSeq || proof.decision[1] !== accepted.activityLeaf
        || proof.decision[2] !== accepted.focus || proof.activity !== activityIdentity(accepted.card.activity)
        || proof.activity === null && (accepted.card.activity !== null || proof.decision[1] !== 0)) return null;
    const quantities = proof.quantities;
    if (!(quantities instanceof Uint8Array)) return null;
    try {
        // Version, the recompute generation (a restore under another one is
        // refused), the soft facts in the shared exact byte form, the
        // quantity rows' thresholds, then the quantity owner's opaque bytes
        // to the end.
        const write = Bytes.writer();
        write.byte(8); write.raw(Buffer.from(proof.generation, 'hex'));
        if (!Providers.packLiquidationInputs(proof.liquidation, write)) return null;
        write.list(proof.stockRoots, row => {
            if (!Array.isArray(row) || row.length !== 2) throw Error('restart stock root');
            write.text(row[0]); write.uint(row[1]);
        });
        write.list(proof.bands, row => {
            if (!Array.isArray(row) || row.length !== 4) throw Error('restart band');
            write.uint(row[0]); write.number(row[1]); write.number(row[2], true); write.number(row[3]);
        });
        write.number(proof.hourAdena);
        // The thresholds' length, then per noted row its index, its count and its thresholds.
        const thresholds = proof.thresholds;
        if (!Array.isArray(thresholds)) return null;
        write.uint(thresholds.length);
        for (let at = 0, count; at < thresholds.length; at += 2 + count) {
            count = thresholdCount(thresholds, at);
            if (count < 0) return null;
            write.uint(thresholds[at]); write.uint(count);
            for (let side = at + 2; side < at + 2 + count; side++) write.number(thresholds[side]);
        }
        write.raw(quantities);
        const bytes = write.finish();
        return bytes.byteLength <= PROOF_RAW_BYTES ? bytes : null;
    } catch (_) { return null; }
}
function restoreEventProof(prefix, accepted) {
    const generation = RecomputeGeneration.current();
    // No minimum length: every short read below throws and refuses the whole prefix.
    if (!generation || !(prefix instanceof Uint8Array)
        || prefix.byteLength > PROOF_RAW_BYTES || !accepted?.card) return null;
    try {
        const read = Bytes.reader(prefix);
        // A prefix of format 7 (it carried no quantity thresholds) is refused once.
        if (read.byte() !== 8 || read.raw(32).toString('hex') !== generation) return null;
        const liquidation = Providers.unpackLiquidationInputs(read);
        const stockRoots = Object.freeze(read.list(() => Object.freeze([read.text(), read.uint()])));
        const bands = Object.freeze(read.list(() => Object.freeze([read.uint(), read.number(), read.number(true), read.number()])));
        const hourAdena = read.number();
        // The thresholds (each entry takes a byte at least: a longer list is malformed).
        const length = read.uint();
        if (length > prefix.byteLength) return null;
        const list = [];
        while (list.length < length) {
            const index = read.uint(), count = read.uint();
            if (list.length + 2 + count > length) return null;
            list.push(index, count);
            for (let side = 0; side < count; side++) list.push(read.number());
        }
        // The packed quantity proof stays packed; a prefix it cannot read is refused here.
        const packed = Uint8Array.from(read.rest());
        let rows = 0;
        const quantities = eachQuantityRow(packed, () => { rows++; }) ? packed : null;
        const thresholds = quantities && checkedThresholds(list, rows) && (length ? Object.freeze(list) : Network.NO_THRESHOLDS);
        if (!thresholds || !Number.isSafeInteger(accepted.characterId)
            || accepted.card.activity === null && accepted.activityLeaf !== 0
            || !Number.isFinite(accepted.baseline?.at)) return null;
        return Object.freeze({ version: 2, restartable: true, owner: accepted.characterId, at: accepted.baseline.at,
            decision: Object.freeze([accepted.decisionSeq, accepted.activityLeaf, accepted.focus]),
            activity: activityIdentity(accepted.card.activity), generation,
            quantities, liquidation, stockRoots, thresholds, bands, hourAdena });
    } catch (_) { return null; }
}
function wireEventProof(proof) {
    if (!proof || proof.version !== 2
        || (proof.activity === null ? proof.decision?.[1] !== 0 : typeof proof.activity !== 'string')) return null;
    try {
        if (!(proof.quantities instanceof Uint8Array)) return null;
        // Packed quantities cross as canonical base64 (receiveEventProof), so
        // this JSON size is the wire's.
        const wire = { ...proof, quantities: Buffer.from(proof.quantities).toString('base64') };
        return Buffer.byteLength(JSON.stringify(wire)) <= PROOF_RAW_BYTES ? wire : null;
    } catch (_) { return null; }
}
// The proof from its wire form or in process; null when its packed
// quantities are malformed or above their bound.
function receiveEventProof(proof) {
    const value = proof?.quantities, cap = Network.QUANTITY_INPUT_BYTES;
    const quantities = value instanceof Uint8Array ? value.byteLength <= cap ? value : null : Bytes.fromBase64(value, cap);
    if (!quantities) return null;
    // A built list is frozen (WishNetwork createQuantityInputs); one from
    // the wire is checked against its rows and frozen.
    const list = proof.thresholds;
    if (Array.isArray(list) && Object.isFrozen(list)) return { ...proof, quantities };
    let rows = 0;
    const thresholds = Array.isArray(list) && eachQuantityRow(quantities, () => { rows++; })
        && checkedThresholds(list, rows) && (list.length ? Object.freeze(list.slice()) : Network.NO_THRESHOLDS);
    return thresholds ? { ...proof, quantities, thresholds } : null;
}
// A proof's thresholds list (WishNetwork createQuantityInputs) when it fits
// its `rows` packed rows: rows by ascending index below `rows`, each with
// at most QUANTITY_THRESHOLDS ascending finite thresholds > 0; else null.
function checkedThresholds(list, rows) {
    for (let at = 0, last = -1, count; at < list.length; at += 2 + count) {
        count = thresholdCount(list, at);
        const index = list[at];
        if (count < 0 || count > Network.QUANTITY_THRESHOLDS || !Number.isSafeInteger(index)
            || index <= last || index >= rows) return null;
        last = index;
        for (let side = at + 2; side < at + 2 + count; side++)
            if (!(list[side] > 0) || list[side] === Infinity || side > at + 2 && list[side] <= list[side - 1]) return null;
    }
    return list;
}
function quantityBands(state, context, projection) {
    const bands = [], stock = new Map();
    for (const kind of ['shots', 'potions', 'scrolls']) {
        const row = context.stock(kind);
        if (row?.itemId && row.target > 0) stock.set(Number(row.itemId), [Math.max(1, Math.ceil(row.target - positive(row.beginnerCurrent))),
            kind === 'shots' ? row : null]);
    }
    const reserved = ItemDisposition.reservedEquipmentAmounts(state);
    const used = new Set((projection?.nodes || []).filter(node => node.key.startsWith('item:')).map(node => Number(node.key.slice(5))));
    const error = Sections.incomeError(state, context.persona);
    for (const [id, row] of Object.entries(state.inventory || {})) {
        const amount = positive(row.amount), itemId = Number(id), template = ItemIndex.find(DataCache.items, itemId);
        if (!amount || row.equipped || row.equippedCount || row.protected || row.protectedAmount || row.reservedAmount
            || row.acceptedCustomer || row.assignedClan || row.available === false || positive(reserved[id])
            || (row.stackable ?? template?.etc?.stackable) !== true) continue;
        if (stock.has(itemId)) {
            const [target, shots] = stock.get(itemId);
            if (amount >= target) bands.push([itemId, target, null, amount]);
            else if (shots && shots.unitPrice > 0) {
                // Shots between the survival line and the target: each unit
                // only moves the restock wish's amount, price and value
                // together. Consumption below the bot's own error (money and
                // hours) is noise; the survival line (survival reserve,
                // `needed`) and an empty stack (use rate, planned slot) stay
                // hard, and any rise is the purchase's own event.
                const floor = Math.max(1, Math.ceil(shots.survivalTarget - positive(shots.beginnerCurrent)));
                const allowance = Math.floor(Math.min(positive(context.hourAdena) * error / shots.unitPrice,
                    shots.benefitPerUnit > 0 ? error / shots.benefitPerUnit : Infinity));
                const low = Math.max(floor, amount - allowance);
                if (amount >= floor && low < amount) bands.push([itemId, low, amount, amount]);
            }
            continue;
        }
        // Only existing free stacks absent from every admitted requirement.
        // A book, recipe, target, new stack or unknown item keeps exact facts.
        const kind = String(template?.template?.kind || row.kind || '');
        if (used.has(itemId) || state.clanId || state.stats?.clanId || positive(state.stats?.karma)
            || !/^Other\.(Material|Arrow)/.test(kind)) continue;
        const unitValue = positive(context.buyback(itemId));
        if (!(unitValue > 0)) continue;
        const allowance = Math.floor(positive(context.hourAdena) * error / unitValue);
        bands.push([itemId, kind.startsWith('Other.Arrow') ? 1 : amount, amount + allowance, amount]);
    }
    return bands;
}
function choiceBagValue(state, bands, price = buyback) {
    return bands.reduce((value, [id, , high]) => value + (high === null ? 0
        : positive(state.inventory?.[id]?.amount) * positive(price(id))), 0);
}
function choiceBagValueHolds(state, bands, baseline, hourAdena, value = choiceBagValue(state, bands)) {
    return Number.isFinite(baseline?.bagValue)
        && Math.abs(value - baseline.bagValue)
            <= positive(hourAdena) * positive(baseline.incomeError);
}
// The cheap check of a held decision: one row per kind of leaf answers "does
// it still stand?" at the decision point (heldBuildVerdict). A row returns ''
// or its own frozen failure: the name (check:<name>) and the sections the
// build that follows re-weighs. input = { heldUnits, current, prepared }:
// heldUnits = the own item's bag+incoming at the decision (a held
// build's entry; a card carries it on its leaf); current = a lazy basics
// reader; prepared = { liquidation } candidates already read by the verdict.
// Execution still prepares its batch and checks via the command/CAS.
const failure = (name, ...sections) => Object.freeze({ reason: `check:${name}`, sections: Object.freeze(sections) });
const EXCLUDED = failure('excluded', 'occupation', 'sources'), MATERIAL_DONE = failure('material_done', 'sources');
const OFFER = failure('offer', 'sources', 'money'), SALE = failure('sale', 'sources', 'supply');
const CRAFT = failure('craft', 'sources', 'supply');
const IMPROVEMENT = failure('improvement', 'sources'), UNSUPPORTED = failure('unsupported', 'sources');
const withHeldUnits = (leaf, heldUnits) => ColdEconomyDecision.ownItem(leaf) !== null && Number.isFinite(heldUnits)
    ? { ...leaf, heldAtDecision: heldUnits } : leaf;
// The hunting spot against the bot's marks (died here, was full, avoided a
// quarrel) and its death pressure: the one exclusion read of a decision.
function spotExcluded(state, leaf) {
    return SpotRiskPolicy.excludedSpotIdsForStates([state]).has(String(leaf.spotId)) ? EXCLUDED : '';
}
// A trade leaf's town route: known and its fees payable now.
function tradeRoute(state, leaf, deps) {
    const trip = deps.tripCost || Trip.preparedReader(deps.routeRows || [], { hourAdena: positive(state.stats?.money?.[0]) });
    const route = trip.details?.(leaf.town);
    return route?.known && Number.isFinite(route.fees) && route.fees <= positive(state.adena) ? { trip, route } : null;
}
const LEAF_CHECKS = Object.freeze({
    hunting: (state, leaf, deps, input) => spotExcluded(state, leaf)
        || (ColdEconomyDecision.materialHunt(leaf)
            && ColdEconomyDecision.remainingToOrder(withHeldUnits(leaf, input.heldUnits), state) <= 0 ? MATERIAL_DONE : ''),
    shopping: (state, leaf, deps, input) => {
        deps = resolved(state, deps, false);
        const trade = tradeRoute(state, leaf, deps);
        if (!trade || !(leaf.kind === 'buy' && leaf.itemId > 0 && leaf.amount > 0 && leaf.unitPrice > 0
            && ['npc', 'configured_store', 'afk'].includes(leaf.sourceType))) return OFFER;
        const held = withHeldUnits(leaf, input.heldUnits);
        const remaining = ColdEconomyDecision.remainingToOrder(held, state);
        if (!(remaining > 0)) return OFFER;
        // The same buy, priced for what is left: another town (cheaper with
        // its trip), a dearer ask or too few units plans again.
        const offer = PurchaseEvidence.reader(state, { board: deps.board, trip: trade.trip }, deps)(leaf.itemId, remaining);
        if (!offer || offer.sourceType !== leaf.sourceType || offer.town !== leaf.town
            || offer.unitPrice > leaf.unitPrice || offer.availableUnits < remaining) return OFFER;
        return Funding.spendable(state, deps.buyOrderEscrow, Funding.nativeTerms(held, leaf.itemId))
            >= remaining * offer.price + trade.route.fees ? '' : OFFER;
    },
    selling: (state, leaf, deps, input) => {
        deps = resolved(state, deps, false);
        if (!tradeRoute(state, leaf, deps) || !(leaf.kind === 'liquidate' && leaf.funding === true && leaf.items?.length
            && OccupationSources.hasNpcSellerInTown(leaf.town))) return SALE;
        return (input.prepared?.liquidation || Providers.liquidationCandidates(state, input.current ? input.current() : basics(state, deps)))
            .some(row => leaf.items.includes(Number(row.selfId))) ? '' : SALE;
    },
    // This retains the chosen intention. The native executor still
    // prepares its actual batch and checks MP, materials and payment.
    crafting: (state, leaf) => Number.isSafeInteger(leaf.recipeId) && leaf.recipeId > 0
        && Recipes.resolveByRecipeId(leaf.recipeId) ? '' : CRAFT,
    improving: (state, leaf) => {
        const improvement = leaf.improvement;
        if (!improvement || typeof improvement !== 'object' || Array.isArray(improvement)) return IMPROVEMENT;
        // An enchant or a special ability names its object: it is still in the
        // bag under its item at the enchant level the decision read. Other
        // objects in the bag are no input; an exchange or a crystallization
        // names none (its inputs are bag rows, held by the quantity proof).
        if (improvement.objectId == null) return '';
        const row = state.inventory?.[improvement.itemId];
        const object = row?.instances?.find(item => Number(item.id) === Number(improvement.objectId));
        return object && positive(object.enchant ?? row.enchant) === positive(improvement.from) ? '' : IMPROVEMENT;
    },
    resting: () => '',
    traveling: () => ''
});
// A completed native graph may choose no economic action (no leaf):
// execution keeps its ordinary hunt/rest/travel path after every shared check.
function leafCheck(state, leaf, deps, input) {
    if (!leaf) return '';
    const row = Object.hasOwn(LEAF_CHECKS, leaf.activity) ? LEAF_CHECKS[leaf.activity] : null;
    return row ? row(state, leaf, deps, input) : UNSUPPORTED;
}
// Board reads of the review go through here while it is built, so each
// item it looked at is reported once (deps.onSourceRead: the occupation
// planner's dependencies). The market is no input of the held decision: it is
// heard at the soft point through the watch list. Later readers of
// context.board (a market look, a sale) report nothing.
function watchedBoard(board, watch) {
    if (!board) return board;
    return Object.assign(Object.create(board), {
        first: (selfId, ...rest) => { watch(selfId); return board.first(selfId, ...rest); },
        list: (selfId, ...rest) => { watch(selfId); return board.list(selfId, ...rest); },
        towns: (selfId, ...rest) => { watch(selfId); return board.towns(selfId, ...rest); },
        ...(board.buyUnits ? { buyUnits: (selfId, ...rest) => { watch(selfId); return board.buyUnits(selfId, ...rest); } } : {}),
        ...(board.heads ? { heads: (selfId, ...rest) => { watch(selfId); return board.heads(selfId, ...rest); } } : {})
    });
}
// One watch row (marketWatchRows): the reference price is the better of the
// build's price and the board head, the error the bot's own.
function watchRow(board, exclude, id, storeType, value, errorOf) {
    if (!(id > 0) || !(value > 0)) return null;
    const head = board?.first(id, storeType, exclude)?.price;
    const reference = !(head > 0) ? value : storeType === SELL ? Math.min(value, head) : Math.max(value, head);
    // Rounded: the baseline is saved with the bot (a few bytes per row).
    return [id, storeType, Math.round(reference), Math.round(errorOf(id) * 1000) / 1000];
}
// A product's census row (one the census can count, MarketDemand
// .hasCensusSource): the rate per hour the build read (MarketDemand.censusOf),
// to 3 decimals (a gear rate below .5/h still crosses), the bot's error on the item; 0 when none is counted or no census
// was published yet (it crosses on the first unit).
function censusWatchRow(id, errorOf) {
    if (!MarketDemand.hasCensusSource(id)) return null;
    return [id, Sections.CENSUS, Math.round((MarketDemand.censusOf(id) || 0) * 1000) / 1000, Math.round(errorOf(id) * 1000) / 1000];
}
// A crafter's one wake row (Sections.DEMANDED): the products its craft level
// makes that the census counts (MarketDemand.demandedCount), so a crafter
// built before a product had buyers rebuilds when one comes.
function censusWakeRows(state) {
    const level = CraftEligibility.craftLevelFor(state);
    return level > 0 ? [[level, Sections.DEMANDED, MarketDemand.demandedCount(level), 0]] : [];
}
// The decision's watch list, read by the soft point (DecisionSections
// .softEvents): the wish roots it would buy (their sell lines, storeType 1)
// and its sale rows (their buy lines, 3; a gear row whose crystal sale the bot may root also its crystal's buy lines),
// each [itemId, storeType, reference price, error], at most
// Sections.MARKET_WATCH. buyValue/sellValue: the
// build's price of an item on that side; errorOf: the bot's error on it.
// The reference is the better of that price and the board head the build
// saw (excluding the bot's own line): the head is one input of the price
// belief, so a far cheaper ask stays below the believed price after the
// rebuild and would cross at every step; the decision already weighed it.
// Only a newer, clearly better line crosses. wakeRows: the crafter's census
// wake row (censusWakeRows), after the wishes, sales and resale censuses,
// before the crystal rows.
// planOf: the build's plan of an item node (network.plans); a wish whose
// item buy waits for rival takers (its path's takers, WishProviders buyWait)
// adds its TAKERS row [itemId, Sections.TAKERS, free units, town code] right
// after its sell row, the waiter's one wake (Sections.softEvents).
function marketWatchRows(queue, sales, board, ownerId, buyValue, sellValue, errorOf, wakeRows = [], crystalOf = () => 0,
    planOf = () => null) {
    const rows = [], exclude = { excludeOwner: ownerId };
    const fits = (id, storeType) => rows.length < Sections.MARKET_WATCH && !rows.some(row => row[0] === id && row[1] === storeType);
    const add = (id, storeType, value) => {
        if (!fits(id, storeType)) return;
        const row = watchRow(board, exclude, id, storeType, value, errorOf);
        if (row) rows.push(row);
    };
    for (const wish of queue) {
        const id = Number(wish.object?.itemId);
        if (!(id > 0)) continue;
        add(id, SELL, buyValue(id));
        const takers = planOf(id)?.kind === 'buy' && planOf(id).takers;
        if (Array.isArray(takers) && takers[0] > 0 && takers[1] > 0 && fits(id, Sections.TAKERS))
            rows.push([id, Sections.TAKERS, takers[1], takers[0]]);
    }
    for (const [id] of sales) add(Number(id), BUY, sellValue(id));
    // A producer root sized by the census (a resale) watches it.
    for (const wish of queue) {
        const id = Number(wish.object?.itemId);
        if (wish.object?.kind !== 'resale' || !fits(id, Sections.CENSUS)) continue;
        const row = censusWatchRow(id, errorOf);
        if (row) rows.push(row);
    }
    for (const row of wakeRows) if (fits(row[0], row[1])) rows.push(row);
    // Last, so the cap drops them first: spare gear whose crystal sale this
    // bot may root (crystalOf, BotCrystallization.saleCrystal): a buy ad on
    // the crystal (new or higher) can make that root (WishProviders); a
    // crystal has no census (MarketDemand.hasCensusSource).
    for (const [id] of sales) {
        const crystal = crystalOf(Number(id));
        if (crystal) add(crystal, BUY, sellValue(crystal));
    }
    return rows;
}
// The crafter's indexed recipes at its craft level: the one producer source
// of both threads.
function defaultProducerSource(state, board) {
    const index = OccupationSources.recipeIndex(board);
    const level = CraftEligibility.craftLevelFor(state), scope = index.scopeFor(level);
    return { recipes: index.rowsFor(level), scope, revision: index.revision(scope) };
}
// The deps a full resolve made, with the state it was made for: a check
// inside the same build (heldBuildVerdict, its LEAF_CHECKS rows) is given
// the build's own deps and does not resolve them again (a second producer
// source read and onSourceScope call). An entry dies with its deps object.
const resolvedFor = new WeakMap();
// The shop owner's NPC lists on main: one reader for the process.
const mainNpcOffersFor = id => {
    const Sources = invoke('GameServer/Bot/Population/ColdOccupationSources'); // lazy: optional main-only shop reader
    Sources.initialise(); return Sources.npcOffersFor(id);
};
function resolved(state, deps, production = true) {
    if (state && resolvedFor.get(deps) === state) {
        if (Diagnostics.active()) Diagnostics.count('context', 'resolved', 'reused');
        return deps;
    }
    deps = { ...runtime, ...deps };
    deps.board = marketBoard(deps.board);
    if (typeof deps.spots === 'function') deps.spots = deps.spots();
    if (typeof deps.memory === 'function') deps.memory = deps.memory(state.characterId);
    if (typeof deps.memoryIdentity === 'function') deps.memoryIdentity = deps.memoryIdentity(state.characterId);
    if (typeof deps.sourceReady === 'function') deps.sourceReady = deps.sourceReady();
    // Stock, survival and own shot-use readers need only the hunt foundation.
    // Production sources and recipe books belong to the full wish review.
    if (production) {
        if (typeof deps.knownRecipes === 'function') deps.knownRecipes = deps.knownRecipes(state.characterId);
        if (!deps.producerSource && deps.board) deps.producerSource = defaultProducerSource;
        if (typeof deps.producerSource === 'function') {
            const source = deps.producerSource(state, deps.board);
            deps.producerRecipes = source?.recipes;
            deps.producerRevision = source?.revision;
            if (source?.scope != null) deps.onSourceScope?.(source.scope);
        }
        if (isMainThread && !Object.hasOwn(deps, 'workshops')) {
            const Workshops = invoke('GameServer/Bot/Economy/CraftWorkshopService');
            deps.workshops = Workshops.publicForRecipe;
        }
        if (isMainThread && !Object.hasOwn(deps, 'knownRecipes')) {
            const known = knownRecipesOf(state);
            if (known) deps.knownRecipes = known;
        }
        if (isMainThread && !Object.hasOwn(deps, 'memory')) {
            // The bot's memory rows for its gear threat, the
            // rows the worker's snapshot carries, read without the snapshot's copy.
            // lazy: worker the main memory owner; the worker passes its own reader.
            deps.memory = invoke('GameServer/Social/InteractionMemoryRuntime').relationRows(Number(state.characterId));
        }
        if (isMainThread && !Object.hasOwn(deps, 'buyOrderEscrow')) {
            // lazy: worker native market records live on main; workers receive their existing context mirror.
            deps.buyOrderEscrow = invoke('GameServer/Bot/Economy/BotAfkMarketService').buyOrderEscrow(state.characterId);
        }
        if (typeof deps.buyOrderEscrow === 'function') deps.buyOrderEscrow = deps.buyOrderEscrow(state.characterId);
    }
    if (!deps.spots && isMainThread) deps.spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure();
    if (!deps.npcOffersFor && isMainThread) deps.npcOffersFor = mainNpcOffersFor;
    if (production) resolvedFor.set(deps, state);
    return deps;
}
function personaOf(state, deps) {
    return deps.persona || invoke('GameServer/Bot/AI/BotPersona').of(state) || { traits: {}, understanding: 0.3 };
}
// The build's price reader is the bot's one reader (PriceBelief.reader); the
// build adds its knowledge switch and its read hook.
function pricing(state, persona, board, timestamp, deps, read = () => {}, prices = new Map()) {
    const knowledgeEnabled = deps.knowledgeEnabled ?? Knowledge.knowledgeEnabled();
    return { knowledgeEnabled, ...PriceBelief.reader({ state, persona, board, timestamp, knowledgeEnabled, read }, prices) };
}
// Price future carried scroll uses only if a review needs extra stock.
// Resolve the known hunt through the existing catalogue index; a merchant
// location during a town visit is never a future hunting origin.
// Below karma that closes towns the saving reads only the origin, the static
// town and gatekeeper tables and the travel mode (ColdTrip.honest), so a hunt
// spot's answer is kept on its catalogue object per travel mode: the two
// route solves run once per spot, not in every build.
const spotScrollHours = new WeakMap();
function scrollHoursFor(state, spots, bestSpotId) {
    if (invoke('GameServer/Karma').closesTowns(state.stats?.karma)) return 0;
    const spot = SpotIndex.spotById(spots, bestSpotId);
    if (!spot?.center) return scrollSavingHours(state, state.stats?.marketReturn?.loc || (state.activity === 'hunting' ? state.loc : null));
    const honest = ColdTrip.honest();
    const held = spotScrollHours.get(spot);
    if (held?.honest === honest) return held.hours;
    const hours = scrollSavingHours(state, spot.center);
    spotScrollHours.set(spot, { honest, hours });
    return hours;
}
function scrollSavingHours(state, origin) {
    if (!origin || ![origin.locX, origin.locY, origin.locZ].every(Number.isFinite)
        || origin.locX === 0 && origin.locY === 0) return 0;
    const destination = TravelRoutes.landingTown(origin);
    const routeState = { ...state, loc: origin, inventory: { 736: { amount: 0 } } };
    const walking = ColdTrip.townPlan(routeState, destination);
    const recall = ColdTrip.townPlan({ ...routeState, inventory: { 736: { amount: 1 } } }, destination);
    return walking && recall && recall.scroll ? Math.max(0, walking.durationMs - recall.durationMs) / 3600000 : 0;
}
// stock(kind) and kitCost(id) over the kit data of one review: the build and
// every later view of its plan answer from the same numbers. Prices go
// through the caller's price reader, so each read joins the review's inputs.
// potionRestHours(): the hours per hour the potions' heal saves in rest
// (potionRest), read only where a potion's worth is (benefitPerUnit), kept on
// the kit data.
function kitReader(data, price, scrollUseHours, potionRestHours) {
    const stock = kind => {
        if (kind === 'scrolls') {
            const current = data.scrolls,
                target = invoke('GameServer/Bot/Travel/ScrollStock').TARGET_AMOUNT, survivalTarget = 1;
            const missing = Math.max(0, target - Math.max(current, survivalTarget));
            const benefitPerUnit = current < target ? scrollUseHours() : 0;
            return { itemId: 736, usePerHour: 0, current, hours: Infinity, targetHours: data.targetHours, target,
                survivalTarget, survivalMissing: Math.max(0, survivalTarget - current), missing,
                unitPrice: price(736), benefitPerUnit, benefitHours: missing * benefitPerUnit, needed: current < target };
        }
        const shots = kind === 'shots';
        const row = shots ? data.shots : data.potions;
        const { itemId, use, current } = row;
        const wantedTarget = Math.max(Math.ceil(use), Math.ceil(use * data.targetHours));
        // Useful owned stock need not justify expensive replacement stock.
        const target = row.canRestock ? wantedTarget : Math.min(current, wantedTarget);
        // Forecast consumption may be fractional; both purchase tranches use
        // the same whole-unit survival stock so their sum remains executable.
        const survivalTarget = row.canRestock ? Math.ceil(use) : Math.min(current, Math.ceil(use));
        const survivalMissing = Math.max(0, survivalTarget - current);
        const missing = Math.max(0, target - Math.max(current, survivalTarget));
        const benefitPerUnit = () => use > 0
            ? (row.benefit + (shots ? 0 : row.restBenefit ??= potionRestHours())) / use : 0;
        return { itemId: Number(itemId), usePerHour: use, ...(shots ? { canRestock: row.canRestock, ownedUsePerHour: row.ownedUsePerHour, beginnerCurrent: row.beginnerCurrent,
                beginnerUsePerHour: row.beginnerUsePerHour, paidUsePerHour: row.paidUsePerHour } : {}),
            current, hours: use > 0 ? current / use : Infinity,
            targetHours: data.targetHours, target, survivalTarget, missing, survivalMissing, unitPrice: price(itemId),
            get benefitPerUnit() { return benefitPerUnit(); }, get benefitHours() { return missing * benefitPerUnit(); },
            needed: use > 0 && current < survivalTarget };
    };
    const kit = [stock('shots'), stock('potions')];
    const escapeCost = data.closed ? 0 : price(736) * Math.max(0, 1 - data.scrolls);
    // A known executable quote pays whole missing units once. The personal
    // price estimate still values an unseen option; it must not underfund
    // a concrete merchant's mandatory stock and trigger repeated tiny fills.
    const kitCost = (id, unitPrice = null) => {
        const quoted = Number.isFinite(unitPrice) && unitPrice > 0;
        if (Number(id) === 736 && data.closed) return 0;
        if (Number(id) === 736) return quoted ? unitPrice * Math.max(0, 1 - data.scrolls) : escapeCost;
        return kit.filter(row => row.itemId === Number(id)).reduce((sum, row) => sum
            + row.survivalMissing
                * (quoted ? unitPrice : row.unitPrice), 0);
    };
    return { stock, kitCost, kit, escapeCost };
}
// The bot's own fit for the spot of its hunting leaf (docs/architecture.md §2
// route): the route's one test, BotRoute.leafFitReader, as a yes or no per
// spot. Only in a worker build (the worker owns the leaf and its planning
// catalog; main's basics keep the table's pick, it reads them only for
// execution caps), for a solo bot (a party hunts its party's route; mode:
// the build's, as select reads it), with a catalog. The reader and its
// verdicts are kept per state object, catalog and timestamp (the frame and
// matchup profiles read only those): the basics and the build of one step
// share them. An entry dies with its state object.
const leafFits = new WeakMap();
function leafFit(state, deps, timestamp) {
    if (isMainThread || !Array.isArray(deps.spots) || !deps.spots.length
        || ['party', 'duo'].includes(deps.mode) || LevelingRoutes.modeForState(state) !== 'solo') return null;
    const kept = leafFits.get(state);
    if (kept && kept.spots === deps.spots && kept.timestamp === timestamp) return kept.fits;
    // lazy: cycle BotRoute > SpotProfiles > BotLifeState > DecisionEvents > EconomyContext
    const verdict = invoke('GameServer/Bot/Population/BotRoute').leafFitReader(state, { spots: deps.spots, timestamp });
    const verdicts = new Map();
    const fits = spotId => {
        const key = String(spotId);
        let fit = verdicts.get(key);
        if (fit === undefined) verdicts.set(key, fit = verdict(spotId) === 'fit');
        return fit;
    };
    leafFits.set(state, { spots: deps.spots, timestamp, fits });
    return fits;
}
// The bot's hour, death and karma prices and its stock of shots and potions:
// the part of a review that needs no wish network. forState builds on it and
// basics() returns it alone, so a reader that wants only these never builds
// the network, and both give the same numbers.
// keepRoute receives the income route search's result (forState reads its
// matchup profiles).
function foundation(state, deps, persona, timestamp, price, keepRoute = null) {
    const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
    const Table = invoke('GameServer/Bot/AI/SpotValueTable');
    const tableRole = Roles.tableRoleFor(state);
    const incomeRoute = IncomeRoute.select(state, { ...deps, timestamp, required: GearProgression.assess(state).milestone.required, price });
    keepRoute?.(incomeRoute);
    let hunt;
    if (incomeRoute) {
        // select already passed this spot through the same ground and matchup reader.
        const row = incomeRoute.row;
        hunt = { perHour: row.income * Hunt.onSpotShare(state),
            expPerHour: row.exp * Hunt.onSpotShare(state), source: 'route', spotId: incomeRoute.spot.id,
            progressSpotId: incomeRoute.spot.id, useShots: row.useShots };
    } else hunt = Hunt.huntIncome(state, timestamp, deps.mode, leafFit(state, deps, timestamp));
    const lostGearHours = hunt.perHour > 0 ? Valuation.pkDropValue(state, price) / hunt.perHour : 0;
    const bestSpotId = hunt.spotId || state.spotId;
    const walkBackHours = WalkBack.hours(bestSpotId, state, deps.spots || SpotService.spots);
    const deathHours = Valuation.deathHours(state, { ...hunt, lostGearHours, walkBackHours });
    const spotTable = bestSpotId ? Table.value(bestSpotId, tableRole, state.level, hunt.useShots !== false) : null;
    const bestTable = spotTable || Table.best(tableRole, state.level, hunt.useShots !== false);
    const ShotStock = invoke('GameServer/Inventory/ShotStock');
    const shotPlan = ShotStock.planForState(state);
    const shotItemId = shotPlan.selfId;
    const potionItemId = HealingPotionStock.purchasePotionFor(state).selfId;
    const withoutShots = bestSpotId ? Table.value(bestSpotId, tableRole, state.level, false) : null;
    const shotPolicy = ShotStock.usePolicy(state, { plan: shotPlan, bestTable, withoutShots,
        hourAdena: Hunt.huntHour(hunt, state), unitPrice: price(shotItemId) });
    const shotBenefit = shotPolicy.benefit;
    const beginnerCurrent = ShotStock.beginnerAmount(state, shotPlan);
    const shotUse = positive(state.inventory?.[shotItemId]?.amount) + beginnerCurrent > 0
        ? shotPolicy.usePerHour : shotPolicy.purchaseUsePerHour;
    const potionUse = positive(bestTable?.potions);
    let bagHours = 2;
    const hasBagForecast = spotTable?.stacks !== null && spotTable?.stacks !== undefined;
    if (hasBagForecast) {
        const Data = DataCache;
        const race = state.stats?.race ?? (Data.classTemplates == null ? undefined : ClassProgression.firstClassRow(Data.classTemplates, state.stats?.classId || 0))?.template?.race;
        // ARCH-NOTE: size the E9 bag interval on the bag after its
        // planned kit stacks exist. Otherwise an empty shot/potion row uses
        // no slot, its refill uses one, and the shorter interval immediately
        // sells part of that refill back to the NPC. Existing stacks retain
        // the exact physical free-slot formula; zero-use stock reserves none.
        const plannedSlots = Number(shotUse > 0 && !positive(state.inventory?.[shotItemId]?.amount) && !beginnerCurrent)
            + Number(potionUse > 0 && !positive(state.inventory?.[potionItemId]?.amount));
        let slotLimit = Floor.inventoryLimit(race);
        const saleLimit = ItemDisposition.soloSaleSlotLimit(state, timestamp);
        if (saleLimit !== null) {
            // Stock cannot be its own reason for an earlier town visit. Keep
            // the entire usable kit while checking known free saleable loot.
            const keptAmounts = { [shotItemId]: positive(state.inventory?.[shotItemId]?.amount),
                ...HealingPotionStock.keptAmounts(state, { targetAmount: Infinity }),
                736: positive(state.inventory?.[736]?.amount) };
            // A sale's reserves (keptTargets), else the focus part: inside a
            // build the network splits held stock itself (heldAmounts).
            if (ItemDisposition.saleCandidates(state, { keptAmounts,
                preparedReservations: deps.saleReservations || ItemDisposition.reservedEquipmentAmounts(state),
                presenceOnly: true })) slotLimit = Math.min(slotLimit, saleLimit);
        }
        const free = Math.max(0, slotLimit - Floor.stateInventory(state, Data.items).slots - plannedSlots);
        bagHours = free === 0 ? 0 : spotTable.stacks > 0 ? free / spotTable.stacks : 24;
    }
    const Visits = invoke('GameServer/Bot/Economy/TownVisitInterval');
    // Bag space bounds a planned outing; it never chooses its duration.
    // Keep the existing initial estimate until actual town visits teach one.
    const targetHours = hasBagForecast
        ? Math.min(Visits.targetHours(state.stats), Visits.targetHours({}, bagHours))
        : Visits.targetHours(state.stats);
    // The kit as data (perf C1): what stock() and kitCost() read, so a kept
    // plan answers them later without this build scope.
    const kitData = { targetHours, scrolls: positive(state.inventory?.[736]?.amount),
        closed: invoke('GameServer/Karma').closesTowns(state.stats?.karma), scrollHours: undefined,
        shots: { itemId: shotItemId, use: shotUse, current: positive(state.inventory?.[shotItemId]?.amount) + beginnerCurrent,
            canRestock: shotPolicy.purchaseUsePerHour > 0, benefit: shotBenefit, ownedUsePerHour: shotPolicy.usePerHour,
            beginnerCurrent, beginnerUsePerHour: shotPolicy.beginnerUsePerHour, paidUsePerHour: shotPolicy.paidUsePerHour },
        potions: { itemId: potionItemId, use: potionUse, current: positive(state.inventory?.[potionItemId]?.amount),
            canRestock: true, benefit: positive(bestTable?.deaths) * deathHours } };
    const { stock, kitCost, kit, escapeCost } = kitReader(kitData, price,
        () => kitData.scrollHours ??= scrollHoursFor(state, deps.spots, bestSpotId),
        () => potionRest(state, { hunt, hourAdena: Hunt.huntHour(hunt, state), deathHours, gearThreatMask: deps.gearThreatMask },
            timestamp));
    const reserve = escapeCost + kit.reduce((sum, row) => sum + row.survivalMissing * row.unitPrice, 0);
    return { tableRole, hunt, hourAdena: Hunt.huntHour(hunt, state), survivalReserve: reserve, kitCost, kit: kitData,
        lostGearHours, bestSpotId, deathHours, bestTable, stock,
        riskWeight: Valuation.riskWeight(state, persona),
        expectedDeathHours: positive(bestTable?.deaths) * deathHours,
        karmaHours: Valuation.karmaHours(state, { ...hunt, lostGearHours, deathsPerHour: positive(bestTable?.deaths) }) };
}
// A potion's worth beside the deaths it averts (the kit's potions benefit):
// the rest its heal saves (HuntCycle potionGain, ctx its reader's).
function potionRest(state, ctx, timestamp) {
    return HuntCycle.reader(state, ctx).potionGain(CombatProfile.profileFor(state, timestamp),
        positive(HealingPotionStock.purchasePotionFor(state).heal));
}
function foundationFromPlan(state, plan, deps, price) {
    const { stock, kitCost } = kitReader(plan.kit, price,
        () => plan.kit.scrollHours ??= scrollHoursFor(state, deps.spots, plan.bestSpotId),
        () => potionRest(state, plan, plan.timestamp));
    return { hunt: plan.hunt, hourAdena: plan.hourAdena, survivalReserve: plan.survivalReserve,
        kit: plan.kit, stock, kitCost, lostGearHours: plan.lostGearHours, bestSpotId: plan.bestSpotId,
        deathHours: plan.deathHours, riskWeight: plan.riskWeight,
        expectedDeathHours: plan.expectedDeathHours, karmaHours: plan.karmaHours };
}
// What basics and heldBasics read alike: the deps of the hunt foundation, the
// step clock, the persona and a price reader over prices (a held build's own,
// else none yet).
function basicsInputs(state, deps, prices) {
    deps = resolved(state, deps, false);
    const timestamp = Number(deps.timestamp || Date.now());
    const persona = personaOf(state, deps);
    const { price } = pricing(state, persona, deps.board || null, timestamp, deps, undefined, prices);
    return { deps, timestamp, persona, price };
}
function basics(state = {}, deps = {}) {
    const { deps: own, timestamp, persona, price } = basicsInputs(state, deps, new Map());
    return { persona, price, timestamp, ...foundation(state, own, persona, timestamp, price) };
}
// A served card's basics: the foundation of the held build the card was made
// from (the same event proof object, so every value it holds is guarded as the
// card is: refusal ''), at the step clock; null when the held build is another
// (evicted, rebuilt, restored) and the caller builds them.
function heldBasics(state = {}, deps = {}, proof = null) {
    const held = proof ? cache.get(actorKeyOf(state, deps)) : null;
    if (!held || held.plan.eventProof !== proof) return null;
    const { deps: own, timestamp, persona, price } = basicsInputs(state, deps, new Map(held.plan.prices));
    return { persona, price, timestamp, ...foundationFromPlan(state, held.plan, own, price) };
}
function stockFor(state, kind, deps = {}) { return basics(state, deps).stock(kind); }
// The bot's held build's key (cache) and its group's.
const actorKeyOf = (state, deps) => deps.actorKey || `character:${Number(state.characterId || 0)}`;
// What the bot's held build wants of an item now: its watch row (the rows
// its buy ads publish, TradeIntent.project), null when the build no longer
// lists the item, undefined when there is no held build to read (evicted,
// restarted, intents pending) or it is older than the certificate it would
// judge (built on a revision before since: a later build published the
// ad). A read of the entry: no verdict, no build.
// A later step that serves the held build and republishes the ad stamps a
// newer revision than the build's, so the build is skipped too: the safe
// side, as the certificate it skips is that same build's row.
function heldWatch(state, selfId, since = 0) {
    const plan = heldPlanSince(state, since);
    if (!plan || plan.intentPending || !Array.isArray(plan.watchList)) return undefined;
    return plan.watchList.find(row => Number(row.itemId) === Number(selfId)) || null;
}
// The survival kit cost of an item at a quoted unit price as the same held
// build counts it (its kit, kitReader), undefined when heldWatch would not
// read the build: the caller then builds the basics. A quoted kitCost reads
// no price, so the reader's price is never asked.
function heldKitCost(state, selfId, unitPrice, since = 0) {
    const plan = heldPlanSince(state, since);
    if (!plan?.kit || !(unitPrice > 0)) return undefined;
    return kitReader(plan.kit, () => 0, () => 0, () => 0).kitCost(selfId, unitPrice);
}
function heldPlanSince(state, since) {
    const held = cache.get(actorKeyOf(state, {})), plan = held?.plan;
    return plan && !plan.pending && held.revision >= since ? plan : null;
}
// What the verdict on the held build compares against its own entry.
function heldOptionsOf(held, state) {
    return { baseline: held?.plan.statsPacket.wishSections, activity: held?.activity,
        leaf: held?.plan.network?.activity, heldUnits: held?.heldUnits, craftReservations: held?.craftReservations,
        mp: held?.mp, input: held?.input, dirty: raisedSince(state, held), money: heldMoney(state, held) };
}
// The money packet the held build priced with, read by its funding mark
// (heldEventsQuiet; design-rules Recompute: own outputs are not inputs): its
// own while the state still carries the packet the build read (not written
// back: a later build of the same step, a refresh), else the state's
// (written back, or moved since: a purchase, another build's). The first
// state off the read packet drops it (MONEY_MOVED: the old packet is not kept
// alive until the next build); a later return to it reads the state's, the
// safe side (a refusal asks a build).
const MONEY_MOVED = Symbol('moneyMoved');
function heldMoney(state, held) {
    const packet = state.stats?.money, read = held?.inputMoney;
    if (!held || read === MONEY_MOVED) return packet;
    if (packet !== read && !(Array.isArray(packet) && Array.isArray(read) && packet.length === read.length
        && packet.every((value, at) => value === read[at]))) {
        held.inputMoney = MONEY_MOVED;
        return packet;
    }
    return held.plan.statsPacket.money;
}
// The raised bits (wishDirty) the held build has not consumed. A build whose
// packet is not written back (a refresh: its plan goes to main, the state
// keeps its bits) is kept with the raise it consumed (held.input[0], the
// sequence, and held.raised, the bits it was built on); while the sequence holds (every
// raise bumps it) those bits are its own input, not news. A held build with
// an unknown workshop or no ask record (a near build: its seq may meet one
// main raised on its own copy) forgives none: the next build asks. A written
// build's packet cleared the bits, so its record is inert. Only the verdict
// and the rebuild mask read it; a reader that compares with the accepted
// decision (the reconsider mask, the carried baseline, the kept route) reads
// every raised bit: that decision is older than the raise.
function raisedSince(state, held) {
    const dirty = Number(state.stats?.wishDirty) || 0;
    return held?.input && held.input[0] === Number(state.stats?.decisionSeq || 0) && held.plan.workshopAsked
        && held.plan.workshop?.known !== false ? dirty & ~held.raised : dirty;
}
// What a build and its verdict read beside the held entry: the gear threat,
// the facts, read once (the held leaf's own trip is read as the field
// activity it ordered, fieldActivity), and the build's input name.
function heldReadsOf(state, deps, held) {
    const gearThreat = GearThreat.prepare(state, deps, held?.gearThreat);
    const current = fieldActivity(state, held?.activity, held?.plan.network?.activity);
    const facts = requestFacts(current, deps);
    return { gearThreat, current, facts, key: inputName(facts, gearThreat.mask) };
}
// The one verdict on the held build (heldBuildVerdict), collecting: the
// sections of all its refusals, no held build or an unproved one = every
// section. Over resolved deps, which it completes with the route rows and
// the gear-threat mask the build reads. handed: the step's collected
// verdict, served when it judged this entry on the same inputs
// (handedVerdict), else null and the verdict is computed here; the step's
// own verdict also hands its reads, made on the same state and deps. Read
// by the build (forState) and, before it, by the worker step's workshop
// (heldWorkshop).
function heldVerdictFor(state, deps) {
    if (typeof deps.routeRows === 'function') deps.routeRows = deps.routeRows(state);
    const held = cache.get(actorKeyOf(state, deps));
    // A valid completed card survives planner-slot reuse or card eviction;
    // the same route is repriced with the current hour value, never a wallet.
    if (!deps.routeRows && held?.plan.routeKey === Trip.key(state)) deps.routeRows = held.plan.routeRows;
    // A build never waits for its route. In the background thread a caller
    // whose own route preparation was refused (occupationFor mode wish at its
    // 64-request cap: the party goal query, the post-round economy ask, the
    // gear step) gets it here, in the same call. Main builds with an unknown
    // route instead (Die, GearPlanSelection, HealingPotionStock, ScrollStock,
    // ShotStock: no route request from main).
    if (!isMainThread && !deps.tripCost && !Trip.fullRows(deps.routeRows)) {
        deps.routeRows = Trip.prepared(state);
        // Read live: a high share against context builds says the 64-request
        // cap refuses too often.
        if (Diagnostics.active()) Diagnostics.count('context', 'route', 'inline');
    }
    const collected = deps.eventVerdict?.collected;
    const handed = handedVerdict(collected, state, held, deps);
    const reads = handed && collected.reads || heldReadsOf(state, deps, held);
    deps.gearThreatMask = reads.gearThreat.mask;
    const verdict = handed || heldBuildVerdict(state, held?.plan.eventProof, deps,
        { ...heldOptionsOf(held, state), facts: reads.facts, collect: true });
    return { held, reads, verdict, handed };
}
// The cause of a held build's first refusal (the rebuild table's
// refused:<reason>:<cause>; forState asks it with diagnostics on), '' for a
// reason with none. unproved: what the verdict could not read (missing: no proof);
// wish_dirty: the sections raised since the held build (its first refusal's
// bits); sections: the facts that moved (heldBuildVerdict). decision_seq has
// none: the held build's own bump is no refusal (decisionMove), so a moved
// sequence is always another build's written packet or a raise with no bits.
function refusalCause(verdict) {
    switch (verdict.reason) {
        case 'unproved': return verdict.cause || 'other';
        case 'wish_dirty': return causeNames(Sections.sectionNames(verdict.firstSections));
        case 'sections': return verdict.cause || 'other';
        default: return '';
    }
}
// The sections a build rebuilds (forState's mask): the bits raised since the
// held build (raisedSince), the prepared card's verdict (cardVerdict, its
// first refusal) and the held build's own verdict (heldVerdict, collected).
function verdictMask(state, cardVerdict, heldVerdict, held) {
    return raisedSince(state, held) | (Number(cardVerdict?.touchedSections) || 0)
        | (Number(heldVerdict?.touchedSections) || 0);
}
function forState(state = {}, deps = {}) {
    const diagnostic = Diagnostics.active();
    const inputSequence = Number(state.stats?.decisionSeq || 0);
    if (diagnostic) Diagnostics.count('context', 'request');
    deps = resolved(state, deps);
    const timestamp = Number(deps.timestamp || Date.now());
    const actorKey = actorKeyOf(state, deps);
    const sourceBoard = marketBoard(deps.board);
    const { held, reads, verdict: eventVerdict, handed } = heldVerdictFor(state, deps);
    const { gearThreat, current, facts, key } = reads;
    // Read once: the hand-off ends here, served or not.
    if (deps.eventVerdict?.collected) deps.eventVerdict.collected = null;
    if (diagnostic && handed) Diagnostics.count('context', 'held_verdict', 'reused');
    // A valid held build is served. A caller that needs the member's graph
    // nodes (a worker group solve) builds unless the held entry kept them
    // (the main thread keeps them, the worker a party member's).
    const served = eventVerdict.valid && !(deps.withNodes && !held.projection);
    // A refresh's kept build read by the next build: served, or why not.
    if (diagnostic && held?.caller === 'economy_refresh') {
        Diagnostics.count('context', 'kept_refresh', served ? 'hit' : eventVerdict.reason || 'nodes');
    }
    const buildEntry = rebuildEntry(deps.caller, deps.trigger);
    if (served) {
        countRebuild(buildEntry, 'served');
        if (deps.onSourceRead) for (const id of held.readIds) deps.onSourceRead(id);
        if (diagnostic) {
            Diagnostics.count('context', 'hit', held.key === key ? 'same_inputs' : 'own_result');
            // The timeline sees the served request too (tools/timeline).
            if (Diagnostics.enabled(state.characterId)) Diagnostics.push({ owner: state.characterId,
                caller: deps.caller || 'economy_context', trigger: deps.trigger || 'request', phase: 'wish_context',
                reason: held.key === key ? 'hit_same_inputs' : 'hit_own_result', outcome: 'held',
                revision: state.simulation?.revision, wallet: positive(state.adena) });
        }
        if (deps.rememberContext !== false) {
            held.gearThreat = gearThreat;
            held.stateRef = new WeakRef(state);
            // Its last keeper: kept_refresh counts only a refresh's own build.
            held.caller = deps.caller || 'economy_context';
            remember(cache, actorKey, held, RETAIN_LIMIT);
        }
        // A late price read of a held plan is reported as in its build.
        const late = id => deps.onSourceRead?.(Number(id));
        return view(state, held.plan, deps, { board: sourceBoard, read: late, projection: held.projection });
    }
    // The mask: the sections that moved since the held build (the raised
    // bits, the prepared card's verdict, this verdict's refusals). A computed
    // piece (Sections.COMPUTED) is rebuilt when one of its sections is in it,
    // else reused from the held build.
    const mask = verdictMask(state, deps.eventVerdict, eventVerdict, held);
    // The foundation is reused with the prices and the horizon it was priced with.
    // Reads no section names, reused with it: the persona and the town-visit
    // rhythm. The source walk is walked anew on every build.
    const keptBase = held && !(mask & Sections.COMPUTED.foundation) ? held.plan : null;
    // The source walk's per-spot ground verdict: its own section rule
    // (GearAcquisitionPlanner.sourceGround).
    const keptGround = !(mask & Sections.COMPUTED.sourceGround) ? held?.sourceGround || null : null;
    const started = performance.now();
    // The build's cause, one of a few names (its duration layer). An
    // input-name mismatch is named as a dependency change; it does not claim
    // which historical event caused it.
    const missReason = !held ? deps.rememberContext === false ? 'unkept_caller' : 'not_retained'
        : held.key !== key ? 'input_dependency_changed'
        : !eventVerdict.valid ? 'held_refused' : 'nodes_needed';
    const diagnosticReason = diagnostic ? missReason : null;
    // The rebuild table's row: a refusal by its first reason and, with
    // diagnostics on, its cause (refusalCause).
    const cause = diagnosticReason === 'held_refused' ? refusalCause(eventVerdict) : '';
    const refusal = cause ? `${eventVerdict.reason}:${cause}` : eventVerdict.reason || 'none';
    const rebuildReason = missReason === 'held_refused' ? `refused:${refusal}` : missReason;
    if (diagnostic) Diagnostics.count('context', 'miss', diagnosticReason);
    // A held refusal split by the verdict's first reason and by whether the
    // caller keeps the build: it picks which refusal to make cheaper. Only
    // the unproved cause splits it (a bounded set; the key table is shared).
    if (diagnosticReason === 'held_refused') {
        Diagnostics.count('context', deps.rememberContext === false ? 'held_refusal_unkept' : 'held_refusal',
            eventVerdict.reason === 'unproved' ? refusal : eventVerdict.reason || 'none');
    }
    let elapsed = 0;
    // The items the review read, each reported once (deps.onSourceRead, the
    // occupation planner's dependencies) and kept with the held entry
    // (held.readIds) so that a hit reports them again. No token: the market
    // is heard at the soft point through the watch list.
    let readIds = new Set();
    let building = true;
    // MVP-6 Bounds: while a gear candidate's arena is built its reads wait
    // in its own scope; the provider keeps the scopes whose descriptors
    // survive the final cut, so a rejected candidate's items never become
    // inputs of the review.
    let scope = null;
    const nodeScopes = [];
    const read = id => { id = Number(id);
        if (!(id > 0)) return;
        // Every open node scope notes the id once (an id the innermost holds,
        // every outer one holds too): a memoized node reports it again.
        const top = nodeScopes[nodeScopes.length - 1];
        if (top && !top.items.has(id)) for (const local of nodeScopes) local.items.add(id);
        // After the build (a late read through its view) nothing is kept.
        if (!readIds) { deps.onSourceRead?.(id); return; }
        if (readIds.has(id)) return;
        if (scope) { scope.add(id); return; }
        readIds.add(id); deps.onSourceRead?.(id);
    };
    const watch = id => { if (building) read(id); };
    const persona = personaOf(state, deps);
    const cash = Sections.bounds(positive(state.adena));
    const budget = Sections.bounds(Funding.budget(state, deps.buyOrderEscrow));
    const board = watchedBoard(sourceBoard, watch);
    // A price is remembered, so every price read counts, also a late one
    // through context.price: its item joins the review's inputs.
    const { price, fromShared, soldPrice, prices, beliefs, beliefFor, knowledgeEnabled } = pricing(state, persona, board, timestamp, deps, read,
        keptBase ? new Map(keptBase.prices) : new Map());
    // The income route of this build's own search: its solo matchup profiles
    // serve the providers' source route reader.
    let incomeRoute = null;
    const base = keptBase ? foundationFromPlan(state, keptBase, deps, price)
        : foundation(state, deps, persona, timestamp, price, route => { incomeRoute = route; });
    // These facts still belong to the reused foundation: its items stay read.
    if (keptBase) for (const id of held.readIds) read(id);
    const quantityInputs = createQuantityInputs();
    const committedKeys = Providers.committedOf(state);
    const context = { inputKey: key, actorKey, state, timestamp, gearThreatMask: gearThreat.mask, persona, board, hunt: base.hunt, price, fromShared, soldPrice, buyback,
        quantityInputs,
        // The committed goals (focus, preempted rows; WishProviders.committedOf)
        // every goal source keeps past its cap, and the gear nomination's
        // basis (the equipment plan's target, the committed gear items),
        // read once per build.
        committedKeys, nominationBasis: Providers.nominationBasis(state, committedKeys),
        ...(keptBase ? { horizonHours: keptBase.horizonHours } : {}),
        riskWeight: base.riskWeight, bestSpotId: base.bestSpotId, deathHours: base.deathHours, lostGearHours: base.lostGearHours,
        karmaHours: base.karmaHours, expectedDeathHours: base.expectedDeathHours, stock: base.stock,
        survivalReserve: base.survivalReserve, kitCost: base.kitCost, hourAdena: base.hourAdena,
        walletBoundary: cash.watch,
        budgetBoundary: budget.watch,
        // The item ids a source node read in this build, so that a node
        // reused within the build reports them again (deps.onSourceRead).
        nodeInputs: { begin: () => { const local = { items: new Set() }; nodeScopes.push(local); return local; },
            end: () => nodeScopes.pop(),
            keep: input => { input.items?.forEach(read); } },
        readScope: { open: () => (scope = new Set()), close: () => { scope = null; },
            keep: kept => { kept.forEach(read); } },
        // The board's watch, for a reader that serves an answer of a board
        // read again within the build (WishPurchaseEvidence): its item is
        // read again, as by the board.
        watch };
    // A worker build given no workshop keeps the held build's (keptWorkshop).
    const workshop = Object.hasOwn(deps, 'workshop') ? deps.workshop : isMainThread ? null
        : keptWorkshop(held, mask, state);
    // The held build's own workshop (heldWorkshop, keptWorkshop) carries the
    // record of its ask; any other is a fresh answer, recorded below.
    const keptAsk = workshop && workshop === held?.plan.workshop ? held.plan.workshopAsked || null : null;
    context.workshop = workshop || { recipeId: 0, productId: 0, incomePerHour: NaN, cycleHours: NaN };
    context.routeKey = Trip.key(state); context.routeRows = Trip.fullRows(deps.routeRows) ? deps.routeRows : null;
    const tripHour = context.hourAdena;
    context.trip = deps.tripCost || Trip.preparedReader(context.routeRows || [], { hourAdena: tripHour });
    context.spotValue = SpotEconomics.create(state, { ...deps, timestamp, persona, price, deathHours: context.deathHours,
        hunt: buildHunt(base.hunt) });
    if (state.incomingPending) {
        // ARCH-NOTE: an oversized incoming projection waits on the existing
        // settlement/preparation owner. Never replace unknown stock with zero
        // demand or renew the decision seed while that input is unavailable.
        context.network = { inputKey: key, queue: [], activity: null, plans: new Map(), demands: new Map(),
            focus: state.stats?.wishFocus || null, dormant: state.stats?.dormantWishes || [],
            moneyPrice: positive(state.stats?.money?.[1]), hourAdena: context.hourAdena, available: 0,
            decisionSeq: state.stats?.decisionSeq || 0, activityLeaf: state.stats?.activityLeaf || 0 };
        context.moneyPrice = context.network.moneyPrice; context.gapHorizonHours = 0;
        context.watchList = []; context.intentPending = true;
        context.itemUsefulness = () => 0; context.worth = price; context.purchaseBudget = () => 0;
        context.statsPacket = { wishFocus: context.network.focus, dormantWishes: context.network.dormant,
            decisionSeq: context.network.decisionSeq, activityLeaf: context.network.activityLeaf,
            money: state.stats?.money || [0, 0, base.survivalReserve, 0], stockTargets: state.stats?.stockTargets || stockTargets(base) };
        readIds = null;
        countRebuild(buildEntry, 'incoming_pending', performance.now() - started);
        return view(state, planOf(context, base, { key, tripHour, prices }), deps, { price, soldPrice, kit: base, board, read, spotValue: context.spotValue, trip: context.trip });
    }
    // One stock reader for the provider's gear witnesses, the root cut's
    // solves and the network build: a stock root's item comes from its owner
    // (the kit's stock(kind), the item the provider roots), so every phase,
    // before the projection exists too, reads one owned count.
    context.wallet = Funding.budget(state, deps.buyOrderEscrow);
    const stockRootItem = rootKey => context.stock(rootKey.slice('stock:'.length))?.itemId;
    const nativeStock = stockReader(state, stockRootItem);
    // prior, requested (the allocation's reading, WishNetwork solve): where
    // its answer flips on the owned count o, the incoming i exact: free stock
    // (o >= prior + 1), all owned (o >= prior + requested), nothing to order
    // (o >= prior + requested - i) and, with incoming, the incoming kept
    // (o >= prior - i + 1) and its shrinking (o >= prior). Any other read
    // (a crystallize batch, a gear witness) notes none: untracked.
    // A read whose answer is the same for every root is one proof row of
    // the item (fact '', WishNetwork createQuantityInputs).
    context.stockFor = (id, rootKey, prior, requested) => {
        const stock = quantityInputs.stock(id, rootKey, nativeStock(id, rootKey), nativeStock.rootFact(id, rootKey));
        if (requested === undefined) { quantityInputs.untracked('stock', id, rootKey); return stock; }
        const incoming = positive(stock?.incoming);
        quantityInputs.atLeast('stock', id, prior + 1, rootKey); quantityInputs.atLeast('stock', id, prior + requested, rootKey);
        if (incoming > 0) {
            quantityInputs.atLeast('stock', id, prior + requested - incoming, rootKey);
            quantityInputs.atLeast('stock', id, prior - incoming + 1, rootKey); quantityInputs.atLeast('stock', id, prior, rootKey);
        }
        return stock;
    };
    context.completionKey = Crystallization.completionKey(state, quantityInputs);
    if (diagnostic) {
        Diagnostics.count('context', 'caller', deps.caller || 'economy_context');
        Diagnostics.count('context', 'foundation', keptBase ? 'kept' : 'built');
    }
    const projection = Providers.build(state, context, { ...deps, sourceGround: keptGround,
        soloProfiles: incomeRoute?.matchupProfiles });
    context.projection = projection;
    const networkKey = key;
    const choiceBands = quantityBands(state, context, projection);
    // The readers below compare with the accepted decision (the state's
    // packet), older than every raised bit, also one a kept refresh build
    // consumed (raisedSince forgives it to the verdict and the mask only).
    const raised = Number(state.stats?.wishDirty) || 0;
    // Unused free loot is compared with the last decision's own value/error:
    // with no section moved the accepted bag value stays.
    const bagValue = choiceBagValue(state, choiceBands, context.buyback);
    const acceptedSections = state.stats?.wishSections;
    context.choiceBagValue = (mask | raised) === 0 && choiceBagValueHolds(state, choiceBands, acceptedSections, context.hourAdena, bagValue)
        ? acceptedSections.bagValue : bagValue;
    // An event re-weighs the held focus and step (WishNetwork reconsider): a
    // section that moved (raised, or named by a refusal). A first build or an
    // unproved held build (no section named, mask = every piece) keeps them.
    // By intent not verdictMask: an unproved verdict's sections rebuild, never re-weigh.
    const moved = raised | (Number(deps.eventVerdict?.touchedSections) || 0)
        | (held ? eventVerdict.movedSections : 0);
    const reconsider = moved !== 0;
    const network = engine.build({ actorKey, inputKey: networkKey, ...projection,
        remembered: deps.rememberContext !== false,
        stockFor: context.stockFor,
        completionKey: context.completionKey,
        characterId: state.characterId, decisionSeq: state.stats?.decisionSeq, activityLeaf: state.stats?.activityLeaf,
        wallet: context.wallet, survivalReserve: base.survivalReserve,
        reconsider,
        // Diagnostics only: the events that re-weigh (network:reconsider), 'quiet' for none.
        reconsiderReasons: !diagnostic ? null : moved ? Sections.sectionNames(moved) : ['quiet'],
        playedHours: positive(state.stats?.playedHours), persona,
        previous: { focus: state.stats?.wishFocus, dormant: state.stats?.dormantWishes },
        hourAdena: context.hourAdena, riskWeight: context.riskWeight,
        caller: deps.caller || 'economy_context', trigger: deps.trigger || diagnosticReason || 'context_build' });
    context.inputKey = networkKey;
    context.horizonHours = projection.horizon;
    context.network = network;
    context.moneyPrice = network.moneyPrice;
    context.hourAdena = network.hourAdena;
    // Affordability removes a funding gap, not the benefit lost while waiting.
    const urgent = network.gap || network.queue.find(row => row.key === network.focus?.[0]) || network.queue[0];
    context.gapHorizonHours = !urgent ? 0 : urgent.key === 'stock:shots' ? base.stock('shots').targetHours
        : urgent.key === 'stock:potions' ? base.stock('potions').targetHours : projection.horizon;
    Object.assign(context, valueReaders(state, network, projection.values, persona, knowledgeEnabled,
        base.kitCost, () => context.statsPacket.money));
    context.watchList = TradeIntent.project(state, network, projection,
        BoardRules.BOT_SHOP_LINES + BoardRules.BOT_RECORDS.buy_ad);
    context.intentPending = context.watchList === null;
    context.watchList ||= [];
    context.statsPacket = { wishFocus: network.focus, dormantWishes: network.dormant,
        decisionSeq: network.decisionSeq, activityLeaf: network.activityLeaf,
        money: Funding.packetFor(network, context.hourAdena, base.survivalReserve), stockTargets: stockTargets(base), wishDirty: 0,
        // The decision's held claims (every row of an item in the bag): what
        // every bag consumer keeps for its goals (ItemDisposition.heldAmounts).
        heldClaims: CraftInputReservations.heldCraftRows(state, network.heldClaims, Infinity) };
    // The bot's twin (TwinCluster): a worker build proposes its town on its
    // board, and a crafter's workshop offer at this build's hour when handed
    // its recipe book; none = the held twin stands (the packet's merge keeps
    // the mind's twin).
    const twin = !isMainThread || Array.isArray(deps.recipeBook) ? TwinCluster.propose(state, { book: deps.recipeBook,
        hourAdena: context.hourAdena, mpPerHour: OccupationSources.mpPerHour(state), error: Sections.incomeError(state, persona),
        board: isMainThread ? null : sourceBoard, watchList: context.watchList,
        // The spot lookup of every build (a worker build cannot reach
        // SpotService's World index): the build's own spot catalog.
        findSpot: id => SpotIndex.spotById(deps.spots, id),
        keepTown: !!held && !(mask & Sections.COMPUTED.town) }) : null;
    if (twin) context.statsPacket.twin = twin;
    let cumulative = base.survivalReserve;
    for (const wish of network.queue) { cumulative += cashCharge(wish); budget.watch(cumulative); }
    const watchedWish = network.gap || network.queue.find(wish => wish.key === network.focus?.[0]);
    const watchedItem = Number(watchedWish?.object?.itemId);
    const belief = beliefs.get(watchedItem) || (keptBase && watchedItem > 0 ? beliefFor(watchedItem) : null);
    const moneyError = belief ? knowledgeEnabled
        ? positive(watchedWish.price) * Math.expm1(PriceBelief.sigma(belief)) : 0 : -1;
    // The bot's error on an item's price, as moneyError reads it (0 without
    // price knowledge or without a belief).
    const priceError = id => {
        const known = knowledgeEnabled && (beliefs.get(id) || beliefFor(id));
        return known ? Math.expm1(PriceBelief.sigma(known)) : 0;
    };
    // ||: a zero-usefulness item's worth is 0, yet its sale is watched at
    // its price.
    const sellValue = id => context.worth(id) || price(id);
    const watchRows = marketWatchRows(network.queue, context.liquidationInputs?.rows || [], sourceBoard,
        Number(state.characterId), price, sellValue, priceError, censusWakeRows(state),
        id => Crystallization.saleCrystal(state, id), id => network.plans?.get?.(`item:${id}`));
    // That the workshop was asked, beside it (never on the workshop object):
    // a kept workshop carries the mark over; a build handed no ask (deps
    // workshopAsked: a near build's empty workshop) records none, so the next
    // build after it asks.
    context.workshopAsked = keptAsk || (Object.hasOwn(deps, 'workshopAsked') ? deps.workshopAsked : true);
    // The build's facts for its baseline: the request's when they were read
    // over this state itself (no held leaf's field activity in between).
    context.statsPacket.wishSections = Sections.snapshot(state, context, cash.result, moneyError, deps.mode,
        { buyOrderEscrow: deps.buyOrderEscrow, budgetBounds: budget.result }, current === state ? facts : requestFacts(state, deps),
        watchRows);
    // The baseline fields of a section not in the mask stay those of the
    // accepted decision (carrySectionBaseline); every moved one is fresh.
    // The money fields are always fresh: the weighing that just ran priced
    // its queue against the current wallet (bagValue: choiceBagValue above).
    Sections.carrySectionBaseline(acceptedSections, context.statsPacket.wishSections, mask | raised | Sections.sectionBit('money'));
    building = false;

    if (diagnostic) {
        Diagnostics.count('context', 'build', diagnosticReason);
        // Builds per worker step (one step's requests share its timestamp):
        // repeat = a second build of the same bot in one step (the goal: 0).
        if (!isMainThread) Diagnostics.count('context', 'step_build', held?.plan.timestamp === timestamp ? 'repeat' : 'first');
        // Per reason too: a wave's builds cost ~3x a calm one's (2026-10-15);
        // the split says whether lost retention or a moved input is the dear one.
        elapsed = performance.now() - started;
        Diagnostics.duration('context', elapsed);
        Diagnostics.duration(`context:${diagnosticReason}`, elapsed);
    }
    // The build's record carries its cause (tools/timeline): the miss reason,
    // the verdict's first refusal (gate), the mask and the time it took.
    if (diagnostic && Diagnostics.enabled(state.characterId)) Diagnostics.push({ owner: state.characterId,
        caller: deps.caller || 'economy_context', trigger: deps.trigger || diagnosticReason,
        phase: 'wish_context', reason: diagnosticReason, inputHash: fnv1a32(networkKey),
        durationMs: Math.round(elapsed * 100) / 100,
        sequence: inputSequence, decisionSeq: network.decisionSeq, activityLeaf: network.activityLeaf,
        revision: state.simulation?.revision, wallet: positive(state.adena), escrow: positive(deps.buyOrderEscrow),
        available: network.available, reserve: base.survivalReserve, wishKey: network.focus?.[0],
        gate: eventVerdict.reason || 'valid', mask: Sections.sectionNames(mask).join('+') || 'none',
        heldFocus: held?.plan.network.focus?.[0], freshFocus: network.focus?.[0],
        heldLeaf: held?.plan.network.activity?.key, freshLeaf: network.activity?.key });
    const plan = planOf(context, base, { key, tripHour, projection, knowledgeEnabled, prices });
    plan.quantityBands = choiceBands;
    // The ground verdict belongs only to the held build entry (bounded by
    // RETAIN_LIMIT, each ground by 2 bits per planning spot). A planning view
    // or a group closure must never retain a second copy.
    const retainedGround = projection.sourceGround;
    projection.sourceGround = null;
    // The build's solves are over: its sized buys end (Network.endSizedBuys),
    // so a kept projection holds no build reader.
    Network.endSizedBuys(projection.nodes);
    if (deps.rememberContext !== false) {
        if (diagnostic && !cache.has(actorKey) && cache.size >= RETAIN_LIMIT) Diagnostics.count('context', 'eviction', 'capacity');
        // The main thread keeps the graph nodes as before (its group solve
        // reads them on a hit); the worker keeps a party member's too (its
        // party goal query reads them on a hit), a solo bot's plan only
        // (perf C1).
        // Its own activity: the later reuse verdict reads the held build
        // with it.
        plan.eventProof = captureEventProof(state, deps, { plan });
        // What the card stamps on its leaf, read once for the held verdict: the
        // own item's bag+incoming at the decision (heldAtDecision) and a
        // craft's reserved inputs: every live goal's held claims (craftReservations).
        const leaf = plan.network?.activity, own = ColdEconomyDecision.ownItem(leaf);
        remember(cache, actorKey, { key, revision: Number(state.simulation?.revision || 0),
            heldUnits: own === null ? undefined : ColdEconomyDecision.heldFor(state, own),
            craftReservations: leaf?.activity === 'crafting' ? CraftInputReservations.heldCraftRows(state, plan.network.heldClaims) : undefined,
            readIds: Int32Array.from(readIds), plan, stateRef: new WeakRef(state), gearThreat,
            activity: state.activity, caller: deps.caller || 'economy_context',
            // The decision this build read (decisionMove: the state still
            // carrying it is no refusal) and the raised bits it consumed
            // (raisedSince, while the sequence is still input[0]).
            input: Object.freeze([inputSequence, Number(state.stats?.activityLeaf || 0), state.stats?.wishFocus?.[0] ?? null]),
            raised: Number(state.stats?.wishDirty) || 0,
            // The money packet this build read (heldMoney: the state still
            // carrying it has not received this build's own packet; dropped
            // once the state moves off it).
            inputMoney: state.stats?.money,
            sourceGround: retainedGround, mp: Number(state.vitals?.mp),
            projection: (isMainThread || partyIdOf(state)) ? projection : null }, RETAIN_LIMIT);
    }
    readIds = null;
    const built = view(state, plan, deps, { price, soldPrice, kit: base, board, read, spotValue: context.spotValue, trip: context.trip, projection });
    // The sections this build saw moved (worker-local, never posted): the
    // worker drops the kept route when they hit COMPUTED.route. A served held
    // build and a card view carry none: they hold only with nothing moved.
    built.mask = mask;
    countRebuild(buildEntry, rebuildReason, performance.now() - started, held ? sameDecision(held.plan.network, network) : null);
    return built;
}
// Plan as data (perf C1). A built context's closures hold the wish network,
// the projection and the whole build scope (~0.6 MB per party bot, measured
// in the worker heap 10-25 while sized buys kept it alive); what its readers
// act on is a few KB of results. A kept projection (main, a worker party
// member) holds its nodes only, no build scope (Network.endSizedBuys):
// estimated ~20-40 KB (EC cache entries average 35 KB, same snapshot). The cache keeps this plan, and every reader,
// the building caller included, gets view(state, plan, deps): the same fields
// and functions, answered from the plan, the state it is given and the kit
// data, without a second wish build.
// Plan nodes keep only what post-build readers walk: the materials of the
// decision card (ColdEconomyDecision.capture), TradeIntent.project and
// npcOwnsPurchase, WishProviders.personalCraftPlan (basePrice, and bidFloor
// for an input no seller offers: the cash weights of TradeIntent.inputSplit
// and lineCash; inputCap: the solve's input ceiling, TradeIntent.inputValue).
// Shared nodes stay shared.
// A requirement row without its plan is looked up by key in network.plans
// (personalCraftPlan); `unresolved` collects those keys for the kept map.
// No `activity` on purpose: with it, a meeting-prep row would match the chosen
// step, get cut, and TradeIntent's guard would then refuse the chosen step's own meeting.
// unitPrice, town, availableUnits: a quoted afk buy's meeting consent (TradeIntent.wishRows).
const NODE_FIELDS = ['kind', 'sourceType', 'quoted', 'executable', 'recipeId', 'missingAmount', 'improvement', 'unseal', 'batches', 'basePrice', 'bidFloor', 'inputCap',
    'unitPrice', 'town', 'availableUnits'];
const NO_REQUIREMENTS = Object.freeze([]);
function planTrimmer(unresolved = new Set()) {
    const seen = new Map();
    const trim = plan => {
        if (!plan || typeof plan !== 'object') return plan;
        if (seen.has(plan)) return seen.get(plan);
        // Absent fields stay absent and an empty requirement list is one
        // shared frozen array: a bot keeps ~20 nodes, most of them buys.
        const out = {};
        for (const field of NODE_FIELDS) if (plan[field] !== undefined) out[field] = plan[field];
        if (plan.workshop) out.workshop = { characterId: plan.workshop.characterId, price: plan.workshop.price,
            loc: plan.workshop.loc, townName: plan.workshop.townName };
        seen.set(plan, out);
        if (plan.grossRequirements) out.grossRequirements = plan.grossRequirements.map(row => ({ key: row.key,
            amount: row.amount, ...(row.once ? { once: true } : {}) }));
        if (plan.execution) out.execution = { ...trim(plan.execution), availableUnits: plan.execution.availableUnits };
        if (plan.requirements) out.requirements = !plan.requirements.length ? NO_REQUIREMENTS : plan.requirements.map(row => {
            if (!row.plan) unresolved.add(row.key);
            return { key: row.key, amount: row.amount, plan: trim(row.plan) };
        });
        return out;
    };
    return trim;
}
// Queue rows keep the fields read after the build (funding, the money packet
// ratio, the card, trade intents, gear and companion choices). network.plans
// keeps the item plans (TradeIntent.npcOwnsPurchase asks by `item:<id>`) and
// the plans of requirement rows that have none. A selected crystal operation
// also keeps its one root: owned inputs can remove it from the money queue.
function compactNetwork(network) {
    const unresolved = new Set(), trim = planTrimmer(unresolved);
    const row = wish => ({ key: wish.key, need: wish.need, object: wish.object, price: wish.price, reserved: wish.reserved,
        valueHours: wish.valueHours, ratio: wish.ratio, funded: wish.funded,
        ...(wish.waitValueHours > 0 ? { waitValueHours: wish.waitValueHours } : {}),
        supported: wish.supported, resolved: wish.resolved, progressionPriority: wish.progressionPriority,
        ...(wish.scrollCash !== undefined ? { scrollCash: wish.scrollCash } : {}),
        ...(wish.ownValueHours !== undefined ? { ownValueHours: wish.ownValueHours } : {}),
        ...(wish.earningValueHours !== undefined ? { earningValueHours: wish.earningValueHours } : {}),
        ...(wish.bidsInputs > 0 ? { bidsInputs: wish.bidsInputs } : {}), plan: trim(wish.plan) });
    const queue = (network.queue || []).map(row);
    const at = network.gap ? (network.queue || []).indexOf(network.gap) : -1;
    const leaf = network.activity;
    const activity = !leaf ? leaf : { ...leaf,
        ...(leaf.requirements ? { requirements: leaf.requirements.map(item => ({ ...item, plan: trim(item.plan) })) } : {}) };
    const all = network.plans || new Map(), plans = new Map();
    for (const [key, plan] of all) if (key.startsWith('item:')) plans.set(key, trim(plan));
    if (leaf?.rootKey && ['crystallize', 'luxury_exchange', 'mammon_unseal'].includes(leaf.kind)
        && all.has(leaf.rootKey)) plans.set(leaf.rootKey, trim(all.get(leaf.rootKey)));
    for (const key of unresolved) if (!plans.has(key) && all.has(key)) plans.set(key, trim(all.get(key)));
    // The network's input key is the plan's key with its market (~2 KB of
    // text per bot, L104): view() gives it back from them, in its place.
    return { ...network, inputKey: undefined, queue, gap: !network.gap ? network.gap : at >= 0 ? queue[at] : row(network.gap), activity, plans };
}
// The build's prices of what the plan's own numbers were made from (the
// kit, the queue, the watch list): a later view starts from them, so its
// stock rows and kit costs agree with the plan's reserve and money packet.
// Other items are priced by the view (~8 of ~140 prices per bot are kept).
function planPrices(prices, kit, context) {
    const ids = [736, kit.shots.itemId, kit.potions.itemId,
        ...(context.network?.queue || []).map(row => row.object?.itemId), ...(context.watchList || []).map(row => row.itemId)];
    const kept = new Map();
    for (const id of ids) if (prices.has(Number(id))) kept.set(Number(id), prices.get(Number(id)));
    return kept;
}
// The leaf's read of its own item (ColdEconomyDecision.ownItem, the
// verdict's ownQuantityRow): its proof row stays apart (WishNetwork finish).
function ownStock(leaf) {
    const itemId = ColdEconomyDecision.ownItem(leaf);
    return itemId !== null && typeof leaf.rootKey === 'string' ? { rootKey: leaf.rootKey, itemId: Number(itemId) } : null;
}
function planOf(context, base, { key, tripHour, projection = null, knowledgeEnabled, prices }) {
    const stockRoots = new Map();
    for (const node of projection?.nodes || [])
        if (node.key.startsWith('stock:') && !stockRoots.has(node.key)) stockRoots.set(node.key, node.object?.itemId);
    return { pending: !projection, key, actorKey: context.actorKey, timestamp: context.timestamp,
        gearThreatMask: context.gearThreatMask, persona: context.persona, hunt: context.hunt,
        riskWeight: context.riskWeight, bestSpotId: context.bestSpotId, deathHours: context.deathHours,
        lostGearHours: context.lostGearHours, karmaHours: context.karmaHours, expectedDeathHours: context.expectedDeathHours,
        survivalReserve: context.survivalReserve, kit: base.kit, hourAdena: context.hourAdena, workshop: context.workshop,
        workshopAsked: context.workshopAsked, routeKey: context.routeKey, routeRows: context.routeRows, tripHour,
        network: compactNetwork(context.network), moneyPrice: context.moneyPrice, gapHorizonHours: context.gapHorizonHours,
        watchList: context.watchList, intentPending: context.intentPending, statsPacket: context.statsPacket,
        wallet: context.wallet, horizonHours: context.horizonHours, values: projection?.values, stockRoots, knowledgeEnabled,
        quantityInputs: projection ? context.quantityInputs?.finish(ownStock(context.network?.activity)) : null,
        // The thresholds of those rows, set by finish() above.
        quantityThresholds: projection ? context.quantityInputs?.thresholds() : null,
        liquidationInputs: context.liquidationInputs,
        prices: planPrices(prices, base.kit, context), gearPlanMemo: undefined };
}
// Whether a stock read depends on its root: a stock root's own item counts
// the whole bag, every other read the free amount (stockReader; a clan
// crystal root's reads too: the reader's clanKey).
function ownStockRow(rootKey, id, rootItem) {
    return rootKey.startsWith('stock:') && rootItem(rootKey) === id;
}
// What a review's stock reader, usefulness, worth and purchase budget read:
// one copy for the build and every later view of its plan.
function stockReader(state, rootItem) {
    const reserved = invoke('GameServer/Bot/AI/PersonalGearProgression').preparedAmounts(state);
    // A clan equipment owner's crystal root reads the stock its own clan
    // demand releases (ClanCrystalSupply.stock); clanKey: that root's key.
    const supply = state.stats?.equipmentPlan?.clanGoal?.clanId && ClanCrystalSupply.requirement(state);
    // A producer's root (resale:) cannot consume the collected personal gear
    // kit (ItemDisposition.reservedEquipmentAmounts, the gear plan's held
    // inputs among it): its purchase graph sees that same free stock, or an
    // input trip reaches the seller with no surviving need for its own
    // reserved goods. Read once per reader, at the first producer read.
    let productionReserved;
    const reservedFor = rootKey => rootKey.startsWith('resale:')
        ? productionReserved ||= ItemDisposition.reservedEquipmentAmounts(state) : reserved;
    const read = (id, rootKey) => ({ owned: supply?.key === rootKey ? ClanCrystalSupply.stock(state, id)
        : ownStockRow(rootKey, id, rootItem)
        ? positive(state.inventory?.[id]?.amount) : WealthDecision.freeAmount(state, state.inventory?.[id] || {}, reservedFor(rootKey)),
    incoming: positive(state.acceptedIncoming?.[id]) });
    read.clanKey = supply ? supply.key : null;
    // The fact a read of `id` by `rootKey` is (WishNetwork createQuantityInputs):
    // the root's own when its answer depends on the root (its own stock row,
    // the clan crystal root, a producer root whose reservation of `id` is not
    // the others'), else '' (one row of the item for every root).
    read.rootFact = (id, rootKey) => ownStockRow(rootKey, id, rootItem) || rootKey === read.clanKey
        || rootKey.startsWith('resale:') && Number(reservedFor(rootKey)[id] || 0) !== Number(reserved[id] || 0) ? rootKey : '';
    return read;
}
function valueReaders(state, network, values, persona, knowledgeEnabled, kitCost, money) {
    const itemUsefulness = id => invoke('GameServer/Bot/Population/ColdEconomyDecision').personalUsefulness(
        network.demands.get(`item:${id}`) || values.get(Number(id)) || 0,
        state, persona.understanding, knowledgeEnabled, id);
    return { itemUsefulness,
        worth: id => network.moneyPrice > 0 ? itemUsefulness(id) / network.moneyPrice : null,
        purchaseBudget: id => {
            const wish = network.queue.find(row => Number(row.object?.itemId) === Number(id));
            return Funding.spendable({ ...state, stats: { ...state.stats, money: money() } }, 0,
                Funding.stockTerms(wish, id, kitCost(id)));
        } };
}
// The build's hunt as the spot reader's hour baseline: a leaf-fit or plain
// hunt. An income-route hunt is not one (its exp is the route spot's share and
// it may hunt without shots): the reader then keeps its own bare hunt.
function buildHunt(hunt) {
    return hunt?.source === 'route' ? undefined : hunt;
}
// Spot values are read inside a build (providers); a later view makes its
// reader only when asked.
function lazySpotValue(state, plan, deps) {
    let reader;
    return (...args) => (reader ||= SpotEconomics.create(state,
        { ...deps, timestamp: plan.timestamp,
            persona: plan.persona, deathHours: plan.deathHours, hunt: buildHunt(plan.hunt) }))(...args);
}
// One reader's context over a plan. `built` carries the building call's own
// readers (prices with their memo, kit, spot value, trip, the projection);
// a later view makes its own from the plan. The state is the caller's, held
// only by this view. Functions read the plan, never a build scope.
function view(state, plan, deps, built = {}) {
    // A later view starts from the build's prices of the plan's own items.
    const { price, soldPrice } = built.price ? built
        : pricing(state, plan.persona, built.board, plan.timestamp, deps, built.read, new Map(plan.prices));
    const { stock, kitCost } = built.kit || kitReader(plan.kit, price,
        () => plan.kit.scrollHours ??= scrollHoursFor(state, deps.spots, plan.bestSpotId),
        () => potionRest(state, plan, plan.timestamp));
    // Reprice funding against this physical wallet. Reuse of benefit/source
    // calculations is never a retained permission to spend an old balance.
    // The held money keeps the build's price (its best use among every
    // root, WishNetwork.heldPriceOf): the queue here holds only its kept roots.
    const floor = plan.hourAdena > 0 ? 1 / plan.hourAdena : 0;
    const funding = moneyQueue(plan.network.queue, Funding.budget(state, deps.buyOrderEscrow),
        plan.survivalReserve, floor, plan.network.heldPrice ?? floor);
    const inputKey = plan.key;
    const network = { ...plan.network, inputKey, ...funding };
    const statsPacket = plan.pending ? plan.statsPacket : { ...plan.statsPacket,
        money: Funding.packetFor(network, plan.hourAdena, plan.survivalReserve) };
    const context = { inputKey, actorKey: plan.actorKey, state,
        timestamp: plan.timestamp, gearThreatMask: plan.gearThreatMask, persona: plan.persona, board: built.board, hunt: plan.hunt,
        price, soldPrice, buyback, riskWeight: plan.riskWeight, bestSpotId: plan.bestSpotId,
        deathHours: plan.deathHours, lostGearHours: plan.lostGearHours, karmaHours: plan.karmaHours,
        expectedDeathHours: plan.expectedDeathHours, stock, survivalReserve: plan.survivalReserve, kitCost,
        hourAdena: plan.hourAdena, workshop: plan.workshop, routeKey: plan.routeKey, routeRows: plan.routeRows,
        trip: built.trip || deps.tripCost || Trip.preparedReader(plan.routeRows || [], { hourAdena: plan.tripHour }),
        spotValue: built.spotValue || lazySpotValue(state, plan, deps),
        network, moneyPrice: network.moneyPrice, gapHorizonHours: plan.gapHorizonHours, watchList: plan.watchList,
        intentPending: plan.intentPending, statsPacket };
    // The plan is the identity of one decision for memos kept beside it
    // (a refused trip, the gear plan choice), not this view object.
    Object.defineProperty(context, 'plan', { value: plan });
    Object.defineProperty(context, 'eventProof', { value: () => plan.eventProof || null });
    Object.defineProperty(context, 'gearPlanMemo', { get: () => plan.gearPlanMemo, set: memo => { plan.gearPlanMemo = memo; } });
    if (plan.pending) {
        context.itemUsefulness = () => 0; context.worth = price; context.purchaseBudget = () => 0;
        return context;
    }
    context.wallet = Funding.budget(state, deps.buyOrderEscrow);
    context.stockFor = stockReader(state, rootKey => plan.stockRoots.get(rootKey));
    // A later view of an entry without its nodes (a worker's solo bot) has
    // the usefulness values only; a group solve that needs the members'
    // nodes rebuilds them (forGroup).
    context.projection = built.projection || { values: plan.values };
    context.horizonHours = plan.horizonHours;
    Object.assign(context, valueReaders(state, network, plan.values, plan.persona, plan.knowledgeEnabled,
        kitCost, () => context.statsPacket.money));
    return context;
}
// The plan's own potion and shot targets, published with its money packet
// (L72): the sale list keeps what the plan decided under spot occupancy
// instead of a second earning-spot search. A changed potion or shot item
// (level, weapon) has no published target yet and reads the foundation; so
// do shots risen since the build: without restock their target is capped by
// the stock owned then (the sale list keeps at most what is owned, so a
// fall needs no fresh read). The shots' survival target and unit price
// close the row: a buyer below that floor waits for a shot seller
// (MarketDemandIndex), spending at most its missing shots' price.
function stockTargets(base) {
    const potions = base.stock('potions'), shots = base.stock('shots');
    return [potions.itemId, potions.target, shots.itemId, shots.target, shots.current,
        // No buy floor when buying does not pay: the build kept only what it holds.
        shots.canRestock ? shots.survivalTarget : 0,
        Math.round(positive(shots.unitPrice) * 100) / 100];
}
function keptTargets(state = {}, deps = {}) {
    const row = state.stats?.stockTargets, ShotStock = invoke('GameServer/Inventory/ShotStock'), plan = ShotStock.planForState(state);
    const beginnerCurrent = ShotStock.beginnerAmount(state, plan);
    if (Array.isArray(row) && (row.length === 5 || row.length === 7) && row[0] === HealingPotionStock.purchasePotionFor(state).selfId
        && row[2] === plan.selfId && positive(state.inventory?.[plan.selfId]?.amount) + beginnerCurrent <= row[4])
        return { potions: row[1], shots: { itemId: row[2], target: row[3], beginnerCurrent } };
    const base = basics(state, deps);
    return { potions: base.stock('potions').target, shots: base.stock('shots') };
}
function survivalReserve(state = {}) {
    return Array.isArray(state.stats?.money) ? positive(state.stats.money[2]) : basics(state).survivalReserve;
}
function forGroup(group, members, deps = {}) {
    const diagnostic = Diagnostics.active();
    if (diagnostic) Diagnostics.count('context_group', 'request');
    const selected = (members || []).slice(0, 9);
    const prepared = deps.memberContexts;
    if (prepared !== undefined && (!Array.isArray(prepared) || prepared.length !== selected.length
        || prepared.some((context, i) => !context?.projection?.nodes || context.state !== selected[i])))
        throw new Error('party_member_context_mismatch');
    const contexts = prepared || selected.map(state => forState(state, { ...deps, caller: 'groupContext' }));
    const first = contexts[0];
    if (!first) {
        if (diagnostic) Diagnostics.count('context_group', 'miss', 'empty_group');
        return null;
    }
    const actorKey = `group:${group.id || group.partyId}`;
    const proposal = deps.rememberGroup === false || String(group.id || group.partyId || '').startsWith('proposal:');
    const wallet = positive(group.adena ?? group.wallet);
    // Each member's network key (its decided facts) and its plan's echo
    // (decision sequence, leaf, focus): the facts do not move with a member's
    // own decision, so with the echo equal keys are equal member plans (perf
    // C1: a member's later view is a new object over the same plan). A party
    // keeps its group answer until a member's facts, decision sequence, leaf
    // or focus move (a watched market crossing moves the sequence).
    const key = [wallet, ...contexts.map(({ inputKey, statsPacket: packet }) =>
        `${inputKey}:${packet?.decisionSeq}:${packet?.activityLeaf}:${packet?.wishFocus?.[0]}`)].join('|');
    const held = proposal ? null : groups.get(actorKey);
    if (held?.key === key) {
        if (diagnostic) Diagnostics.count('context_group', 'hit', 'same_members');
        return remember(groups, actorKey, held, GROUP_LIMIT).context;
    }
    const started = diagnostic ? performance.now() : 0;
    if (diagnostic) Diagnostics.count('context_group', 'miss', proposal ? 'uncached_proposal'
        : !held ? 'not_retained' : 'input_dependency_changed');
    const nodes = [], roots = [];
    // Each member keeps its actual wishes/effects. Namespaced dependencies
    // enter the group's one purse and one engine, never a second evaluator.
    // A worker solo bot's later view (a formation candidate's) keeps only its
    // usefulness values: the same call that made it builds again asking for
    // the nodes (perf C1).
    const sources = contexts.map((context, i) => context.projection?.nodes ? context.projection
        : forState(selected[i], { ...deps, caller: 'groupContext', withNodes: true }).projection);
    for (let i = 0; i < contexts.length; i++) {
        const source = sources[i];
        const prefix = `${i}:`;
        // The group solve has no stock reader: a member's path with gross
        // inputs only (Task 2 readers) orders what the member does not hold
        // for one batch, and pays its held units at its own price (node.price).
        const held = new Map(source.nodes.map(node => [node.key, node]));
        const missing = path => {
            const requirements = [];
            let ownValue = 0;
            for (const row of path.grossRequirements) {
                const id = row.key.startsWith('item:') ? Number(row.key.slice(5)) : 0;
                const stock = id ? contexts[i].stockFor?.(id, '') || {} : {};
                const { toOrder: order, toExecute } = remainingQuantity({ required: row.amount,
                    freePhysical: positive(stock.owned), acceptedIncoming: positive(stock.incoming) });
                const node = held.get(row.key);
                ownValue += (row.amount - toExecute) * positive(node?.price);
                if (order > 0) requirements.push({ ...row, amount: order });
            }
            return { requirements, ownInputOpportunityValue: positive(path.ownInputOpportunityValue) + ownValue };
        };
        for (const node of source.nodes) nodes.push({ ...node, key: prefix + node.key,
            paths: (node.paths || []).map(path => {
                const own = path.requirements || !path.grossRequirements ? null : missing(path);
                return { ...path, ...own, ...(path.town ? { tripScope: contexts[i].actorKey } : {}),
                requirements: (own?.requirements || path.requirements || [])
                .map(row => ({ ...row, key: prefix + row.key })),
                ...(path.grossRequirements ? { grossRequirements: path.grossRequirements.map(row => ({ ...row, key: prefix + row.key })) } : {}) };
            }) });
        roots.push(...source.roots.map(key => prefix + key));
    }
    const byKey = new Map(nodes.map(node => [node.key, node]));
    roots.sort((a, b) => positive(byKey.get(b).valueHours) / Math.max(1, positive(byKey.get(b).price))
        - positive(byKey.get(a).valueHours) / Math.max(1, positive(byKey.get(a).price)));
    // MVP-6: the same admission as one member's projection; a root whose
    // union does not fit is pending and the smaller ones still proceed.
    const { roots: admitted, kept } = admitRoots(roots, byKey, { label: 'group' });
    const network = engine.build({ actorKey, inputKey: key, remembered: false, nodes: nodes.filter(node => kept.has(node.key)), roots: admitted,
        wallet, playedHours: positive(group.playedHours), persona: group.persona || first.persona,
        previous: { focus: group.wishFocus, dormant: group.dormantWishes },
        hourAdena: contexts.reduce((sum, context) => sum + context.hunt.perHour, 0),
        moneyPaths: sources[0].moneyPaths, riskWeight: first.riskWeight });
    const groupHunt = { ...first.hunt, perHour: contexts.reduce((sum, member) => sum + member.hunt.perHour, 0),
        expPerHour: contexts.reduce((sum, member) => sum + member.hunt.expPerHour, 0) };
    const context = { ...first, actorKey, inputKey: key, network, hunt: groupHunt, groupIncomePerHour: groupHunt.perHour,
        moneyPrice: network.moneyPrice,
        hourAdena: network.hourAdena, statsPacket: { wishFocus: network.focus, dormantWishes: network.dormant } };
    context.itemUsefulness = id => contexts.reduce((sum, member) => sum + member.itemUsefulness(id), 0);
    context.worth = id => network.moneyPrice > 0 ? context.itemUsefulness(id) / network.moneyPrice : null;
    if (diagnostic) {
        Diagnostics.count('context_group', 'build');
        Diagnostics.duration('context_group', performance.now() - started);
    }
    if (!proposal) {
        if (diagnostic && !groups.has(actorKey) && groups.size >= GROUP_LIMIT)
            Diagnostics.count('context_group', 'eviction', 'capacity');
        remember(groups, actorKey, { key, ids: contexts.map(member => Number(member.state.characterId)), context }, GROUP_LIMIT);
    }
    return context;
}
// Why the held build's workshop (the occupation planner's answer it was
// built with: the owner's line feasibility mask) is not kept, null when it
// is: kept while its section did not move (mask, Sections.COMPUTED.workshop:
// the kit) and known. The mask reads no route row, hour or wallet.
function heldWorkshopRefusal(held, mask) {
    const workshop = held?.plan.workshop;
    if (!workshop) return 'unknown';
    if (Number(mask) & Sections.COMPUTED.workshop) return 'mask';
    return workshop.known !== false && Number.isFinite(workshop.incomePerHour) ? null : 'unknown';
}
// Why a build does not keep the held workshop, null when it does: the held
// refusal, or a held build without the ask's mark (a near build: 'no_ask').
// Judged only where a build follows: a served held build keeps its workshop
// as it is (a re-ask there would renew the card only, not the plan, and
// repeat every step).
function buildWorkshopRefusal(held, mask) {
    return heldWorkshopRefusal(held, mask) || (held.plan.workshopAsked ? null : 'no_ask');
}
// A crafter's build that keeps no known workshop. Counts crafters only: a
// bot without workshop entries has no workshop to know.
function countUnknownWorkshop(state) {
    if (Diagnostics.active() && TwinCluster.entriesOf(state)?.length) Diagnostics.count('occupation', 'workshop', 'unknown');
}
// Why the step asks the occupation planner (heldWorkshop's refusal), for
// service crafters only: a bot that cannot craft has no workshop to keep.
function countWorkshopAsk(state, reason) {
    if (Diagnostics.active() && CraftEligibility.isServiceCrafter(state)) Diagnostics.count('workshop', 'ask', reason);
}
// A worker build given no workshop (forState: a reader that builds without
// the step's workshop, e.g. a stock check or a refresh): the held one, else an unknown
// one, which the step's next build does not keep (heldWorkshop: it asks).
function keptWorkshop(held, mask, state) {
    if (!buildWorkshopRefusal(held, mask)) return held.plan.workshop;
    countUnknownWorkshop(state);
    return ColdEconomyDecision.unknownWorkshop();
}
// The worker's decision point (planLifecycle), before its build on the same
// state: the verdict on the held build is computed here (heldVerdictFor) and
// handed to that build (eventVerdict, the step's: `collected`, handedVerdict);
// the route rows it judged are written back on the step's deps, which the
// build spreads. The held workshop (heldWorkshopRefusal) under the mask the
// build will take (none for a valid verdict, which serves the held build; a
// refusal also asks a held build without the ask's mark), or null: ask the
// occupation planner. A valid verdict is handed to the build either
// way: the ask only renews the card's workshop. No held proof: null,
// nothing judged.
function heldWorkshop(state, deps, eventVerdict) {
    const held = cache.get(actorKeyOf(state, deps));
    if (!held?.plan.eventProof) {
        countWorkshopAsk(state, 'no_proof');
        return null;
    }
    const own = resolved(state, { ...deps, eventVerdict });
    const { reads, verdict } = heldVerdictFor(state, own);
    deps.routeRows = own.routeRows;
    eventVerdict.collected = collectedOf(verdict, state, held.plan.eventProof, heldOptionsOf(held, state), own, reads);
    const refusal = verdict.valid ? heldWorkshopRefusal(held, 0)
        : buildWorkshopRefusal(held, verdictMask(state, eventVerdict, verdict, held));
    const kept = refusal ? null : held.plan.workshop;
    // The ask awaits the planner, and memory or recipe rows may land before
    // the build: its reads (the build key among them) are taken fresh then.
    if (!kept) eventVerdict.collected.reads = null;
    if (Diagnostics.active()) {
        if (kept) Diagnostics.count('workshop', 'kept', verdict.valid ? 'held_valid' : 'lifecycle');
        else {
            countWorkshopAsk(state, refusal);
            // The served held build keeps an unknown workshop.
            if (verdict.valid) countUnknownWorkshop(state);
        }
    }
    return kept;
}
function preparedRouteRows(state) {
    const plan = cache.get(`character:${Number(state.characterId)}`)?.plan;
    return plan?.routeKey === Trip.key(state) ? plan.routeRows : null;
}
function forgetGroup(partyId) {
    if (groups.delete(`group:${partyId}`) && Diagnostics.active()) Diagnostics.count('context_group', 'eviction', 'group_release');
}
function forgetContext(id, reason = 'explicit_invalidation', expectedState = null) {
    id = Number(id);
    const key = `character:${id}`;
    if (expectedState && cache.get(key)?.stateRef.deref() !== expectedState) return;
    // Publication replaces the facts object, not the economic decision. The
    // next reader's verdict validates the held build against the state.
    if (reason !== 'state_publication') {
        if (cache.delete(key) && Diagnostics.active()) { Diagnostics.count('context', 'eviction', reason); }
        engine.forget(key, reason);
    }
    for (const [groupKey, held] of groups) {
        if (held.ids.includes(id)) {
            groups.delete(groupKey);
            if (Diagnostics.active()) Diagnostics.count('context_group', 'eviction', reason);
        }
    }
}
function forget(id) {
    forgetContext(id);
    invoke('GameServer/Bot/Population/ColdCombatProfile').forgetBuild(id);
}
function reset() {
    if (Diagnostics.active() && cache.size) Diagnostics.count('context', 'eviction', 'reset', cache.size);
    if (Diagnostics.active() && groups.size) Diagnostics.count('context_group', 'eviction', 'reset', groups.size);
    cache.clear(); groups.clear(); engine.clear(); routeAnchors = new WeakMap();
}
function size() { return { context: cache.size, engine: engine.cache.size, groups: groups.size }; }

module.exports = { FIELD_ACTIVITIES, rebuildStats, REBUILD_ROWS_MAX, REBUILD_NAME_MAX, captureEventProof, heldBuildVerdict, eventProofHolds, restartEventProof, receiveEventProof, restoreEventProof, wireEventProof, size, forState, forGroup, forgetGroup, basics, heldBasics, stockFor, keptTargets, stateForActor, preparedRouteRows, heldWorkshop, heldWatch, heldKitCost, RETAIN_LIMIT, leafCheck, survivalReserve, forgetContext, forget, reset, configure, compactNetwork, marketBoard, knownRecipesOf };
