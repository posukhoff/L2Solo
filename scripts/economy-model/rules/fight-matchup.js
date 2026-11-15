'use strict';
// The expected fight of one solo engagement: a bot and one rolled pull of a
// mob species, from the state the fight starts in (HP, MP, cooldowns still
// running, a bottle still running), on expected values through the game's own
// rules: the pull as one mob packed by the bot's area share
// (BotPullEstimate.pullView), the bot's turn as the cold fight takes it
// (a bottle first, then the solo self-heal, then the class policy's skill or
// the weapon), the expected hit (BotTargetMatchup.expectedHit), action delays,
// the mob's mean action and pace (ColdMobAction.actionMix). It answers the
// engagement's time, the bot's actions and casts, MP and bottles spent, the
// damage taken with its second moment and the cooldowns left. The bot's death
// does not stop the path (the tail of the damage over HP is the caller's).
// Pure: plain profiles and numbers in, numbers out; no World, DB or rng.
// Callers: the economy model's fight tools (offline).
require('../../../src/Global');

const BR = invoke('GameServer/Bot/Population/BackgroundResolver');
const CCPol = invoke('GameServer/Bot/Population/ColdClassPolicy');
const CCP = invoke('GameServer/Bot/Population/ColdCombatProfile');
const CMA = invoke('GameServer/Bot/Population/ColdMobAction');
const TM = invoke('GameServer/Bot/AI/BotTargetMatchup');
const ER = invoke('GameServer/Bot/AI/BotEncounterReadiness');
const Pull = invoke('GameServer/Bot/AI/BotPullEstimate');
const SoloSelfHeal = invoke('GameServer/Bot/AI/SoloSelfHeal');
const Potions = invoke('GameServer/Bot/AI/HealingPotionStock');
const Rules = invoke('GameServer/Skills/C4SkillRules');

// A path that has not killed the pull after this many bot actions is cut: the
// bot cannot hurt it in any time a hunt allows.
const MAX_ACTIONS = 400;
// A drunk bottle holds the bot's next action this long (the cold fight's potion turn).
const POTION_MS = 250;

// One mob of a pull view (the inverse of BotPullEstimate.pullView).
function oneMob(view) {
    if (!(Number(view?.pull) > 1)) return view;
    const one = { ...view, maxHp: view.maxHp / view.pull, pAtk: view.unitPAtk, pull: 1 };
    delete one.pack;
    delete one.unitPAtk;
    return one;
}

// The share of the bot's damage by area skills that packs a pull: the solo
// readiness read at the bot's vitals on the species' usual pull, as the cold
// fight reads it before it rolls the pull.
function areaShareAt(profiles, hp, mp, mob) {
    const one = oneMob(mob);
    const usual = Pull.pullView({ ...one, pull: 1 }, Number(one.usualPull) || 1);
    return Number(ER.evaluate(ER.atVitals(profiles, hp, mp, null), usual).survival.areaShare) || 0;
}

// The bot's hit on the view and its second moment: the expected hit with the
// critical rate at 0 and at 1000 (the method ColdMobAction.actionMix uses for
// the mob), a weapon swing landing at its hit chance; an area skill strikes
// every mob of the pull.
function botHit(p, view, skill, shot, low, high) {
    const zero = TM.expectedHit(low, view, skill, shot), crit = TM.expectedHit(high, view, skill, shot);
    const rate = Math.min(1, Math.max(0, Number(skill ? (skill.spell === true ? p.mCritRate : 0) : p.critical) || 0) / 1000);
    const lands = skill ? 1 : Math.max(1e-6, CCP.expectedHitChance(p.accur, view.evasion));
    const struck = skill && Number(view.pull) > 1 && Rules.hitsArea(Rules.resolveCached(skill)) ? Number(view.pull) : 1;
    const mean = Math.max(0.01, TM.expectedHit(p, view, skill, shot)) * struck;
    return { mean, square: ((1 - rate) * zero * zero + rate * crit * crit) / lands * struck * struck };
}

// One engagement. profile: the bot's matchup profile (hits, shots); fp: its
// fight profile (class policy, delays); mob: the species (one mob or a view of
// it); k: the pull rolled; areaShare: areaShareAt at the start; start: { hp, mp,
// at (the fight's timestamp), cooldowns: { selfId: ms left }, potionLeft: ms a
// bottle still runs }; bag: the inventory the bottles come from (read only);
// holder: what the potion rule reads the bot's role from (its state).
function engagement({ profile: p, fp, mob, k = 1, areaShare = 0, start, bag = null, holder = null }) {
    const view = Pull.pullView(oneMob(mob), k, areaShare);
    const shot = p.shot || null, mix = CMA.actionMix(view, { profile: p }, 0);
    const low = { ...p, critical: 0, mCritRate: 0 }, high = { ...p, critical: 1000, mCritRate: 1000 };
    const at0 = Number(start.at) || 0, maxHp = Number(fp.maxHp) || Number(p.maxHp) || 1;
    const fighter = { vitals: { hp: Number(start.hp), mp: Number(start.mp), maxHp },
        cooldowns: Object.fromEntries(Object.entries(start.cooldowns || {}).map(([id, left]) => [id, at0 + Number(left)])) };
    const vitals = fighter.vitals, mp0 = vitals.mp;
    let t = 0, botAt = 0, mobAt = CCP.openingMs(fp, view), mobHp = view.maxHp, actions = 0, mobActions = 0;
    let potions = 0, potionHot = null, potionUntil = at0 + Math.max(0, Number(start.potionLeft) || 0), inventory = null, pace = null;
    let hitSum = 0, hitSquare = 0, hits = 0, hitDelay = 0;
    const casts = {};
    // A running bottle's ticks up to now (the cold fight's potion HoT; its tick
    // applier is private to the resolver).
    const ticks = now => {
        while (potionHot && potionHot.remaining > 0 && potionHot.nextAt <= now) {
            vitals.hp = Math.min(maxHp, vitals.hp + potionHot.heal);
            potionHot.remaining -= 1;
            potionHot.nextAt += potionHot.intervalMs;
        }
        if (potionHot && potionHot.remaining <= 0) potionHot = null;
    };
    while (mobHp > 0 && actions < MAX_ACTIONS) {
        if (botAt > mobAt) {
            t = mobAt;
            ticks(t);
            vitals.hp -= mix.perAction;
            mobActions += 1;
            mobAt += mix.actionMs;
            continue;
        }
        t = botAt;
        ticks(t);
        const at = at0 + t;
        // One bottle per fight, none while one runs (the resolver's coldBottleFree,
        // private to it: this is its copy).
        if (!(potions > 0) && !potionHot && potionUntil <= at) {
            inventory ||= { ...(bag || {}) };
            const potion = Potions.consumeColdPotion(inventory, vitals.hp, maxHp, holder);
            if (potion) {
                const effect = Potions.coldEffectFor(potion, t);
                vitals.hp = Math.min(maxHp, vitals.hp + Number(effect.immediateHeal || 0));
                potionHot = effect.hot ? { ...effect.hot } : null;
                if (effect.hot) potionUntil = at + Potions.HOT_MS;
                potions += 1;
                botAt += POTION_MS;
                continue;
            }
        }
        // The solo self-heal (SoloSelfHeal.inFight) on the fight's pace from the
        // bot's first turn; that turn only sets the pace.
        if (!pace) pace = { at: t, hp: vitals.hp, mobHp, healed: 0 };
        else {
            const actor = CCPol.actorFor(fp, { hp: vitals.hp, mp: vitals.mp, cooldowns: fighter.cooldowns, time: at, charges: 0 });
            const heal = SoloSelfHeal.inFight(actor, { mobHp, ...SoloSelfHeal.pace(pace, { at: t, hp: vitals.hp, mobHp }) });
            if (heal) {
                const before = vitals.hp, record = heal.coldRecord;
                vitals.hp = Math.min(maxHp, before + Math.max(0, SoloSelfHeal.healAmount(actor, heal, heal.fetchSemantic?.() || {}, false)));
                pace.healed += vitals.hp - before;
                BR.combat.spendSkill(fighter, record, at);
                casts[record.selfId] = (casts[record.selfId] || 0) + 1;
                botAt += CCP.actionDelayMs(fp, record, CCP.actionShot(shot, record)?.spiritshot === true);
                continue;
            }
        }
        actions += 1;
        const skill = CCPol.select(fp, { hp: vitals.hp, mp: vitals.mp, cooldowns: fighter.cooldowns, time: at, charges: 0,
            mob: view, mobHp, party: false })?.skill || null;
        const hit = botHit(p, view, skill, shot, low, high);
        if (skill) {
            BR.combat.spendSkill(fighter, skill, at);
            casts[skill.selfId] = (casts[skill.selfId] || 0) + 1;
        }
        const delay = CCP.actionDelayMs(fp, skill, CCP.actionShot(shot, skill)?.spiritshot === true);
        botAt += delay;
        hitSum += hit.mean; hitSquare += hit.square; hits += 1; hitDelay += delay;
        mobHp -= hit.mean;
    }
    const cut = mobHp > 0, mean = mobActions * mix.perAction;
    // Var(D) = E[N] Var(X) + Var(N) E[X]^2 over the mob's actions; Var(N) from
    // the fight's length: the bot's actions to kill as a renewal count (mob HP
    // x the per-hit variance / mean^3), each at the bot's mean action delay.
    let variance = mobActions * Math.max(0, mix.squarePerAction - mix.perAction ** 2);
    if (hits > 0 && hitSum > 0 && mix.actionMs > 0) {
        const mu = hitSum / hits, sigma2 = Math.max(0, hitSquare / hits - mu * mu), delay = hitDelay / hits;
        variance += view.maxHp * sigma2 / mu ** 3 * delay * delay / mix.actionMs ** 2 * mix.perAction ** 2;
    }
    const end = Math.max(t, botAt);
    return { ms: end, botActions: actions, casts, mpSpent: Math.max(0, mp0 - vitals.mp), mobActions, potions, cut,
        taken: { mean, square: mean * mean + variance },
        cooldowns: Object.fromEntries(Object.entries(fighter.cooldowns).map(([id, until]) => [id, until - at0 - end]).filter(([, left]) => left > 0)) };
}

module.exports = { engagement, areaShareAt, oneMob, MAX_ACTIONS };
