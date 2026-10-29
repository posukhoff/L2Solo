const assert = require('assert');

require('../src/Global');
invoke('GameServer/DataCache').init();

const DataCache = invoke('GameServer/DataCache');
const Formulas = invoke('GameServer/Formulas');
const HitRules = invoke('GameServer/Combat/HitRules');
const CombatantView = invoke('GameServer/Combat/CombatantView');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');
const NpcCombatChoice = invoke('GameServer/Npc/NpcCombatChoice');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');

const constant = value => () => value;

// A shield that blocks adds its defence (one rule, hot and cold).
const attacker = CombatantView.view({ pAtk: 1000, critRate: 0 });
const bare = CombatantView.view({ pDef: 400, dex: 30 });
const shielded = CombatantView.view({ pDef: 400, dex: 30, shieldPDef: 300, shieldRate: 90 });
const open = HitRules.melee(attacker, bare, {}, constant(0.5)).damage;
const blocked = HitRules.melee(attacker, shielded, {}, constant(0.5));
assert.strictEqual(blocked.shield, Formulas.SHIELD_DEFENSE_SUCCEED);
assert(blocked.damage < open, `a blocked hit lands less (${blocked.damage} vs ${open})`);
assert.strictEqual(HitRules.melee(attacker, shielded, { facing: false }, constant(0.5)).shield, Formulas.SHIELD_DEFENSE_FAILED,
    'a shield behind the defender blocks nothing');

// A physical skill crits by its own base rate and STR, a skill without one never.
assert.strictEqual(HitRules.physicalSkillCritRate({}, 40), 0);
assert(HitRules.physicalSkillCritRate({ baseCritRate: 15 }, 40) > HitRules.physicalSkillCritRate({ baseCritRate: 15 }, 20));

// The monster's choice: a self buff it lacks first, no control on a held target, a debuff only after its gap.
function fakeSkill(id, semantic, extra = {}) {
    return { fetchSelfId: () => id, fetchSemantic: () => semantic, fetchConsumedMp: () => 0, fetchDistance: () => 40,
        fetchTargetKind: () => extra.target || 'enemy', fetchSpell: () => false, fetchSkillType: () => extra.type || 'pdam' };
}
const stun = fakeSkill(1, { effect: 'stun' });
const buff = fakeSkill(2, { effect: 'might', effectType: 'buff' }, { target: 'self', type: 'buff' });
const debuff = fakeSkill(3, { effect: 'poison', effectType: 'debuff' });
const choose = (skills, options = {}) => NpcCombatChoice.select({ skills, usable: () => true, buffNeeded: () => true,
    hasTarget: true, impairments: {}, aiType: 'fighter', targetAiType: 'fighter', debuffReady: true, rng: constant(0), ...options });
assert.strictEqual(choose([stun, buff]).category, 'buff', 'a missing self buff comes first');
assert.strictEqual(choose([stun]).category, 'hard_control');
assert.strictEqual(choose([stun], { impairments: { disabled: true } }), null, 'a held target is not stunned again');
assert.strictEqual(choose([debuff], { debuffReady: false }), null, 'a debuff waits out its gap');

// The cold monster casts its own skills, as the hot one: a stun that lands holds the bot.
function mobWith(category) {
    for (const npc of DataCache.npcs) {
        if (npc.template?.type !== 'L2Monster' && npc.template?.type !== undefined) continue;
        const skills = NpcSkills.combatSkillsFor({ fetchSelfId: () => npc.selfId });
        if (skills.some(skill => NpcCombatChoice.category(skill) === category && Number(skill.fetchSemantic?.()?.durationMs) > 0
            && skill.fetchConsumedMp() <= 100)) {
            return ColdCombatProfile.npcForSpot({ id: 'stun_test', avgLevel: npc.template?.level || 1,
                npcEntries: [{ selfId: npc.selfId, count: 1 }] }, constant(0));
        }
    }
    return null;
}
const stunner = mobWith('hard_control');
assert(stunner, 'the datapack has a monster with a stun');
const bot = HuntCycle.referenceState(1, Math.max(1, stunner.level));
const fighter = { state: bot, profile: ColdCombatProfile.profileFor(bot, 0, { store: false }), readyAt: 0 };
const fight = BackgroundResolver.combat.coldMobFight(stunner);
assert(fight.skills.length > 0, 'the cold monster knows its skills');
let time = 0;
for (let step = 0; step < 4 && !(fighter.controlledUntil > 0); step++) {
    const action = BackgroundResolver.combat.coldMobAction(stunner, fight, fighter, { time, at: 0, rng: constant(0) });
    assert.strictEqual(action.damage, 0, 'a self buff or a stun deals no damage');
    time += action.delayMs;
}
assert(fight.buffs.size > 0, 'the monster buffs itself first');
assert(fighter.controlledUntil > 0 && fighter.readyAt === fighter.controlledUntil, 'a landed stun holds the bot');
assert(Object.values(fight.cooldowns).some(until => until > 0), 'the stun starts its reuse');
// A held bot is not stunned again: the monster hits it.
const hit = BackgroundResolver.combat.coldMobAction(stunner, fight, fighter, { time, at: 0, rng: constant(0) });
assert(hit.damage > 0, 'the monster strikes a held bot');

console.log('Combat core checks passed');
