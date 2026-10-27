'use strict';

const { trait, stageHours, decisionHorizon, withinHorizon, horizonUnits, resale } = require('./EconomicValuation');
const { SELL, BUY } = require('../../AfkTrade/BoardIndex');
const Sources = require('../../Items/ItemAcquisitionCatalog');
const Diagnostics = require('./EconomyDiagnostics');
const Funding = require('./PurchaseFunding');
const Equipment = require('../AI/BotEquipmentCompatibility');
const Network = require('./WishNetwork');
const ProductionIndex = require('./RecipeProductionIndex');
const Progression = require('../AI/PersonalGearProgression');
const DualSwords = require('../../Items/C4DualSwordCombinations');
const RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const { canCraft } = require('./CraftEligibility');
const { GRADE_RANK, levelForGrade } = require('../AI/GearGradeRule');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const KillRewards = invoke('GameServer/Bot/Population/ColdKillRewards');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const DataCache = invoke('GameServer/DataCache');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const ProgressionCap = invoke('GameServer/Progression/ProgressionCap');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
// A module read inside a hot function: require() walks the module path on
// every call, so each path is resolved once here. The relative require keeps
// the module's dependency boundary (tests pass their own require).
const needed = new Map();
function need(path) {
    let module = needed.get(path);
    if (!module) needed.set(path, module = require(path));
    return module;
}

// Compatibility is game data shared by class/role, not an actor's prescribed
// purchase. Keep every item (including SA and set parts) in this immutable view.
// Only a review's finalists are bounded; prices, holdings and funding are live.
const GEAR_FINALISTS_PER_SLOT = 8;
// A wish review keeps at most WishNetwork.MAX_ROOTS roots and MAX_NODES
// nodes (plan E92). Producer candidates priced in detail share that bound: at most
// three producer roots are nominated, and pricing more candidates than a
// review can hold as roots adds cost without a reachable choice.
const PRODUCER_PRICED = Network.MAX_ROOTS;
// The key prefix of the next-level root (one per review; the root cut keeps its slot).
const LEVEL_ROOT = 'level:';
// The scroll verdicts (one shared frozen row each): scrollReadiness and
// scrollSource return READY, SOURCE (a scroll still to find) or null.
const SCROLL_READY = Object.freeze({ ready: true });
const SCROLL_SOURCE = Object.freeze({ ready: false });
// MVP-6 (PLAN "Admission and placement"): four gear roots, four admission
// rounds (the initial evaluation plus three affected re-evaluations).
const GEAR_ROOTS = 4;
const GEAR_ROUNDS = 4;
const SOLVER_LIMITS = new Set(['missing_wish_requirement', 'cyclic_wish_network', 'invalid_wish_node', 'wish_network_depth']);
// One root solved alone as the network build solves it: with a stock reader
// (used = the stock already claimed) allocate is the whole evaluation;
// rootWish is the stockless one. claims: the stock the solve claimed, or null.
function solveRoot(solver, node, used) {
    if (!used) return { wish: solver.rootWish(node.key), claims: null };
    const wish = { key: node.key, need: node.need, object: node.object };
    return { wish, claims: solver.allocate(wish, used) };
}
// The review's root cut (Network.admitRoots) ranks each root by the network's
// own score of that root solved alone on the whole review, as gear admission
// evaluates a candidate. A solver bound (SOLVER_LIMITS) scores the root 0;
// the next root gets a fresh solver, since the thrown one may hold a dirty visit.
function rootScores(roots, nodes, solverOptions) {
    const scores = new Map();
    let solver = null;
    for (const key of roots) {
        let value = 0;
        try {
            solver ||= Network.createSolver({ ...solverOptions, nodes });
            value = Math.max(0, Network.score(solveRoot(solver, solver.byKey.get(key), solverOptions.stockFor ? new Map() : null).wish) || 0);
        } catch (error) {
            if (!SOLVER_LIMITS.has(error?.message)) throw error;
            solver = null;
        }
        scores.set(key, value);
    }
    return scores;
}
// The bot's committed goal keys: WishNetwork.committedKeys over its saved
// focus / dormant packet, read once per build (EconomyContext ctx.committedKeys).
// Every goal source keeps a committed root beside its winners and past its
// caps while the root is still valid by that source's own checks; whether
// the bot holds it is WishNetwork.build's loyalty, never the source's.
function committedOf(state) {
    return Network.committedKeys({ focus: state.stats?.wishFocus, dormant: state.stats?.dormantWishes });
}
// [the equipment plan's target (0 while deferred), ...the committed gear items]: the gear
// focus and the gear goals a higher-priority root preempted, so a
// committed goal stays nominated.
// At most 6 items (the target, the focus, 4 dormant rows).
function nominationBasis(state, committed = committedOf(state)) {
    const held = [];
    for (const key of committed) {
        const item = String(key).match(/^power:(\d+):/);
        if (item) held.push(Number(item[1]));
    }
    // A deferred plan's target is the old focus: only committed goals pin.
    const plan = state.stats?.equipmentPlan;
    return Object.freeze([plan?.status === 'deferred' ? 0 : Number(plan?.target?.selfId || 0), ...held]);
}
// quoteFor: the build's buy reader (purchaseFor); its executable quote nominates
// the strongest piece the bot can really buy now (gd 10-24 "the strongest item
// the bot can really get"), whatever its belief price ranks.
function gearCandidates(state, ctx = null, wornFor = wornReader(state), acquisitionAllowed = null, exchanges = null, quoteFor = null) {
    const Data = invoke('GameServer/DataCache');
    const revision = Sources.revision();
    const role = Planner.roleFor(state);
    const classId = Number(state.stats?.classId || state.classId || 0);
    const kits = invoke('GameServer/Bot/AI/BotGear').wishKitsFor(Data.items, revision, classId, role, Planner, Sources);
    const maxRank = GRADE_RANK[Planner.gradeForLevel(state.level)];
    const result = new Map();
    const budget = Math.max(0, Number(ctx?.wallet ?? Funding.budget(state)) - Number(ctx?.survivalReserve || 0));
    const [target, ...held] = ctx?.nominationBasis || nominationBasis(state);
    const slotKits = new Map(kits);
    for (const [slot, kit] of kits) if (Equipment.pairedSlot(slot) && !slotKits.has(Equipment.pairedSlot(slot))) slotKits.set(Equipment.pairedSlot(slot), kit);
    for (const [slot, kit] of slotKits) {
        const allowed = [];
        for (let at = 0; at < kit.length; at++) if (kit.rankAt(at) <= maxRank) allowed.push(at);
        // The exported game-data view is also used to construct fixed kits;
        // it has no actor choice or expensive build evaluation.
        if (!ctx) { result.set(slot, allowed.map(at => kit.itemAt(at))); continue; }
        const current = replacementWorn(wornFor, slot);
        const owned = current && Data.items && need('../../Item/ItemTemplateIndex').find(Data.items, current.selfId);
        const before = owned ? Planner.itemScore(owned, role, classId) : 0;
        const efficientByRank = new Map();
        // Every nominated target / committed item of the slot (two can share one).
        const retained = [];
        let affordable = null, above = null, exchangeEfficient = null, exchangeStrong = null, supplied = null;
        const cheaper = (a, b) => !b || a.price < b.price || a.price === b.price && a.item.selfId < b.item.selfId;
        const better = (a, b) => !b || a.ratio > b.ratio || a.ratio === b.ratio && cheaper(a, b);
        for (const at of allowed) {
            const item = kit.itemAt(at);
            if (acquisitionAllowed && !acquisitionAllowed(item.selfId)) continue;
            const price = Number(ctx.price(item.selfId));
            if (!(price > 0) || Number(current?.selfId) === Number(item.selfId)) continue;
            ctx.budgetBoundary?.(price + Number(ctx.survivalReserve || 0));
            const score = kit.scoreAt(at);
            // A gear step is strictly stronger than the worn piece, at any
            // grade up to the level's: no side-grade (a same-score SA or set
            // alternative included).
            if (!(score > before)) continue;
            const row = { item, price, score, ratio: (score - before) / price };
            if (Number(item.selfId) === target || held.includes(Number(item.selfId))) retained.push(row);
            const rank = String(item.etc?.rank || 'none');
            if (better(row, efficientByRank.get(rank))) efficientByRank.set(rank, row);
            if (exchanges?.has(Number(item.selfId))) {
                if (better(row, exchangeEfficient)) exchangeEfficient = row;
                if (!exchangeStrong || score > exchangeStrong.score || score === exchangeStrong.score && cheaper(row, exchangeStrong)) exchangeStrong = row;
            }
            if (price <= budget && (!affordable || score > affordable.score
                || score === affordable.score && cheaper(row, affordable))) affordable = row;
            if (quoteFor && (!supplied || score >= supplied.score)) {
                const quote = quoteFor(item.selfId);
                const cost = quote && quote.availableUnits >= 1 ? Number(quote.price) + Number(quote.tripFees || 0) : Infinity;
                if (cost < Infinity) ctx.budgetBoundary?.(cost + Number(ctx.survivalReserve || 0));
                if (cost <= budget && (!supplied || score > supplied.score || cost < supplied.cost)) supplied = { row, cost, score };
            }
            if (price > budget && cheaper(row, above)) above = row;
        }
        const selected = new Map();
        // A price-efficient representative of every usable rank keeps intermediate
        // purchases in the comparison, even when the wallet covers a higher one.
        // Rank nominates alternatives, never a required next purchase.
        for (const row of [...retained, ...efficientByRank.values(), affordable, above, exchangeEfficient, exchangeStrong, supplied?.row]) if (row) selected.set(Number(row.item.selfId), row);
        // E303: the finalists cap of 8, per slot per review, cut by value
        // (score gained per adena), never by nomination order.
        if (Diagnostics.active()) {
            Diagnostics.count('cap', 'gear_finalists', 'check');
            if (selected.size > GEAR_FINALISTS_PER_SLOT) {
                Diagnostics.count('cap', 'gear_finalists', 'cut');
                Diagnostics.count('cap', 'gear_finalists', 'dropped', selected.size - GEAR_FINALISTS_PER_SLOT);
            }
        }
        // The plan target and the committed gear goals (focus, preempted;
        // at most 6), the strongest affordable, the strongest exchange and
        // the strongest supplied row are pinned before it.
        let finalists = [...selected.values()];
        if (finalists.length > GEAR_FINALISTS_PER_SLOT) {
            const pinned = new Set([...retained, affordable, exchangeStrong, supplied?.row].filter(Boolean));
            finalists = [...pinned, ...finalists.filter(row => !pinned.has(row))
                .sort((a, b) => better(a, b) ? -1 : better(b, a) ? 1 : 0)];
        }
        result.set(slot, finalists.slice(0, GEAR_FINALISTS_PER_SLOT).map(row => row.item));
    }
    return result;
}
function rows(state) { return Object.values(state.inventory || {}); }
// Direct provider questions use their original owner semantics. Allocation
// stock has a separate root-specific reader (and different reservations).
function quantityReaders(state) {
    let crystalFree;
    return {
        physical: id => Math.max(0, Number(state.inventory?.[id]?.amount) || 0),
        incoming: id => Number(state.acceptedIncoming?.[id] || 0),
        free: id => need('./WealthCraftDecision').freeAmount(state, state.inventory?.[id] || {}),
        crystalFree: id => (crystalFree ||= need('./BotCrystallization').freeReader(state))(id)
    };
}
// The prepared native book is authority, including an empty learned book.
// Workshop entries are the crafter's offer (its twin: the known recipes it
// can craft), a subset of the learned book, read when no book is passed.
function worn(state, slot, inventoryRows = rows(state)) {
    return inventoryRows.find(row => (row.equipped || row.equippedCount > 0)
        && (row.equippedSlots?.length ? row.equippedSlots.includes(slot) : Number(row.slot) === slot)) || null;
}
// This reader belongs to one synchronous review, never to a saved owner.
// Keep the native first-row and equippedSlots rules, including jewellery sides.
function wornReader(state) {
    let inventoryRows;
    const slots = new Map();
    return slot => {
        if (!slots.has(slot)) slots.set(slot, worn(state, slot, inventoryRows ||= rows(state)));
        return slots.get(slot);
    };
}
function replacementWorn(wornFor, slot) {
    return Equipment.isWeaponSlot(slot) ? wornFor(7) || wornFor(14) : wornFor(slot);
}
// What wearing `item` in its slot adds to the bot: its kit profile against
// the numbers with the item worn (ColdCombatProfile.candidateProfiles).
function gearGain(state, item, timestamp = Date.now(), threatMask = 3) {
    return gearGainReader(state, timestamp, {}, undefined, threatMask)(item);
}
// options: the kit profile slot (candidateProfiles; preparation: the future state).
function gearGainReader(state, timestamp, options = {}, caster = require('./BotImprovementPolicy').isCaster(state), threatMask = 3) {
    threatMask = threatMask === 1 ? 1 : 3;
    let candidates, ownWeapon;
    const role = Planner.roleFor(state), classId = Number(state.stats?.classId || state.classId || 0);
    const selectedWeapon = item => {
        if (!Planner.equipmentCandidate(item, state, role)) return false;
        if (ownWeapon === undefined) {
            ownWeapon = null;
            const Data = invoke('GameServer/DataCache');
            const Index = need('../../Item/ItemTemplateIndex');
            // The same native comparison, once per review, includes weapons
            // received but not yet reconciled. Known material slots need no lookup.
            for (const [key, row] of Object.entries(state.inventory || {})) {
                if (!(Number(row.amount) > 0) || Number(row.slot) > 0 && !Equipment.isWeaponSlot(row.slot)) continue;
                const owned = Index.find(Data.items, row.selfId);
                if (Equipment.isWeaponSlot(owned?.etc?.slot) && Planner.equipmentCandidate(owned, state, role)
                    && Planner.equipmentItemBetter(owned, ownWeapon?.item, role, classId)) ownWeapon = { key, item: owned };
            }
        }
        if (!ownWeapon || Planner.equipmentItemBetter(item, ownWeapon.item, role, classId)) return true;
        // Native receipt keys are integer template ids: an equally scored,
        // equally priced newly inserted lower key is encountered first.
        return Number(item.selfId) < Number(ownWeapon.key)
            && !Planner.equipmentItemBetter(ownWeapon.item, item, role, classId);
    };
    return (item, targetSlot = Number(item.etc.slot)) => {
        const slot = targetSlot;
        if (Equipment.isWeaponSlot(slot) && !selectedWeapon(item)) return { attack: 0, defence: 0 };
        candidates ||= Profile.candidateProfiles(state, timestamp, options);
        // The item at enchant 0 in its slot; what it replaces comes off (a
        // weapon both hands, a two-handed one the shield, a jewel its side).
        const before = candidates.before, after = candidates.after({ free: worn => Equipment.equipmentReplacementConflict(slot, worn),
            wear: { selfId: Number(item.selfId), enchant: 0, slot } });
        const attack = caster ? 'mAtk' : 'pAtk';
        const attackGain = Math.max(0, Number(after[attack]) / Math.max(1, Number(before[attack])) - 1);
        const defenceGain = Math.max(0, 1 - Number(before.pDef) / Math.max(1, Number(after.pDef)));
        const magicGain = Math.max(0, 1 - Number(before.mDef) / Math.max(1, Number(after.mDef)));
        return { attack: attackGain, defence: threatMask === 1 ? defenceGain : Math.max(defenceGain, magicGain) };
    };
}
// The one valuation of a gear step against its family (user 2026-10-24):
// the strongest reachable step wins. A step serves until a stronger row of
// its family that is itself taken (evaluated, fundable, its own net > 0
// after the rows stronger than it) is ready and wearable; its benefit after
// that hour is lost: net = value - benefit/h * (H - max(that hour, own ready
// hour, own start)) - effort, H its horizon (the stage's hours). One pass
// from the strongest row down (strength = benefit per hour) over rows
// already evaluated: no extra solve. Returns each evaluated row's net.
function gearStepNets(family) {
    const positive = value => Math.max(0, Number(value) || 0);
    const rows = family.filter(row => row.status === 'evaluated').sort(strongerFirst);
    const nets = new Map(), cutters = [];
    for (const row of rows) {
        const strength = gearStrength(row);
        const start = Math.max(positive(row.wish.readyHours), positive(row.node.notBeforeHours));
        let replaced = Infinity;
        for (const cutter of cutters) if (cutter.strength > strength) replaced = Math.min(replaced, cutter.start);
        const lost = Number.isFinite(replaced) ? strength * Math.max(0, positive(row.node.horizonHours) - Math.max(replaced, start)) : 0;
        const net = row.wish.valueHours - lost - row.wish.effort;
        nets.set(row, net);
        if (net > 0 && Network.fundable(row.wish)) cutters.push({ strength, start });
    }
    return nets;
}
// A gear row's strength (gearStepNets): its benefit per hour.
const gearStrength = row => Math.max(0, Number(row.node.benefitPerHour) || 0);
const strongerFirst = (a, b) => gearStrength(b) - gearStrength(a);
// The one family rank (admission's winners): a fundable row before an
// unfundable one (no ready hour to weigh), then the higher net, then
// before(row, lead); only a positive net leads. lead: { row, net, fundable }.
function offerGearLead(lead, row, net, before) {
    if (!(net > 0)) return;
    const fundable = Number(Network.fundable(row.wish));
    if (!lead.row || fundable > lead.fundable || fundable === lead.fundable
        && (net > lead.net || net === lead.net && before(row, lead.row))) {
        lead.row = row; lead.net = net; lead.fundable = fundable;
    }
}
// A family's leader: entries [row, net] (gearStepNets).
function gearFamilyLead(entries, before) {
    const lead = { row: null, net: 0, fundable: -1 };
    for (const [row, net] of entries) offerGearLead(lead, row, net, before);
    return lead;
}
// A review judges the bot against every drop source of every candidate: its
// combat readiness is computed once for the review (the planner's scope).
function build(state, ctx, deps = {}) {
    const diagnostic = Diagnostics.active();
    if (diagnostic) Diagnostics.count('provider', 'request');
    const started = diagnostic ? performance.now() : 0;
    const result = Planner.withReadiness(() => buildProjection(state, ctx, deps));
    if (diagnostic) {
        Diagnostics.count('provider', 'build', 'context_miss');
        Diagnostics.duration('provider', performance.now() - started);
    }
    return result;
}
// The wait of a buy of n units from a town's players' asks until they are
// its own (WishPurchaseEvidence.unitWait): the quote's units free for its ask
// (its units less the other n - 1) against the units rival takers hold on the
// town's asks before the bot (CommittedExits.rivalTakerUnits, the quote's town
// code), over the item's observed supply (MarketDemand.supplyPerHour). An
// NPC's stock (Infinity) never waits. waitHours 0 or the wait, takers [town
// code, free units] the wake row reads (EconomyContext.marketWatchRows,
// DecisionSections TAKERS): a unit is free for the ask once rivals hold fewer.
// A buy short of n waits by the same rule for its first unit: the town's
// units held by rivals are not on sale to it now (componentroute 2026-10-25).
// The units it lacks queue behind every other buyer's bids on the item too
// (board: the build's board, BoardIndex.buyUnits without its own lines, any
// town, like the supply; luxwait 2026-10-25), those priced at or above the
// bid it would post for them (bidPrice: the no-seller price sizedBuyFor
// charges them, the one planning price; never its standing bid's, a route's
// own output read back into the route sort, luxwait3; an estimate: sellers
// rank the top 20 bids by value net of their trip, MarketPricing.bestAnswer,
// the higher bid mostly first, luxwait2): shortHours only, the step's wait
// and its wake row read the takers alone.
function buyWait(id, quote, n, characterId, timestamp, board = null, bidPrice = 0) {
    if (quote?.sourceType !== 'afk' || !(quote.availableUnits < Infinity)) return { waitHours: 0 };
    const code = need('./ShotCraftPolicy').townCode(quote.town);
    // A town that sells fewer than the n units asked (Network.shortOf, the
    // parent's test too) is a partial fill: the bot buys what it sells (the
    // parent's test, WishNetwork solve, bids for the rest).
    const short = Network.shortOf(quote, n) > 0;
    if (!(code > 0) && !short) return { waitHours: 0 };
    // A town with no code has no rival takers to read: none ahead.
    const rivals = code > 0 ? need('./CommittedExits').rivalTakerUnits(id, code, characterId) : 0;
    let rate;
    const supply = () => rate ??= need('./MarketDemand').supplyPerHour(id, timestamp);
    const Evidence = need('./WishPurchaseEvidence');
    // The units free for the ask: the quote's units less the other n - 1 it
    // asks; a short buy's step asks one of them first: its units whole.
    const free = short ? quote.availableUnits : quote.availableUnits - (n - 1);
    const hours = Evidence.unitWait({ units: free, rivals, supply });
    const wait = hours > 0 ? { waitHours: hours, takers: [code, free] } : { waitHours: 0 };
    if (!short) return wait;
    // shortHours: when all n are there after the step's wait, the units it
    // lacks coming after the rivals' (unitWait, units <= 0); the route
    // sort's completion time (WishNetwork solve adds it to the path's hours,
    // the wait in them), never the step's wait.
    const bids = board?.buyUnits ? board.buyUnits(id, characterId, bidPrice) : 0;
    const all = Evidence.unitWait({ units: quote.availableUnits - (n - 1), rivals: rivals + bids, supply });
    return { ...wait, shortHours: Number.isFinite(hours) ? all - hours : all };
}
// The buy path for the n units a parent asks (WishNetwork solve): the town
// and asks a buyer of n takes (the reader's sized quote) and its wait
// (buyWait), once per amount a build asks; the one-unit path itself (the
// same object) while the reader's one-unit quote holds for n and the n units
// wait no longer than one. Made here, not in buildProjection: V8 keeps one
// context per function scope, so a closure made there would hold the whole
// build scope for as long as its buy lives (partyheap, the worker heap
// 10-25); this one holds only what it reads: the buy, the item, the build's
// buy reader, the bot and the build's hour. Every buy path a route can pick
// is sized here: the elsewhere buy too (taken: the town whose asks it
// leaves out; wake: the first buy's wake row it keeps while its own wait
// has none). A town that sells fewer than n
// (Network.shortOf, componentroute 2026-10-25) keeps its step's price (the
// quote's mean: the units on sale bought now, funding and leaves read it)
// and carries what all n cost and when they arrive, read only by the route
// sort (WishNetwork solve): shortPrice, a unit's share of what the units it
// lacks add at the no-seller price (listPrice: the node's price(id), at
// least the NPC buy-back, the floor the no-seller buy's bid carries,
// buyback), and shortHours (buyWait, the build's board: other buyers' bids
// at or above that same price, the bot's own lines left out and never its
// place; luxwait3).
function sizedBuyFor(buy, id, purchaseFor, characterId, timestamp, listPrice, buyback, board, taken = null, wake = undefined) {
    let sized = null;
    return n => {
        if (!(n > 1)) return buy;
        let path = sized?.get(n);
        if (!path) {
            // An elsewhere quote is a new object at every read: never the same.
            const quote = purchaseFor(id, n, taken), same = !quote || (!taken && quote === purchaseFor(id));
            const bought = same ? buy : quote, short = Network.shortOf(bought, n);
            // The no-seller price the units it lacks cost: their bid too, the
            // one price their queue is read at (luxwait3). A bid counts only
            // above the NPC buy-back (PriceDecision.aboveBuyback, the board's
            // one floor): below it the bid stands at the floor, the buy-back
            // the network's bidFloor charges too.
            const floor = short > 0 ? buyback(id) : 0;
            const bidPrice = short > 0 ? need('./PriceDecision').aboveBuyback(listPrice, floor) ? listPrice : floor : 0;
            const wait = buyWait(id, bought, n, characterId, timestamp, board, bidPrice);
            path = same && !(short > 0) && wait.waitHours === buy.waitHours ? buy
                : { ...buy, ...(same ? {} : quote), takers: wake, shortHours: undefined, shortPrice: undefined, ...wait,
                    ...(short > 0 ? { shortPrice: (bidPrice - bought.price) * short / n } : {}) };
            (sized ||= new Map()).set(n, path);
        }
        return path;
    };
}
function buildProjection(state, ctx, deps) {
    // Diagnostics only: wall time per block (provider:<block>); a lazy source
    // closure counts in the block that calls it. Null while diagnostics are off.
    const blocks = Diagnostics.laps('provider:');
    const nativeQuantities = quantityReaders(state), quantityInputs = ctx.quantityInputs;
    // The committed goals every source below keeps past its cap (committedOf).
    const committed = new Set(ctx.committedKeys || committedOf(state));
    // The committed progression goals, and the earning roots that fund one
    // (they follow the root they fund in the cut), a cap left out (no room,
    // still valid by their source): WishNetwork.build keeps their dormant
    // rows (capped).
    const capped = [];
    const keepCapped = node => {
        if (node && committed.has(node.key) && (Number(node.progressionPriority) > 0 || node.progressionFunding)
            && !capped.includes(node.key)) capped.push(node.key);
    };
    const physical = id => {
        const value = nativeQuantities.physical(id);
        quantityInputs?.physical(id, value); return value;
    };
    const present = id => {
        const value = nativeQuantities.physical(id);
        quantityInputs?.present(id, value); return value > 0;
    };
    // Read as an amount (an offer's old units): no threshold, untracked.
    const free = id => {
        const value = nativeQuantities.free(id);
        quantityInputs?.free(id, value); quantityInputs?.untracked('free', id); return value;
    };
    const hasFree = id => {
        const value = nativeQuantities.free(id);
        quantityInputs?.freePresent(id, value); return value > 0;
    };
    const incoming = id => {
        const value = nativeQuantities.incoming(id);
        quantityInputs?.incoming(id, value); return value;
    };
    const timestamp = ctx.timestamp ?? Date.now();
    const magic = need('./BotImprovementPolicy').isCaster(state);
    const Recipes = invoke('GameServer/Items/C4RecipeItems'), Profit = need('./CraftProfitPolicy');
    // `nodes` is the current target: the real projection, or one gear
    // candidate's scratch arena while it is evaluated (MVP-6).
    // `nodeKeys` holds the keys of `nodes` (the same target), so a membership
    // test is one lookup instead of a scan; `add` is the only writer of both
    // and `rollback` the only one that takes nodes back.
    // Only path builders (inputs, itemNode, craftPath) build within
    // Network.MAX_NODES; roots, farm leaves and admitted gear join over it,
    // and the one value cut (Network.admitRoots below) keeps roots by rank,
    // not by build order.
    let nodes = [], nodeKeys = new Set(), scratch = false;
    const roots = [], values = new Map();
    const add = node => { if (nodeKeys.has(node.key)) return false;
        nodes.push(node); nodeKeys.add(node.key); return true; };
    const rollback = mark => { for (const node of nodes.splice(mark)) nodeKeys.delete(node.key); };
    // One descriptor per item key in this build, shared by the scratch
    // arenas and the real graph, so a witness and its expanded root read
    // identical nodes. ARCH-NOTE: dies at return; at most Network.MAX_NODES
    // per target, no owner store. Every build walks its sources anew.
    const descriptors = new Map();
    // The item ids each descriptor's construction read: a reuse reports them again.
    const descriptorInputs = new Map();
    // The read scope of the candidate whose arena built each descriptor;
    // only scopes with a descriptor in the final cut become inputs.
    const builtBy = new Map();
    let readScope = null;
    const include = key => {
        if (nodeKeys.has(key)) return;
        const node = descriptors.get(key);
        if (!node) return;
        for (const path of node.paths || []) {
            for (const row of path.requirements || []) include(row.key);
            for (const row of path.grossRequirements || []) include(row.key);
        }
        add(node);
    };
    const root = node => {
        if (node.object?.itemId && !Sources.hasSource(node.object.itemId)) return false;
        if (!add(node)) return false;
        roots.push(node.key); return true;
    };
    // One path's inputs ({ selfId, amount, once } -> { key, amount, once })
    // at `depth`: all of them enter the graph leaving one slot for the node
    // that owns the path, or none does (null) and the nodes they added are
    // taken back, so a path that does not enter holds no place in the bound.
    const inputs = (rows, depth) => {
        const mark = nodes.length, requirements = [];
        for (const row of rows) {
            const key = itemNode(row.selfId, depth);
            if (!key) { rollback(mark); return null; }
            requirements.push({ key, amount: row.amount, ...(row.once ? { once: true } : {}) });
        }
        if (nodes.length >= Network.MAX_NODES) { rollback(mark); return null; }
        return requirements;
    };
    const positive = value => Math.max(0, Number(value) || 0);
    const price = id => ctx.price(id);
    // A context without market evidence (a test's own price table) knows no sold price.
    const soldPriceOf = id => ctx.soldPrice ? ctx.soldPrice(id) : 0;
    const horizon = decisionHorizon(state, ctx);
    const progression = Progression.assess(state);
    // Every reader but the gear root choice keeps the author's acquisition kit.
    const acquisitionKit = Progression.acquisition(state, progression);
    const preparation = Progression.preparation(state, progression);
    const futureHorizon = preparation ? stageHours(preparation, ctx.hunt.expPerHour, ctx.persona) : 0;
    // Keyed on the C kit milestone (PersonalGearProgression.assess
    // milestone): C luxury recipes load while it is open.
    const cKitOpen = progression.milestone.required;
    // A clan equipment owner's next crystal (or its luxury delivery): one
    // root over the crystal's item node below (ClanCrystalSupply).
    const clanSupply = state.stats?.equipmentPlan?.clanGoal?.clanId && need('./ClanCrystalSupply').requirement(state);
    // The luxury shop sells C gear (BotLuxuryExchange): from the C level (or
    // while preparing for it) until the B level, past it while the C kit is
    // still open; the levels are the grade rule's (GearGradeRule).
    const luxury = (clanSupply?.plan?.strategy === 'luxury_exchange'
        || Progression.allowsCGradeAcquisition(state) && (state.level < levelForGrade('b') || cKitOpen)
            && (state.level >= levelForGrade('c') || preparation))
        ? need('./BotLuxuryExchange').recipes() : null;
    const powerWeight = (ctx.persona.primaryDrive === 'progression' ? 1 : 0.5) + trait(ctx.persona, 'caution');
    const sourceIndex = deps.spots?.length ? Planner.sourceIndexFor(deps.spots) : null;
    // ARCH-NOTE: PERF: Native repeated source reads fell 7004→1395 / 7229→1408;
    // exact 600 whole preparation mean 2.165→1.985 ms / max 27.369→21.393 ms.
    // Fixed state/time/persona make spotValue pure within this build.
    // This local map dies at return: ~468 KB transient per measured build,
    // zero ArrayBuffers and zero maps retained after return + GC; no owner store.
    const sourceValues = new Map();
    // ARCH-NOTE: PERF: native same-input provider replay (60 builds/variant)
    // 124.56 -> 27.28 ms; nine complete projections byte-equal. Reuse the
    // existing 16,384-entry yield bound and atlas counts, no per-bot retention.
    // Shared-host offline result only; not a live throughput/budget claim.
    // A spot value reads items (its recipe scrolls' market facts): they are
    // kept with it and read again on a hit, as farmFacts below, so a value
    // first read in a rejected candidate's arena joins a retained one's reads.
    const spotValue = spot => {
        let entry = sourceValues.get(spot);
        if (entry === undefined) {
            const input = ctx.nodeInputs?.begin();
            try {
                const value = ctx.spotValue(spot);
                // The scope's Set itself: closed at end() below, never written again.
                entry = { value, inputs: input?.items.size ? { items: input.items } : null };
            } finally { if (input) ctx.nodeInputs.end(); }
            sourceValues.set(spot, entry);
        } else if (entry.inputs) ctx.nodeInputs.keep(entry.inputs);
        return entry.value;
    };
    // Task 2 readers: one combat profile, spoil eligibility, craft labour and
    // trip map per build, shared by every farm and craft fact; they die at return.
    let combat = null, spoiler;
    const profile = () => combat ??= Profile.profileFor(state, timestamp);
    const Occupation = invoke('GameServer/Bot/Population/ColdOccupationSources');
    let labour = null;
    const craftLabour = () => labour ??= Occupation.craftLabour(state, timestamp, profile);
    const sourceTrips = new Map(), farmFacts = new Map();
    // The bot's ground verdict per spot, kept with its held build while no
    // source section moved (deps.sourceGround, EconomyContext's).
    const sourceGround = Planner.sourceGround(deps.spots || [], deps.sourceGround);
    const routeAllowed = Planner.sourceRouteReader(state, { timestamp, matchupProfiles: deps.soloProfiles, ground: sourceGround });
    const knownRecipes = new Set(ItemDisposition.knownRecipeIds(state, deps.knownRecipes));
    const preparingItems = new Set();
    // The one buy reader of every item node (wear, buy, input): the best
    // landed offer over the board and the NPCs, each with its trip (R1).
    const purchaseFor = need('./WishPurchaseEvidence').reader(state, ctx, deps);
    // Giran's NPC alone (no board), built at its first read: the D crystal
    // sweeps' retail source (crystalChoices). Its quotes stay out of the
    // build's entries: every item node buys at purchaseFor.
    let giranReader = null;
    const giranNpc = () => giranReader ||= need('./WishPurchaseEvidence').reader(state, ctx, deps, { npcOnly: true, town: 'Giran' });
    // A grade's crystal catalogue sweep, once per build (BotCrystallization
    // .catalog): the input pieces and their cost per crystal (BotCrystallization
    // .choices, the one ranker; a held piece at its held item node's price,
    // a bought one at its landed cost), read by the own-need node
    // (item:<crystal>) and the crystal sale root alike. D: gear at Giran's
    // NPC (unlimited, never above the board's D price); C-S: the grade's gear
    // with a sell line on the board (no NPC sells it; BotCrystallization
    // .listed, the board's group list, never the catalogue), quoted by the
    // build's one buy reader (purchaseFor: an id an item node also reads is
    // quoted once); each quoted id is a build read (the watched board). The
    // listed set is read like the farm roots' buy items (ctx.board.itemIds):
    // a newly listed piece joins at the next build; the held build hears the
    // market through its watch list (EconomyContext watchedBoard). No Giran
    // NPC quote enters purchaseFor's entries. The rows die at return;
    // a later reader in another node scope gets the sweep's board reads again
    // (ctx.nodeInputs.keep).
    const crystalSweeps = new Map(), ownPrice = id => positive(price(id));
    const crystalChoices = rank => {
        let sweep = crystalSweeps.get(rank);
        if (!sweep) {
            const Crystals = need('./BotCrystallization'), input = ctx.nodeInputs?.begin();
            try {
            const purchase = rank === 'd' ? giranNpc()
                : purchaseFor;
            const rows = Crystals.choices(state, purchase, ctx.hourAdena, rank, quantityInputs, profile, ownPrice,
                rank === 'd' ? null : ctx.board);
            crystalSweeps.set(rank, sweep = { rows, inputs: input && { items: input.items } });
            } finally { if (input) ctx.nodeInputs.end(); }
        }
        if (sweep.inputs) ctx.nodeInputs.keep(sweep.inputs);
        return sweep.rows;
    };
    blocks?.lap('build');
    // The farm or spoil path reads GearAcquisitionPlanner.sourceFacts: the
    // hunt rules the bot hunts by (D4-D6), an hour at its net cost (D7). The
    // trip is one row per town in the network, never once per unit.
    // Whether the bot spoils (KillRewards.spoilerFor), read once per
    // build and only when a spoil record is in question.
    const isSpoiler = () => {
        if (spoiler === undefined) spoiler = KillRewards.spoilerFor(state,
            { skills: Profile.skillsFor(state) }) || false;
        return spoiler;
    };
    const sourcePath = id => {
        if (!sourceIndex?.has(Number(id))) return null;
        if (Progression.isCGradeHelmet(need('../../Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, Number(id)))) return null;
        const factsKey = Number(id);
        if (!farmFacts.has(factsKey)) {
            const input = ctx.nodeInputs?.begin();
            try {
            if (sourceIndex.get(Number(id)).some(entry => entry.kind === 'spoil')) isSpoiler();
            // Only the best ready fact comes back; with diagnostics every record is
            // also counted as ready or by its reason (refusals only as counts).
            const diagnostic = Diagnostics.active(), reasons = diagnostic ? new Map() : null;
            const steps = Planner.sourceFacts(state, id, 1, { spots: deps.spots, spotValue,
                trips: sourceTrips, trip: deps.tripCost || ctx.trip || { details: () => ({ known: false }) }, spoiler, timestamp,
                economicLower: acquisitionKit.required || !!spoiler, readyOnly: true, counts: reasons, routeAllowed,
                bestForWish: { progressionRequired: acquisitionKit.required, hourAdena: ctx.hourAdena } });
            let step;
            do step = steps.next(); while (!step.done);
            const best = step.value[0] || null;
            // One count per reason and item: a per-fact count cost 4% of the worker.
            if (diagnostic) {
                for (const [reason, amount] of reasons) Diagnostics.count('provider', 'source_fact', reason, amount);
                Diagnostics.count('provider', 'source_path', best ? 'ready' : reasons.size ? 'refused' : 'no_source');
            }
            farmFacts.set(factsKey, { best, inputs: input && { items: input.items } });
            } finally { if (input) ctx.nodeInputs.end(); }
        }
        const { best, inputs } = farmFacts.get(factsKey);
        // A later retained candidate may reuse a fact first read in a rejected
        // arena. Reattach every competing source read, including absent paths.
        if (inputs) ctx.nodeInputs.keep(inputs);
        return best ? { kind: best.kind, activity: 'hunting', costHours: best.hours * best.netHourCost, readyHours: best.hours,
            spotId: best.spotId, npcId: best.npcId, itemId: Number(id), amount: 1,
            ...(best.town ? { town: best.town, tripHours: best.tripHours, tripFees: best.tripFees } : {}) } : null;
    };
    // The item node's paths to an item (itemNode builds them), one rule for
    // the node and the scroll verdict (scrollSource): a buy is available
    // when the item is on sale at a known trip (purchaseFor,
    // WishPurchaseEvidence) or is a non-raid item (ordinary =
    // Sources.hasNonRaidSource) with a believed price (nobody sells it: a
    // bid at least at that price); a farm path is the best ready source fact
    // (sourcePath), none for a luxury piece or a market-only item.
    const buyAvailable = (id, ordinary) => ordinary && price(id) > 0 || !!purchaseFor(id);
    const marketOnlyItem = id => Progression.marketOnly?.(state, need('../../Item/ItemTemplateIndex').find(DataCache.items, Number(id)), acquisitionKit);
    const farmPath = (id, marketOnly = marketOnlyItem(id)) => !marketOnly && sourcePath(id);
    // The one verdict "can this craft run now" (a producer row carries it as
    // recipeReady, WealthCraftDecision.producerStep reads it): a known
    // recipe or a free held scroll the learner takes (the network's stock
    // reader) is ready; a scroll its item node has a path to (buyAvailable
    // or farmPath) is to find (SOURCE); a recipe the learner refuses (its
    // held scroll nets nothing, no scroll is bought) or a scroll with no
    // path: null, never. Which path brings it is the scroll's item node's
    // choice (buy on sale, farm, else a bid; WishNetwork solve sort, R3;
    // user 2026-10-24), never this verdict's. Admission takes ready rows
    // and one scroll to find; craftPath plans any non-null. scrollReadiness
    // is its part that reads no source: SCROLL_READY, null (refused) or
    // SCROLL_SOURCE.
    const scrollReadiness = recipe => {
        if (knownRecipes.has(Number(recipe.recipeId))) return SCROLL_READY;
        if (!need('./WealthCraftDecision').learnsRecipe(state, recipe)) return null;
        return hasFree(recipe.recipeItemId) ? SCROLL_READY : SCROLL_SOURCE;
    };
    const scrollSource = (recipe, readiness = scrollReadiness(recipe)) => {
        if (readiness !== SCROLL_SOURCE) return readiness;
        const id = recipe.recipeItemId, ordinary = Sources.hasNonRaidSource(id);
        return buyAvailable(id, ordinary) || ordinary && farmPath(id) ? SCROLL_SOURCE : null;
    };
    // The craft path reads CraftProfitPolicy.craftFacts, as the producer
    // does: gross inputs only (the network's stock reader subtracts held and
    // incoming units once), native commands and labour hours. Held inputs are
    // valued by the network at their exit value, never here.
    // batches: the commands one path plans (a producer root sized by its
    // exit); every other path is one batch.
    const craftPath = (recipe, id, depth = 0, ownOnly = false, batches = 1) => {
        if (!Sources.allowsRecipe(recipe)) return null;
        const dual = recipe?.kind === 'dual_sword_combine';
        const ownCapable = recipe && (dual || invoke('GameServer/Bot/Economy/CraftShopService').canCraft(state, recipe));
        const earlyCustomer = !ownCapable && state.level < 40 && Progression.personal(state) && !preparation;
        // A visible early buyer can order consumables without changing the
        // authored equipment progression or the cold executor's admission.
        if (earlyCustomer && (state.phase !== 'hot'
            || Number(need('../../Item/ItemTemplateIndex').find(DataCache.items, Number(id))?.etc?.slot) > 0)) return null;
        const own = ownCapable ? Profit.craftFacts(recipe, { batches: 1, ...craftLabour() }) : null;
        let workshop = !ownOnly && recipe && deps.workshops ? knownWorkshop(recipe, state, ctx, deps) : null;
        if (workshop && own?.status === 'ready' && knownRecipes.has(Number(recipe.recipeId))
            && Profit.labour(recipe, { hourAdena: ctx.hourAdena || ctx.hunt?.perHour, mpPerHour: craftLabour().mpPerHour })?.adena <= workshop.cost) workshop = null;
        if (recipe && (ownCapable || workshop) && nodes.length + recipe.materials.length < Network.MAX_NODES) {
            const learned = !!workshop || dual || knownRecipes.has(Number(recipe.recipeId));
            if (!learned && scrollSource(recipe) == null) return null;
            const facts = workshop ? Profit.craftFacts(recipe, { batches: 1, executor: 'workshop',
                capacityBatches: workshop.capacityBatches, fee: workshop.price, recipeInput: 0 })
                : Profit.craftFacts(recipe, { batches, ...craftLabour(),
                    recipeInput: learned ? 0 : recipe.recipeItemId });
            if (facts.status !== 'ready') return null;
            // A physical attempt consumes one whole command, including failure.
            // Its chance reduces the finite root benefit once per command;
            // inputs are not divided by expected yield.
            const cycleHours = workshop ? 1 / 3600 : dual ? Number(recipe.costHours || 1 / 3600) : facts.labourHours;
            if (!(cycleHours > 0)) return null;
            const grossRequirements = inputs([...facts.gross].map(([selfId, amount]) =>
                ({ selfId, amount, once: facts.once.has(selfId) })), depth + 1);
            if (!grossRequirements) return null;
            return { kind: 'craft', activity: 'crafting', itemId: Number(id), recipeId: recipe.recipeId,
                ...(workshop ? { workshop, price: facts.fee, town: workshop.townName,
                    tripHours: workshop.tripHours, tripFees: workshop.tripFees,
                    executable: workshop.capacityBatches > 0, availableUnits: workshop.capacityBatches * facts.productCount, quoted: true } : {}),
                requiresRecipeLearning: !learned, successProbability: facts.successProbability, perCommand: facts.perCommand,
                costHours: cycleHours, productCount: facts.productCount, grossRequirements };
        }
        return null;
    };
    const itemNode = (id, depth = 0) => {
        if (!Sources.hasSource(id)) return null;
        const key = `item:${id}`;
        if (nodeKeys.has(key)) return key;
        if (depth >= 3 || nodes.length >= Network.MAX_NODES || preparingItems.has(key)) return null;
        // A descriptor this build already made enters the real graph under the
        // same node bound (Network.MAX_NODES) as a fresh one: its whole missing closure is counted
        // first. A candidate's scratch arena copies it whole, so its witness
        // reads the real graph's descriptors; the arena bound is the evaluation's.
        // Its quantity reads are already in the build-wide quantityInputs.
        if (descriptors.has(key)) {
            if (descriptorInputs.has(key)) {
                ctx.nodeInputs.keep(descriptorInputs.get(key));
                if (scratch && readScope) builtBy.set(key, readScope);
            }
            const missing = new Set();
            const collect = at => {
                if (missing.has(at) || nodeKeys.has(at) || !descriptors.has(at)) return;
                missing.add(at);
                for (const path of descriptors.get(at).paths || []) {
                    for (const row of path.requirements || []) collect(row.key);
                    for (const row of path.grossRequirements || []) collect(row.key);
                }
            };
            collect(key);
            if (!scratch && nodes.length + missing.size > Network.MAX_NODES) return null;
            include(key); return key;
        }
        const local = ctx.nodeInputs?.begin();
        try {
        const observed = purchaseFor(id);
        // A raid origin belongs to the clan's prepared roster. A personal
        // wish needs actual owned stock or a finite supplier, not a price.
        const ordinary = Sources.hasNonRaidSource(id);
        if (!ordinary && !observed && !present(id)) return null;
        preparingItems.add(key);
        const marketOnly = marketOnlyItem(id);
        // waitHours: how long a unit of its own takes (buyWait); a consumer's
        // buy that waits has no step now and is ready only then (WishNetwork).
        const listPrice = price(id);
        const buy = { kind: 'buy', activity: 'shopping', price: listPrice, itemId: Number(id), amount: 1,
            available: buyAvailable(id, ordinary), executable: !!observed,
            // No seller offers it: a buyer's-line producer bids for it, at
            // least its NPC buy-back (WishNetwork bidFloor).
            ...(observed || { availableUnits: 0, buyback: ctx.buyback(id) }), ...buyWait(id, observed, 1, state.characterId, timestamp) };
        // Priced again for more units (sizedBuyFor).
        if (observed) Network.sizedBuy(buy, sizedBuyFor(buy, id, purchaseFor, state.characterId, timestamp, listPrice, ctx.buyback, ctx.board));
        const paths = [buy];
        // An ask rival takers hold (a wait) leaves the rest of the market: the
        // reader's quote without that town's asks (its NPC, another town's
        // ask or NPC) is a second buy path, ready now unless it waits too
        // (WishNetwork sort: executable first, readyFirst). It joins the
        // node's paths past their cut below, never in place of one. Ready, it
        // keeps the first buy's wake row (takers, EconomyContext
        // marketWatchRows): the taken ask freed, the cheaper buy comes back.
        const other = buy.waitHours > 0 ? purchaseFor(id, 1, observed.town) : null;
        const otherWait = other ? buyWait(id, other, 1, state.characterId, timestamp) : null;
        const second = other ? { ...buy, ...other, ...otherWait, takers: otherWait.takers || buy.takers } : null;
        // Sized like the first buy (sizedBuyFor): a parent's n units from the
        // market without that town's asks, short of n priced the same way.
        if (second) Network.sizedBuy(second, sizedBuyFor(second, id, purchaseFor, state.characterId, timestamp, listPrice, ctx.buyback, ctx.board, observed.town, buy.takers));
        const drop = farmPath(id, marketOnly);
        if (drop) paths.push(drop);
        const crystal = invoke('GameServer/Bot/Economy/BotImprovementPolicy').crystalPath(state, id, ctx, deps.spots || []);
        if (crystal) paths.push(crystal);
        const recipes = Recipes.resolveVariantsByProductId(id);
        const targetTemplate = need('../../Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, Number(id));
        const unseal = targetTemplate?.etc?.rank === 'b' && [9, 12].includes(Number(targetTemplate.etc.slot))
            ? invoke('GameServer/Items/C4Unseal').forProduct(id) : null;
        if (unseal) {
            const trip = ctx.trip?.details?.('Giran');
            const input = trip?.known && inputs([{ selfId: unseal.sourceId, amount: 1 }], depth + 1);
            if (input) paths.push({ kind: 'mammon_unseal', activity: 'crafting',
                itemId: Number(id), unseal: { sourceId: unseal.sourceId, productId: unseal.productId },
                costHours: 1 / 3600, town: 'Giran', quoted: true, tripHours: trip.hours, tripFees: trip.fees,
                grossRequirements: input });
        }
        // A dual sword has one combination per product: the owner's index, not a filter per node.
        const combination = recipes.length ? null : DualSwords.resolveByProductId(id);
        const alternatives = recipes.length ? recipes : combination ? [combination] : [];
        for (const recipe of marketOnly ? [] : alternatives) {
            const craft = craftPath(recipe, id, depth);
            if (craft) paths.push(craft);
        }
        const exchange = luxury?.get(Number(id));
        if (exchange) {
            const trip = ctx.trip?.details?.('Giran');
            const requirements = trip?.known && inputs(exchange.materials, depth + 1);
            if (requirements) paths.push({ kind: 'luxury_exchange',
                activity: 'improving', itemId: Number(id), costHours: 1 / 3600,
                town: 'Giran', quoted: true, tripHours: trip.hours, tripFees: trip.fees,
                improvement: { kind: 'luxury_exchange', ...exchange }, grossRequirements: requirements });
        }
        // Any grade's crystals: the pieces this bot breaks with its own skill
        // (BotCrystallization.canSelf), from the grade's one sweep.
        const Crystals = need('./BotCrystallization'), crystalRank = Crystals.CRYSTAL_RANKS.get(Number(id));
        if (crystalRank && Crystals.canSelf(state, crystalRank)) {
            const choices = crystalChoices(crystalRank);
            // A funded C kit has an authored unlimited D supplier. Preserve
            // that chain instead of forecasting thousands of crystals from
            // one small public lot and repeatedly changing counterparties.
            if (luxury && choices.some(choice => choice.sourceType === 'npc')) paths.length = 0;
            for (const choice of choices) {
                const requirements = inputs(choice.inputs || [{ selfId: choice.selfId, amount: 1 }], depth + 1);
                if (!requirements) continue;
                paths.push({ ...Crystals.path(id, choice.inputs || choice.selfId),
                    productCount: choice.net, batchLimit: choice.batchLimit,
                    availableUnits: choice.net * choice.batchLimit, quoted: true, grossRequirements: requirements });
            }
        }
        // Held units are worth the bot's own price (PriceBelief.reader), the
        // same node price its wish pays for missing ones.
        // A node made from inputs (craft, exchange, crystallize, unseal)
        // carries its market price too (PriceBelief soldPrice, 0 untraded):
        // the solve's input ceiling (WishNetwork inputCap) reads it.
        // Own paths up to the node bound less the second buy's place
        // (Network.MAX_PATHS): the second joins past the cut, never in place of one.
        const kept = paths.slice(0, Network.MAX_PATHS - 1);
        if (second && kept[0] === buy) kept.splice(1, 0, second);
        const soldPrice = kept.some(path => path.grossRequirements?.length) ? soldPriceOf(id) : 0;
        const node = { key, object: Number(id), price: price(id), ...(soldPrice > 0 ? { soldPrice } : {}), paths: kept };
        descriptors.set(key, node);
        if (local) descriptorInputs.set(key, { items: [...local.items] });
        if (scratch && readScope) builtBy.set(key, readScope);
        add(node);
        preparingItems.delete(key);
        return key;
        } finally { if (local) ctx.nodeInputs.end(); }
    };
    if (clanSupply) {
        const key = itemNode(clanSupply.selfId);
        if (key) root({ key: clanSupply.key, need: 'power',
            object: { itemId: Number(clanSupply.plan.target.selfId), slot: Number(clanSupply.plan.target.slot), clanSupply: true },
            valueHours: Math.max(1, horizon), progressionPriority: 3.5, personalAcquisition: true,
            paths: [{ requirements: [{ key, amount: clanSupply.amount }] }] });
    }
    // A finite earning goal uses the existing resale certificate and input
    // graph. The finished product is output, never a preparatory BUY leaf.
    // Only finalists expand their recipe DAG; public candidates come from the
    // worker's existing item->recipe index, not a per-actor catalogue scan.
    const producerCandidates = function* () {
        for (const id of knownRecipes) yield Recipes.resolveByRecipeId(id);
        for (const row of rows(state)) {
            const amount = need('./WealthCraftDecision').freeAmount(state, row);
            // EC fences bag identities; this native branch depends only on
            // whether its row has any free units, not the positive count.
            if (quantityInputs) {
                if (state.inventory?.[row.selfId] !== row) quantityInputs.unsupported();
                else quantityInputs.freePresent(row.selfId, amount);
            }
            if (amount > 0) yield Recipes.resolve?.(Number(row.selfId));
        }
        yield* deps.producerRecipes || [];
    };
    const production = new Map(), seenProduction = new Set();
    const investment = state.stats?.shotRecipeDemand;
    const investmentId = Number(investment?.at) + 30 * 60 * 1000 > timestamp ? Number(investment.itemId) : 0;
    // The crystal exits the producer block found, rooted after its finalists.
    const crystalExits = [];
    // The lots of `perLot` units one craft-for-sale exit takes, 1..`cap`
    // (0: none): a listing exit the batches its demand remainder takes
    // (ShotSalePolicy.exit maxBatches), a buyer's line the lots it takes
    // beyond the `oldUnits` held, incoming or listed (Price.bidLots, the one
    // owner). One sizing for the producer, crystal and farm roots, so the
    // network buys or farms inputs only for units the line takes.
    const exitLots = (offer, perLot, oldUnits, cap, asks = ctx.board.list(Number(offer.selfId), SELL)) => offer.type === 'listing'
        ? Math.max(1, Math.min(cap, Math.floor(Number(offer.maxBatches) || 1)))
        : need('./PriceDecision').bidLots(state, offer, { board: ctx.board, timestamp, asks, oldUnits, perLot, cap,
            producer: Number(state.characterId) });
    // The bot's own plain sell lines by item (Price.plainSale), grouped once
    // per build at the first read, not once per candidate; and the one count
    // of a sale exit's old units: free, incoming and on those lines
    // (Price.heldUnits), for the producer, crystal and farm lines alike.
    let ownSalesByItem = null;
    const ownSalesOf = id => {
        if (!ownSalesByItem) {
            ownSalesByItem = new Map();
            for (const line of ctx.board.ownerLines?.(state.characterId) || []) {
                if (!need('./PriceDecision').plainSale(line)) continue;
                const item = Number(line.selfId);
                if (!ownSalesByItem.has(item)) ownSalesByItem.set(item, []);
                ownSalesByItem.get(item).push(line);
            }
        }
        return ownSalesByItem.get(Number(id)) || [];
    };
    const oldUnitsOf = id => need('./PriceDecision').heldUnits(free(id), incoming(id), ownSalesOf(id));
    const serviceCraft = invoke('GameServer/Bot/Economy/CraftShopService');
    if (ctx.board && ctx.hourAdena > 0 && serviceCraft.marketProducer(state)) {
        // Plan bound (E92 "Performance, fixed bounds"): preliminary admission
        // reads only the RecipeProductionIndex rows and O(1) facts per recipe;
        // the detailed exit pricing runs for PRODUCER_PRICED finalists only.
        const Price = need('./PriceDecision'), MarketDemand = need('./MarketDemand');
        const Profit = need('./CraftProfitPolicy');
        // The same offer guard admits a candidate and opens its detailed pricing.
        const usableExit = (offer, ownSales) => Number(offer.ownerId) !== Number(state.characterId) && !Number(offer.enchant || 0)
            && offer.count > 0 && offer.price > 0 && !ownSales.some(line => line.price !== offer.price);
        // What one exit pays for `batches` lots of `count` units beyond the
        // `oldUnits` already held or listed: a listing exit its sale over the
        // forecast (ShotSalePolicy.exit), a bid line its sale (Price.bidSale,
        // the units it leaves at `residual` each); with the trip to its town.
        // Null when the exit is not usable, its town unknown or the sale pays
        // nothing. The one gross-per-offer reading of the producer loop and
        // the crystal root.
        const exitGross = (offer, count, batches, oldUnits, ownSales, asks, residual) => {
            if (!usableExit(offer, ownSales)) return null;
            const trip = ctx.trip?.details?.(offer.town);
            if (!trip?.known || ![trip.hours, trip.fees].every(value => Number.isFinite(value) && value >= 0)) return null;
            const sale = offer.type === 'listing' ? (() => {
                const input = { applicableUnits: offer.applicableUnits, willingUnits: offer.willingUnits,
                    cheaperUnits: offer.cheaperUnits, price: offer.price, residualUnitValue: offer.residualUnitValue };
                const before = Price.saleOutcome({ ...input, units: oldUnits });
                const after = Price.saleOutcome({ ...input, units: oldUnits + count * batches });
                return { status: before.known && after.known ? 'ready' : 'unknown', exit: offer,
                    before, after, gross: after.receipts - before.receipts };
            })() : Price.bidSale(state, offer, { board: ctx.board, timestamp, asks,
                oldUnits, units: count * batches, residualUnitValue: residual, producer: Number(state.characterId) });
            if (sale.status !== 'ready' || sale.exit.trial && !(sale.after.sold > sale.before.sold)) return null;
            return sale.gross > 0 ? { gross: sale.gross, trip } : null;
        };
        const exitCeiling = (offers, ownSales, best) => {
            for (let at = 0; at < offers.length && at < 5; at++)
                if (usableExit(offers[at], ownSales) && offers[at].price > best) best = offers[at].price;
            return best;
        };
        // The one producer value and the one answer to "does it earn" (R3):
        // one exit's sale net per hour of its delay (MarketDemand.perHour; a
        // bid exit sells within the half-hour floor) = gross x success - the
        // inputs at the bot's own prices (RecipeProductionIndex marketFacts
        // under its own error, inputCostFor) - the scroll's share at the bot's own price of it; it earns when the rate is > 0. Admission ranks by it over
        // the best exit it sees, the priced stage reads it with the exact
        // offer gross, the finalists take only rows above 0. The network
        // still buys or farms each input by its cheapest path (WishNetwork).
        const netRate = (recipe, gross, inputPrice, scrollShare, delayHours) =>
            MarketDemand.perHour(gross * Number(recipe.successRate ?? 100) / 100 - inputPrice - scrollShare, delayHours);
        // Admission: per candidate at most 5 head bids of the indexed sorted
        // list (no copy) and the forecast's price belief, the exits the
        // priced stage prices (NPC buyback is the residual value of the units
        // a bid leaves, Price.bidSale, in both stages: alone it is no exit,
        // ShotCraftPolicy.exitTuple has no NPC form). Reads go cheapest first
        // and stop at the first loss: the exit, the inputs at the market
        // facts' shared prices under the bot's own error, the scroll's readiness
        // (scrollReadiness, no source read); a to-find row ranks on its net with a free
        // scroll, and the scroll row reads its source and price from the best of those
        // down (scrollSource). The rest rank by net
        // rate: the head bid within the half-hour floor or the believed
        // price over the forecast's delay (the listing's units capped at the
        // forecast's applicableUnits, the scroll shared over its sales as
        // the priced stage shares it); the known book only breaks ties, so
        // known and unknown recipes compete by the same outcome.
        const admitted = [];
        // The bot's price of an item a shared fact holds (PriceBelief.reader
        // fromShared); a context without the reader reads its belief.
        const fromShared = ctx.fromShared || (id => price(id));
        const demandReader = { characterId: Number(state.characterId), understanding: ctx.persona.understanding,
            marketTrades: state.marketTrades || {} };
        for (const recipe of producerCandidates()) {
            if (!Sources.allowsRecipe(recipe) || seenProduction.has(Number(recipe.recipeId))) continue;
            seenProduction.add(Number(recipe.recipeId));
            if (!serviceCraft.canCraft(state, recipe)) continue;
            const count = Number(recipe.productCount || 1), id = Number(recipe.productId);
            if (!Number.isSafeInteger(count) || count <= 0) continue;
            const ownSales = ownSalesOf(id), oldUnits = oldUnitsOf(id);
            if (!Number.isSafeInteger(oldUnits) || oldUnits < 0) continue;
            const demand = MarketDemand.forecast(id, null, timestamp, demandReader);
            const shot = ShotStock.gradedShopShot(id);
            // A head bid at or under the NPC buy-back is no buyer: the
            // seller's NPC exit beats it (PriceDecision.aboveBuyback, the
            // price floor). Units beyond the line still count at the buy-back
            // in the priced stage (exitGross residual, Price.bidSale).
            const head = exitCeiling(ctx.board.list(id, 3), ownSales, 0);
            const bid = Price.aboveBuyback(head, ctx.buyback(id)) ? head : 0;
            const listed = demand ? positive(price(id)) : 0;
            const listedUnits = listed > 0 ? Math.min(count, demand.applicableUnits || 0) : 0;
            const gross = Math.max(count * bid, listed * listedUnits) * Number(recipe.successRate ?? 100) / 100;
            if (!(gross > 0)) continue;
            // One batch's inputs at the bot's own prices, the ones its input
            // nodes read: the recipe's shared market facts (RecipeProductionIndex,
            // computed once per market change for every crafter; linear in
            // batches) under its own error (inputCostFor). Their items are
            // the build's reads, so a move of one rebuilds it.
            const facts = ProductionIndex.marketFacts(recipe, { board: ctx.board, timestamp });
            ctx.nodeInputs?.keep(facts);
            const inputPrice = ProductionIndex.inputCostFor(facts, state.characterId, fromShared);
            if (!(gross > inputPrice)) continue;
            const readiness = scrollReadiness(recipe);
            if (!readiness) continue;
            // A ready recipe costs nothing more; a scroll to buy its price.
            // net(learningPrice) falls as the price rises, so net(0) bounds a
            // scroll row's net before its scroll is priced (below).
            const known = knownRecipes.has(Number(recipe.recipeId)), ready = readiness.ready;
            const netAt = learningPrice => Math.max(bid > 0 ? netRate(recipe, count * bid, inputPrice, learningPrice) : -Infinity,
                listed > 0 ? netRate(recipe, listed * listedUnits, inputPrice,
                    Profit.learningShare(learningPrice, count, demand.applicableUnits / demand.delayHours, horizon),
                    demand.delayHours) : -Infinity);
            const net = netAt(0);
            if (!(net > 0)) continue;
            // An investment recipe and a product with demand root first
            // (primaryEarning); progression funding stays shots-only.
            const earningPreference = Number(recipe.recipeItemId) === investmentId ? 2 : demand ? 1 : 0;
            admitted.push({ recipe, count, id, ownSales, oldUnits, shot, demand: Boolean(demand), earningPreference,
                known, ready, inputPrice, margin: ProductionIndex.margin(recipe, listed, inputPrice), learningPrice: 0, net,
                netAt: ready ? null : netAt });
        }
        // E303: the priced producers cap of 12 counts the rows that can run
        // now (scrollSource ready); a scroll to find takes one more place, the
        // best by net of a product no kept ready row makes (one root per
        // product: a 100% variant's scroll on sale never displaces the known
        // 70% recipe), so a scroll hunt never cuts a recipe the bot can craft.
        // A scroll row's net (scroll at its believed price, as every input:
        // the network then buys, farms or bids for it, its cheapest path) is
        // at most its bound net(0): candidates go by bound, best first; each
        // reads its source (scrollSource), then its price; the reads stop once
        // no bound left can beat the best row found, the one row a full read
        // would pick.
        // A committed product (its resale root a committed goal, or the recipe
        // whose scroll the bot is buying: its investment, shotRecipeDemand)
        // keeps its rows past the cap and its scroll row beside the best one.
        const byNet = (a, b) => b.net - a.net || Number(b.known) - Number(a.known) || a.recipe.recipeId - b.recipe.recipeId;
        const committedProduct = row => committed.has(`resale:${row.id}`) || Number(row.recipe.recipeItemId) === investmentId;
        let priced = admitted.filter(row => row.ready);
        if (priced.length > PRODUCER_PRICED) {
            priced.sort(byNet);
            const capped = (row, at) => at >= PRODUCER_PRICED && !committedProduct(row);
            priced = priced.filter((row, at) => !capped(row, at));
        }
        const readyProducts = new Set(priced.map(row => row.id));
        const bestScrollRow = bounds => {
            let best = null;
            for (const bound of bounds.sort(byNet)) {
                if (best && byNet(bound, best) > 0) break;
                if (!scrollSource(bound.recipe, SCROLL_SOURCE)) continue;
                const learningPrice = positive(price(bound.recipe.recipeItemId));
                const row = { ...bound, learningPrice, net: bound.netAt(learningPrice) };
                if (row.net > 0 && (!best || byNet(row, best) < 0)) best = row;
            }
            return best;
        };
        const toFind = admitted.filter(row => !row.ready && !readyProducts.has(row.id));
        const scrollRow = bestScrollRow(toFind);
        if (scrollRow) priced.push(scrollRow);
        for (const id of new Set(toFind.filter(row => committedProduct(row) && row.id !== scrollRow?.id).map(row => row.id))) {
            const row = bestScrollRow(toFind.filter(bound => bound.id === id));
            if (row) priced.push(row);
        }
        if (Diagnostics.active()) {
            Diagnostics.count('cap', 'producers', 'check');
            if (admitted.length > priced.length) {
                Diagnostics.count('cap', 'producers', 'cut');
                Diagnostics.count('cap', 'producers', 'dropped', admitted.length - priced.length);
            }
        }
        // A finite setup the executor holds while it buys the recipe or the
        // inputs (ItemDisposition.productionSetup: a recipe investment, a shot
        // craft preparing, a wealth craft buying) keeps its lot: its recipe's
        // root plans the batches the executor chose, each exit priced for
        // that quantity (a listing's forQuantity), not the lots the exit
        // takes now (exitLots sizes every other lot).
        const heldSetups = [ItemDisposition.productionSetup(state, timestamp, investment || null),
            ItemDisposition.productionSetup(state, timestamp)];
        for (const { recipe, count, id, ownSales, oldUnits, shot, demand, earningPreference, ready, inputPrice: batchInputs, margin, learningPrice } of priced) {
        const asks = ctx.board.list(id, SELL);
        const publicOffers = ctx.board.list(id, 3).slice(0, 5);
        const listingOffers = demand ? need('./WealthCraftPolicy').drain(need('./ShotSalePolicy').exits(state, recipe, {
            board: ctx.board, timestamp, trip: ctx.trip, npcOffersFor: ctx.npcOffersFor, existing: oldUnits })) : [];
        const heldLot = heldSetups.find(setup => Number(setup?.recipe.recipeId) === Number(recipe.recipeId))?.batches || 0;
        for (const source of [...publicOffers, ...listingOffers]) {
            const offer = heldLot && source.forQuantity ? source.forQuantity(heldLot) : source;
            if (!offer) continue;
            const batches = heldLot || exitLots(offer, count, oldUnits, need('./WealthCraftPolicy').MAX_BATCHES, asks);
            const sold = batches && exitGross(offer, count, batches, oldUnits, ownSales, asks, ctx.buyback(id));
            if (!sold) continue;
            const { gross, trip } = sold;
            const inputPrice = batchInputs * batches;
            // A learned recipe is kept: a listing exit's sale carries its share
            // of the price over the units the forecast sells (its rate, already
            // without the units rivals' plans in flight commit) in the horizon.
            // A bid exit is one sale and carries the whole price.
            const learningShare = offer.type === 'listing'
                ? Profit.learningShare(learningPrice, count * batches, offer.applicableUnits / offer.delayHours, horizon) : learningPrice;
            if (learningShare < learningPrice && Diagnostics.active()) Diagnostics.count('provider', 'learning', 'shared');
            const rate = netRate(recipe, gross, inputPrice, learningShare, offer.delayHours);
            // The scroll to find is worth to this crafter the crafts the
            // forecast's units (without rivals' committed units,
            // MarketDemand.forecast) sell past this lot in the horizon at the
            // recipe's margin at its own prices (the inputs it pays, the
            // product's listed price), less the trip (Profit.keptRecipeValue);
            // the root's kept value carries it into the scroll's bid.
            // Not a copy of RecipeProductionIndex.scrollValue: both take one
            // craft's margin from ProductionIndex.margin, but scrollValue
            // answers what the scroll is worth to any buyer (one craft of its
            // best recipe at the market's shared prices, the scroll's derived
            // demand in PriceBelief), this what this recipe keeps for this
            // crafter (its own prices under its own error, times the crafts
            // its demand sells in its horizon).
            const keptLearning = !ready && offer.type === 'listing' ? Profit.keptRecipeValue({ price: learningPrice,
                share: learningShare, margin, perCraft: count, units: count * batches,
                ratePerHour: offer.applicableUnits / offer.delayHours, horizonHours: horizon,
                tripCost: trip.fees + trip.hours * ctx.hourAdena }) : learningPrice - learningShare;
            const previous = production.get(id);
            if (!previous || rate > previous.rate || rate === previous.rate && recipe.recipeId < previous.recipe.recipeId)
                production.set(id, { recipe, ready, gross, rate, shot, earningPreference, inputPrice: inputPrice + learningPrice,
                    keptLearning, town: offer.town, trip, batches, exit: offer });
        }
        }
        // Spare gear of any grade the bot's own Crystallize skill breaks
        // (canRootSale) yields crystals sold like any product: to the head buy
        // lines and the forecast listing (ShotSalePolicy.exits), beyond the
        // crystals already held, incoming or listed; crystals no exit takes
        // count 0 (at NPC buyback a grade's crystals pay ~1.2x its gear's
        // buyback, so a covered bid would break every spare). Reads in that order:
        // the skill, the exits (a buy line or a forecast town), the input row.
        // The input is the grade's crystal sweep (crystalChoices, shared with
        // the own-need node: the held spares and the bought gear, D at Giran's
        // NPC, C-S on the board). One input type, one command: the first row
        // of BotCrystallization.choices' order, the cost per crystal the solver
        // charges (a held piece at its own price, a bought one landed); the
        // need path's bundle of spares is not one type.
        const Crystals = need('./BotCrystallization');
        for (const [crystalId, rank] of Crystals.CRYSTAL_RANKS) {
            const key = `resale:${crystalId}`;
            if (nodeKeys.has(key) || !Crystals.canRootSale(state, rank)) continue;
            const buyLines = ctx.board.list(crystalId, BUY).slice(0, 5);
            if (!buyLines.length && !MarketDemand.towns(crystalId, timestamp).length) continue;
            const row = crystalChoices(rank).find(choice => choice.selfId);
            if (!row) continue;
            // A piece costs what the solver charges for it: its cost per
            // crystal (choices' score) times its crystals.
            const pieceCost = row.score * row.net;
            const ownSales = ownSalesOf(crystalId), oldUnits = oldUnitsOf(crystalId);
            if (!Number.isSafeInteger(oldUnits) || oldUnits < 0) continue;
            const asks = ctx.board.list(crystalId, SELL);
            const listingOffers = need('./WealthCraftPolicy').drain(need('./ShotSalePolicy').exits(state,
                { productId: crystalId, productCount: row.net }, { board: ctx.board, timestamp, trip: ctx.trip,
                    npcOffersFor: ctx.npcOffersFor, existing: oldUnits }));
            let best = null;
            for (const offer of [...buyLines, ...listingOffers]) {
                // The pieces whose crystals the exit takes, up to the spare count.
                const pieces = exitLots(offer, row.net, oldUnits, row.batchLimit, asks);
                const sold = pieces && exitGross(offer, row.net, pieces, oldUnits, ownSales, asks, 0);
                if (!sold) continue;
                const rate = MarketDemand.perHour(sold.gross - pieces * pieceCost, offer.delayHours);
                if (!best || rate > best.rate) best = { ...sold, rate, pieces, town: offer.town };
            }
            if (best) crystalExits.push({ key, crystalId, row, ...best });
        }
    }
    // Finalists: the first 3 ready rows by rate that earn (netRate > 0) and
    // have a craft path, plus the one scroll-to-find row admission kept; a
    // pathless row leaves its place to the next.
    const producerFinalists = [...production.values()].sort((a, b) => b.rate - a.rate
        || a.recipe.recipeId - b.recipe.recipeId);
    const produced = new Set();
    let readyRoots = 0;
    for (const row of producerFinalists) {
        const id = Number(row.recipe.productId);
        const pinned = committed.has(`resale:${id}`);
        if (row.ready && readyRoots >= 3 && !pinned || produced.has(id) || !(row.rate > 0)) continue;
        const mark = nodes.length, path = craftPath(row.recipe, id, 0, true, row.batches);
        if (!path) continue;
        if (!root({ key: `resale:${id}`, need: 'power', object: { itemId: id, amount: Number(row.recipe.productCount || 1) * row.batches, kind: 'resale' },
            primaryEarning: row.earningPreference,
            // A buyer's line pays the whole lot (bidsInputs: its value in
            // adena): the inputs nobody sells are bid at their share of that
            // line (TradeIntent.preparedProject), not bought at belief
            // (WishNetwork earns). A listing exit stays within what the
            // market already offers.
            ...(row.exit.type !== 'listing' ? { bidsInputs: row.gross } : {}),
            // Keep the crafter's finite income setup in the same graph as
            // its gear. Otherwise its separate native action can travel to
            // a recipe seller whose meeting has no surviving need certificate.
            progressionPriority: row.shot && acquisitionKit.required ? 3 : 0,
            progressionFunding: acquisitionKit.required,
            // The cash price pays the whole recipe; the part later sales
            // carry (for a scroll to find, at least the later crafts' margin,
            // Profit.keptRecipeValue) stays as the kept recipe's value, earned
            // over the horizon (keptPerHour) once the root is ready (WishNetwork value()).
            valueHours: row.gross / ctx.hourAdena, keptHours: row.keptLearning / ctx.hourAdena,
            keptPerHour: horizon > 0 && Number.isFinite(horizon) ? row.keptLearning / horizon / ctx.hourAdena : 0, price: row.inputPrice,
            // The one exit decision of a craft for sale: the cold step sizes
            // this exit, the hot leaf crafts for it (ShotCraftPolicy.exitTuple).
            // recipeReady: scrollSource's verdict, the craft step's gate.
            paths: [{ ...path, recipeReady: row.ready, quoted: true, town: row.town, tripHours: row.trip.hours, tripFees: row.trip.fees,
                exit: need('./ShotCraftPolicy').exitTuple(row.exit.type === 'listing' ? row.exit
                    : { offer: row.exit, price: row.exit.price }) }] })) { rollback(mark); continue; }
        produced.add(id);
        if (row.ready && !pinned) readyRoots++;
    }
    for (const { key, crystalId, row, pieces, gross, town, trip } of crystalExits) {
        if (nodeKeys.has(key)) continue;
        // The root ranks on the sweep row's cost; its piece's item node buys
        // at purchaseFor (the best landed offer, never dearer than Giran's
        // NPC), the quote the held check reads back.
        const requirements = inputs([{ selfId: row.selfId, amount: pieces }], 1);
        if (!requirements) continue;
        // The lot sits in the path: the solver asks a root for one unit.
        root({ key, need: 'power', object: { itemId: crystalId, amount: pieces * row.net, kind: 'resale' },
            progressionFunding: acquisitionKit.required, valueHours: gross / ctx.hourAdena,
            paths: [{ ...need('./BotCrystallization').path(crystalId, [{ selfId: row.selfId, amount: pieces }]),
                productCount: pieces * row.net, quoted: true, town, tripHours: trip.hours, tripFees: trip.fees,
                grossRequirements: requirements }] });
    }
    // Any farmer can earn by supplying finite public demand for recipes,
    // parts and resources a buyer bids above NPC buy-back for (user
    // 2026-10-24): the item's cheapest ready source, drop or spoil
    // (sourcePath), at a spot it may leave its route for. No buyer means no
    // speculative farm goal. The value is the line's gain over buy-back,
    // the effort the farm hours at their net cost plus the trip (WishNetwork
    // finiteProduction keeps the root only while the value beats it; its
    // rank counts the farm hours, WishNetwork committedEffort).
    // The loop over the board's buy items reads no depth, sale or path: the
    // pre-cut keeps the 8 lines of the best gain per kill for this bot (the
    // spread over buy-back times the units per kill of the item's best
    // record at a spot its route reader admits, spoils only for a spoiler,
    // never one sourceFacts refuses by the bot's level band or solo bound,
    // Planner.sourceLevelReader, asked before the route reader;
    // Planner.sourceRecordsByYield ranks the records once per item). The
    // line's depth (exitLots), its source path (which sizes the lot) and
    // its sale are read for those 8 only, in that order; the first ready
    // one is the bot's one farm_sale root per build (a committed line,
    // committedOf, beside it past the 8), ranked by the network
    // score in the one root cut (no reserved slot, no crowd term: a closed
    // line wakes its farmers, EconomyContext soldLinesOf).
    // The farm's lot fits the horizon like a gear drop path (statusOf,
    // E212, one verdict: EconomicValuation.withinHorizon): the units it
    // farms for are at most those its source path delivers in the horizon
    // at that path's hours per unit, after its trips (horizonUnits); a line
    // whose first unit takes the whole horizon is a lottery, no farm plan,
    // cut in the 8-line pre-cut already.
    if (sourceIndex && ctx.board?.itemIds && ctx.hourAdena > 0 && Progression.personal(state)) {
        // A committed line (its resale root a committed goal, committedOf)
        // stays beside the 8, uncounted, while its own checks hold; the
        // units it already farmed are its sale's old units, so its first
        // unit in the bag never ends the goal (another line's held item is
        // sold, not farmed).
        const demand = [], pinnedLines = [];
        // The band at sourcePath's economicLower, read once at the first
        // record that reaches it (a spoiler's band is never narrower here
        // than its source path's).
        let levelRefusal = null;
        for (const id of ctx.board.itemIds(3)) {
            if (!sourceIndex.has(Number(id))) continue;
            const pinned = committed.has(`resale:${id}`);
            if (!pinned && present(id) || nodeKeys.has(`resale:${id}`)) continue;
            const offer = farmLine(ctx.board, id, state.characterId);
            if (!offer || !need('./PriceDecision').aboveBuyback(offer.price, ctx.buyback(id))) continue;
            const { entries, order, perKill: yields } = Planner.sourceRecordsByYield(deps.spots, id);
            // Ranked by per kill: the walk stops, with 8 kept, at the first
            // record below the 8th line's gain.
            const spread = offer.price - ctx.buyback(id), bar = !pinned && demand.length === 8 ? demand[7].gain : 0;
            let perKill = 0;
            for (let rank = 0; rank < order.length; rank++) {
                if (spread * yields[rank] < bar) break;
                const entry = entries[order[rank]];
                if (entry.kind === 'spoil' && !isSpoiler()) continue;
                levelRefusal ??= Planner.sourceLevelReader(state, acquisitionKit.required || isSpoiler());
                if (levelRefusal(entry)) continue;
                if (!routeAllowed(entry.spot)) continue;
                // A record whose first unit takes the whole horizon at its
                // spot's kill rate (the penalty-free yield and no trip: an
                // upper bound, never cuts a line its source path delivers)
                // keeps no slot: the walk goes on to the next record.
                if (horizonUnits(1 / (positive(spotValue(entry.spot)?.kills) * yields[rank]), horizon) === 0) continue;
                perKill = yields[rank];
                break;
            }
            if (!(perKill > 0)) continue;
            if (pinned) { pinnedLines.push({ id, offer, pinned }); continue; }
            demand.push({ id, offer, gain: spread * perKill });
            demand.sort((a, b) => b.gain - a.gain || a.id - b.id);
            if (demand.length > 8) demand.pop();
        }
        for (const { id, offer, pinned } of [...pinnedLines, ...demand]) {
            const asks = ctx.board.list(id, SELL);
            // The units held (a committed line's), incoming or on the bot's own sell lines.
            const oldUnits = oldUnitsOf(id);
            let units = exitLots(offer, 1, oldUnits, 50, asks);
            if (!units) continue;
            const trip = ctx.trip?.details?.(offer.town);
            if (!trip?.known) continue;
            const source = sourcePath(id);
            if (!source) continue;
            // One measure of hours with the network's plan (statusOf): the
            // source's trip and the sale's trip, when to another town, are
            // elapsed hours of the lot too.
            const tripHours = positive(source.tripHours) + (source.town !== offer.town ? positive(trip.hours) : 0);
            units = Math.min(units, horizonUnits(source.readyHours, horizon - tripHours));
            if (!units) continue;
            const sale = need('./PriceDecision').bidSale(state, offer, { board: ctx.board,
                timestamp, asks, units, oldUnits, residualUnitValue: ctx.buyback(id), producer: Number(state.characterId) });
            if (sale.status !== 'ready' || !(sale.gross > 0)) continue;
            const key = `farm:${id}`;
            if (!add({ key, object: Number(id), price: 0, paths: [source] })) continue;
            root({ key: `resale:${id}`, need: 'power', object: { itemId: Number(id), amount: units, kind: 'resale' },
                progressionFunding: acquisitionKit.required,
                valueHours: Math.max(0, sale.gross - units * ctx.buyback(id)) / ctx.hourAdena,
                paths: [{ kind: 'farm_sale', itemId: Number(id), quoted: true,
                    town: offer.town, tripHours: trip.hours, tripFees: trip.fees,
                    requirements: [{ key, amount: units }] }] });
            // The committed lines and the first ready other one.
            if (!pinned) break;
        }
    }
    // Paid enchant, SA and henna are objects of the same power queue.
    // Missing materials inherit that value; only a genuinely ready leaf applies.
    blocks?.lap('sources');
    for (const improvement of invoke('GameServer/Bot/Economy/BotImprovementPolicy').opportunities(state, ctx)) {
        const materials = improvement.materials.map(material => {
            quantityInputs?.atLeast('physical', material.selfId, material.amount);
            return { ...material, missing: Math.max(0, material.amount - physical(material.selfId)) };
        });
        const requirements = inputs(materials.filter(material => material.missing > 0)
            .map(material => ({ selfId: material.selfId, amount: material.missing })), 0);
        if (!requirements) continue;
        const ready = !requirements.length && positive(state.adena) >= positive(improvement.fee);
        ctx.walletBoundary?.(positive(improvement.fee));
        root({ key: improvement.key, need: 'power', object: { ...improvement, kind: 'improvement' },
            valueHours: improvement.valueHours, price: improvement.price,
            paths: [{ activity: ready ? 'improving' : null, kind: improvement.kind,
                improvement, price: positive(improvement.fee), costHours: 1 / 3600,
                riskHours: improvement.riskHours || 0, requirements }] });
        for (const material of materials) values.set(material.selfId,
            positive(values.get(material.selfId)) + improvement.valueHours / Math.max(1, material.amount));
    }
    const candidates = [];
    const planningState = preparation || state;
    const wornFor = wornReader(planningState), gainFor = gearGainReader(state, timestamp, {}, magic, ctx.gearThreatMask ?? 3);
    let futureGain;
    const acquisitionAllowed = id => {
        const item = need('../../Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, Number(id));
        if (Progression.marketOnly?.(state, item, acquisitionKit)) {
            const offer = purchaseFor(id);
            if (!offer || !(offer.availableUnits >= 1)) return false;
            // The wallet threshold this answer turns on, as every cash comparison of the build.
            ctx.walletBoundary?.(offer.price + offer.tripFees + positive(ctx.survivalReserve));
            return offer.price + offer.tripFees <= Math.max(0, state.adena - ctx.survivalReserve);
        }
        return Sources.hasNonRaidSource(id) || present(id) || !!purchaseFor(id);
    };
    for (const [slot, items] of gearCandidates(planningState, ctx, wornFor, acquisitionAllowed, luxury, purchaseFor)) for (const item of items) {
        if (!Planner.considerable(item, planningState)) continue;
        const current = replacementWorn(wornFor, slot);
        if (Number(current?.selfId) === Number(item.selfId)) continue;
        const early = !!preparation && item.etc?.rank === 'c';
        const gain = early ? (futureGain ||= gearGainReader(preparation, timestamp,
            { preparation: true }, magic, ctx.gearThreatMask ?? 3))(item, slot) : gainFor(item, slot);
        const benefitHorizon = early ? futureHorizon : horizon;
        const currentPrice = current ? price(current.selfId) : 0;
        const future = resale(price(item.selfId), { trend: MarketCounters.moveOf(MarketCounters.counterOf(item.selfId)),
            hours: benefitHorizon, understanding: ctx.persona.understanding, assertiveness: trait(ctx.persona, 'assertiveness'),
            caution: trait(ctx.persona, 'caution'), nextBuyerUse: price(item.selfId) * Math.min(1, gain.attack + gain.defence),
            npcFloor: ctx.buyback(item.selfId) });
        // One valuation for every gear step, at any grade: its benefit over
        // the stage's hours (the level weights the horizon only) plus resale.
        // A step into a kit gap carries the gap's priority to stand among
        // the kit roots; its value decides whether it is worth taking.
        const value = (gain.attack + gain.defence * ctx.deathHours) * benefitHorizon
            + (ctx.hunt.perHour > 0 ? (future - currentPrice) / ctx.hunt.perHour : 0);
        if (!(value > 0) || !(price(item.selfId) > 0)) continue;
        candidates.push({ item, slot, value, gain, notBeforeHours: early ? horizon : 0,
            horizonHours: early ? horizon + futureHorizon : horizon,
            progressionPriority: Progression.priority(slot, progression) });
    }
    // MVP-6: every nominated candidate is valued by the same path solver
    // the network uses, over its own scratch arena of item descriptors. A
    // forecast without a supplier no longer screens out a step now: the
    // fundable path wins its family, then its net (gearStepNets).
    blocks?.lap('benefits');
    const admission = { candidates: 0, evaluations: 0, maxScratch: 0, rounds: 0, pending: [], admitted: [] };
    const solverOptions = { hourAdena: ctx.hourAdena, riskWeight: ctx.riskWeight, stockFor: ctx.stockFor || null,
        wallet: ctx.wallet ?? positive(state.adena), survivalReserve: ctx.survivalReserve };
    const real = nodes, realKeys = nodeKeys, gear = [];
    for (const candidate of candidates) {
        nodes = []; nodeKeys = new Set(); scratch = true; readScope = ctx.readScope?.open() || null;
        const key = itemNode(candidate.item.selfId);
        const keys = nodes.map(node => node.key);
        nodes = real; nodeKeys = realKeys; scratch = false; readScope = null; ctx.readScope?.close();
        if (!key) continue;
        const benefitPerHour = (candidate.gain.attack + candidate.gain.defence * ctx.deathHours) * powerWeight;
        gear.push({ candidate, keys, family: Equipment.isWeaponSlot(candidate.slot) ? 'weapon' : candidate.slot,
            node: { key: `power:${candidate.item.selfId}:${candidate.slot}`, need: 'power',
                object: { itemId: Number(candidate.item.selfId), slot: candidate.slot }, price: price(candidate.item.selfId),
                valueHours: candidate.value * powerWeight,
                progressionPriority: candidate.progressionPriority,
                ...(luxury || acquisitionKit.rank === GRADE_RANK.b ? { personalAcquisition: true } : {}),
                benefitPerHour, notBeforeHours: candidate.notBeforeHours, horizonHours: candidate.horizonHours,
                paths: [{ requirements: [{ key, amount: 1 }] }] } });
        admission.maxScratch = Math.max(admission.maxScratch, keys.length);
    }
    admission.candidates = gear.length;
    // A throw of the solver's own bounds or an arena over Network.MAX_NODES descriptors
    // is `limit`: unresolved, never an unavailable item or a zero cost.
    // A path whose benefit cannot start inside the horizon is not a missing
    // path: it waits, counted, for money or a cheaper source. Its own elapsed
    // time (a drop's expected kills, a craft, a trip) at or past the horizon
    // waits too, though resale keeps its ready value above zero (E212).
    const statusOf = (wish, node) => !wish.plan ? 'no_path'
        : wish.valueHours > 0 && withinHorizon(wish.plan.hours, node.horizonHours) ? 'evaluated'
            : wish.fullValueHours > 0 ? 'not_ready' : 'no_path';
    const evaluate = (row, used) => {
        admission.evaluations++; row.evaluations = (row.evaluations || 0) + 1;
        row.status = 'limit'; row.wish = null; row.claims = null;
        // The arena joins its own root in the union: both within Network.MAX_NODES.
        if (row.keys.length + 1 > Network.MAX_NODES) return;
        try {
            const solver = Network.createSolver({ ...solverOptions, nodes: [...row.keys.map(key => descriptors.get(key)), row.node] });
            const { wish, claims } = solveRoot(solver, row.node, solverOptions.stockFor ? used : null);
            if (claims && wish.plan) row.claims = claims;
            row.wish = wish;
            row.status = statusOf(wish, row.node);
        } catch (error) {
            if (!SOLVER_LIMITS.has(error?.message)) throw error;
        }
    };
    const score = row => Network.score(row.wish);
    const before = (a, b) => a.node.progressionPriority !== b.node.progressionPriority
        ? a.node.progressionPriority > b.node.progressionPriority
        : (a.node.key === ctx.completionKey) !== (b.node.key === ctx.completionKey)
            ? a.node.key === ctx.completionKey
            : score(a) > score(b) || score(a) === score(b) && a.node.key < b.node.key;
    // Each family's winner (gearFamilyLead).
    const winners = open => {
        const families = new Map();
        for (const row of gear) {
            if (!row.wish || !open(row.family)) continue;
            if (!families.has(row.family)) families.set(row.family, []);
            families.get(row.family).push(row);
        }
        const best = [];
        for (const family of families.values()) {
            const { row } = gearFamilyLead(gearStepNets(family), before);
            if (row) best.push(row);
        }
        return best.sort((a, b) => b.node.progressionPriority - a.node.progressionPriority
            || (luxury ? Number(Network.fundable(b.wish)) - Number(Network.fundable(a.wish)) : 0)
            || (before(a, b) ? -1 : before(b, a) ? 1 : 0));
    };
    // Family winners enter one at a time by score while the union of their
    // descriptors stays within Network.MAX_NODES; a winner that does not fit is pending
    // and the others proceed. Shared stock: after each admission except the
    // last, only candidates holding a newly claimed item are re-evaluated.
    function* admitGear() {
        let used = new Map();
        for (const row of gear) { evaluate(row, used); yield row; }
        admission.rounds = gear.length ? 1 : 0;
        const admitted = [], closed = new Set(), union = new Set();
        const fits = row => [...row.keys, row.node.key].filter(key => !union.has(key)).length + union.size <= Network.MAX_NODES;
        const join = row => { for (const key of row.keys) union.add(key); union.add(row.node.key); admitted.push(row); };
        const pending = row => { admission.pending.push({ key: row.node.key, reason: 'node_limit' }); keepCapped(row.node); };
        // The committed gear goals (committedOf), highest priority first, in
        // committed order within one: each enters before the next family
        // winner unless that winner stands higher (Network.pinned), so a goal
        // the bot paused never takes the node budget of the one it pursues;
        // beside its family's winner, outside the 4-root cap, while still
        // valid (nominated: an upgrade, not worn; valued; evaluated). The
        // network's loyalty decides whether the bot keeps it (WishNetwork.build).
        const pins = [];
        for (const key of committed) { const row = gear.find(row => row.node.key === key); if (row) pins.push(row); }
        pins.sort((a, b) => positive(b.node.progressionPriority) - positive(a.node.progressionPriority));
        let wins = 0;
        // An admitted row's claims on held stock: the candidates still to come
        // (open families, pins) holding a newly claimed item are evaluated
        // again against them, at most GEAR_ROUNDS rounds, none after the last.
        function* claim(row) {
            if (!row.claims || admission.rounds >= GEAR_ROUNDS || wins >= GEAR_ROOTS && !pins.length) return;
            const claimed = new Set();
            for (const [id, count] of row.claims) if (count > (used.get(id) || 0)) claimed.add(`item:${id}`);
            used = new Map(used);
            for (const [id, count] of row.claims) used.set(id, Math.max(used.get(id) || 0, count));
            const affected = gear.filter(other => (!closed.has(other.family) || pins.includes(other))
                && !admitted.includes(other) && other.keys.some(key => claimed.has(key)));
            if (!affected.length) return;
            admission.rounds++;
            for (const other of affected) {
                evaluate(other, used);
                yield other;
            }
        }
        for (;;) {
            const [winner] = wins < GEAR_ROOTS ? winners(family => !closed.has(family)) : [];
            if (pins.length && (!winner || Network.pinned(pins[0].node, committed, positive(winner.node.progressionPriority)))) {
                const pin = pins.shift();
                if (pin.status !== 'evaluated' || admitted.includes(pin)) continue;
                if (!fits(pin)) { pending(pin); continue; }
                join(pin);
                yield* claim(pin);
                continue;
            }
            if (!winner) break;
            closed.add(winner.family);
            if (!admitted.includes(winner)) {
                if (!fits(winner)) { pending(winner); continue; }
                join(winner);
            }
            wins++;
            yield* claim(winner);
        }
        // E303: families with an evaluated winner left out because the gear roots cap of 4 was reached.
        if (Diagnostics.active() && wins >= GEAR_ROOTS) {
            const left = winners(family => !closed.has(family)).length;
            if (left) {
                Diagnostics.count('cap', 'gear_roots', 'cut');
                Diagnostics.count('cap', 'gear_roots', 'dropped', left);
            }
        }
        // Shared held stock (MVP-6): the network allocates it in the author's
        // money priority (stockless full value per price, an unquoted root at
        // its market price), not by score. Admitted roots whose arenas share
        // a held item someone claimed are allocated again in that order, one
        // evaluation each (a stockless solve for the order and an allocation),
        // so every witness is the expanded wish. A root the network would then
        // drop leaves admission as pending; its family waits for the next review.
        const shared = new Set(), seen = new Set();
        for (const row of admitted) for (const key of new Set(row.keys)) (seen.has(key) ? shared : seen).add(key);
        const claimed = key => admitted.some(row => row.claims?.get(Number(key.slice(5))) > 0);
        if (solverOptions.stockFor && [...shared].some(key => key.startsWith('item:') && claimed(key))) {
            const rows = [];
            for (const row of admitted) {
                admission.evaluations++; row.evaluations++;
                row.status = 'limit'; row.wish = null; row.claims = null;
                try {
                    const solver = Network.createSolver({ ...solverOptions, nodes: [...row.keys.map(key => descriptors.get(key)), row.node] });
                    const base = solver.rootWish(row.node.key);
                    if (base.plan && base.fullValueHours > 0) rows.push({ row, solver, base });
                    else row.status = 'no_path';
                } catch (error) {
                    if (!SOLVER_LIMITS.has(error?.message)) throw error;
                }
            }
            // The network's claim order (WishNetwork settle): priority, a
            // completion, the committed goals before a rival.
            const order = Network.claimOrder(Network.activePriority(rows.map(row => row.base)), ctx.completionKey, [...committed]);
            rows.sort((a, b) => order(a.base, b.base));
            used = new Map();
            for (const { row, solver } of rows) {
                const wish = { key: row.node.key, need: row.node.need, object: row.node.object };
                const claims = solver.allocate(wish, used);
                row.wish = wish; row.claims = wish.plan ? claims : null;
                row.status = statusOf(wish, row.node);
                // Only a root that stays admitted keeps its claim on held stock.
                if (row.status === 'evaluated') used = claims;
                yield row;
            }
            for (let at = admitted.length - 1; at >= 0; at--) if (admitted[at].status !== 'evaluated') {
                if (admitted[at].status === 'no_path') admission.pending.push({ key: admitted[at].node.key, reason: 'no_path' });
                admitted.splice(at, 1);
            }
        }
        // A goal the solver cannot evaluate is no capped goal: it would stay
        // preempted for as long as the limit holds.
        for (const row of gear) if (row.status === 'limit' && !admitted.includes(row))
            admission.pending.push({ key: row.node.key, reason: 'evaluation_limit' });
        for (const row of gear) if (row.status === 'not_ready')
            admission.pending.push({ key: row.node.key, reason: 'not_ready_in_horizon' });
        // The selected-path witness: the scalar facts the expanded root must repeat.
        admission.admitted = admitted.map(row => ({ key: row.node.key, family: row.family, scratch: row.keys.length,
            evaluations: row.evaluations, price: row.wish.price, effort: row.wish.effort, valueHours: row.wish.valueHours,
            supported: row.wish.supported, resolved: row.wish.resolved }));
        return admitted;
    }
    // ARCH-NOTE: the provider runs inside the synchronous EconomyContext
    // forState; yielding each evaluation through prepareNative would need
    // forState and its callers as generators (the MVP-6 continuation gate,
    // not met). The generator keeps the per-evaluation step and is drained
    // here synchronously.
    const admitting = admitGear();
    let step = admitting.next();
    while (!step.done) step = admitting.next();
    const admittedGear = step.value;
    blocks?.lap('admission');
    if (!acquisitionKit.required && ctx.hunt.expPerHour > 0 && state.level < ProgressionCap.effectiveLevelCap()) {
        root({ key: `${LEVEL_ROOT}${state.level + 1}`, need: 'power', object: { level: state.level + 1 },
            valueHours: powerWeight, price: 0, paths: [{ kind: 'experience', activity: 'hunting',
                spotId: ctx.hunt.progressSpotId || ctx.bestSpotId, costHours: 1, riskHours: ctx.expectedDeathHours }] });
    }
    for (const kind of ['shots', 'potions', 'scrolls']) {
        const stock = ctx.stock(kind);
        // A necessary refill covers the planned outing in the same purchase.
        // Only the survival shortfall outranks unfinished equipment; once that
        // floor is filled, optional stock cannot keep the kit on hold.
        const amount = Number(stock?.survivalMissing || 0)
            + (acquisitionKit.required && kind !== 'shots' ? 0 : Number(stock?.missing || 0));
        if (Diagnostics.active() && Diagnostics.enabled(state.characterId)) Diagnostics.push({ owner: state.characterId,
            caller: deps.caller || 'wish_provider', trigger: 'projection_build',
            phase: 'wish_need', reason: !(amount > 0) ? 'target_satisfied' : !(stock.unitPrice > 0)
                ? 'unknown_price' : !(stock.benefitPerUnit > 0) ? 'no_expected_benefit' : 'stock_shortfall',
            decisionSeq: state.stats?.decisionSeq, activityLeaf: state.stats?.activityLeaf,
            wishKey: `stock:${kind}`, item: stock?.itemId, target: stock?.target,
            owned: stock?.current, missing: stock?.missing, requested: amount,
            unitPrice: stock?.unitPrice, valueHours: amount * (stock?.benefitPerUnit || 0), wallet: state.adena });
        if (!(amount > 0) || !(stock.unitPrice > 0) || !(stock.benefitPerUnit > 0)) continue;
        const key = inputs([{ selfId: stock.itemId, amount }], 0)?.[0].key;
        if (!key) continue;
        const heldStock = nativeQuantities.physical(stock.itemId);
        quantityInputs?.stockPhysical(`stock:${kind}`, stock.itemId, heldStock);
        root({ key: `stock:${kind}`, need: 'power', object: { itemId: stock.itemId, amount, kind },
            progressionPriority: acquisitionKit.required && stock.survivalMissing > 0 ? 4 : 0,
            valueHours: amount * stock.benefitPerUnit * powerWeight, price: amount * stock.unitPrice,
            // The survival tranche is the kit's cost (kitCost), already held
            // by the survival reserve; the money queue charges only the rest.
            reserved: Math.min(amount * stock.unitPrice, Math.max(0, Number(ctx.kitCost?.(stock.itemId)) || 0)),
            // gross = held units + amount, so allocation leaves `amount`.
            paths: [{ requirements: [{ key, amount }],
                grossRequirements: [{ key, amount: amount
                    + heldStock }] }] });
        values.set(stock.itemId, stock.benefitPerUnit);
    }
    const paidInputs = state.stats?.equipmentPlan?.crystalPreparation && need('./BotCrystallization').preparation(state);
    // Paid inputs break where the bot stands (its own skill): no trip.
    if (paidInputs) root({ key: paidInputs.key, need: 'power', object: { itemId: paidInputs.plan.target.selfId },
        valueHours: 1, progressionPriority: 3.5, paths: [{ ...paidInputs.path, costHours: 1 / 3600 }] });
    for (const node of deps.nodes || []) { if (node.need) root(node); else add(node); }
    // Admitted gear enters the real graph last: its arena descriptors are
    // already built (no path is built here) and their union is within
    // Network.MAX_NODES (admitGear). The one rank cut below (admitRoots)
    // compares every root, so no root loses its place by build order.
    for (const row of admittedGear) {
        for (const key of row.keys) include(key);
        values.set(Number(row.candidate.item.selfId), row.candidate.value * powerWeight);
        root(row.node);
    }
    const moneyPaths = ctx.hunt.perHour > 0 ? [{ activity: 'hunting', kind: 'money',
        spotId: ctx.bestSpotId, incomePerHour: ctx.hunt.perHour, riskHours: ctx.expectedDeathHours }] : [];
    // Not for sale: the admitted gear items in the bag. What this build's
    // goals claim of the bag the network takes off the sale rows itself, per
    // unit (WishNetwork funding): claims of the same build, after its split.
    const liquidation = liquidationInputs(state, { shots: ctx.stock('shots'), potions: ctx.stock('potions'),
        excluded: [...values.keys()].filter(id => Object.hasOwn(state.inventory || {}, id)) });
    ctx.liquidationInputs = liquidation.proof;
    const sale = (liquidation.candidates || liquidationCandidates(state, ctx)).filter(row => !values.has(Number(row.selfId)));
    const saleValue = sale.reduce((sum, row) => sum + ctx.buyback(row.selfId) * row.count, 0);
    if (saleValue > 0) {
        // NPC buyback is the same across towns. Compare the prepared routes
        // once; a nearby seller can fund gear without an unaffordable fare to
        // the item's preferred player-market town.
        let best = null;
        for (const town of need('./EconomicTrip').towns) {
            if (!need('../Population/ColdOccupationSources').hasNpcSellerInTown(town)) continue;
            const route = ctx.trip?.details?.(town);
            if (route?.known) ctx.walletBoundary?.(route.fees);
            if (!route?.known || route.fees > Number(state.adena || 0)) continue;
            const cost = need('./EconomicTrip').price(route, Math.max(1, ctx.hunt.perHour));
            if (!best || cost < best.cost) best = { town, route, cost };
        }
        if (best) {
            const { town, route } = best;
            // [id, units for sale, units in the bag past the clan's (the held
            // reader keeps claim + clan), NPC cash per unit].
            const clan = need('../../Clan/ClanSupplyPolicy').reservedAmounts(state);
            moneyPaths.push({ activity: 'selling', kind: 'liquidate', repeatable: false,
                cashFees: route.fees, actionHours: route.hours, town,
                sale: sale.map(row => [Number(row.selfId), row.count,
                    Math.max(0, positive(state.inventory?.[row.selfId]?.amount) - positive(clan[row.selfId])), ctx.buyback(row.selfId)]) });
        }
    }
    // External game providers compete by the same value, rather than by
    // arriving after twelve preassigned gear slots.
    const byKey = new Map(nodes.map(node => [node.key, node]));
    // Only a cut reads the solved worth: within both bounds every root is
    // kept and the cheap keys alone order them (the build picks by score,
    // ties by key, so a root's position moves no choice).
    const cuts = roots.length > Network.MAX_ROOTS || nodes.length > Network.MAX_NODES;
    const rank = cuts ? rootScores(roots, nodes, solverOptions) : null;
    // At the priority the build keeps (WishNetwork.priorityOrder): an
    // earning root ranks beside the active root, ahead of the lower gear
    // roots the build drops, so the node bound never cuts it for them; the
    // needed root it funds goes first, so it never cuts that root either.
    // The level root keeps its slot before the scored roots of its priority,
    // as before the score rank: whether levelling competes by score is open.
    // A committed goal (committedOf) goes first of the roots of its place: no
    // rival, earning root or deeper tree there cuts the goal the bot pursues,
    // and a committed earning root still follows the needed root it funds.
    const active = Network.activePriority(roots.map(key => byKey.get(key)));
    roots.sort((a, b) => Network.priorityOrder(byKey.get(a), byKey.get(b), active)
        || Number(committed.has(b)) - Number(committed.has(a))
        || positive(byKey.get(b).primaryEarning) - positive(byKey.get(a).primaryEarning)
        || Number(b.startsWith(LEVEL_ROOT)) - Number(a.startsWith(LEVEL_ROOT))
        || (rank ? rank.get(b) - rank.get(a) : 0) || a.localeCompare(b));
    const cut = Network.admitRoots(roots, byKey);
    admission.pending.push(...cut.pending);
    for (const row of cut.pending) keepCapped(byKey.get(row.key));
    for (const [key, scope] of builtBy) if (cut.kept.has(key)) ctx.readScope.keep(scope);
    if (Diagnostics.active()) {
        Diagnostics.count('provider', 'admission', 'candidate', admission.candidates);
        Diagnostics.count('provider', 'admission', 'evaluation', admission.evaluations);
        Diagnostics.count('provider', 'admission', 'round', admission.rounds);
        Diagnostics.count('provider', 'admission', 'gear_root', admittedGear.length);
        for (const row of admission.pending) Diagnostics.count('provider', 'admission_pending', row.reason);
    }
    const keptNodes = nodes.filter(node => cut.kept.has(node.key));
    blocks?.lap('tail'); blocks?.done();
    return { nodes: keptNodes, roots: cut.roots, values, moneyPaths, horizon, admission, sourceGround, capped };
}
// Only public recipe rows and a prepared route can prove a usable service.
// This bounded indexed read is shared by visible and distant bots. No private
// recipe book, producer-profit gate or synchronous route expansion is needed.
function knownWorkshop(recipe, state, ctx, deps) {
    const trip = deps.tripCost || ctx.trip;
    if (typeof trip?.details !== 'function') return null;
    let best = null;
    for (const row of deps.workshops(Number(recipe.recipeId), state) || []) {
        if (Number(row.characterId) === Number(state.characterId)
            || Number(row.recipeId) !== Number(recipe.recipeId)
            || !Number.isSafeInteger(Number(row.price)) || Number(row.price) < 0
            || ![row.loc?.locX, row.loc?.locY, row.loc?.locZ].every(Number.isFinite)) continue;
        // Capacity bounds one command; the chosen row's craft facts are read once by the caller.
        if (!(Number(row.capacityBatches) >= 1)) continue;
        const route = trip.details(row.townName);
        if (!route?.known || !Number.isFinite(route.hours) || !Number.isFinite(route.fees)) continue;
        const cost = Number(row.price) + need('./EconomicTrip').price(route, Number(ctx.hourAdena || ctx.hunt?.perHour || 0));
        if (!best || cost < best.cost || cost === best.cost && Number(row.characterId) < best.characterId)
            best = { ...row, characterId: Number(row.characterId), cost,
                tripHours: route.hours, tripFees: route.fees };
    }
    return best;
}
// The plan a wish's build chose for one requirement row: the row's own
// plan (the allocated pass: owned and incoming stock subtracted), else the
// item's plan by key (a compact network keeps rows without a plan there,
// EconomyContext planTrimmer).
function requirementPlan(network, row) {
    return row?.plan || network?.plans?.get?.(row?.key) || null;
}
// The path a root's build chose for its item `item:<id>` (buy, craft, drop,
// spoil, owned, mammon_unseal, luxury_exchange): the one reader for "how
// does this wish get its item" (GearPlanSelection passes its kind to the gear
// planner, R1). A root without that row (the item is owned) reads the
// item's plan.
function rootItemPlan(network, wish, itemId) {
    const key = `item:${Number(itemId)}`;
    return requirementPlan(network, wish?.plan?.requirements?.find(row => row.key === key) || { key });
}
// Translate the chosen shared wish into the existing equipment craft owner
// or an opt-in hot stock visit, using the already built graph.
// What the bot works toward: the focus root (network.focus[0]) as its wish
// row (the money queue's, else its node object and plan), and whether the
// current step (the activity leaf) serves it. Every plan target translates
// this root; a step toward it (`next`) comes only from a leaf that serves it.
function focusWish(context) {
    const network = context?.network, key = network?.focus?.[0];
    if (typeof key !== 'string' || !key) return null;
    const parts = key.split(':');
    const wish = network.queue?.find(row => row.key === key) || { key,
        object: context.projection?.nodes?.find(row => row.key === key)?.object
            || (parts[0] === 'power' ? { itemId: Number(parts[1]), slot: Number(parts[2]) } : undefined),
        plan: network.plans?.get(key) };
    return { key, wish, serving: network.activity?.rootKey === key };
}
// The focus root's plan while the step serves it, else null (the caller's
// selected plan defers the held one).
function personalCraftPlan(state, context, { allowStock = false } = {}) {
    const leaf = context?.network?.activity;
    const focus = focusWish(context);
    if (!focus?.serving) return null;
    const paidInputs = state.stats?.equipmentPlan?.crystalPreparation && need('./BotCrystallization').preparation(state);
    if (paidInputs && focus.key === paidInputs.key) return paidInputs.plan;
    if (!['crafting', 'shopping', 'hunting', 'improving'].includes(leaf.activity)) return null;
    const wish = focus.wish;
    const targetId = Number(wish?.object?.itemId || leaf.rootKey.split(':')[1]);
    const stock = allowStock && state.phase === 'hot' && /^stock:(shots|potions|scrolls)$/.test(leaf.rootKey);
    const clanSupply = wish.object?.clanSupply && need('./ClanCrystalSupply').requirement(state);
    if (!targetId || !leaf.rootKey.startsWith('power:') && !stock && !clanSupply) return null;
    if (stock && (leaf.activity !== 'crafting' || leaf.funding || !wish?.funded)) return null;
    // Ready blacksmith exchanges cost no money, so their root need not be in
    // the spending queue. Route the native selected leaf to the equipment
    // owner; it cannot be executed by the dwarf workshop/production owner.
    const dual = leaf.kind === 'craft' && leaf.activity === 'crafting' && leaf.executable && !leaf.funding
        ? DualSwords.resolveByRecipeId(leaf.recipeId) : null;
    const dualReady = dual?.productId === targetId ? Planner.craftReadiness(dual, state, recipe => recipe) : null;
    if (dualReady?.status === 'ready_to_craft') return {
        strategy: 'craft', status: 'ready_to_craft', next: null,
        target: { selfId: targetId, slot: 14 }, recipeId: dual.recipeId, outputAmount: 1,
        materials: dualReady.materials,
        combine: { type: 'dual_sword', resultId: targetId, stationId: dual.station.id,
            npcId: dual.station.npcId, requirements: dual.materials.map(row => ({ ...row })) },
        source: 'wish_network'
    };
    const providers = {}, components = {}, visited = new Set(), crystalInputs = new Map();
    let finalRecipe = null, unseal = null;
    let exchange = leaf.kind === 'luxury_exchange' && Number(leaf.improvement?.itemId) === targetId ? leaf.improvement : null;
    const visit = (plan, depth = 0) => {
        if (!plan || depth > 8 || visited.has(plan)) return;
        visited.add(plan);
        if (plan.kind === 'mammon_unseal' && Number(plan.unseal?.productId) === targetId)
            unseal = plan.unseal;
        if (plan.kind === 'luxury_exchange' && Number(plan.improvement?.itemId) === targetId)
            exchange = plan.improvement;
        if (plan.kind === 'crystallize') {
            const command = plan.execution || plan;
            for (const input of command.improvement.items
                || [{ selfId: command.improvement.sourceSelfId, amount: Number(command.batches || 1) }])
                crystalInputs.set(Number(input.selfId), Number(input.amount));
        }
        // A craft by a dwarf's workshop, or by the bot itself: its own
        // known recipe (craftPath without a workshop; a scroll still to
        // learn is no crafter yet).
        if (plan.kind === 'craft' && (plan.workshop || !plan.requiresRecipeLearning)) {
            const recipe = RecipeItems.resolveByRecipeId(plan.recipeId);
            if (!recipe || DualSwords.isCombination(recipe)) return;
            if (Number(recipe.productId) === Number(unseal?.sourceId || targetId)) finalRecipe = recipe;
            components[recipe.productId] = Number(recipe.recipeId);
            providers[recipe.recipeId] = plan.workshop ? { workshop: true, characterId: Number(plan.workshop.characterId),
                price: Number(plan.workshop.price),
                loc: plan.workshop.loc, townName: plan.workshop.townName, known: true } : { self: true, known: true };
        }
        for (const row of plan.requirements || []) visit(requirementPlan(context.network, row), depth + 1);
    };
    visit(wish?.plan || context.network.plans.get(`item:${targetId}`));
    if (clanSupply) {
        const plan = clanSupply.plan;
        const inputs = [...crystalInputs].map(([selfId, amount]) => ({ selfId, amount }));
        return { ...plan, valueRate: Number(wish.ratio || 0),
            ...(plan.strategy === 'luxury_exchange'
                ? { materials: [...plan.materials.filter(row => !inputs.some(input => input.selfId === row.selfId)), ...inputs] }
                : inputs.length ? { crystalPreparation: { materials: inputs } } : {}) };
    }
    // The bag against the exchange, by the planner's one readiness rule (as
    // the craft plan below): its materials held is ready_to_craft (the
    // blacksmith runs every exchange), short is active.
    if (exchange) return { strategy: 'luxury_exchange',
        status: Planner.craftReadiness({ ...exchange, recipeId: 0 }, state, recipe => recipe, () => null, null).status || 'active',
        target: { selfId: targetId, slot: Number(wish.object?.slot || leaf.rootKey.split(':')[2]) }, exchange,
        materials: [...exchange.materials.map(row => ({ ...row })),
            ...[...crystalInputs].map(([selfId, amount]) => ({ selfId, amount }))],
        ...(leaf.activity === 'hunting' ? { next: { spotId: leaf.spotId, npcId: leaf.npcId,
            selfId: Number(leaf.itemId || leaf.object), sourceKind: leaf.kind } } : {}),
        valueRate: Number(wish.ratio || 0), source: 'wish_network' };
    if (!finalRecipe && !unseal) return null;
    // The bag against the recipe, by the planner's one readiness rule: a
    // ready plan or component sends the bot to its crafter (ColdCraftingService
    // craftTrip), a short one keeps each material's missing count. A plan
    // still breaking gear for crystals stays active while only a component
    // is ready: its preparation readers (BotCrystallization, ItemDisposition
    // equipment hold) serve an active plan.
    // Its crafters: the providers above, the bot itself while its craft
    // skill covers the recipe (MP is the executor's wait, not a readiness).
    const crafter = recipe => providers[recipe.recipeId]?.self ? canCraft(state, recipe) ? recipe : null
        : providers[recipe.recipeId] ? recipe : null;
    const readiness = finalRecipe ? Planner.craftReadiness(finalRecipe, state, crafter,
        id => RecipeItems.resolveByRecipeId(components[id]) || null) : null;
    const status = readiness?.status === 'component_ready' && crystalInputs.size ? null : readiness?.status;
    return { strategy: 'craft', status: status || 'active',
        target: { selfId: targetId, slot: stock ? 0 : Number(wish.object?.slot || leaf.rootKey.split(':')[2]) },
        ...(leaf.activity === 'hunting' ? { next: { spotId: leaf.spotId, npcId: leaf.npcId,
            selfId: Number(leaf.itemId || leaf.object), sourceKind: leaf.kind } } : {}),
        recipeId: Number(finalRecipe?.recipeId) || null,
        outputAmount: Number(wish.object?.amount || 1) + (stock ? Math.max(0, Number(state.inventory?.[targetId]?.amount) || 0) : 0),
        materials: readiness ? readiness.materials : [{ selfId: unseal.sourceId, amount: 1 }],
        ...(unseal ? { unseal: { ...unseal } } : {}), craftProviders: providers,
        ...(crystalInputs.size ? { crystalPreparation: {
            materials: [...crystalInputs].map(([selfId, amount]) => ({ selfId, amount })) } } : {}),
        componentRecipes: components, valueRate: Number(wish.ratio || 0), source: 'wish_network',
        // A ready step the bot crafts itself waits for its MP in the worker
        // (ColdSimulationKernel), not in a main command.
        ...(status && providers[readiness.recipe?.recipeId]?.self ? { selfCraftMp: Number(readiness.recipe.mpCost || 0) } : {}),
        ...(stock ? { purpose: 'stock', wishKey: leaf.rootKey } : {}) };
}
// The NPC funding sale of a town visit: bag units only (the visit sells the
// bag, BotLifeState.applyNpcLiquidation) past the focus part of the held
// reader; a build's own claims come off in its network (WishNetwork funding).
function liquidationCandidates(state, ctx) {
    const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
    return Disposition.saleCandidates(state, { preparedReservations: Disposition.reservedEquipmentAmounts(state),
        keptAmounts: { ...invoke('GameServer/Inventory/ShotStock').keptAmounts(state, ctx),
            ...invoke('GameServer/Bot/AI/HealingPotionStock').keptAmounts(state, { targetAmount: ctx.stock('potions').target }),
            ...invoke('GameServer/Bot/Travel/ScrollStock').keptAmounts(state) }
    }).filter(row => row.npcComparable);
}
// Re-run the native selector, including rejected and cap-displaced items. The
// held foundation supplies only its stock targets; current owners still read
// current bag/warehouse quantities, equipment and physical reservations.
// These ordered pairs are its complete output consumed by the provider.
function liquidationInputs(state, basis) {
    if (!basis?.shots || !basis?.potions) return { proof: null, candidates: null };
    const shots = basis.shots, potions = basis.potions;
    const known = Number.isSafeInteger(shots.itemId) && shots.itemId > 0
        && [shots.target, shots.beginnerCurrent ?? 0, potions.target].every(value => Number.isFinite(value) && value >= 0);
    const excluded = basis.excluded || [];
    if (!known || !Array.isArray(excluded) || excluded.length > 128
        || !excluded.every(id => Number.isSafeInteger(id) && id > 0)
        || new Set(excluded).size !== excluded.length) return { proof: null, candidates: null };
    const exclusions = new Set(excluded);
    // Select before filtering: an excluded item can still displace a later
    // candidate at the native cap. These are the rows funding actually uses.
    const candidates = liquidationCandidates(state, { stock: kind => basis[kind] })
        .filter(row => !exclusions.has(Number(row.selfId)));
    const proof = Object.freeze({
        basis: Object.freeze({
            shots: Object.freeze({ itemId: shots.itemId, target: shots.target, beginnerCurrent: shots.beginnerCurrent ?? 0 }),
            potions: Object.freeze({ target: potions.target }),
            excluded: Object.freeze(excluded.slice())
        }),
        rows: Object.freeze(candidates.map(row => Object.freeze([row.selfId, row.count])))
    });
    return { proof, candidates };
}
// Exact transport of one proof above for the saved restart prefix: its fixed
// basis shape, then the ordered rows. Any other shape is refused, not cut.
const plainKeys = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function packLiquidationInputs(proof, write) {
    const basis = proof?.basis, shots = basis?.shots;
    if (!plainKeys(proof, ['basis', 'rows']) || !plainKeys(basis, ['shots', 'potions', 'excluded'])
        || !plainKeys(shots, ['itemId', 'target', 'beginnerCurrent']) || !plainKeys(basis.potions, ['target'])
        || !Array.isArray(proof.rows) || !proof.rows.every(row => Array.isArray(row) && row.length === 2)) return false;
    write.uint(shots.itemId); write.number(shots.target); write.number(shots.beginnerCurrent); write.number(basis.potions.target);
    write.list(basis.excluded, id => write.uint(id));
    write.list(proof.rows, ([id, count]) => { write.uint(id); write.number(count); });
    return true;
}
function unpackLiquidationInputs(read) {
    const shots = Object.freeze({ itemId: read.uint(), target: read.number(), beginnerCurrent: read.number() });
    const potions = Object.freeze({ target: read.number() });
    const excluded = Object.freeze(read.list(() => read.uint()));
    const rows = Object.freeze(read.list(() => Object.freeze([read.uint(), read.number()])));
    return Object.freeze({ basis: Object.freeze({ shots, potions, excluded }), rows });
}
// The buy line a farm_sale root sells to: the head plain (enchant 0) BUY
// line of the item not the bot's own. The pre-cut reads it for the root, the
// SOLD watch row for its reference and its close (DecisionSections.marketCrossed).
function farmLine(board, id, ownerId) {
    return board?.first(id, BUY, { excludeOwner: ownerId, enchant: 0 }) || null;
}

module.exports = { farmLine, GEAR_FINALISTS_PER_SLOT, committedOf, nominationBasis, quantityReaders, knownWorkshop, rootItemPlan, focusWish, personalCraftPlan, liquidationCandidates, liquidationInputs, packLiquidationInputs, unpackLiquidationInputs, build, gearCandidates, gearStepNets, gearGain, worn };
