const ClassProgression = invoke('GameServer/ClassProgression');
const DataCache = invoke('GameServer/DataCache');
const Formulas = invoke('GameServer/Formulas');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const RestPolicy = invoke('GameServer/Bot/AI/RestPolicy');

// ARCH-NOTE: native FirstPrice needs seated recovery time in the clan worker.
// Share the resolver's unchanged calculation without its ChargeLifecycle/network
// imports; the authored regeneration and class tables arrive once per worker.

function midpointBand(levelBand) {
    if (!levelBand) return 1;
    const parts = String(levelBand).split('-').map((value) => Number(value));
    if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return Number(parts[0]) || 1;
    return Math.round((parts[0] + parts[1]) / 2);
}

// Game data: once per skill tree per class, level and passive.
const passiveAdds = new Map();
let passiveTree = null;
function coldPassiveRegenAdd(state, skillId, stat) {
    if (passiveTree !== DataCache.skillTree) { passiveAdds.clear(); passiveTree = DataCache.skillTree; }
    const classId = Number(state.stats?.classId ?? state.classId);
    const level = Number(state.level || midpointBand(state.levelBand));
    const key = `${classId}:${level}:${skillId}`;
    let add = passiveAdds.get(key);
    if (add !== undefined) return add;
    const skill = ClassProgression.currentTreeSkill(DataCache.skillTree || [], classId, skillId);
    const skillLevel = (skill?.levels || [])
        .filter((entry) => Number(entry.pLevel) <= level)
        .reduce((highest, entry) => Math.max(highest, Number(entry.level) || 0), 0);
    add = skillLevel ? Number(C4SkillRules.resolve({ selfId: skillId, level: skillLevel }).stats?.[stat]) || 0 : 0;
    passiveAdds.set(key, add);
    return add;
}

// options.stats: the kit's effective { con, men } (a kit profile, HuntCycle);
// unset, the class template's base stats.
function coldRestRegenPerTick(state, options = {}) {
    const level = Math.max(1, Number(state.level || midpointBand(state.levelBand)) || 1);
    const classId = Number(state.stats?.classId ?? state.classId);
    const baseStats = options.stats || (ClassProgression.firstClassRow(DataCache.classTemplates || [], classId) || {}).base || {};
    const hpBase = Number(DataCache.revitalize?.hp?.[level]) || 0;
    const mpBase = Number(DataCache.revitalize?.mp?.[level]) || 0;
    const hp = ((hpBase * Formulas.calcLevelMod(level) * Formulas.calcBaseMod.CON(Number(baseStats.con) || 1))
        + coldPassiveRegenAdd(state, 212, 'regHpAdd')) * 1.5;
    const mp = ((mpBase * Formulas.calcLevelMod(level) * Formulas.calcBaseMod.MEN(Number(baseStats.men) || 1))
        + coldPassiveRegenAdd(state, 229, 'regMpAdd')) * 1.5;

    return { hp: Math.max(0, hp) * (options.hpMultiplier || 1), mp: Math.max(0, mp) * (options.mpMultiplier || 1) };
}

function requiresManaRecovery(state, options = {}) {
    if (typeof options.requireMana === 'boolean') return options.requireMana;
    return RestPolicy.restsForMana(state, options.party === true);
}

// The seated seconds that refill missingHp and missingMp (MP only for a bot
// that rests for mana). options.regen: a coldRestRegenPerTick the caller holds.
function restSeconds(state, missingHp, missingMp, options = {}) {
    const regen = options.regen || coldRestRegenPerTick(state, options);
    const hpSeconds = Math.max(0, missingHp) / Math.max(0.01, regen.hp / (Formulas.REGEN_TICK_MS / 1000));
    const mpSeconds = requiresManaRecovery(state, options)
        ? Math.max(0, missingMp) / Math.max(0.01, regen.mp / (Formulas.REGEN_TICK_MS / 1000))
        : 0;
    return Math.max(hpSeconds, mpSeconds);
}

function estimateRestMs(state, vitals, options = {}) {
    const maxHp = Number(vitals.maxHp || vitals.hp || 1);
    const maxMp = Number(vitals.maxMp || vitals.mp || 1);
    return Math.round(Math.max(restSeconds(state, maxHp - Number(vitals.hp || 0), maxMp - Number(vitals.mp || 0), options), 8) * 1000);
}

module.exports = { coldRestRegenPerTick, requiresManaRecovery, restSeconds, estimateRestMs };
