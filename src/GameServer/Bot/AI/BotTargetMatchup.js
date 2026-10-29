const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const Rules = invoke('GameServer/Skills/C4SkillRules');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const WeaponMask = invoke('GameServer/Skills/WeaponMask');
const Formulas = invoke('GameServer/Formulas');
const RestPolicy = invoke('GameServer/Bot/AI/RestPolicy');
const Pull = invoke('GameServer/Bot/AI/BotPullEstimate');

const MIN_EFFICIENCY = 0.15;
const ELEMENTS = ['fire', 'water', 'wind', 'earth', 'holy', 'dark'];
const DAMAGE_TYPES = new Set([Rules.DAMAGE, Rules.DAMAGE_EFFECT, Rules.DRAIN,
    Rules.DEATH_LINK, Rules.FATAL, Rules.BLOW]);
const weaponStat = kind => ({ 'Weapon.Bow': 'bowWpnVuln', 'Weapon.Knife': 'daggerWpnVuln',
    'Weapon.Blunt': 'bluntWpnVuln', 'Weapon.BigBlunt': 'bluntWpnVuln' })[kind];
const number = (value, fallback = 1) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const positive = value => Math.max(1, number(value));
// Resolved on first use (the cold worker loads this module before them);
// invoke() re-resolves the path on every call inside spot scans.
let DataCacheModule, HuntingTargetPolicy, ColdCombatProfile;
const dataCache = () => DataCacheModule || (DataCacheModule = invoke('GameServer/DataCache'));
const huntingTargetPolicy = () => HuntingTargetPolicy
    || (HuntingTargetPolicy = invoke('GameServer/Bot/AI/BotHuntingTargetPolicy'));
const coldCombatProfile = () => ColdCombatProfile
    || (ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile'));

function npcTemplate(id) {
    return ItemTemplateIndex.findLastByLength(dataCache().npcs, id, npcTemplate);
}

// A scan owns this snapshot: do not retain live effects, equipment or learned
// skills across decisions. Cold callers already own an immutable profile.
function actorProfile(actor) {
    return {
        classId: actor.fetchClassId?.(), level: actor.fetchLevel?.(),
        role: Roles.combatRoleFor(actor),
        pAtk: actor.fetchCollectivePAtk?.() ?? actor.fetchPAtk?.(),
        mAtk: actor.fetchCollectiveMAtk?.() ?? actor.fetchMAtk?.(),
        atkSpd: actor.fetchCollectiveAtkSpd?.() ?? actor.fetchAtkSpd?.() ?? 300,
        castSpd: actor.fetchCollectiveCastSpd?.() ?? actor.fetchCastSpd?.() ?? 333,
        maxMp: actor.fetchMaxMp?.(), weaponMask: WeaponMask.weaponMaskFor(actor),
        maxHp: actor.fetchMaxHp?.(),
        pDef: actor.fetchCollectivePDef?.() ?? actor.fetchPDef?.(),
        equipment: { weaponKind: actor.backpack?.fetchTotalWeaponKind?.() },
        skills: (actor.skillset?.skills || actor.skillset?.fetchSkills?.() || []).map(skill => ({
            selfId: skill.fetchSelfId?.(), level: skill.fetchLevel?.(),
            reuseReady: actor.canUseSkill?.(skill) !== false,
            semantic: skill.fetchSemantic?.() || {}, passive: skill.fetchPassive?.(),
            spell: skill.fetchSpell?.(), power: skill.fetchPower?.(), mp: skill.fetchConsumedMp?.(),
            hitTime: skill.fetchHitTime?.(), reuse: skill.fetchReuseTime?.(), distance: skill.fetchDistance?.()
        }))
    };
}

function actorProfiles(actors) {
    return actors.filter(Boolean).flatMap(actor => {
        const profile = actorProfile(actor);
        if (actor.summon && !actor.summon.isDead?.() && !actor.summon.state?.fetchDead?.()) {
            return [profile, { ...actorProfile(actor.summon), role: 'dps' }];
        }
        return coldProfiles(profile, { vitals: { mp: actor.fetchMp?.() } });
    });
}

function coldProfiles(profile, state = {}, timestamp = Date.now()) {
    const profiles = [{ ...profile, skills: (profile.skills || []).map(skill => ({
        ...skill, semantic: skill.semantic || Rules.resolveCached(skill)
    })) }];
    const summon = state.stats?.coldCombat?.summon;
    if (summon?.active && number(summon.hp, summon.maxHp) > 0 && summon.expiresAt > timestamp) {
        profiles.push({ ...summon, role: 'dps', skills: [], soloDamageReceiver: false });
    } else if (Roles.isSummoner(profile.classId)) {
        const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
        const skill = Cold.summonSkills(profile).find(s => s.reuseReady !== false
            && number(s.mp, 0) <= number(state.vitals?.mp, profile.maxMp)
            && number(state.stats?.coldCombat?.cooldowns?.[s.selfId], 0) <= timestamp);
        if (skill) profiles.push({ ...invoke('GameServer/Bot/Population/ColdSummonProfile')(profile, Cold.summonDetails(skill)),
            role: 'dps', skills: [], soloDamageReceiver: false });
    }
    if ((profile.role || Roles.combatRoleFor(profile)) === 'mage') {
        profiles[0].soloAttackScores = invoke('GameServer/Bot/Population/ColdClassPolicy')
            .soloAttackScores(profiles[0], { summon: profiles.length > 1 });
    }
    return profiles;
}

// What of a bot's solo profile array (stateProfiles) moves with no build
// section: whether the bot is alive (a dead bot has no profiles) and the
// summon beside it (coldProfiles: its live cold summon, or the servitor a
// summoner can cast now). -1 dead, 0 alone, else the summon's npc id (1 for
// a live summon whose profile names none, the hot path's actorProfile).
function profileKey(profiles) {
    if (!profiles.length) return -1;
    return profiles.length > 1 ? Number(profiles[1].npcId) || 1 : 0;
}

function profileStats(profiles) {
    return [...new Set((profiles || []).flatMap(profile => [weaponStat(profile.equipment?.weaponKind),
        ...(profile.skills || []).map(skill => {
            const trait = (skill.semantic || Rules.resolve(skill)).trait;
            return skill.spell && ELEMENTS.includes(trait) ? `${trait}Vuln` : null;
        })]).filter(Boolean))];
}

function skillStats(actor) {
    return profileStats([{ equipment: { weaponKind: actor.backpack?.fetchTotalWeaponKind?.() },
        skills: (actor.skillset?.skills || []).map(skill => ({
            spell: skill.fetchSpell?.(), semantic: skill.fetchSemantic?.() || {}
        })) }]);
}

function targetView(target, stats = ['bowWpnVuln', 'bluntWpnVuln', 'daggerWpnVuln', ...ELEMENTS.map(e => `${e}Vuln`)]) {
    if (!target || typeof target.fetchHp !== 'function') return target || {};
    // ColdClassPolicy supplies the same projection as native target scans.
    if (target.matchupTarget) return target.matchupTarget;
    // Native effect evaluation loads World/GameTime; cold workers must use
    // their serialized target stats without importing the live world.
    const EffectStats = invoke('GameServer/Effects/EffectStats');
    const vulnerabilities = {};
    for (const stat of stats) {
        vulnerabilities[stat] = EffectStats.multiplier(target, stat, 1);
    }
    const pDef = target.fetchCollectivePDef?.() ?? target.fetchPDef?.();
    const mDef = target.fetchCollectiveMDef?.() ?? target.fetchMDef?.();
    return { vulnerabilities, pDef, mDef, undead: target.fetchUndead?.() === true,
        maxHp: target.fetchMaxHp?.(),
        pAtk: target.fetchCollectivePAtk?.() ?? target.fetchPAtk?.(),
        atkSpd: target.fetchCollectiveAtkSpd?.() ?? target.fetchAtkSpd?.(),
        basePDef: target.fetchPDef?.() ?? pDef, baseMDef: target.fetchMDef?.() ?? mDef };
}

function modifier(target, semantic = {}, magic = false, kind = '') {
    const stat = magic ? (ELEMENTS.includes(semantic.trait) ? `${semantic.trait}Vuln` : null)
        : semantic.trait === 'bow' ? 'bowWpnVuln'
            : semantic.trait === 'dagger' ? 'daggerWpnVuln' : weaponStat(kind);
    const vuln = stat ? Math.max(0, number(target.vulnerabilities?.[stat])) : 1;
    const base = magic ? target.baseMDef : target.basePDef;
    const defense = magic ? target.mDef : target.pDef;
    return vuln * (number(base, 0) > 0 && number(defense, 0) > 0 ? base / defense : 1);
}

function skillModifier(actor, target, skill, view = targetView(target)) {
    return modifier(view, skill.fetchSemantic?.(), skill.fetchSpell?.() === true,
        actor.backpack?.fetchTotalWeaponKind?.() || '');
}

// The damage rates of the cold fight, one owner (channels, soloSurvival,
// HuntCycle's kit ratio): a profile's auto-attack and a spell of `power`
// against a target's defence, and a target's hits against a profile.
// A bow shot lasts as long as the cold fight's (Formulas.normalAttackMs: it
// draws and reloads); a swing keeps the gate's own 500 / atkSpd seconds.
function attackRate(profile, target) {
    const speed = positive(profile.atkSpd || 300);
    const perSecond = profile.equipment?.weaponKind === 'Weapon.Bow'
        ? 1000 / Math.max(250, Formulas.normalAttackMs(speed, { bow: true, reuseDelay: profile.equipment?.attackReuseDelay }))
        : speed / 500;
    return 70 * positive(profile.pAtk) / positive(target.basePDef || target.pDef) * perSecond;
}
function spellDamage(profile, target, power) {
    return 91 * Math.sqrt(positive(profile.mAtk)) * power / positive(target.baseMDef || target.mDef);
}
function spellRate(profile, target, power, hitTime = 3000) {
    return spellDamage(profile, target, power) / Math.max(0.5, number(hitTime, 3000) / 1000 * 333 / positive(profile.castSpd || 333));
}
function incomingRate(target, profile) {
    return 70 * target.pAtk / profile.pDef * positive(target.atkSpd || 253) / 500;
}

function channels(profile, target) {
    const role = profile.role || Roles.combatRoleFor(profile);
    const kind = profile.equipment?.weaponKind || '';
    const physical = role !== 'mage';
    const result = [];
    if (physical) result.push({ weight: attackRate(profile, target),
    modifier: modifier(target, {}, false, kind), magic: false, normal: true });
    for (const skill of profile.skills || []) {
        const semantic = skill.semantic || Rules.resolve(skill);
        const magic = skill.spell === true;
        if (skill.passive || !DAMAGE_TYPES.has(semantic.skillType) || semantic.target !== 'enemy'
            || semantic.notUsedInC4 || (role === 'mage' && !magic)
            || (semantic.undeadOnly && target.undead !== true)
            || (number(profile.maxMp, 0) > 0 && number(skill.mp, 0) > profile.maxMp)
            || (semantic.requires?.weaponsAllowed && !(semantic.requires.weaponsAllowed & profile.weaponMask))
            || (kind === 'Weapon.Bow' && number(semantic.castRange ?? skill.distance, 0) < 400)) continue;
        const power = Math.max(0, number(skill.power ?? semantic.power, 0));
        if (!power) continue;
        // An area skill hits every mob of a pull (F20; BotPullEstimate.pullView).
        const struck = Rules.hitsArea(semantic) ? Math.max(1, number(target.pull)) : 1;
        const weight = struck * (magic
            ? spellRate(profile, target, power, skill.hitTime)
            : 70 * (positive(profile.pAtk) + power) / positive(target.basePDef || target.pDef)
                / Math.max(1, number(skill.hitTime, 1500) / 1000));
        const hitDamage = struck * (magic
            ? spellDamage(profile, target, power)
            : 70 * (positive(profile.pAtk) + power) / positive(target.basePDef || target.pDef));
        result.push({ weight, modifier: modifier(target, semantic, magic, kind), magic,
            soloScore: profile.soloAttackScores?.[skill.selfId],
            survivalWeight: Math.min(weight, hitDamage / Math.max(0.25, number(skill.reuse, 0) / 1000)),
            damageBudget: number(skill.mp, 0) > 0
                ? Math.floor(number(profile.maxMp, 0) / skill.mp) * hitDamage : Infinity });
    }
    return result;
}

// attacksOf: channels, or a caller's per-target list of them (npcVerdict).
function evaluate(profiles, target, attacksOf = channels) {
    let neutral = 0, effective = 0;
    for (const profile of profiles || []) {
        const attacks = attacksOf(profile, target);
        if (!attacks.length) continue; // Missing legacy skill data is not immunity.
        neutral += Math.max(...attacks.map(a => a.weight));
        effective += Math.max(...attacks.map(a => a.weight * a.modifier));
    }
    const efficiency = neutral > 0 ? effective / neutral : 1;
    return { efficiency, eligible: efficiency > MIN_EFFICIENCY,
        penalty: Math.round(Math.max(0, 1 - efficiency) * 900),
        reason: efficiency <= MIN_EFFICIENCY ? 'target_resistance' : 'target_efficiency' };
}

// Full-health readiness, not an estimate of the current injured fight. Keep
// headroom for misses, interrupted casts and the retreat before zero HP.
// Missing legacy projections remain neutral until real stats are available.
function soloSurvival(profiles, target, minimum = 1.5, attacksOf = channels) {
    // The cold solo executor damages the owner; the summon only adds attacks.
    // Native actor profiles retain their ordinary tanking behavior.
    const receivers = profiles?.filter(profile => profile.soloDamageReceiver !== false);
    if (!receivers?.length || !(target.maxHp > 0) || !(target.pAtk > 0)
        || receivers.some(profile => profile.survivalKnown === false || !(profile.maxHp > 0) || !(profile.pDef > 0))) {
        return { eligible: true, survivalRatio: null };
    }
    const lifetime = Math.max(...receivers.map(profile => profile.maxHp / incomingRate(target, profile)));
    const damage = profiles.reduce((sum, profile) => sum + Math.max(0, ...soloChannels(profile, target, attacksOf)
        .map(attack => Math.min((attack.survivalWeight ?? attack.weight) * lifetime,
            attack.damageBudget ?? Infinity) * attack.modifier)), 0);
    const survivalRatio = damage / target.maxHp;
    return { eligible: survivalRatio >= minimum, survivalRatio,
        reason: survivalRatio >= minimum ? 'solo_survival_ready' : 'insufficient_survival_margin' };
}

function soloChannels(profile, target, attacksOf = channels) {
    const attacks = attacksOf(profile, target);
    // T100: a bot that sits for MP and fights with its weapon (an archer)
    // spends MP only while its bar is near full (BotCombatUtility's price):
    // its fight is the normal attack.
    if (!Roles.usesCasterWeaponCombat(profile) && RestPolicy.restsForMana(profile)) {
        const normal = attacks.filter(attack => attack.normal);
        if (normal.length) return normal;
    }
    if (!profile.soloAttackScores) return attacks;
    // The executor chooses by native skill priority, not maximum DPS. Do not
    // admit a fight on a fast spell the bot would never select at full HP.
    let best = null, score = -Infinity;
    for (const attack of attacks) {
        if (!Number.isFinite(attack.soloScore)) continue;
        const current = attack.soloScore + Math.round(180 * Math.log2(
            Math.max(0.01, Math.min(2, attack.modifier))));
        if (current > score) { best = attack; score = current; }
    }
    return best ? [best] : [];
}

function soloCanHunt(profiles, target, { maxTargetLevel, npcLevel, attacksOf = channels } = {}) {
    const survival = soloSurvival(profiles, target, 1.5, attacksOf);
    if (maxTargetLevel && Number(npcLevel || 0) > maxTargetLevel) {
        return { ...survival, eligible: false, reason: 'recovery_level' };
    }
    return survival.survivalRatio === null ? { ...evaluate(profiles, target, attacksOf), survivalRatio: null } : survival;
}

// An optimistic damage bound, not another survival gate. Compile skills once
// against unit defenses and an undead target, then keep at most three numeric
// attack envelopes per profile. Separate maxima for rate/budget and the best
// vulnerability can only increase damage, so an exact-safe mob stays eligible.
function soloSpotUpperBound(profiles) {
    const receivers = profiles?.filter(profile => profile.soloDamageReceiver !== false);
    if (!receivers?.length || receivers.some(p => p.survivalKnown === false
        || !Number.isFinite(p.maxHp) || !(p.maxHp > 0) || !Number.isFinite(p.pDef) || !(p.pDef > 0))) {
        return () => true;
    }
    const lifetimeNumerator = Math.max(...receivers.map(p => p.maxHp * p.pDef)) * 500 / 70;
    if (!Number.isFinite(lifetimeNumerator)) return () => true;
    const neutral = { basePDef: 1, pDef: 1, baseMDef: 1, mDef: 1, undead: true };
    const bounds = profiles.map(profile => {
        const bound = { continuous: 0, physicalRate: 0, physicalBudget: 0, magicRate: 0, magicBudget: 0 };
        for (const attack of channels(profile, neutral)) {
            const rate = attack.survivalWeight ?? attack.weight;
            const budget = attack.damageBudget ?? Infinity;
            if (!attack.magic && budget === Infinity) bound.continuous = Math.max(bound.continuous, rate);
            else {
                const prefix = attack.magic ? 'magic' : 'physical';
                bound[`${prefix}Rate`] = Math.max(bound[`${prefix}Rate`], rate);
                bound[`${prefix}Budget`] = Math.max(bound[`${prefix}Budget`], budget);
            }
        }
        return bound;
    });
    // Search-local, capped at 4096 species (every C4 NPC template; ~130 KiB of
    // pairs at most, dies with the search); never retained on a bot, a shared
    // verdict fingerprint or a saved combat projection. A source route reader
    // asks it for ~700 spots of one build (R3 cost: at 256 a third of its
    // asks recomputed a species).
    const seen = new Map();
    // Every answer is kept, the unhuntable (null) and unknown-stat (true) too.
    function maybeSafe(selfId) {
        if (seen.has(selfId)) return seen.get(selfId);
        const allowed = speciesBound(selfId);
        if (seen.size < 4096) seen.set(selfId, allowed);
        return allowed;
    }
    function speciesBound(selfId) {
        const npc = npcTemplate(selfId);
        if (!npc || !huntingTargetPolicy().canHunt(npc)) return null;
        const target = coldCombatProfile().npcCombatStats(npc);
        if (!(target?.maxHp > 0) || !(target.pAtk > 0)
            || !(target.basePDef > 0) || !(target.baseMDef > 0)) return true;
        const seconds = lifetimeNumerator / (target.pAtk * positive(target.atkSpd || 253));
        let vulnerability = 1;
        for (const stat in target.vulnerabilities) {
            vulnerability = Math.max(vulnerability, number(target.vulnerabilities[stat]));
        }
        const damage = bounds.reduce((sum, bound) => sum + Math.max(
            bound.continuous * seconds / positive(target.pDef),
            Math.min(bound.physicalRate * seconds, bound.physicalBudget) / positive(target.pDef),
            Math.min(bound.magicRate * seconds, bound.magicBudget) / positive(target.mDef)) * vulnerability, 0);
        return damage / target.maxHp >= 1.5;
    }
    return spot => {
        let total = 0, safe = 0;
        for (const entry of spot.npcEntries || []) {
            const allowed = maybeSafe(Number(entry.selfId));
            if (allowed === null) continue;
            const weight = Math.max(1, number(entry.count));
            total += weight;
            if (allowed) safe += weight;
        }
        return !total || safe / total >= 0.6;
    };
}

// options.buffed: the fight profile (buffs and night at options.timestamp)
// instead of the bot's kit profile; options.store: handed to the profile
// (false: a what-if state under the bot's id).
function stateProfiles(state, options = {}) {
    if (options.matchupProfiles) return options.matchupProfiles;
    const states = (options.capacityStates?.length ? options.capacityStates : [state])
        .filter(member => member.vitals?.hp !== 0 && member.activity !== 'dead');
    // Do not invent the other members of an incomplete party projection.
    if (options.mode === 'party' && states.length === 1) return [];
    const Cold = coldCombatProfile();
    const profiles = states.flatMap(member => typeof member.fetchHp === 'function'
        ? actorProfiles([member])
        : coldProfiles({ ...Cold.withBuildSite('matchup', () => (options.buffed === true ? Cold.fightProfile : Cold.profileFor)(
            member, options.timestamp, { store: options.store })),
            // Partial route projections must not turn an invented default
            // class/build into evidence that the real character is too weak.
            survivalKnown: !!member.stats?.coldCombat
                || Number.isFinite(Number(member.stats?.classId ?? member.classId))
        }, member, options.timestamp));
    return profiles;
}

// A spot search checks hundreds of spots with one profile array, and each mob
// species appears on several of them. The verdict depends only on the
// profiles, the species and the safety options: it is computed when asked and
// kept only for that array (a WeakMap keyed by it, options.matchupProfiles of
// one search), so it dies with the search.
const npcVerdicts = new WeakMap();

// Verdicts of one profile array: safety options key -> species id -> verdict.
function optionVerdicts(profiles, options) {
    let byOptions = npcVerdicts.get(profiles);
    if (!byOptions) npcVerdicts.set(profiles, byOptions = new Map());
    const optionsKey = `${options.soloSafety ? 1 : 0}:${options.maxTargetLevel || 0}`;
    let verdicts = byOptions.get(optionsKey);
    if (!verdicts) byOptions.set(optionsKey, verdicts = new Map());
    return verdicts;
}

// pull: the spot's mean pull of the species; the fight meets a whole pull
// (resolveFight: BotPullEstimate.pullView), so the verdict judges it.
function npcVerdict(verdicts, selfId, options, pull = 1) {
    const size = Math.max(1, Math.round(Number(pull) || 1));
    const key = size > 1 ? `${selfId}:${size}` : selfId;
    if (verdicts.has(key)) return verdicts.get(key);
    const npc = npcTemplate(selfId);
    let verdict = null;
    if (npc && huntingTargetPolicy().canHunt(npc)) {
        const target = Pull.pullView(coldCombatProfile().npcCombatStats(npc), size);
        // One attack list per profile against this species: the efficiency and
        // the solo survival read the same channels (pure in profile and target).
        const lists = new Map();
        const attacksOf = profile => { let list = lists.get(profile);
            if (!list) lists.set(profile, list = channels(profile, target)); return list; };
        const match = evaluate(options.profiles, target, attacksOf);
        const withinRecoveryLevel = !options.maxTargetLevel || Number(npc.template?.level || 0) <= options.maxTargetLevel;
        const canHunt = options.soloSafety ? soloCanHunt(options.profiles, target,
            { maxTargetLevel: options.maxTargetLevel, npcLevel: Number(npc.template?.level || 0), attacksOf }).eligible
            : match.eligible && withinRecoveryLevel;
        verdict = Object.freeze({ efficiency: match.efficiency, canHunt });
    }
    verdicts.set(key, verdict);
    return verdict;
}

// A spot's matchup reads only its mob list and the verdicts of one profile
// array and safety options, so it is kept beside them: a spot search checks
// hundreds of spots against the same verdicts.
const spotMatchups = new WeakMap();

// One species' verdict ({ efficiency, canHunt } or null) for profiles under
// safety options: the one a spot search with the same profiles and options
// reads, so a solo fight's pick (ColdCombatProfile.npcForSpot) shares it.
function speciesVerdict(profiles, selfId, options = {}) {
    return npcVerdict(optionVerdicts(profiles, options), Number(selfId),
        { profiles, soloSafety: options.soloSafety, maxTargetLevel: options.maxTargetLevel }, options.pull);
}

// One spawn group's verdict over its pulls (BotPullEstimate.pullsOf): the
// pulls the profiles survive (allowed, their shares as measured), their
// share of the group, and the efficiency over all its pulls; null for a
// species no one hunts. The bot takes only the spawns it can (user 10-29).
function entryVerdict(verdicts, entry, verdictOptions) {
    const allowed = [];
    let efficiency = 0, share = 0, known = false;
    for (const [size, part] of Pull.pullsOf(entry)) {
        const verdict = npcVerdict(verdicts, Number(entry.selfId), verdictOptions, size);
        if (!verdict) continue;
        known = true;
        efficiency += part * verdict.efficiency;
        if (verdict.canHunt) {
            allowed.push([size, part]);
            share += part;
        }
    }
    return known ? { efficiency, canHunt: share > 0, share, allowed } : null;
}

// The spawn group's verdict for profiles under safety options, as a spot
// search reads it (spotMatchup), for a solo fight's pick (npcForSpot).
function speciesPulls(profiles, entry, options = {}) {
    return entryVerdict(optionVerdicts(profiles, options), entry,
        { profiles, soloSafety: options.soloSafety, maxTargetLevel: options.maxTargetLevel });
}

function spotMatchup(spot, profiles, options = {}) {
    if (!profiles?.length) return evaluate([], {});
    let total = 0, effective = 0, eligible = false, safe = 0;
    const verdicts = optionVerdicts(profiles, options);
    let bySpot = spotMatchups.get(verdicts);
    if (!bySpot) spotMatchups.set(verdicts, bySpot = new WeakMap());
    const known = bySpot.get(spot);
    if (known) return known;
    const verdictOptions = { profiles, soloSafety: options.soloSafety, maxTargetLevel: options.maxTargetLevel };
    for (const entry of spot.npcEntries || []) {
        const verdict = entryVerdict(verdicts, entry, verdictOptions);
        if (!verdict) continue;
        const weight = Math.max(1, number(entry.count));
        total += weight;
        effective += weight * Math.min(1, verdict.efficiency);
        eligible ||= verdict.canHunt;
        safe += weight * verdict.share;
    }
    const efficiency = total ? effective / total : 1;
    const safeFraction = total ? safe / total : 1;
    const spotEligible = !total || (eligible && (!options.soloSafety || safeFraction >= 0.6));
    const penalty = Math.round((1 - efficiency) * 250 + (options.soloSafety ? (1 - safeFraction) * 250 : 0));
    const result = Object.freeze({ efficiency, safeFraction, eligible: spotEligible, penalty });
    bySpot.set(spot, result);
    return result;
}

// A fixed attack envelope, shared with the survival gate. Admission may
// compare native buff effects without running an encounter simulation.
function damageRate(profiles, target = {}) {
    return profiles.reduce((sum, profile) => sum + Math.max(0, ...channels(profile, target)
        .map(attack => (attack.survivalWeight ?? attack.weight) * attack.modifier)), 0);
}

module.exports = { MIN_EFFICIENCY, actorProfiles, coldProfiles, profileKey, targetView, skillModifier, damageRate, attackRate, spellRate, incomingRate,
    profileStats, skillStats, evaluate, soloSurvival, soloCanHunt, soloSpotUpperBound, stateProfiles, spotMatchup, speciesVerdict };
