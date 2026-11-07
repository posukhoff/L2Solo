'use strict';

// A far bot's Newbie Guide visit: the executor of its rebuff answered the guide
// (Bot/AI/Rebuff), main's command step (PopulationService's entry branch, routed by
// the kernel). The guide in reach gives its blessing (BotBuffs.newbieEffects: its
// three 20-minute buffs) and full HP/MP, as it does a body (applyFullNewbieBlessing).
// A bot in the field walks to the guide and back: that time it rests (no fights) at
// the walking pace a far bot's town walk uses (ColdVisit). Done once, buffed or not
// (its level or karma moved since the answer, or the guide is out of reach).
const BotBuffs = invoke('GameServer/Bot/AI/BotBuffs');
const Rebuff = invoke('GameServer/Bot/AI/Rebuff');
const WALK_UNITS_PER_SECOND = 120;
const FIELD = new Set(['hunting', 'resting']);

function pending(state) {
    return Rebuff.pending(state?.stats, 'guide');
}

// The step's resolve result (BotLifeState.applyResolve).
function plan(state, timestamp) {
    const answer = pending(state), stats = state.stats || {};
    const guide = BotBuffs.closestGuide(state.loc);
    const serves = BotBuffs.newbieEligible(state.level, stats.karma) && BotBuffs.guideInReach(state.loc, guide);
    const field = FIELD.has(state.activity);
    const walkMs = serves && field ? Math.ceil(2 * Math.hypot(Number(state.loc?.locX || 0) - guide.locX,
        Number(state.loc?.locY || 0) - guide.locY) / WALK_UNITS_PER_SECOND) * 1000 : 0;
    const blessing = serves ? BotBuffs.newbieEffects(timestamp) : [];
    const keys = new Set(blessing.map(effect => effect.key));
    const patch = { stats: { ...stats, rebuff: Rebuff.done(answer) } };
    if (serves) {
        patch.stats.coldCombat = { ...stats.coldCombat,
            effects: [...(stats.coldCombat?.effects || []).filter(effect => !keys.has(effect.key)), ...blessing] };
        patch.vitals = { ...state.vitals, hp: Number(state.vitals?.maxHp || 0) || state.vitals?.hp,
            mp: Number(state.vitals?.maxMp || 0) || state.vitals?.mp };
    }
    if (walkMs > 0) {
        patch.activity = 'resting';
        patch.stats.restUntil = timestamp + walkMs;
    }
    return { patch, events: serves ? [{ type: 'newbie_guide', weight: 1,
        summary: `${state.name || 'Bot'} received the Newbie Guide's blessing in ${guide.name}` }] : [],
    materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: timestamp + Math.max(1000, walkMs),
    debug: { activity: serves ? 'newbie_guide' : 'newbie_guide_out_of_reach', fights: 0, wins: 0 } };
}

async function resolve(state, timestamp = Date.now(), options = {}) {
    const next = plan(state, timestamp);
    const saved = await invoke('GameServer/Bot/Population/BotLifeState').applyResolve(state, next, options);
    if (saved && next.events.length) await invoke('GameServer/Bot/Population/BotLifeEvents').recordMany(state.characterId, next.events);
    return { ok: !!saved, state: saved || state, debug: next.debug };
}

module.exports = { pending, plan, resolve };
