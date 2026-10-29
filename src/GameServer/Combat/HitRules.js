'use strict';

// Domain service: the outcome of one hit from two fighters' numbers
// (CombatantView) and the hit's context. The hot Attack (prepareMeleeHit,
// prepareNpcMeleeHit, prepareSkillDamage) and the cold fight
// (BackgroundResolver) both resolve hits here, so a rule changed here changes
// both. The hit roll itself (Formulas.hitChance) is the caller's: a normal
// attack can miss, a skill cannot.
//
// Context: soulshot / spiritshot / blessedSpiritshot (loaded), facing (the
// defender faces the attacker: its shield can block), bow (the attacker
// shoots: a shield blocks more), modifier (the product of the target's
// weapon, element, race and undead terms the adapter knows), and for a melee
// anger() (the attacker's critical anger bonus, read only on a critical
// that is not blocked) and spreadRng (the weapon spread's roll; hot leaves it
// to Math.random). Returns { damage, critical, shield }.
const Formulas = invoke('GameServer/Formulas');

function shieldRoll(defender, { facing = true, bow = false } = {}, rng) {
    return Formulas.rollShieldUse({ shieldRate: defender.shieldRate, dex: defender.dex, facing, bow }, rng);
}

function guardedPDef(defender, shield) {
    return defender.pDef + (shield === Formulas.SHIELD_DEFENSE_SUCCEED ? defender.shieldPDef : 0);
}

function melee(attacker, defender, context = {}, rng = Math.random) {
    const shield = shieldRoll(defender, context, rng);
    const critical = Formulas.rollCritical(attacker.critRate, rng);
    const blocked = shield === Formulas.SHIELD_DEFENSE_PERFECT_BLOCK;
    const anger = critical && !blocked && context.anger ? Number(context.anger()) || 0 : 0;
    const damage = blocked ? 1 : Math.round(Formulas.calcMeleeDamage(attacker.pAtk, attacker.pAtkRnd, guardedPDef(defender, shield), {
        critical,
        soulshot: context.soulshot === true,
        criticalDamageMultiplier: attacker.critDamageMul,
        criticalDamageAdd: attacker.critDamageAdd + anger,
        rng: context.spreadRng
    }) * (context.modifier ?? 1));
    return { damage, critical, shield, anger: anger > 0 };
}

// A physical skill's critical rate (per mille): its base rate x 10 by the
// attacker's STR (Lisvus calcCrit for skills); none without a base rate.
function physicalSkillCritRate(semantic, str) {
    const base = Number(semantic?.baseCritRate) || 0;
    return base > 0 ? base * 10 * Formulas.calcBaseMod.STR(Math.max(1, Math.round(Number(str) || 1))) : 0;
}

// context.power (the skill's, after Fatal / Death Link), blow (a blow's
// formula), skillCritRate (physicalSkillCritRate).
function physicalSkill(attacker, defender, context = {}, rng = Math.random) {
    const shield = shieldRoll(defender, context, rng);
    if (shield === Formulas.SHIELD_DEFENSE_PERFECT_BLOCK) return { damage: 1, critical: false, shield };
    const formula = context.blow ? Formulas.calcBlowDamage.bind(Formulas) : Formulas.calcPhysicalDamage.bind(Formulas);
    let damage = Math.round(formula(attacker.pAtk, attacker.pAtkRnd, guardedPDef(defender, shield), context.power, {
        soulshot: context.soulshot === true,
        criticalDamageMultiplier: attacker.critDamageMul,
        criticalDamageAdd: attacker.critDamageAdd,
        rng
    }) * (context.modifier ?? 1));
    const critical = context.skillCritRate > 0 && Formulas.rollCritical(context.skillCritRate, rng);
    if (critical) damage *= 2;
    return { damage, critical, shield };
}

function magicSkill(attacker, defender, context = {}, rng = Math.random) {
    const critical = Formulas.rollCritical(attacker.mCritRate, rng);
    const damage = Math.round(Formulas.calcMagicDamage(attacker.mAtk, context.power, defender.mDef, {
        spiritshot: context.spiritshot === true, blessedSpiritshot: context.blessedSpiritshot === true, magicCritical: critical
    }) * (context.modifier ?? 1));
    return { damage, critical, shield: Formulas.SHIELD_DEFENSE_FAILED };
}

// An effect's resistance stats by its trait (Lisvus: stun via shock, cancel
// via the banes), and its land chance in percent (Lisvus calcSkillSuccess,
// Formulas.calcSkillEffectSuccessRate): attacker { level, mAtk, soulshot,
// spiritshot, blessedSpiritshot }, target { level, mDef }, resistModifier
// (traitResistModifier of the target's resist and vulnerability).
const RESIST_FAMILY_BY_TRAIT = {
    shock: { resist: 'stunResist', vulnerability: 'stunVuln' },
    warrior_bane: { resist: 'cancelResist', vulnerability: 'cancelVuln' },
    mage_bane: { resist: 'cancelResist', vulnerability: 'cancelVuln' }
};
function resistStats(trait) {
    return RESIST_FAMILY_BY_TRAIT[trait] || { resist: `${trait}Resist`, vulnerability: `${trait}Vuln` };
}
function traitResistModifier(resist, vulnerability) {
    const vuln = Number(vulnerability);
    return Math.max(0, 1 - ((Number(resist) || 0) / 100)) * Math.max(0, Number.isFinite(vuln) ? vuln : 1);
}
function effectLandChance(semantic, magic, attacker, target, resistModifier = 1) {
    const effectTrait = semantic.effectTrait || semantic.trait;
    // Lisvus calcSkillSuccess defaults unset lvlDepend to 1 for PARALYZE
    // and FEAR, and to 2 for every other effect type.
    const levelDepend = semantic.levelDepend || (
        semantic.effect === 'paralyze' || semantic.effect === 'fear' || effectTrait === 'paralyze' || effectTrait === 'fear' ? 1 : 2);
    return Formulas.calcSkillEffectSuccessRate({
        baseChance: semantic.baseLandRate, magic, mAtk: attacker.mAtk, mDef: target.mDef,
        soulshot: !!attacker.soulshot, spiritshot: !!attacker.spiritshot, blessedSpiritshot: !!attacker.blessedSpiritshot,
        attackerLevel: attacker.level, targetLevel: target.level, magicLevel: semantic.magicLevel, levelDepend, resistModifier
    });
}

module.exports = { melee, physicalSkill, magicSkill, physicalSkillCritRate, resistStats, traitResistModifier, effectLandChance };
