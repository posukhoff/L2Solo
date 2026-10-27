'use strict';

const GearLifecycle = require('./GearLifecycle');
const Data = invoke('GameServer/DataCache');
const Index = invoke('GameServer/Item/ItemTemplateIndex');
const StarterItemCatalog = require('../../Knowledge/StarterItemCatalog');
const Compatibility = invoke('GameServer/Bot/AI/BotEquipmentCompatibility');
const { GRADES: RANKS, gradeForLevel, levelForGrade, topGradeOf } = invoke('GameServer/Bot/AI/GearGradeRule');
// The author's working kit (milestone) ends at the top grade a shop sells
// (GearGradeRule's source table: the luxury shop's C); his acquisition kit
// runs one grade further (B), and the grades past it are buy-only while that
// kit is open (marketOnly: A, S).
const SHOP_TOP = RANKS.indexOf(topGradeOf('luxury'));
const KIT_TOP = SHOP_TOP + 1;
// The first graded level (D: a starter kit is outgrown) and the C expertise
// level (the working weapon and armour before jewellery).
const D_LEVEL = levelForGrade('d'), C_LEVEL = levelForGrade('c');
function adventurer(state = {}) {
    return !state.stats?.craftStationId
        && !(state.activity === 'crafting' && state.stats?.craftShop
            && Number(state.stats?.generatedIndex) >= 10000);
}
function personal(state = {}) {
    return adventurer(state) && !invoke('GameServer/Clan/ClanSupplyPolicy').hasWarehouse(state);
}

// The kit gaps: a slot empty or worn under the level's grade
// (GearGradeRule.gradeForLevel). A gap names its slot and priority; which
// item closes it, at which grade, is the wish's (WishProviders: the strongest
// reachable step stronger than worn, by its value over the stage's hours).
// A gap's `wornRank`: the grade worn in its slot (empty = none).
// `milestone`: is the author's working kit (level grade, at most C) still open, which slots?
function assess(state = {}) {
    // Clan custody changes where surplus goes, not the member's need for a
    // working kit. Its own wallet and native sources still fund equipment.
    if (!adventurer(state)) return { required: false, gaps: new Map(), milestone: { required: false, gaps: new Map() } };
    const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    const Gear = invoke('GameServer/Bot/AI/BotGear');
    const classId = Number(state.stats?.classId ?? state.classId ?? 0), role = Planner.roleFor(state);
    const level = Math.max(1, Number(state.level) || 1);
    const starters = StarterItemCatalog.ids(Data.newbieItems, true);
    const equipped = new Map();
    for (const row of Object.values(state.inventory || {})) {
        const item = Index.find(Data.items, row.selfId);
        if (!item || !Planner.equipmentCandidate(item, state, role)) continue;
        for (const slot of Planner.equippedSlotsFor(row, item.etc?.slot)) equipped.set(slot, item);
    }
    const weapon = equipped.get(7) || equipped.get(14);
    const twoHanded = !!equipped.get(14);
    const kit = (planLevel, rank) => {
        const baseline = Gear.planFor({ classId, level: planLevel });
        const gaps = new Map();
        for (const entry of baseline.items) {
            const slot = Number(entry.slot);
            if (slot === 8 && twoHanded) continue;
            let current = Compatibility.isWeaponSlot(slot) ? weapon
                : equipped.get(slot) || ([10, 11].includes(slot) ? equipped.get(15) : null);
            if (slot === 15 && !current && equipped.has(10) && equipped.has(11)) {
                const chest = equipped.get(10), legs = equipped.get(11);
                current = { selfId: chest.selfId, starterKit: starters.has(Number(chest.selfId)) || starters.has(Number(legs.selfId)),
                    etc: { slot: 15, rank: RANKS[Math.min(RANKS.indexOf(chest.etc?.rank || 'none'),
                        RANKS.indexOf(legs.etc?.rank || 'none'))], mp: Number(chest.etc?.mp || 0) + Number(legs.etc?.mp || 0) },
                    stats: { pDef: Number(chest.stats?.pDef || 0) + Number(legs.stats?.pDef || 0) } };
            }
            const reference = Index.find(Data.items, entry.selfId);
            const minScore = level < D_LEVEL && reference ? Planner.itemScore(reference, role, classId) : 0;
            const empty = !current, currentRank = empty ? 0 : RANKS.indexOf(current.etc?.rank || 'none');
            // A usable NG weapon still owes its first upgrade from D_LEVEL:
            // the weapon gap keeps the top priority and a D floor.
            const ungradedWeapon = level >= D_LEVEL && Compatibility.isWeaponSlot(slot) && currentRank < 1;
            const inadequate = current && (currentRank < rank
                || level < D_LEVEL && (current.starterKit || starters.has(Number(current.selfId))
                    || Planner.itemScore(current, role, classId) < minScore));
            // From C expertise, finish the working weapon and armour before
            // jewellery. Empty jewellery does not outrank an under-grade weapon.
            const priority = level >= C_LEVEL && slot === 6 ? 0 : ungradedWeapon ? 3 : level >= C_LEVEL
                ? GearLifecycle.slotPriority(slot)
                : empty ? Compatibility.isWeaponSlot(slot) ? 3 : 2 : 1;
            if (empty || inadequate) gaps.set(slot, { slot, priority, rank: ungradedWeapon ? 1 : rank, minScore, wornRank: currentRank });
        }
        // C helmets have no Luxury exchange. Keep the opportunity without
        // holding the working kit, earning routes or higher grades behind it.
        return { required: [...gaps.values()].some(gap => gap.priority > 0), gaps };
    };
    const rank = RANKS.indexOf(gradeForLevel(level)), milestoneRank = Math.min(rank, SHOP_TOP);
    const own = kit(rank === 0 ? 10 : levelForGrade(RANKS[Math.min(rank, KIT_TOP)]), rank);
    const milestone = rank === milestoneRank ? own : kit(levelForGrade(RANKS[milestoneRank]), milestoneRank);
    return { required: own.required, gaps: own.gaps, rank, starters, role, classId,
        milestone: { required: milestone.required, gaps: milestone.gaps, starters, role, classId } };
}

// The author's acquisition kit (a7c9bef22 acquisitionAssessment), read by
// every gear reader but the gear root choice: the level kit below 52; from
// 52 the C kit while open, then the B kit. Derived from `assessment` (the
// own kit is the B kit at 52-60 and holds every B gap above), no scan.
function acquisition(state, assessment = assess(state)) {
    if (!adventurer(state)) return { required: false, gaps: new Map(), rank: 0 };
    const milestone = assessment.milestone, b = KIT_TOP;
    if (Number(state.level) < levelForGrade(RANKS[KIT_TOP]) || milestone.required)
        return { required: milestone.required, gaps: milestone.gaps, rank: Math.min(assessment.rank, SHOP_TOP) };
    if (assessment.rank === b) return { required: assessment.required, gaps: assessment.gaps, rank: b };
    const gaps = new Map();
    for (const [slot, gap] of assessment.gaps) if (gap.wornRank < b) gaps.set(slot, { ...gap, rank: Math.min(gap.rank, b) });
    return { required: [...gaps.values()].some(gap => gap.priority > 0), gaps, rank: b };
}

// Is an A/S piece buy-only (no drop, recipe or craft party)? While the
// acquisition kit is open; a caller holding it passes it (`kit`).
function marketOnly(state, item, kit = null) {
    return Number(item?.etc?.slot) > 0 && RANKS.indexOf(item.etc.rank) > KIT_TOP && (kit || acquisition(state)).required;
}

function isCGradeHelmet(item) {
    return item?.etc?.rank === 'c' && Number(item.etc.slot) === 6;
}

function gapFor(slot, assessment) {
    return assessment.gaps.get(Number(slot))
        || (GearLifecycle.slotPriority(slot) === 3 ? assessment.gaps.get(7) || assessment.gaps.get(14)
            : Number(slot) === 15 ? assessment.gaps.get(10) || assessment.gaps.get(11)
            : [10, 11].includes(Number(slot)) ? assessment.gaps.get(15) : null);
}
// The kit priority of a step into `slot`: its gap's, at any grade. Whether
// the step is worth taking (stronger than worn, reachable, paying) is the
// wish's valuation, not a grade gate here. A reader that passes the item: a
// starter or weaker piece before 20 closes nothing and competes by its value
// alone; a milestone reader (grade, default) also closes nothing under the
// gap's grade. The gear roots pass grade false: the level's grade is a
// weight and a horizon only (game decision 10-24).
function priority(slot, assessment, item = null, { grade = true } = {}) {
    const gap = gapFor(slot, assessment);
    if (!gap) return 0;
    // lazy: cycle GearAcquisitionPlanner loads this module at its top
    const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    if (item && (grade && RANKS.indexOf(item.etc?.rank || 'none') < gap.rank || gap.rank === 0
        && (assessment.starters.has(Number(item.selfId))
            || Planner.itemScore(item, assessment.role, assessment.classId) < gap.minScore))) return 0;
    return gap.priority;
}

// Preparation changes the acquisition ceiling, never the wear/expertise rule.
// The future bag is short lived and uses the same class, paired-slot and armor
// selection as a physical inventory reconciliation at PREPARED_LEVEL; its
// grade is the lifted ceiling, read without building that bag.
// The prepared grade is the luxury shop's (the bot saves its crystals for
// it from the grade below's level: 20 to 40).
const PREPARED_GRADE = RANKS[SHOP_TOP];
const PREPARED_LEVEL = levelForGrade(PREPARED_GRADE);
const PREPARATION_LEVEL = levelForGrade(RANKS[SHOP_TOP - 1]);
function preparing(state, assessment) {
    if (!personal(state) || state.level < PREPARATION_LEVEL || state.level >= PREPARED_LEVEL) return false;
    return !(assessment || assess(state)).milestone.required;
}
function preparation(state, assessment) {
    return preparing(state, assessment) ? futureState(state) : null;
}
// Warehouse custody does not remove the member's own C acquisition sources.
// Early preparation keeps its existing personal-owner boundary.
function allowsCGradeAcquisition(state) {
    return adventurer(state) && (Number(state.level) >= PREPARED_LEVEL || personal(state));
}
function futureState(state) {
    const exp = Number(Data.experience[PREPARED_LEVEL - 1]);
    const next = { ...state, level: PREPARED_LEVEL, exp, stats: { ...state.stats, exp } };
    next.inventory = invoke('GameServer/Bot/AI/GearAcquisitionPlanner').equipInventoryUpgrades(next, state.inventory);
    return next;
}
function preparedAmounts(state) {
    if (!personal(state) || state.level < PREPARATION_LEVEL || state.level >= PREPARED_LEVEL) return {};
    if (!Object.values(state.inventory || {}).some(row => Number(row.amount) > 0
        && Index.find(Data.items, row.selfId)?.etc?.rank === PREPARED_GRADE)) return {};
    const reserved = {};
    for (const row of Object.values(futureState(state).inventory)) {
        if (Index.find(Data.items, row.selfId)?.etc?.rank === PREPARED_GRADE && row.equippedCount > 0)
            reserved[row.selfId] = Number(row.equippedCount);
    }
    return reserved;
}

module.exports = { personal, adventurer, assess, acquisition, marketOnly, priority, PREPARED_GRADE, PREPARED_LEVEL, PREPARATION_LEVEL, preparing, preparation, preparedAmounts, allowsCGradeAcquisition, isCGradeHelmet };
