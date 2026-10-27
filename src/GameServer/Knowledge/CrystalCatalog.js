'use strict';
const { CRYSTAL_IDS } = invoke('GameServer/Items/C4EnchantRules');

// The one crystallizable-gear catalogue: grade ('d'..'s', the grades with a
// crystal, C4EnchantRules.CRYSTAL_IDS) -> [{ gear, crystals, crystalId }],
// every piece that breaks into crystals (its unenchanted count), in catalogue
// order. Built once per item catalogue; its readers add their own admission
// (BotCrystallization.sweep: a template price, cheapest per crystal first;
// FirstPrice: an acquisition source; ColdOccupationSources.gearRowsFor: the
// npc and board quotes of each piece).
let gradeItems = null, byGradeRows = null;
function byGrade(items) {
    if (byGradeRows && gradeItems === items) return byGradeRows;
    const rows = new Map();
    for (const gear of items || []) {
        const crystals = Number(gear?.etc?.cristals || 0), rank = String(gear?.etc?.rank || '');
        const crystalId = CRYSTAL_IDS[rank.toUpperCase()];
        if (!crystalId || !(crystals > 0)) continue;
        if (!rows.has(rank)) rows.set(rank, []);
        rows.get(rank).push(Object.freeze({ gear, crystals, crystalId: Number(crystalId) }));
    }
    gradeItems = items; byGradeRows = rows;
    return rows;
}
module.exports = { byGrade };
