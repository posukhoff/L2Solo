'use strict';
const Index = require('../../Item/ItemTemplateIndex');
const Luxury = require('./BotLuxuryExchange');
const Floor = require('../Population/SurvivalFloor');
const Eligibility = require('./CraftEligibility');
const Rules = invoke('GameServer/Items/C4EnchantRules');
const Data = invoke('GameServer/DataCache');
const Progression = invoke('GameServer/Bot/AI/PersonalGearProgression');
const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
const CrystalCatalog = require('../../Knowledge/CrystalCatalog');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Price = invoke('GameServer/Bot/Economy/PriceDecision');
// The Crystallize skill level a grade needs (C4).
const SKILL_LEVEL = Object.freeze({ d: 1, c: 2, b: 3, a: 4, s: 5 });
// Each grade's crystal id -> its grade (C4EnchantRules.CRYSTAL_IDS, D to S).
const CRYSTAL_RANKS = new Map(Object.entries(Rules.CRYSTAL_IDS).map(([grade, id]) => [Number(id), grade.toLowerCase()]));
// The crystal a crystal preparation makes: C, the B recipes' input.
const PREPARED_CRYSTAL = Rules.CRYSTAL_IDS.C;
let templates, candidates = new Map();
// The one answer to "can this bot crystallize this grade": its own
// Crystallize skill (248). Bots never crystallize at an NPC.
function canSelf(state, rank = 'd') {
    const needed = SKILL_LEVEL[rank];
    return needed > 0 && ownSkills(state)
        .some(skill => Number(skill.selfId) === 248 && Number(skill.level) >= needed);
}
// The skill list canSelf reads; a held answer keys on this reference.
const NO_SKILLS = Object.freeze([]);
function ownSkills(state) {
    return state?.stats?.coldCombat?.skills || state?.skills || NO_SKILLS;
}
// What breaking a piece yields: its grade's crystals (C4EnchantRules,
// D to S), the count with its enchant; null for ungraded or crystal-less.
function reward(template, enchant = 0) {
    const rank = template?.etc?.rank;
    const crystalId = Rules.CRYSTAL_IDS[String(rank).toUpperCase()];
    if (!crystalId) return null;
    const kind = template.template.kind;
    const gross = Rules.crystalCount({ rank, cristals: template.etc.cristals, enchant,
        isWeapon: () => kind.startsWith('Weapon.'), isArmor: () => kind.startsWith('Armor.'),
        fetchKind: () => kind });
    return gross > 0 ? { gross, net: gross, crystalId } : null;
}
// The one floor of an item's exit (T89, decision 10-28): the better of the
// NPC buy-back (PriceDecision.buyback) and breaking it into its grade's
// crystals at priceOf (crystal id -> price). state: the holder, whose
// crystals count only when it roots their sale itself (canRootSale: its own
// skill, a roaming crafter; WishProviders' crystal root breaks its spares);
// null = the market's view (a piece any crystallizer would pay its crystals
// for). A sale on the board goes on top (the caller's listing or traded
// price). O(skills); the crystal price is read only when the holder breaks
// the piece.
function exitFloor(id, priceOf, state = null, enchant = 0) {
    const npc = Price.buyback(id);
    const template = Index.find(Data.items, Number(id));
    if (state && !canRootSale(state, template?.etc?.rank)) return npc;
    const result = reward(template, enchant);
    return result ? Math.max(npc, result.net * Math.max(0, Number(priceOf(result.crystalId)) || 0)) : npc;
}
// A held piece this bot can break itself: a reward and its skill level.
function crystallizable(state, id) {
    const template = Index.find(Data.items, id);
    return !!reward(template) && canSelf(state, template.etc.rank);
}
// The one answer to "may this bot root a sale of this grade's crystals"
// (WishProviders' crystal root, EconomyContext's crystal watch rows): a
// market producer (CraftEligibility.marketProducer) with the grade's skill.
function canRootSale(state, rank) {
    return canSelf(state, rank) && Eligibility.marketProducer(state);
}
// The crystal a held piece's sale root yields for this bot; 0 when it may
// not root that sale (canRootSale) or the piece breaks into none.
function saleCrystal(state, id) {
    const template = Index.find(Data.items, id), result = reward(template);
    return result && canRootSale(state, template.etc.rank) ? result.crystalId : 0;
}
// A grade's sweep catalogue, once per thread: `rows`, every piece of the one
// crystallizable-gear catalogue (CrystalCatalog.byGrade, FirstPrice's too)
// with a template price, cheapest per crystal first (`order`: its
// position, the sweep's walk order); `group`, the market counter they all
// share (MarketCounters.counterOf, 'gear c'), the key of the board's list of
// the grade's listed gear (listed). Dropped when the item templates are rebuilt.
function sweep(rank) {
    if (templates !== Data.items) { templates = Data.items; candidates = new Map(); }
    if (candidates.has(rank)) return candidates.get(rank);
    // The immutable catalogue bounds the scan. Rank only after reading
    // actual quotes: a template-price shortlist hides cheap live inputs.
    const rows = (CrystalCatalog.byGrade(templates).get(rank) || []).filter(row => Number(row.gear.template.price) > 0)
        .sort((a, b) => a.gear.template.price / a.crystals - b.gear.template.price / b.crystals || a.gear.selfId - b.gear.selfId)
        .map(row => Number(row.gear.selfId));
    const entry = { rows, order: new Map(rows.map((id, at) => [id, at])), group: rows.length ? Counters.counterOf(rows[0]) : null };
    candidates.set(rank, entry); return entry;
}
function catalog(rank = 'd') {
    return sweep(rank).rows;
}
// The grade's pieces with a sell line on the board, in the sweep's order:
// the only ones a board reader can quote (C-S gear, no NPC sells it). Read
// from the board's own group list (BoardIndex.groupItemIds, kept by every
// line put or removed): O(listed ids), never the catalogue.
function listed(board, rank) {
    const { order, group } = sweep(rank);
    if (!group || !board?.groupItemIds) return [];
    return board.groupItemIds(group).filter(id => order.has(id)).sort((a, b) => order.get(a) - order.get(b));
}
function spareState(state) {
    // The selected exchange reserves its inputs for this operation. Other
    // equipment, component and future-gear owners still protect their bag.
    const plan = invoke('GameServer/Bot/Economy/ItemDisposition').equipmentInputPlan(state);
    return plan?.strategy === 'luxury_exchange' ? { ...state, stats: { ...state.stats, equipmentPlan: null } }
        : plan?.crystalPreparation ? { ...state, stats: { ...state.stats,
            equipmentPlan: { ...plan, crystalPreparation: null } } } : state;
}
// The focus part of the held reader only (reservedEquipmentAmounts): its
// readers are the decision (its build splits held stock itself) and the
// executors of its steps (a crystallize, a preparation's command), which
// take what that split gave them; the goals' claims (ItemDisposition.
// heldAmounts) guard the bag against the sale and the warehouse.
function freeReader(state) {
    const source = spareState(state);
    const freeAmount = invoke('GameServer/Bot/Economy/WealthCraftDecision').freeAmount;
    const reserved = invoke('GameServer/Bot/Economy/ItemDisposition').reservedEquipmentAmounts(source);
    return id => freeAmount(source, source.inventory?.[id] || {}, reserved);
}
// purchase: the quote reader of an input (id -> offer or null), asked for
// every offered piece: the grade's sweep catalogue (D at Giran's NPC), or
// with `board` only its listed pieces (listed(board, rank), after canSelf).
// profile: the caller's kit profile reader (() => ColdCombatProfile's),
// read once, at the first offer.
// ownPrice: the price the caller's solver charges a held piece (its item
// node's price); a held row's score is that per crystal, a bought row's its
// landed cost, so the first row is the cheapest input by the solver's own
// cost. Without it a held piece costs 0 (spares first).
// Empty for a bot without the skill for this grade (canSelf).
function choices(state, purchase, incomePerHour = 0, rank = 'd', quantityInputs = null, profile = null, ownPrice = null, board = null) {
    if (!canSelf(state, rank)) return [];
    const rows = [], bundle = [];
    // One command breaks the whole input (C4 Crystallize has no count limit):
    // bought pieces are bounded by the bag room the survival floor leaves
    // (no no_slot / overweight unload between the buy and the crystallize).
    // One bag scan (the floor's bag), at the first offer.
    let bag = null, bundleNet = 0;
    const held = [];
    for (const row of Object.values(state.inventory || {})) { const template = Index.find(Data.items, row.selfId); if (template?.etc?.rank === rank && reward(template)) held.push(Number(row.selfId)); }
    // The walk: the offered pieces and the held ones, in catalogue order
    // (held pieces outside it last, in bag order): the bundle below takes
    // the first held spares of that order.
    const { rows: catalogue, order } = sweep(rank), last = order.size;
    const offered = board ? listed(board, rank) : catalogue;
    const walk = held.length ? [...offered, ...held].sort((a, b) => (order.get(a) ?? last) - (order.get(b) ?? last)) : offered;
    const seen = new Set(walk);
    // No piece of this grade in the catalogue or the bag: no free reader.
    if (!seen.size) return rows;
    const readFree = freeReader(state);
    for (const id of seen) {
        const held = state.inventory?.[id], own = readFree(id);
        // Missing bag identities are fenced by the caller's structural event.
        // These are the exact native questions for its existing physical rows.
        if (held) {
            quantityInputs?.present(id, Number(held.amount) || 0);
            // Read as a batch amount below, no threshold noted: untracked.
            quantityInputs?.crystalFree(id, own); quantityInputs?.untracked('crystalFree', id);
        }
        // A bought copy of worn/useful gear could be reconciled into the kit.
        // Prefer a different type or an already free physical spare.
        if (Number(held?.amount) > 0 && !own) continue;
        const template = Index.find(Data.items, id), result = reward(template, 0);
        if (own && bundle.length < 4) {
            bundle.push({ selfId: id, amount: own }); bundleNet += own * result.net;
        }
        const offer = purchase(id);
        if (!own && !offer) continue;
        const batchLimit = own + (offer ? Math.min(Floor.bagRoom(bag ||= Floor.bagOf(state, profile()), template?.template?.mass),
            Number(offer.availableUnits || 0)) : 0);
        if (!batchLimit) continue;
        const total = own ? Number(ownPrice?.(id)) || 0 : offer.price + offer.tripFees;
        rows.push({ selfId: id, ...result, score: (total + (own ? 0 : offer.tripHours) * incomePerHour) / result.net,
            sourceType: own ? 'owned' : offer.sourceType,
            batchLimit, hours: own ? 0 : offer.tripHours });
    }
    rows.sort((a, b) => a.score - b.score || a.hours - b.hours || a.selfId - b.selfId);
    const selected = [], limit = bundle.length > 1 ? 1 : 2;
    // Kit reconciliation is expensive. Check candidates in actual landed
    // price order and stop once the two retained paths are safe inputs.
    for (const row of rows) {
        const id = row.selfId;
        if (!state.inventory?.[id]) {
            const template = Index.find(Data.items, id);
            const inventory = { ...state.inventory, [id]: { selfId: id, amount: 1, slot: template.etc.slot, equipped: false } };
            const equipped = Planner.equipInventoryUpgrades(state, inventory);
            if (equipped[id]?.equipped || equipped[id]?.equippedCount > 0) continue;
        }
        selected.push(row);
        if (selected.length === limit) break;
    }
    return bundle.length > 1
        ? [{ inputs: bundle, net: bundleNet, batchLimit: 1 }, ...selected] : selected;
}
// The one crystallize command path, with the bot's own skill.
// inputs: a fixed batch, [{ selfId, amount }] rows the command breaks whole
// (items); or one item id whose piece count the leaf's batches set
// (sourceSelfId).
function path(crystalId, inputs) {
    const fixed = Array.isArray(inputs);
    const sources = fixed ? { items: inputs, ...(inputs.length === 1 ? { sourceSelfId: inputs[0].selfId } : {}) }
        : { sourceSelfId: Number(inputs) };
    return { kind: 'crystallize', activity: 'improving', itemId: Number(crystalId), costHours: 1 / 3600,
        improvement: { kind: 'crystallize', ...sources } };
}
function inputAmount(state, id) {
    // lazy: cycle ItemDisposition requires BotCrystallization at load
    const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
    const plan = Disposition.equipmentInputPlan(state);
    // A crystal preparation serves only a plan still gathering ('active'): at
    // the craft statuses the inputs are already in hand.
    const rows = plan?.status === 'active' && plan.crystalPreparation?.materials || Disposition.exchangeMaterials(plan);
    if (!crystallizable(state, id)) return 0;
    // The plan's amount was sized by choices (batchLimit) when it was built.
    return Number(rows.find(row => Number(row.selfId) === Number(id))?.amount || 0);
}
// Paid physical inputs can finish their conversion while another ingredient
// of the final B recipe has no current route. That gap cannot release them
// to sale or replace their equipment owner.
function preparation(state) {
    const plan = invoke('GameServer/Bot/Economy/ItemDisposition').equipmentInputPlan(state);
    if (!plan?.crystalPreparation || plan.status !== 'active' || !plan.target?.selfId) return null;
    const missing = Number(plan.materials?.find(row => Number(row.selfId) === PREPARED_CRYSTAL)?.amount || 0)
        - Number(state.inventory?.[PREPARED_CRYSTAL]?.amount || 0);
    if (!(missing > 0)) return null;
    const prep = plan.crystalPreparation;
    const key = `crystal_input:${plan.target.selfId}:${plan.target.slot}`;
    let free = null;
    for (const rank of ['c', 'd']) {
        if (!canSelf(state, rank)) continue;
        const inputs = []; let amount = 0;
        for (const row of prep.materials || []) {
            if (Index.find(Data.items, row.selfId)?.etc?.rank !== rank) continue;
            const count = Math.min(Number(row.amount || 0), (free ||= freeReader(state))(row.selfId));
            if (count > 0) { inputs.push({ selfId: Number(row.selfId), amount: count }); amount += count; }
        }
        if (inputs.length)
            return { key, plan, path: { ...path(Rules.CRYSTAL_IDS[rank.toUpperCase()], inputs), batches: amount } };
    }
    return null;
}
// Scheduler admission reads only the selected bounded inputs. The worker
// still chooses the operation and the native transaction validates ownership.
// quantityInputs (optional) records the bag reads a crystal preparation's
// answer rests on, for a caller whose decision is held on them.
function ready(state, quantityInputs = null) {
    // Ordinary scheduler rows need no game catalogue or reservation services.
    const saved = state?.stats?.equipmentPlan;
    if (!saved?.crystalPreparation && saved?.strategy !== 'luxury_exchange'
        && saved?.exchange?.kind !== 'luxury_exchange') return false;
    const plan = invoke('GameServer/Bot/Economy/ItemDisposition').equipmentInputPlan(state);
    if (plan?.crystalPreparation && plan.status === 'active') {
        const prep = plan.crystalPreparation, reader = freeReader(state);
        // atLeast: the count each read is compared with (its threshold).
        const readFree = (id, atLeast) => {
            const amount = reader(id);
            quantityInputs?.crystalFree(id, amount); quantityInputs?.atLeast('crystalFree', id, atLeast);
            return amount;
        };
        const held = Number(state.inventory?.[PREPARED_CRYSTAL]?.amount);
        quantityInputs?.physical(PREPARED_CRYSTAL, Math.max(0, held || 0));
        // The crystals' threshold is noted only when its compare runs.
        const crystalsHeld = () => {
            const crystals = Number(plan.materials?.find(row => Number(row.selfId) === PREPARED_CRYSTAL)?.amount);
            quantityInputs?.atLeast('physical', PREPARED_CRYSTAL, crystals);
            return held >= crystals;
        };
        return (prep.materials || []).some(row => crystallizable(state, row.selfId)
            && readFree(row.selfId, 1) > 0) || crystalsHeld();
    }
    if (plan?.strategy !== 'luxury_exchange' || !Planner.planRunning(plan)
        || !Progression.allowsCGradeAcquisition(state)) return false;
    // The exchange's price is the catalogue's (resolve), not the saved copy:
    // a plan saved before a recipe change lists the old materials.
    const exchange = Luxury.resolve(plan.exchange);
    if (!exchange) return false;
    const amount = id => invoke('GameServer/Bot/Economy/WealthCraftDecision').freeAmount(state, state.inventory?.[id] || {});
    if (exchange.materials.every(row => amount(row.selfId) >= row.amount)) return true;
    // The pieces the bot breaks for those crystals: the plan's other materials.
    const paid = new Set(exchange.materials.map(row => row.selfId));
    const inputs = (plan.materials || []).filter(row => !paid.has(Number(row.selfId)));
    return inputs.length > 0 && inputs.every(row => Number(row.amount) > 0
        && crystallizable(state, row.selfId) && amount(row.selfId) >= Number(row.amount));
}
function completionKey(state, quantityInputs = null) {
    // Each build asks; a saved plan with neither a crystal preparation nor a
    // luxury exchange has no completion (ready's guard, same reading).
    const saved = state?.stats?.equipmentPlan;
    if (!saved?.crystalPreparation && saved?.strategy !== 'luxury_exchange'
        && saved?.exchange?.kind !== 'luxury_exchange') return null;
    const plan = invoke('GameServer/Bot/Economy/ItemDisposition').equipmentInputPlan(state);
    if (plan?.crystalPreparation && plan.status === 'active' && ready(state, quantityInputs)
        && !Planner.equipmentTargetFulfilled(state, plan))
        return `power:${plan.target.selfId}:${Number(plan.target.slot)}`;
    if (plan?.strategy !== 'luxury_exchange' || !Planner.planRunning(plan) || !plan.target?.slot) return null;
    const exchange = Luxury.resolve(plan.exchange);
    if (!exchange || Number(plan.target.selfId) !== exchange.itemId || !Luxury.eligible(state, exchange)) return null;
    // atLeast: the count each read is compared with (its threshold).
    const freeOf = (id, atLeast) => {
        const amount = invoke('GameServer/Bot/Economy/WealthCraftDecision').freeAmount(state, state.inventory?.[id] || {});
        quantityInputs?.free(id, amount); quantityInputs?.atLeast('free', id, atLeast);
        return amount;
    };
    const crystalsReady = exchange.materials.every(row => freeOf(row.selfId, row.amount) >= row.amount);
    const receivedInputs = (plan.materials || []).some(row => crystallizable(state, row.selfId)
        && freeOf(row.selfId, 1) > 0);
    if (!crystalsReady && !receivedInputs) return null;
    if (Planner.equipmentTargetFulfilled(state, plan)) return null;
    const assessment = Progression.assess(state).milestone;
    const priority = Progression.priority(plan.target.slot, assessment, Index.find(Data.items, exchange.itemId));
    // Finish the selected paid-for kit piece before reallocating its crystals
    // to alternatives. A newly missing weapon or urgent stock still wins.
    if (!priority || priority < Math.max(0, ...[...assessment.gaps.values()].map(row => row.priority))) return null;
    return `power:${exchange.itemId}:${Number(plan.target.slot)}`;
}
module.exports = { CRYSTAL_RANKS, canSelf, exitFloor, ownSkills, crystallizable, canRootSale, saleCrystal, reward, catalog, listed, choices, path, freeReader, inputAmount, preparation, ready, completionKey };
