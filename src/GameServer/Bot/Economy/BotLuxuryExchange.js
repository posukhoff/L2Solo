'use strict';

const Shop = require('../../World/Generics/NpcExchangeShopLists');
const Index = require('../../Item/ItemTemplateIndex');
const Data = invoke('GameServer/DataCache');
const Progression = invoke('GameServer/Bot/AI/PersonalGearProgression');
const { GRADE_SOURCE } = invoke('GameServer/Bot/AI/GearGradeRule');
const NPC_IDS = [7097, 7098];
let spawns, items, catalog;
// One immutable index per thread, rebuilt only when authored spawns change.
// Bots pay the player's price: every required row (the C and D crystals).
// Its rows are the gear of the grades the luxury shop is the source of
// (GearGradeRule.GRADE_SOURCE: C).
function recipes() {
    if (catalog && spawns === Data.npcSpawns && items === Data.items) return catalog;
    spawns = Data.npcSpawns; items = Data.items; catalog = new Map();
    const enabled = new Set();
    for (const region of spawns || []) for (const row of region.spawns || [region])
        if (Number(row.total) > 0 && NPC_IDS.includes(Number(row.selfId))) enabled.add(Number(row.selfId));
    for (const npcId of enabled) Shop.fetchForNpc(npcId).forEach((row, recipeIndex) => {
        if (GRADE_SOURCE[Index.find(items, row.result.selfId)?.etc?.rank] !== 'luxury') return;
        const required = row.required || [];
        if (!required.length || !required.every(item => Number(item.amount) > 0)) return;
        catalog.set(Number(row.result.selfId), Object.freeze({ npcId, recipeIndex,
            itemId: Number(row.result.selfId), amount: Number(row.result.amount),
            materials: Object.freeze(required.map(item => Object.freeze({ selfId: Number(item.selfId), amount: Number(item.amount) }))) }));
    });
    return catalog;
}
function resolve(proposal) {
    const recipe = recipes().get(Number(proposal?.itemId));
    return recipe && recipe.npcId === Number(proposal.npcId)
        && recipe.recipeIndex === Number(proposal.recipeIndex) ? recipe : null;
}
function eligible(state, recipe) {
    const item = recipe && Index.find(Data.items, recipe.itemId);
    if (!item) return false;
    // From the preparation level (the grade below's) once the working kit is
    // closed, from the prepared grade's own level always.
    if (!Progression.allowsCGradeAcquisition(state) || Number(state.level) < Progression.PREPARATION_LEVEL
        || Number(state.level) < Progression.PREPARED_LEVEL && Progression.assess(state).milestone.required) return false;
    // lazy: worker loading the planner here at load time pulls main-only modules into the cold worker
    const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    return Planner.suitable(item, state, Planner.roleFor(state), item.etc?.rank);
}
module.exports = { recipes, resolve, eligible, NPC_IDS };
