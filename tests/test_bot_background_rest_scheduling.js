const assert = require('assert');

const fs = require('node:fs');
const nodePath = require('node:path');
const isolated = require('./helpers/isolatedSocialDatabase')('bot_background_rest_scheduling', nodePath.resolve(__dirname, '..'));
require('./helpers/databaseIsolation');
require('../src/Global');
isolated.assertConfigured(options.default);
invoke('GameServer/DataCache').init();

const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const BackgroundPartyResolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');

try {
const timestamp = 1_000_000;
const restUntil = timestamp + 24 * 60 * 60 * 1000;
const exhausted = {
    characterId: 81,
    name: 'TiredSolo',
    level: 20,
    levelBand: '18-22',
    activity: 'resting',
    vitals: { hp: 10, maxHp: 800, mp: 0, maxMp: 420 },
    stats: { classId: 11, role: 'mage', restUntil },
    party: { role: 'dps' }
};

const solo = BackgroundResolver.resolveSolo({ state: exhausted, spot: null, elapsedMs: 0, timestamp });
assert.strictEqual(solo.patch.activity, 'resting');
assert.strictEqual(solo.nextResolveAt, restUntil, 'a resting solo bot must sleep until its persisted recovery deadline');

// A pet's regen and a potion's ms are fractions; a fractional clock fails the
// command checkpoint, so the deadline that carries them is whole, and not early.
const fractional = BackgroundResolver.resolveRest({ ...exhausted, stats: { ...exhausted.stats, restUntil: restUntil + 0.25 } },
    0, timestamp, { requireMana: true });
assert.strictEqual(fractional.patch.stats.restUntil, restUntil + 1, 'a rest deadline is whole milliseconds, rounded up');

const party = { partyId: 'rest-scheduling', cohesion: 0.7, risk: 0.2, stats: { restUntil } };
const spot = { id: 'test_spot', name: 'Test Spot', center: {}, rewards: { exp: 1, sp: 1, adenaMin: 1, adenaMax: 1 } };
const restedParty = BackgroundPartyResolver.resolve({
    party,
    members: [exhausted, {
        ...exhausted,
        characterId: 82,
        name: 'ReadyMember',
        vitals: { hp: 800, maxHp: 800, mp: 420, maxMp: 420 },
        stats: { classId: 1, role: 'dps' }
    }],
    spot,
    elapsedMs: 0,
    timestamp
});
assert.strictEqual(restedParty.nextResolveAt, restUntil, 'a resting party must share one recovery deadline');
assert(restedParty.memberResults.every(({ result }) => result.patch.activity === 'resting'), 'ready members must remain seated with their recovering party');
assert.strictEqual(restedParty.partyPatch.stats.restUntil, restUntil, 'the common party deadline must be persisted');

const fullRaidMembers = [91, 92].map((characterId) => ({
    ...exhausted,
    characterId,
    activity: 'resting',
    vitals: { hp: 100000, maxHp: 100000, mp: 100000, maxMp: 100000 },
    stats: { classId: 11, role: 'mage', restUntil: timestamp + 8000 }
}));
const recoveredRaid = BackgroundPartyResolver.resolve({
    party: {
        partyId: 'raid-rest-recovery',
        cohesion: 0.7,
        risk: 0.2,
        stats: {
            restUntil: timestamp + 8000,
            objective: { sourceKind: 'raid', raidBossTemplateId: 999 }
        }
    },
    members: fullRaidMembers,
    spot: { ...spot, raidBoss: true, raidBossTemplateId: 999 },
    elapsedMs: 3000,
    timestamp
});
assert(recoveredRaid.memberResults.every(({ result }) => result.patch.activity === 'grouped'),
    'a fully recovered raid party must resume preparation before its estimated deadline');
assert.strictEqual(recoveredRaid.partyPatch.stats.restUntil, null,
    'a fully recovered raid party must clear the shared recovery deadline');

// This positive combat case needs a real level-20 encounter. The old spot
// has neither an NPC nor an average level: its fallback reward of 1 is
// penalized against NPC level 0 and both level-20 party shares round to 0.
// Select the first authored ordinary monster at the unchanged member level,
// without filtering its strength or modifying its rewards/vitals/skills.
const combatNpc = invoke('GameServer/DataCache').npcs
    .filter(npc => npc.template.kind === 'Monster' && npc.template.level === exhausted.level
        && Number(npc.rewards?.exp) > 0)
    .sort((left, right) => left.selfId - right.selfId)[0];
assert(combatNpc, 'the native catalogue contains an ordinary monster at the existing party level');
const combatSpot = { ...spot, avgLevel: combatNpc.template.level,
    npcSelfIds: [combatNpc.selfId], npcEntries: [{ selfId: combatNpc.selfId, count: 1 }] };
let observedCombat;
const nativeFight = BackgroundResolver.resolvePartyFight;
// These unequipped members may not take the monster (the party's pick refuses
// it: test_bot_cold_combat pins that); the case pins the rest rule in a live
// fight, so its pick takes the monster regardless.
BackgroundResolver.resolvePartyFight = function (options) {
    const result = nativeFight.call(this, { ...options, partyProfiles: null });
    observedCombat = { input: arguments[0], result };
    return result;
};
let combatRestParty, combatMembers;
try {
combatRestParty = BackgroundPartyResolver.resolve({
    party: { partyId: 'combat-rest', cohesion: 0.7, risk: 0.2, roleCoverage: { dps: 2 }, stats: {} },
    members: combatMembers = [
        { ...exhausted, characterId: 83, activity: 'grouped', vitals: { hp: 800, maxHp: 800, mp: 1, maxMp: 420 }, stats: { classId: 5, role: 'tank' }, party: { role: 'tank' } },
        { ...exhausted, characterId: 84, activity: 'grouped', vitals: { hp: 800, maxHp: 800, mp: 420, maxMp: 420 }, stats: { classId: 1, role: 'dps' }, party: { role: 'dps' } }
    ],
    spot: combatSpot,
    elapsedMs: 10_000,
    timestamp,
    rng: () => 0
});
} finally { BackgroundResolver.resolvePartyFight = nativeFight; }
// A party rests between fights, never in one, as hot: a tank out of MP in a live
// fight fights on, and the mob stays pending, not a kill and not a loss.
assert(observedCombat.result.timedOut && !observedCombat.result.won,
    'the original bounded encounter times out before the monster is defeated');
assert(observedCombat.result.debug.remainingHp > 0, 'the timed-out target is still alive');
assert(observedCombat.input.timestamp > timestamp - 10_000, 'the encounter starts after its walk from the round\'s start');
assert.strictEqual(observedCombat.input.spot, combatSpot, 'the authored ordinary target is used unchanged');
assert.strictEqual(observedCombat.result.debug.mobSelfId, combatNpc.selfId);
assert.strictEqual(combatRestParty.debug.spotId, combatSpot.id);
assert.strictEqual(combatRestParty.debug.attemptedFights, 1, 'the original elapsed window attempts one encounter');
assert.strictEqual(combatRestParty.debug.wins, 0, 'a cut fight mints no kill');
assert.strictEqual(combatRestParty.debug.losses, 0, 'a cut fight is no loss');
assert(combatRestParty.memberResults.every(({ result }) => result.patch.activity === 'grouped'), 'nobody sits down in a live fight');
assert(combatRestParty.partyPatch.stats.pveEncounter?.hp > 0, 'the fight stays pending');
assert(!combatRestParty.partyPatch.stats.restUntil, 'no rest deadline while the mob lives');
assert(combatRestParty.memberResults.every(({ result }) => Number(result.materialize.exp || 0) === 0
    && Number(result.materialize.sp || 0) === 0), 'an unfinished encounter mints no EXP or SP');
// The kill ends the fight: the whole party sits together, before any next pull.
const killedParty = BackgroundPartyResolver.resolve({
    party: { partyId: 'combat-rest', cohesion: 0.7, risk: 0.2, roleCoverage: { dps: 2 },
        stats: { pveEncounter: { ...combatRestParty.partyPatch.stats.pveEncounter, hp: 1 } } },
    members: combatMembers,
    spot: combatSpot,
    elapsedMs: 10_000,
    // The members' clock: the step's timestamp or the cut fight's walk past it.
    timestamp: combatRestParty.memberResults[0].result.doneAt + 10_000,
    rng: () => 0
});
assert.strictEqual(killedParty.debug.wins, 1, 'the pending mob falls, and the party takes no next one');
assert(killedParty.partyPatch.stats.restUntil > timestamp + 10_000, 'the rest deadline comes with the fight\'s end');
assert.strictEqual(killedParty.nextResolveAt, killedParty.partyPatch.stats.restUntil);
assert(killedParty.memberResults.every(({ result }) => result.patch.activity === 'resting'), 'a party rest seats every living member together');
assert.strictEqual(killedParty.partyPatch.stats.pveEncounter, null);
assert.strictEqual(BackgroundResolver.needsRest({ stats: { classId: 1 } }, {
    hp: 800, maxHp: 800, mp: 0, maxMp: 420
}, { party: true, hpThreshold: 0.3, mpThreshold: 0.18 }), false,
    'an empty-MP physical DPS must not stop the whole party');
assert.strictEqual(BackgroundResolver.needsRest({ stats: { classId: 5 } }, {
    hp: 800, maxHp: 800, mp: 0, maxMp: 420
}, { party: true, hpThreshold: 0.3, mpThreshold: 0.18 }), true,
    'an empty-MP tank must still trigger party recovery because Hate is part of its primary job');

// A cold solo round runs on one clock from the bot's last action (roundStart = the
// step's timestamp - its elapsed): the bot sits down at its fight's end, as a hot
// bot sits between fights, not at the round's end; nothing carries but its clock.
const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
const RestPolicy = invoke('GameServer/Bot/AI/RestPolicy');
const ColdRest = invoke('GameServer/Bot/Population/ColdRest');
const tick = invoke('GameServer/Formulas').REGEN_TICK_MS;
const originalProfile = Cold.profileFor, originalFightProfile = Cold.fightProfile, originalNpc = Cold.npcForSpot;
try {
    const caster = { classId: 12, level: 29, role: 'mage', maxHp: 592, maxMp: 932,
        pDef: 243, pAtk: 96, mAtk: 162, castSpd: 194, atkSpd: 263, weaponMask: 8,
        equipment: { weaponKind: 'Weapon.Blunt' }, accur: 100, evasion: 0, critical: 0, effects: [],
        skills: [{ selfId: 1230, level: 1, spell: true, passive: false, power: 51, mp: 35, hitTime: 4000 }] };
    Cold.profileFor = Cold.fightProfile = () => ({ ...caster });
    Cold.npcForSpot = () => ({ maxHp: 500, pAtk: 60, atkSpd: 253, pDef: 100, mDef: 70, basePDef: 100, baseMDef: 70,
        vulnerabilities: {}, level: 25, selfId: 156, accur: 100, evasion: 0, critical: 0 });
    const field = { id: 'field', name: 'field', minLevel: 25, maxLevel: 25, avgLevel: 25, density: 8, tags: [],
        tagsAuthoritative: true, center: { locX: 50000, locY: 150000, locZ: -3000 },
        npcEntries: [{ selfId: 156, count: 8 }], levelCounts: { 25: 8 } };
    const hunter = { characterId: 85, level: 29, exp: 0, sp: 0, adena: 0, phase: 'cold', activity: 'hunting', spotId: 'field',
        inventory: {}, loc: {}, timing: {}, vitals: { hp: 592, maxHp: 592, mp: 300, maxMp: 932 },
        stats: { classId: 12, classProgressionClassId: 12, classProgressionLevel: 29, deaths: 0 } };
    const at = 1_800_000_000_000, budget = 120_000, line = { line: RestPolicy.THRESHOLDS.rested };
    const seatedRate = ColdRest.coldRestRegenPerTick(hunter, { profile: caster, timestamp: at });

    const worn = BackgroundResolver.resolveSolo({ state: hunter, spot: field, elapsedMs: budget, timestamp: at, rng: () => 0.5 });
    assert.strictEqual(worn.patch.activity, 'resting', 'the fights wear the caster down to a rest');
    // The vitals its last fight left (the rest event reads them where it sits down).
    const sat = worn.events.find(event => event.type === 'rest').meta;
    const fightEnd = { hp: sat.hpPct * caster.maxHp, maxHp: caster.maxHp, mp: sat.mpPct * caster.maxMp, maxMp: caster.maxMp };
    const sitAt = at - budget + worn.debug.combatMs;
    assert(sitAt < at - budget / 2, `its last fight ends well before the round's end (${at - sitAt} ms before)`);
    const restUntil = worn.patch.stats.restUntil;
    assert(Math.abs(restUntil - Math.ceil(sitAt + BackgroundResolver.estimateRestMs(hunter, fightEnd, line))) <= 1,
        `the rest ends at the fight's end + the rest it needs (${restUntil - at} ms after the round)`);
    assert(Math.abs(worn.patch.vitals.mp - (fightEnd.mp + seatedRate.mp * (at - sitAt) / tick)) < 0.01,
        `at the round's end it has rested seated since its fight, no standing regen after it (MP ${worn.patch.vitals.mp} from ${fightEnd.mp})`);
    assert(Math.abs(worn.debug.seatedMs - (at - sitAt)) < 0.01, 'the round\'s time after the sit is seated');
    assert.strictEqual(worn.doneAt, at, 'its clock is the round\'s end: no field carries the rest');
    // At its deadline the rest step (seated from the round's end) finds the bot at its line.
    const rested = BackgroundResolver.resolveRest({ ...hunter, activity: 'resting', vitals: worn.patch.vitals,
        stats: { ...hunter.stats, ...worn.patch.stats } }, restUntil - worn.doneAt, restUntil);
    assert(rested.patch.vitals.mp >= RestPolicy.THRESHOLDS.rested.mp * caster.maxMp,
        `at its deadline the bot is at its rested line (MP ${rested.patch.vitals.mp})`);
    assert.strictEqual(rested.patch.activity, 'hunting', 'and stands up, the rest not extended');
    // A rest step's own deadline (from a whole-ms step time) is never short of the line either.
    for (const mp of [300, 301, 302, 303]) {
        const low = { ...hunter, activity: 'resting', vitals: { ...hunter.vitals, mp }, stats: { ...hunter.stats } };
        const until = BackgroundResolver.resolveRest(low, 0, at).patch.stats.restUntil;
        const up = BackgroundResolver.resolveRest({ ...low, stats: { ...low.stats, restUntil: until } }, until - at, until);
        assert.strictEqual(up.patch.activity, 'hunting', `at its deadline the bot stands up at its line (MP ${mp}: ${up.patch.vitals.mp})`);
    }

    // A fight refused (the bot cannot take the mob at its HP) seats it where it was refused.
    const tired = { ...hunter, vitals: { ...hunter.vitals, hp: 150 } };
    const refused = BackgroundResolver.resolveSolo({ state: tired, spot: field, elapsedMs: 30_000, timestamp: at, rng: () => 0.5 });
    assert.strictEqual(refused.patch.stats.lastReason, 'solo_recovery_needed');
    assert.strictEqual(refused.debug.attemptedFights, 0);
    // It stood (walked) only until the refusal: its standing regen runs that long, no longer.
    const refusedAt = BackgroundResolver.applyStandingRegen(tired, tired.vitals, refused.debug.combatMs, at);
    const refusedNeed = BackgroundResolver.estimateRestMs(tired, refusedAt, line);
    assert.strictEqual(refused.patch.stats.restUntil, Math.ceil(at - 30_000 + refused.debug.combatMs + refusedNeed),
        'a refused fight\'s rest starts at the refusal, inside the interval the round credits');

    // The same rest inside a longer round ends in it: the bot stands up at its rested
    // line and hunts on in the same round.
    const longer = BackgroundResolver.resolveSolo({ state: tired, spot: field, elapsedMs: 600_000, timestamp: at, rng: () => 0.5 });
    assert(longer.debug.wins > 0, `after the rest it fights on in the round (${longer.debug.wins} wins)`);
    assert(longer.debug.seatedMs >= refusedNeed, `it sat for the rest it needed first (${longer.debug.seatedMs} ms)`);
    assert(longer.events.findIndex(event => event.type === 'rest') < longer.events.findIndex(event => event.type === 'hunt'),
        'the rest came before the fights');

    // MP under every cast (the survival floor) is what the last round left: the bot sat
    // down there, so the interval before the step is a seated rest.
    const drained = { ...hunter, vitals: { ...hunter.vitals, mp: 20 } };
    const floored = BackgroundResolver.resolveSolo({ state: drained, spot: field, elapsedMs: 60_000, timestamp: at, rng: () => 0.5 });
    assert.strictEqual(floored.debug.reason, 'survival_no_mp');
    assert.strictEqual(floored.patch.vitals.mp,
        BackgroundResolver.resolveRest({ ...drained, activity: 'resting' }, 60_000, at, { requireMana: true }).patch.vitals.mp,
        'the floor\'s rest is seated over the interval since the last round');
    assert(floored.patch.vitals.mp > 20, 'it regenerates there');

    // A party round runs on the same clock: from the members' credited hunt, each
    // fight at its own moment (after its walk), the rest from its last fight's end.
    const nuker = { ...caster, skills: [{ ...caster.skills[0], reuse: 3000 }] };
    Cold.profileFor = Cold.fightProfile = () => ({ ...nuker });
    const pair = (mp, hp = hunter.vitals.hp) => [85, 86].map((characterId, k) => ({ ...hunter, characterId, activity: 'grouped',
        vitals: { ...hunter.vitals, mp, hp }, party: { role: k ? 'dps' : 'tank' }, stats: { ...hunter.stats, role: k ? 'dps' : 'tank' } }));
    const partyFights = (members, elapsedMs) => {
        const seen = [];
        BackgroundResolver.resolvePartyFight = function (options) {
            const result = nativeFight.call(this, { ...options, partyProfiles: null });
            seen.push({ at: options.timestamp, members: options.members, result,
                foughtMs: Math.max(Number(result.debug?.durationMs || 0), result.won
                    ? Math.max(0, ...result.members.map(member => Number(member.readyAt) || 0)) : 0) });
            return result;
        };
        try {
            return { seen, party: BackgroundPartyResolver.resolve({ party: { partyId: 'clock', cohesion: 0.7, risk: 0.2,
                roleCoverage: { dps: 2 }, stats: {} }, members, spot: field, elapsedMs, timestamp: at, rng: () => 0.5 }) };
        } finally { BackgroundResolver.resolvePartyFight = nativeFight; }
    };
    const hunt = partyFights(pair(932), 120_000);
    assert(hunt.seen.length >= 2, `the party fights more than once in its round (${hunt.seen.length})`);
    assert(hunt.seen[0].at > at - 120_000 && hunt.seen[0].at < at, 'its first fight starts after its walk from the round\'s start');
    for (let k = 1; k < hunt.seen.length; k++) {
        const before = hunt.seen[k - 1];
        assert(hunt.seen[k].at >= before.at + before.foughtMs, `fight ${k + 1} starts after fight ${k} ends`);
        for (const member of hunt.seen[k].members) {
            const cast = Number(member.stats?.coldCombat?.cooldowns?.[1230]) - 3000;
            if (!(cast > 0)) continue;
            assert(cast >= hunt.seen[0].at && cast <= before.at + before.foughtMs,
                `fight ${k + 1} reads the reuse of a cast inside the fights before it (${cast - before.at} ms after fight ${k}'s start)`);
        }
    }
    // A worn party sits at its last fight's end, to its slowest member's rest from there.
    const worn2 = partyFights(pair(120), 30_000);
    const rest = worn2.party.partyPatch.stats.restUntil;
    assert(rest > at, 'the worn party rests past its round');
    const last = worn2.seen[worn2.seen.length - 1];
    const sitAt2 = last.at + last.foughtMs;
    assert(sitAt2 < at, `it sits at its last fight's end, inside the round (${at - sitAt2} ms before its end)`);
    const standing = ColdRest.coldRestRegenPerTick(hunter, { profile: nuker, standing: true, timestamp: at - 30_000 });
    const need = Math.max(...last.result.members.map(({ state, vitals }) => {
        const atSit = { ...vitals, mp: Math.min(vitals.maxMp, vitals.mp + standing.mp * last.foughtMs / tick),
            hp: Math.min(vitals.maxHp, vitals.hp + standing.hp * last.foughtMs / tick) };
        return BackgroundResolver.resolveRest({ ...state, vitals: atSit }, 0, sitAt2, { party: true }).patch.stats.restUntil;
    }));
    assert(Math.abs(rest - need) <= 1, `the party rest ends at its last fight's end + the rest it needs (${rest - need} ms off)`);
    assert(worn2.party.memberResults.every(({ result }) => result.doneAt === at), 'its members\' clock is the round\'s end');
    // The same rest inside a longer round ends in it: the party stands up at its
    // locked line and hunts on.
    // (a small HP bar: its rest from the trigger to the line fits in a round)
    const small = { ...nuker, maxHp: 150 };
    Cold.profileFor = Cold.fightProfile = () => ({ ...small });
    const longer2 = partyFights(pair(932, 15).map(member => ({ ...member, vitals: { ...member.vitals, maxHp: 150 } })), 135_000);
    const after = longer2.seen.findIndex((fight, k) => k > 0 && fight.at > longer2.seen[k - 1].at + longer2.seen[k - 1].foughtMs + 5000);
    assert(after > 0, 'a fight follows the party\'s rest in the round');
    for (const member of longer2.seen[after].members) {
        assert(RestPolicy.restOver(member.vitals, { mana: ColdRest.requiresManaRecovery(member), party: true }),
            `it stood up at its line (MP ${member.vitals.mp})`);
    }
} finally {
    Cold.profileFor = originalProfile;
    Cold.fightProfile = originalFightProfile;
    Cold.npcForSpot = originalNpc;
}

console.log('Bot background rest scheduling checks passed');

} finally {
    fs.rmSync(isolated.directory, { recursive: true, force: true });
}
